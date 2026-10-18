// The public side of web chat: what a visitor's browser may do with a widget key from an
// allowed website, with no sign-in. The transport (apps/server) owns HTTP: the shared rate
// limit, the Origin header, CORS, body limits and generic errors. This file owns everything
// stored. It never sees the visitor's address.
//
// The rules it keeps:
// - a widget answers only while it, its business and its channel are on, and only for a
//   website on its list;
// - a session is opened by the server with a token it shows once and stores as a digest;
// - nothing a visitor types proves who they are, so a session always gets a contact and a
//   conversation of its own: it never joins a contact that already existed, never changes
//   one, and never touches a stored consent. An address that a contact already holds is
//   kept as a claim, for the team to judge;
// - a session reads and writes its own messages and nothing else.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  requireBusiness,
  runCommand,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  createContactInput,
  DEFAULT_WEBCHAT_SETTINGS,
  publicWebchatMessageInput,
  publicWebchatSessionInput,
  WEBCHAT_LIMITS,
  webchatWidgetKey,
  webchatWidgetSettings,
  type PublicWebchatConfig,
  type PublicWebchatMessage,
  type PublicWebchatMessageInput,
  type PublicWebchatMessages,
  type PublicWebchatSession,
  type PublicWebchatSessionInput,
  type WebchatWidgetSettings,
} from '@repo/contracts';
import { withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { ConflictError, parsePublicId, ValidationError } from '@repo/kernel';
import { applyLeadSourceRules, createContact, NO_VISIT, recordTouch } from '@repo/module-crm';
import { sql } from 'kysely';
import * as z from 'zod';

import { recordConsent } from './consent-record.js';
import { allowedOrigin, MAX_ORIGIN_LENGTH } from './webchat-origin.js';
import {
  evaluateSessionStart,
  evaluateVisitorMessage,
  sessionIsLive,
  visitorName,
} from './webchat-policy.js';
import { newSessionToken, sessionDigest } from './webchat-token.js';
import { holdBusinessIfActive } from './webchat-locks.js';

/**
 * A request that passed the gate: the widget it names is on, and the website it comes from
 * is on the widget's list. The transport passes it back unchanged and builds nothing from
 * it but the CORS header, which carries `origin`: the stored value, never the header's.
 */
export interface WebchatAdmission {
  readonly agencyId: string;
  readonly businessId: string;
  readonly widgetId: string;
  readonly origin: string;
}

/** What the transport says about a request: an id for logs and audit, and nothing else. */
export interface PublicWebchatRequest {
  readonly requestId: string;
}

/** Why a request did nothing. The transport gives each one generic answer. */
export type WebchatRefusal =
  /** No such session for this widget and website, or it has ended or expired. */
  | { readonly outcome: 'session_invalid' }
  /** The widget is off, or was turned off since the gate. */
  | { readonly outcome: 'unavailable' }
  /** The details do not fit what the widget asks for. */
  | { readonly outcome: 'invalid' }
  /** A limit of the widget or the session; try again after this long. */
  | { readonly outcome: 'limited'; readonly retryAfterSeconds: number }
  /** The session has had all the messages one session takes. */
  | { readonly outcome: 'session_full' };

export interface PublicWebchatHandlers {
  /** The gate. Undefined for an unknown key, a widget that is off, or a website not listed. */
  readonly admit: (
    widgetKey: string,
    originHeader: unknown,
  ) => Promise<WebchatAdmission | undefined>;
  readonly config: (
    admission: WebchatAdmission,
  ) => Promise<{ readonly outcome: 'ok'; readonly config: PublicWebchatConfig } | WebchatRefusal>;
  readonly start: (
    admission: WebchatAdmission,
    input: PublicWebchatSessionInput,
    request: PublicWebchatRequest,
  ) => Promise<{ readonly outcome: 'ok'; readonly session: PublicWebchatSession } | WebchatRefusal>;
  readonly send: (
    admission: WebchatAdmission,
    token: string | undefined,
    input: PublicWebchatMessageInput,
    request: PublicWebchatRequest,
  ) => Promise<{ readonly outcome: 'ok'; readonly message: PublicWebchatMessage } | WebchatRefusal>;
  readonly messages: (
    admission: WebchatAdmission,
    token: string | undefined,
    after: number,
  ) => Promise<{ readonly outcome: 'ok'; readonly page: PublicWebchatMessages } | WebchatRefusal>;
  readonly end: (
    admission: WebchatAdmission,
    token: string | undefined,
    request: PublicWebchatRequest,
  ) => Promise<{ readonly outcome: 'ok' } | WebchatRefusal>;
}

const DAY_MS = 86_400_000;
/** Expired sessions removed each time a widget starts one: constant work, and more than one added. */
const CLEANUP_BATCH = 20;

// A widget saved before it had settings reads as the defaults.
function settingsOf(stored: unknown): WebchatWidgetSettings {
  const merged = webchatWidgetSettings.safeParse({
    ...DEFAULT_WEBCHAT_SETTINGS,
    ...(typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {}),
  });
  return merged.success ? merged.data : DEFAULT_WEBCHAT_SETTINGS;
}

interface LiveWidget {
  readonly id: string;
  readonly allowedOrigins: readonly string[];
  readonly settings: WebchatWidgetSettings;
}

/**
 * The widget while it may answer: its channel account active and its business active.
 * With `lock`, the widget row is held for update, so two sessions of one widget start one
 * after the other and each counts the other; its channel is share-locked, so one switched
 * off meanwhile either commits first, and is seen here, or waits. The caller holds the
 * business already (holdBusinessIfActive), as the lock order asks.
 */
async function liveWidget(
  trx: DatabaseTransaction,
  widgetId: string,
  lock: boolean,
): Promise<LiveWidget | undefined> {
  const query = trx
    .selectFrom('messaging.webchat_widgets as widget')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.id', '=', 'widget.id')
        .onRef('channel.business_id', '=', 'widget.business_id'),
    )
    .innerJoin('tenancy.businesses as business', 'business.id', 'widget.business_id')
    .select(['widget.id', 'widget.allowed_origins', 'widget.settings'])
    .where('widget.id', '=', widgetId)
    .where('channel.status', '=', 'active')
    .where('business.status', '=', 'active');
  const row = await (lock ? query.forUpdate('widget') : query).executeTakeFirst();
  if (row === undefined) return undefined;
  if (lock) {
    const channel = await trx
      .selectFrom('messaging.channel_accounts')
      .select('id')
      .where('id', '=', row.id)
      .where('status', '=', 'active')
      .forShare()
      .executeTakeFirst();
    if (channel === undefined) return undefined;
  }
  return { id: row.id, allowedOrigins: row.allowed_origins, settings: settingsOf(row.settings) };
}

const gate = z.strictObject({
  widgetId: z.uuid(),
  /** The stored origin the request matched; never the header's own text. */
  origin: z.string().min(1).max(MAX_ORIGIN_LENGTH),
});
const digest = z.string().regex(/^[0-9a-f]{64}$/);

/** The widget, if it is still on and still lists the website the request passed the gate with. */
async function widgetFor(
  trx: DatabaseTransaction,
  input: z.output<typeof gate>,
  lock: boolean,
): Promise<LiveWidget | undefined> {
  const widget = await liveWidget(trx, input.widgetId, lock);
  return widget !== undefined && allowedOrigin(input.origin, widget.allowedOrigins) !== undefined
    ? widget
    : undefined;
}

const startSession = defineCommand({
  name: 'webchat.start_session',
  permission: 'contacts.manage',
  input: gate.extend({ visitor: publicWebchatSessionInput }),
  // No name, address or token: what was asked for, and from where.
  audit: (input) => ({
    widgetId: input.widgetId,
    origin: input.origin,
    email: input.visitor.email !== undefined,
    marketingConsent: input.visitor.marketingConsent,
  }),
  async handle(
    trx,
    input,
    command,
  ): Promise<{ outcome: 'ok'; session: PublicWebchatSession } | WebchatRefusal> {
    const businessId = requireBusiness(command.context);
    // Share-locked: a business switched off meanwhile commits first, and is seen, or waits.
    if (!(await holdBusinessIfActive(trx, command.context, 'share')))
      return { outcome: 'unavailable' };
    const widget = await widgetFor(trx, input, true);
    if (widget === undefined) return { outcome: 'unavailable' };
    const { visitor } = input;
    if (widget.settings.emailRequired && visitor.email === undefined) return { outcome: 'invalid' };
    // Consent needs the box the widget showed and an address it is for. A request that
    // claims a tick the widget never offered is refused, not quietly recorded without it.
    const wording = widget.settings.marketingConsentWording;
    if (visitor.marketingConsent && (wording === null || visitor.email === undefined))
      return { outcome: 'invalid' };

    // Expired sessions that never became a chat go as new ones come, oldest first, in
    // bounded work: a busy widget stays tidy between the worker's runs of
    // expireWebchatSessions, and without them. A session that became a chat is kept.
    await sql`
      delete from messaging.webchat_sessions
      where business_id = ${businessId}::uuid and id in (
        select id from messaging.webchat_sessions
        where business_id = ${businessId}::uuid and widget_id = ${widget.id}::uuid
          and expires_at < clock_timestamp() and contact_id is null
        order by created_at limit ${CLEANUP_BATCH})
    `.execute(trx);

    // The database's clock, so every app instance counts the same hour.
    const {
      rows: [facts],
    } = await sql<{
      now: Date;
      hour: string;
      day: string;
      oldest_hour: Date | null;
      oldest_day: Date | null;
    }>`
      select clock_timestamp() as now,
        count(*) filter (where created_at > clock_timestamp() - interval '1 hour') as hour,
        count(*) as day,
        min(created_at) filter (where created_at > clock_timestamp() - interval '1 hour') as oldest_hour,
        min(created_at) as oldest_day
      from messaging.webchat_sessions
      where business_id = ${businessId}::uuid and widget_id = ${widget.id}::uuid
        and created_at > clock_timestamp() - interval '1 day'
    `.execute(trx);
    if (facts === undefined) throw new Error('The session count returned no row.');
    const decision = evaluateSessionStart(
      {
        startedLastHour: Number(facts.hour),
        startedLastDay: Number(facts.day),
        oldestInHour: facts.oldest_hour,
        oldestInDay: facts.oldest_day,
        now: facts.now,
      },
      WEBCHAT_LIMITS,
    );
    if (!decision.allowed)
      return { outcome: 'limited', retryAfterSeconds: decision.retryAfterSeconds };

    const token = newSessionToken();
    const tokenDigest = sessionDigest(widget.id, token);
    if (tokenDigest === undefined) throw new Error('A new session token has no digest.');
    const expiresAt = new Date(facts.now.getTime() + WEBCHAT_LIMITS.sessionDays * DAY_MS);
    await trx
      .insertInto('messaging.webchat_sessions')
      .values({
        business_id: businessId,
        widget_id: widget.id,
        token_digest: tokenDigest,
        origin: input.origin,
        visitor_name: visitor.name === undefined || visitor.name === '' ? null : visitor.name,
        visitor_email: visitor.email ?? null,
        marketing_consent: visitor.marketingConsent,
        consent_wording: visitor.marketingConsent ? wording : null,
        created_at: facts.now,
        expires_at: expiresAt,
      })
      .execute();
    return { outcome: 'ok', session: { token, expiresAt: expiresAt.toISOString() } };
  },
});

interface SessionRow {
  readonly id: string;
  readonly origin: string;
  readonly visitor_name: string | null;
  readonly visitor_email: string | null;
  readonly marketing_consent: boolean;
  readonly consent_wording: string | null;
  readonly contact_id: string | null;
  readonly conversation_id: string | null;
  readonly last_seq: number;
  readonly inbound_count: number;
  readonly minute_started_at: Date | null;
  readonly minute_count: number;
  readonly expires_at: Date;
  readonly ended_at: Date | null;
  readonly now: Date;
}

/**
 * The session a token opens for this widget on this website, or undefined. The digest has
 * the widget's id in it and the lookup names the widget, so another widget's token finds
 * nothing. With `lock` the row is held until the transaction ends.
 */
async function sessionFor(
  trx: DatabaseTransaction,
  widgetId: string,
  origin: string,
  tokenDigest: string,
  lock: boolean,
): Promise<SessionRow | undefined> {
  const query = trx
    .selectFrom('messaging.webchat_sessions')
    .select([
      'id',
      'origin',
      'visitor_name',
      'visitor_email',
      'marketing_consent',
      'consent_wording',
      'contact_id',
      'conversation_id',
      'last_seq',
      'inbound_count',
      'minute_started_at',
      'minute_count',
      'expires_at',
      'ended_at',
      sql<Date>`clock_timestamp()`.as('now'),
    ])
    .where('widget_id', '=', widgetId)
    .where('token_digest', '=', tokenDigest);
  const row: SessionRow | undefined = await (lock ? query.forUpdate() : query).executeTakeFirst();
  if (row === undefined) return undefined;
  const live = sessionIsLive({
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    origin: row.origin,
    requestOrigin: origin,
    now: row.now,
  });
  return live ? row : undefined;
}

/** The contact that holds an email address now, in the trash or not. */
async function holderOf(trx: DatabaseTransaction, email: string): Promise<string | undefined> {
  const holder = await trx
    .selectFrom('crm.contact_identities')
    .select('contact_id')
    .where('kind', '=', 'email')
    .where('value_normalized', '=', email)
    .executeTakeFirst();
  return holder?.contact_id;
}

/**
 * The contact a session's first message is from, and their conversation: always new ones.
 *
 * An email address typed into a public form proves nothing. An address no contact holds is
 * given to the new contact, as any form would. An address a contact already holds (in the
 * trash or not) stays where it is: the visitor becomes a contact without it, and the
 * session keeps who they said they were as a claim. Nothing of the existing contact is
 * read, changed or shown, and their conversation is not this visitor's.
 */
async function introduce(
  trx: DatabaseTransaction,
  command: CommandContext,
  businessId: string,
  widgetId: string,
  session: SessionRow,
): Promise<{ contactId: string; conversationId: string; claimedContactId: string | null }> {
  // Unknown senders are looked up and created one at a time per business, as inbound
  // email does, so a chat and a mailbox can't create the same contact at once.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`inbound-senders:${businessId}`}, 0))`.execute(
    trx,
  );
  const name = visitorName(session.visitor_name ?? undefined);
  const email = session.visitor_email;
  let holder = email === null ? undefined : await holderOf(trx, email);
  let publicContactId: string | undefined;
  if (email !== null && holder === undefined) {
    // Someone signed in can add the same address without the lock above; the unique index
    // then decides, and the visitor is the one without the address.
    await sql`savepoint webchat_contact`.execute(trx);
    try {
      const created = await createContact(
        trx,
        createContactInput.parse({ ...name, emails: [email] }),
        command,
        'webchat',
      );
      publicContactId = created.id;
    } catch (error) {
      await sql`rollback to savepoint webchat_contact`.execute(trx);
      if (!(
        error instanceof ValidationError && error.issues.every((issue) => issue.code === 'taken')
      ))
        throw error;
      holder = await holderOf(trx, email);
    } finally {
      await sql`release savepoint webchat_contact`.execute(trx);
    }
  }
  const holdsEmail = publicContactId !== undefined;
  publicContactId ??= (await createContact(trx, createContactInput.parse(name), command, 'webchat'))
    .id;
  const contactId = parsePublicId('contact', publicContactId);
  if (contactId === undefined) throw new Error('The visitor has no contact.');

  // Where the visitor came from. The widget reads nothing of the page it is on but its
  // website, so that is all a chat's touch knows.
  const decision = await recordTouch(trx, businessId, {
    contactId,
    medium: 'chat',
    visit: { ...NO_VISIT, landingUrl: session.origin },
    subject: { kind: 'webchat_session', id: session.id },
  });
  // The business's own lead source rules that match a chat: their tags and field values.
  // The touch above carries the name.
  if (decision !== undefined) await applyLeadSourceRules(trx, command, contactId, decision);

  const conversation = await trx
    .insertInto('messaging.conversations')
    .values({ business_id: businessId, contact_id: contactId })
    .returning('id')
    .executeTakeFirstOrThrow();

  // Only for an address the new contact holds. The contact is new, so no consent of
  // anybody else's is changed, and no withdrawal can be undone.
  if (session.marketing_consent && session.consent_wording !== null && holdsEmail)
    await recordConsent(trx, command, {
      contactId,
      channel: 'email',
      purpose: 'marketing',
      status: 'granted',
      // The words that were beside the box, the widget that showed them, and the website.
      // No address of the visitor's device is kept.
      evidence: {
        source: 'form',
        wording: session.consent_wording,
        widgetId,
        pageUrl: session.origin,
      },
    });
  return { contactId, conversationId: conversation.id, claimedContactId: holder ?? null };
}

const asMessage = (row: {
  seq: number;
  direction: string;
  body_text: string;
  created_at: Date;
}): PublicWebchatMessage => ({
  seq: row.seq,
  from: row.direction === 'inbound' ? 'visitor' : 'team',
  text: row.body_text,
  sentAt: row.created_at.toISOString(),
});

const sendMessage = defineCommand({
  name: 'webchat.send_message',
  permission: 'contacts.manage',
  input: gate.extend({ tokenDigest: digest, message: publicWebchatMessageInput }),
  // Identifiers only: no text and no digest reach the audit log.
  audit: (input) => ({
    widgetId: input.widgetId,
    origin: input.origin,
    clientMessageId: input.message.clientMessageId,
  }),
  async handle(
    trx,
    input,
    command,
  ): Promise<{ outcome: 'ok'; message: PublicWebchatMessage } | WebchatRefusal> {
    const businessId = requireBusiness(command.context);
    // The business, then the conversation, then the session (webchat-locks.ts): the order
    // of the team's reply, the Inbox and the outbound worker, so none waits on another.
    if (!(await holdBusinessIfActive(trx, command.context))) return { outcome: 'unavailable' };
    const widget = await widgetFor(trx, input, false);
    if (widget === undefined) return { outcome: 'unavailable' };
    const seen = await sessionFor(trx, widget.id, input.origin, input.tokenDigest, false);
    if (seen === undefined) return { outcome: 'session_invalid' };
    if (seen.conversation_id !== null)
      await trx
        .selectFrom('messaging.conversations')
        .select('id')
        .where('id', '=', seen.conversation_id)
        .forUpdate()
        .executeTakeFirst();
    const session = await sessionFor(trx, widget.id, input.origin, input.tokenDigest, true);
    if (session === undefined) return { outcome: 'session_invalid' };
    // Another request of this session made its conversation meanwhile, and this one holds
    // the session without it. Stop; the widget sends again, and the message id keeps it one.
    if (session.conversation_id !== seen.conversation_id)
      throw new ConflictError('The chat changed. Send the message again.');

    const repeated = await trx
      .selectFrom('messaging.webchat_session_messages as link')
      .innerJoin('messaging.messages as message', (join) =>
        join
          .onRef('message.id', '=', 'link.message_id')
          .onRef('message.business_id', '=', 'link.business_id'),
      )
      .select(['link.seq', 'message.direction', 'message.body_text', 'message.created_at'])
      .where('link.session_id', '=', session.id)
      .where('link.client_message_id', '=', input.message.clientMessageId)
      .executeTakeFirst();
    if (repeated !== undefined) return { outcome: 'ok', message: asMessage(repeated) };

    const decision = evaluateVisitorMessage(
      {
        sent: session.inbound_count,
        minuteStartedAt: session.minute_started_at,
        minuteCount: session.minute_count,
        now: session.now,
      },
      WEBCHAT_LIMITS,
    );
    if (!decision.allowed)
      return decision.reason === 'too_fast'
        ? { outcome: 'limited', retryAfterSeconds: decision.retryAfterSeconds }
        : { outcome: 'session_full' };

    const known =
      session.contact_id !== null && session.conversation_id !== null
        ? { contactId: session.contact_id, conversationId: session.conversation_id }
        : await introduce(trx, command, businessId, widget.id, session);
    const claimed = 'claimedContactId' in known ? known.claimedContactId : null;
    const at = session.now;
    const stored = await trx
      .insertInto('messaging.messages')
      .values({
        business_id: businessId,
        conversation_id: known.conversationId,
        channel: 'webchat',
        channel_account_id: widget.id,
        direction: 'inbound',
        status: 'received',
        // Plain text exactly as typed. It is never HTML: whoever shows it shows text.
        body_text: input.message.text,
        author_kind: 'contact',
        author_id: known.contactId,
        created_at: at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // A new message reopens the conversation, and wakes a snoozed one.
    await trx
      .updateTable('messaging.conversations')
      .set((eb) => ({
        status: 'open',
        snoozed_until: null,
        needs_reply: true,
        unread_count: eb('unread_count', '+', 1),
        last_message_at: sql<Date>`greatest(last_message_at, ${at})`,
        last_inbound_at: sql<Date>`greatest(last_inbound_at, ${at})`,
      }))
      .where('id', '=', known.conversationId)
      .execute();
    const seq = session.last_seq + 1;
    await trx
      .insertInto('messaging.webchat_session_messages')
      .values({
        business_id: businessId,
        session_id: session.id,
        seq,
        message_id: stored.id,
        client_message_id: input.message.clientMessageId,
      })
      .execute();
    await trx
      .updateTable('messaging.webchat_sessions')
      .set({
        last_seq: seq,
        inbound_count: session.inbound_count + 1,
        minute_started_at: decision.minuteStartedAt,
        minute_count: decision.minuteCount,
        contact_id: known.contactId,
        conversation_id: known.conversationId,
        ...(claimed === null ? {} : { claimed_contact_id: claimed }),
        // The details live with the contact from here on.
        visitor_name: null,
        visitor_email: null,
        marketing_consent: false,
        consent_wording: null,
      })
      .where('id', '=', session.id)
      .execute();
    await command.emit({
      type: 'message.received',
      subject: { kind: 'message', id: stored.id },
      payload: {
        conversationId: known.conversationId,
        widgetId: widget.id,
        channel: 'webchat',
        // Automations and webhooks are told, as the Inbox is, that nobody proved who wrote.
        identity: 'unverified',
      },
      records: [known.contactId],
    });
    return {
      outcome: 'ok',
      message: { seq, from: 'visitor', text: input.message.text, sentAt: at.toISOString() },
    };
  },
});

const endSession = defineCommand({
  name: 'webchat.end_session',
  permission: 'contacts.manage',
  input: gate.extend({ tokenDigest: digest }),
  audit: (input) => ({ widgetId: input.widgetId, origin: input.origin }),
  async handle(trx, input, command): Promise<{ outcome: 'ok' } | WebchatRefusal> {
    // Before the session is held, as every writer does (webchat-locks.ts).
    if (!(await holdBusinessIfActive(trx, command.context))) return { outcome: 'unavailable' };
    const session = await sessionFor(trx, input.widgetId, input.origin, input.tokenDigest, true);
    if (session === undefined) return { outcome: 'session_invalid' };
    // The visitor's own details go with the session; the messages stay with the business.
    await trx
      .updateTable('messaging.webchat_sessions')
      .set({
        ended_at: sql<Date>`clock_timestamp()`,
        ...(session.contact_id === null
          ? {
              visitor_name: null,
              visitor_email: null,
              marketing_consent: false,
              consent_wording: null,
            }
          : {}),
      })
      .where('id', '=', session.id)
      .execute();
    return { outcome: 'ok' };
  },
});

/**
 * The handlers the public transport calls. Every write is a command run as the contact
 * with no signed-in user's powers: the commands are not exported, and each checks again,
 * inside its own transaction, what the gate checked.
 */
export function createPublicWebchatHandlers(db: Database): PublicWebchatHandlers {
  const services = { db, authorize: allowEveryone };
  const invocation = (admission: WebchatAdmission, correlationId: string): Invocation => ({
    context: {
      agencyId: admission.agencyId,
      businessId: admission.businessId,
      actorKind: 'contact',
      correlationId: z.uuid().parse(correlationId),
    },
    // No ip and no userAgent: the audit log keeps neither for a visitor.
    permissions: 'all',
  });
  const scope = (admission: WebchatAdmission): z.input<typeof gate> => ({
    widgetId: admission.widgetId,
    origin: admission.origin,
  });

  return {
    async admit(widgetKey, originHeader) {
      if (!webchatWidgetKey.safeParse(widgetKey).success) return undefined;
      // The one way across businesses: a key names its widget, its business and its agency.
      const {
        rows: [found],
      } = await sql<{ agency_id: string; business_id: string; widget_id: string }>`
        select agency_id, business_id, widget_id from private.resolve_webchat_widget(${widgetKey})
      `.execute(db);
      if (found === undefined) return undefined;
      const admission = {
        agencyId: found.agency_id,
        businessId: found.business_id,
        widgetId: found.widget_id,
      };
      const widget = await withTenant(
        db,
        invocation({ ...admission, origin: '' }, randomUUID()).context,
        (trx) => liveWidget(trx, found.widget_id, false),
      );
      if (widget === undefined) return undefined;
      const origin = allowedOrigin(originHeader, widget.allowedOrigins);
      return origin === undefined ? undefined : { ...admission, origin };
    },

    config: (admission) =>
      withTenant(db, invocation(admission, randomUUID()).context, async (trx) => {
        const widget = await widgetFor(trx, scope(admission), false);
        if (widget === undefined) return { outcome: 'unavailable' };
        return {
          outcome: 'ok',
          config: {
            title: widget.settings.title,
            greeting: widget.settings.greeting,
            emailRequired: widget.settings.emailRequired,
            marketingConsentWording: widget.settings.marketingConsentWording,
            messageLength: WEBCHAT_LIMITS.messageLength,
          },
        };
      }),

    start: (admission, input, request) =>
      runCommand(
        services,
        startSession,
        { ...scope(admission), visitor: input },
        invocation(admission, request.requestId),
      ),

    async send(admission, token, input, request) {
      const tokenDigest = sessionDigest(admission.widgetId, token);
      if (tokenDigest === undefined) return { outcome: 'session_invalid' };
      return runCommand(
        services,
        sendMessage,
        { ...scope(admission), tokenDigest, message: input },
        invocation(admission, request.requestId),
      );
    },

    async messages(admission, token, after) {
      const tokenDigest = sessionDigest(admission.widgetId, token);
      if (tokenDigest === undefined) return { outcome: 'session_invalid' };
      return withTenant(db, invocation(admission, randomUUID()).context, async (trx) => {
        const widget = await widgetFor(trx, scope(admission), false);
        if (widget === undefined) return { outcome: 'unavailable' };
        const session = await sessionFor(trx, widget.id, admission.origin, tokenDigest, false);
        if (session === undefined) return { outcome: 'session_invalid' };
        // Through the session's own list only: never the conversation, which may hold
        // email and SMS with the contact whose address this visitor typed.
        const rows = await trx
          .selectFrom('messaging.webchat_session_messages as link')
          .innerJoin('messaging.messages as message', (join) =>
            join
              .onRef('message.id', '=', 'link.message_id')
              .onRef('message.business_id', '=', 'link.business_id'),
          )
          .select(['link.seq', 'message.direction', 'message.body_text', 'message.created_at'])
          .where('link.session_id', '=', session.id)
          .where('link.seq', '>', after)
          .where('message.channel', '=', 'webchat')
          .where('message.channel_account_id', '=', widget.id)
          .orderBy('link.seq')
          .limit(WEBCHAT_LIMITS.pageSize + 1)
          .execute();
        const page = rows.slice(0, WEBCHAT_LIMITS.pageSize);
        return {
          outcome: 'ok',
          page: {
            messages: page.map(asMessage),
            // A place past the end is brought back to it, so a later message is not skipped.
            cursor: page.at(-1)?.seq ?? Math.min(after, session.last_seq),
            more: rows.length > page.length,
          },
        };
      });
    },

    async end(admission, token, request) {
      const tokenDigest = sessionDigest(admission.widgetId, token);
      if (tokenDigest === undefined) return { outcome: 'session_invalid' };
      return runCommand(
        services,
        endSession,
        { ...scope(admission), tokenDigest },
        invocation(admission, request.requestId),
      );
    },
  };
}
