// What the external tracking script may do with a tracking id from a website, with no
// sign-in. The transport (apps/server) owns HTTP: the shared rate limit, the Origin header,
// CORS, the body limit and generic answers. This file owns everything stored.
//
// A page view:
// - is answered with a view token (view-token.ts), whether or not page views are kept, so a
//   form on the page can be sent;
// - is kept with its page's host and path and the campaign facts of its address, never its
//   query, and counted in the page's day;
// - carries the visitor's random id only while the business recognises returning visitors,
//   and not from a browser that sends Global Privacy Control unless told to;
// - of a visitor a form has already identified, belongs to that contact, and is put on the
//   contact's timeline at most once per page each half hour.
//
// A form sent (only while form capture is on):
// - must come with a view token of this business, shown to this source at least two seconds
//   before; one page shown gives five forms at most, and a business takes so many an hour;
// - is stored once for the id the script chose;
// - without an email address or a phone number the CRM can read, keeps nothing personal:
//   only that a form was sent, on which page;
// - with one, makes or finds the contact through the CRM's own intake, as a form does: its
//   touch and lead source, the custom fields named by their keys, a note of what filled
//   nothing, the visitor's earlier page views, and one event for workflows.
// Nothing about any contact is ever answered: every request gets the same receipt.

import { allowEveryone, defineCommand, runCommand, type CommandContext } from '@repo/commands';
import {
  LEAD_SOURCE_LIMITS,
  publicTrackingEvent,
  type PublicTrackingEvent,
  type PublicTrackingReceipt,
} from '@repo/contracts';
import { withTenant, type Database, type DatabaseTransaction, type Json } from '@repo/db';
import { AppError, ConflictError, toPublicId, ValidationError } from '@repo/kernel';
import {
  applyLeadSourceRules,
  decideLeadSourceFor,
  intakeContact,
  readArrival,
  readRecordField,
  readVisit,
  recordTouch,
  setRecordFieldCommand,
  writeIntakeReview,
  type VisitFacts,
} from '@repo/module-crm';
import { readPhoneNumbers } from '@repo/module-messaging';
import { holdActiveBusiness } from '@repo/module-tenancy';
import { sql } from 'kysely';
import * as z from 'zod';

import { visitorSource } from '../visitor-source.js';
import { mapFields, type CapturedField, type MappedForm } from './fields.js';
import { admittedOrigin, pageOfOrigin } from './origin.js';
import { trackingSettingsOf } from './settings.js';
import { checkViewToken, issueViewToken } from './view-token.js';

/** A request the gate let through: its business, and the website it came from. */
export interface TrackingAdmission {
  readonly agencyId: string;
  readonly businessId: string;
  /** The admitted origin, as the CORS header carries it: never the header's own text. */
  readonly origin: string;
}

/** What the transport says about a request. The address is the one the server saw. */
export interface TrackingRequest {
  readonly requestId: string;
  readonly ipAddress: string;
  /** Whether the browser sent the Global Privacy Control signal (Sec-GPC: 1). */
  readonly gpc: boolean;
}

export type TrackingRefusal =
  /** The business is off, or the page is not on the website the request came from. */
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'limited'; readonly retryAfterSeconds: number }
  /** The view token is not this business's or this source's, or too old. */
  | { readonly outcome: 'stale' };

export interface PublicTrackingHandlers {
  /** The gate. Undefined for an unknown id, a business that is off, or a website not listed. */
  readonly admit: (
    trackingId: string,
    originHeader: unknown,
  ) => Promise<TrackingAdmission | undefined>;
  readonly record: (
    admission: TrackingAdmission,
    event: PublicTrackingEvent,
    request: TrackingRequest,
  ) => Promise<
    { readonly outcome: 'ok'; readonly receipt: PublicTrackingReceipt } | TrackingRefusal
  >;
}

export interface PublicTrackingOptions {
  readonly db: Database;
  /** Keys the view tokens: the server's public intake secret. */
  readonly secret: string;
  /** The clock, in milliseconds. Tests pass their own. */
  readonly now?: () => number;
  /** How many forms are taken: TRACKING_FORM_LIMITS by default. Tests pass smaller ones. */
  readonly limits?: Partial<Record<keyof typeof TRACKING_FORM_LIMITS, number>>;
}

export const TRACKING_FORM_LIMITS = {
  /** Forms one page shown may give. */
  perView: 5,
  /** Forms with an address a business takes in an hour. */
  perBusinessHour: 500,
  /** How long a known visitor's page is not put on the timeline again, in minutes. */
  timelineMinutes: 30,
} as const;

const RECEIVED: PublicTrackingReceipt = { status: 'received' };

const asJson = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;

/** The campaign labels of an address, and which click ids it carried; never their values. */
function campaignOf(visit: VisitFacts): Record<string, unknown> {
  const clickIds = (
    [
      ['gclid', visit.gclid],
      ['gbraid', visit.gbraid],
      ['wbraid', visit.wbraid],
      ['fbclid', visit.fbclid],
      ['msclkid', visit.msclkid],
      ['ttclid', visit.ttclid],
      ['li_fat_id', visit.liFatId],
    ] as const
  )
    .filter(([, value]) => value !== null)
    .map(([name]) => name);
  return {
    ...(visit.utmSource === null ? {} : { utmSource: visit.utmSource }),
    ...(visit.utmMedium === null ? {} : { utmMedium: visit.utmMedium }),
    ...(visit.utmCampaign === null ? {} : { utmCampaign: visit.utmCampaign }),
    ...(visit.utmContent === null ? {} : { utmContent: visit.utmContent }),
    ...(visit.utmTerm === null ? {} : { utmTerm: visit.utmTerm }),
    ...(clickIds.length === 0 ? {} : { clickIds }),
  };
}

/** What a workflow trigger may filter on: the page and the campaign, nothing personal. */
const triggerFacts = (page: { host: string; path: string }, visit: VisitFacts) => ({
  pageHost: page.host,
  pagePath: page.path,
  ...(visit.utmSource === null ? {} : { utmSource: visit.utmSource }),
  ...(visit.utmMedium === null ? {} : { utmMedium: visit.utmMedium }),
  ...(visit.utmCampaign === null ? {} : { utmCampaign: visit.utmCampaign }),
});

/** The page's title as kept: trimmed, at most 300 characters, or none. */
function titleOf(event: PublicTrackingEvent): string | null {
  const title = event.title?.trim().slice(0, 300) ?? '';
  return title === '' ? null : title;
}

/** An external form's name as kept, as GoHighLevel names a form it could not name. */
function formNameOf(event: Extract<PublicTrackingEvent, { type: 'form_submission' }>): string {
  const name = event.formName.trim();
  return name === '' ? 'Unidentified Form' : name;
}

interface PageFacts {
  readonly page: { readonly host: string; readonly path: string };
  readonly visit: VisitFacts;
  readonly visitorId: string | null;
}

/** Counts a page's view or form in its day, and when it was last seen. */
async function countDay(
  trx: DatabaseTransaction,
  businessId: string,
  page: PageFacts['page'],
  kind: 'page_views' | 'form_submissions',
): Promise<void> {
  await trx
    .insertInto('forms.tracking_page_days')
    .values({
      business_id: businessId,
      page_host: page.host,
      page_path: page.path,
      day: sql<Date>`current_date`,
      [kind]: 1,
    })
    .onConflict((conflict) =>
      conflict.columns(['business_id', 'page_host', 'page_path', 'day']).doUpdateSet({
        [kind]: sql`forms.tracking_page_days.${sql.ref(kind)} + 1`,
        last_seen_at: sql<Date>`now()`,
      }),
    )
    .execute();
}

// What the commands are handed: the event as the script sent it, with the page the gate
// already read from it (the request's own website), so a command reads nothing twice.
const eventInput = z.object({
  businessId: z.uuid(),
  origin: z.string().min(1),
  page: z.object({ host: z.string().min(1), path: z.string().min(1) }),
  visitorId: z.uuid().nullable(),
});

/** The facts of a page the gate already read. */
const factsFrom = (input: z.output<typeof eventInput>, event: PublicTrackingEvent): PageFacts => ({
  page: input.page,
  visit: readVisit({ pageUrl: event.pageUrl, referrer: event.referrer }, input.origin),
  visitorId: input.visitorId,
});

/** A known visitor's page view, put on their contact's timeline. */
const pageViewCommand = defineCommand({
  name: 'external_tracking.page_view',
  permission: 'contacts.manage',
  input: eventInput.extend({ event: publicTrackingEvent, contactId: z.uuid() }),
  // Identifiers only: no page address reaches the audit log.
  audit: (input) => ({ contactId: input.contactId }),
  async handle(trx, input, command): Promise<void> {
    const facts = factsFrom(input, input.event);
    const id = await writePageView(trx, input.businessId, input.event, facts, input.contactId);
    const shownLately = await trx
      .selectFrom('forms.tracking_events')
      .select('id')
      .where('kind', '=', 'page_view')
      .where('visitor_id', '=', input.visitorId)
      .where('page_host', '=', facts.page.host)
      .where('page_path', '=', facts.page.path)
      .where('id', '<>', id)
      .where(
        'received_at',
        '>',
        sql<Date>`now() - make_interval(mins => ${TRACKING_FORM_LIMITS.timelineMinutes}::integer)`,
      )
      .where('contact_id', '=', input.contactId)
      .executeTakeFirst();
    if (shownLately !== undefined) return;
    await command.emit({
      type: 'external_tracking.page_viewed',
      subject: { kind: 'tracking_event', id },
      payload: { contactId: input.contactId, ...triggerFacts(facts.page, facts.visit) },
      records: [input.contactId],
    });
  },
});

function factsOf(
  event: PublicTrackingEvent,
  origin: string,
  visitorId: string | null,
): PageFacts | undefined {
  const page = pageOfOrigin(event.pageUrl, origin);
  if (page === undefined) return undefined;
  return {
    page,
    visit: readVisit({ pageUrl: event.pageUrl, referrer: event.referrer }, origin),
    visitorId,
  };
}

async function writePageView(
  trx: DatabaseTransaction,
  businessId: string,
  event: PublicTrackingEvent,
  facts: PageFacts,
  contactId: string | null,
): Promise<string> {
  const row = await trx
    .insertInto('forms.tracking_events')
    .values({
      business_id: businessId,
      kind: 'page_view',
      page_host: facts.page.host,
      page_path: facts.page.path,
      page_title: titleOf(event),
      referrer_domain: facts.visit.referrerDomain,
      campaign: asJson(campaignOf(facts.visit)),
      visitor_id: facts.visitorId,
      session_id: event.sessionId,
      device_type: event.deviceType ?? null,
      contact_id: contactId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await countDay(trx, businessId, facts.page, 'page_views');
  if (facts.visitorId !== null && contactId !== null)
    await trx
      .updateTable('forms.tracking_visitors')
      .set({ last_seen_at: sql<Date>`now()` })
      .where('visitor_id', '=', facts.visitorId)
      .execute();
  return row.id;
}

type Resolved =
  | {
      readonly outcome: 'created' | 'updated';
      readonly contactId: string;
      readonly review: readonly string[];
      /** Whether the phone number was left off the contact, as one the CRM cannot read. */
      readonly phoneLeft: boolean;
    }
  | { readonly outcome: 'unresolved' };

/** Makes or finds the contact through the CRM's intake, as a form does, inside a savepoint. */
async function resolveContact(
  trx: DatabaseTransaction,
  command: CommandContext,
  mapped: MappedForm,
  source: string,
  withPhone: boolean,
): Promise<Resolved> {
  const ownPhones = (await readPhoneNumbers(trx)).map((number) => number.e164);
  await sql`savepoint tracking_contact`.execute(trx);
  try {
    const contact = await intakeContact(
      trx,
      {
        ...(mapped.firstName === undefined ? {} : { firstName: mapped.firstName }),
        ...(mapped.lastName === undefined ? {} : { lastName: mapped.lastName }),
        emails: mapped.email === undefined ? [] : [mapped.email],
        phones: withPhone && mapped.phone !== undefined ? [mapped.phone] : [],
        source,
      },
      command,
      'form',
      { ownPhones, deferReview: true },
    );
    await sql`release savepoint tracking_contact`.execute(trx);
    return {
      outcome: contact.created ? 'created' : 'updated',
      contactId: contact.contactId,
      review: contact.review,
      phoneLeft: !withPhone && mapped.phone !== undefined,
    };
  } catch (error) {
    await sql`rollback to savepoint tracking_contact`.execute(trx);
    await sql`release savepoint tracking_contact`.execute(trx);
    // A phone number the CRM cannot read: the contact is made from the email address, and
    // the number is kept in the note for the team.
    if (error instanceof ValidationError && withPhone && mapped.email !== undefined)
      return resolveContact(trx, command, mapped, source, false);
    if (error instanceof ConflictError || error instanceof ValidationError)
      return { outcome: 'unresolved' };
    throw error;
  }
}

/**
 * Fills the contact's custom fields whose keys the form's fields are named by, each in a
 * savepoint; gives the fields that filled one. A value the field refuses fills nothing and
 * stays with the submission and its note.
 */
async function fillCustomFields(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string,
  fields: readonly CapturedField[],
): Promise<Set<CapturedField>> {
  const filled = new Set<CapturedField>();
  const keys = [...new Set(fields.map((field) => field.name.toLowerCase()))];
  if (keys.length === 0) return filled;
  const definitions = await trx
    .selectFrom('crm.field_definitions as d')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.business_id', '=', 'd.business_id').onRef('o.id', '=', 'd.object_type_id'),
    )
    .select(['d.id', 'd.key'])
    .where('o.kind', '=', 'contact')
    .where('d.archived_at', 'is', null)
    .where('d.key', 'in', keys)
    .execute();
  const record = toPublicId('contact', contactId);
  const byKey = new Map(definitions.map((definition) => [definition.key, definition.id]));
  for (const field of fields) {
    const definition = byKey.get(field.name.toLowerCase());
    if (definition === undefined) continue;
    const fieldId = toPublicId('field', definition);
    await sql`savepoint tracking_field`.execute(trx);
    try {
      const current = await readRecordField(trx, command, record, fieldId);
      // A value the contact already has stays, as a form leaves it, and the answer goes in
      // the note.
      const empty = current.value === null || current.value === '';
      if (empty) {
        await setRecordFieldCommand.handle(
          trx,
          { id: record, fieldId, value: field.value, revision: current.revision },
          command,
        );
        filled.add(field);
      }
      await sql`release savepoint tracking_field`.execute(trx);
    } catch (error) {
      await sql`rollback to savepoint tracking_field`.execute(trx);
      await sql`release savepoint tracking_field`.execute(trx);
      if (!(error instanceof AppError)) throw error;
    }
  }
  return filled;
}

const formSubmission = publicTrackingEvent.options[1];
const submitInput = eventInput.extend({ event: formSubmission, mark: z.string().min(1) });

/** One line of the note for a field that filled nothing. */
const reviewLine = (field: CapturedField): string => {
  const label = field.label?.trim() ?? '';
  return `${label === '' ? field.name : label}: "${field.value}"`;
};

export function createPublicTrackingHandlers(
  options: PublicTrackingOptions,
): PublicTrackingHandlers {
  const { db, secret } = options;
  const now = options.now ?? (() => Date.now());
  const services = { db, authorize: allowEveryone };
  const limits = { ...TRACKING_FORM_LIMITS, ...options.limits };

  // Every write is made as the system: no visitor and no signed-in user's powers.
  const invocation = (admission: TrackingAdmission, correlationId: string) => ({
    context: {
      agencyId: admission.agencyId,
      businessId: admission.businessId,
      actorKind: 'system' as const,
      correlationId: z.uuid().parse(correlationId),
    },
    permissions: 'all' as const,
  });

  const submit = defineCommand({
    name: 'external_tracking.form_submit',
    permission: 'contacts.manage',
    input: submitInput,
    // Identifiers only: no field value, address or page reaches the audit log.
    audit: (input) => ({ clientSubmissionId: input.event.clientSubmissionId }),
    async handle(trx, input, command): Promise<void> {
      const { event } = input;
      const businessId = input.businessId;
      // The business, held first as every intake holds it; one switched off meanwhile stores
      // nothing.
      if (!(await holdActiveBusiness(trx, command.context))) return;
      // A repeat is answered as the first was, and stores nothing.
      const repeated = await trx
        .selectFrom('forms.external_submissions')
        .select('id')
        .where('client_submission_id', '=', event.clientSubmissionId)
        .executeTakeFirst();
      if (repeated !== undefined) return;
      const facts = factsFrom(input, event);
      const mapped = mapFields(event.fields);

      // Where the visitor came from, read as a form reads it: this page's address, or the
      // first page of the visit on the same website when this one says nothing.
      const arrival = readArrival(
        { pageUrl: event.pageUrl, referrer: event.referrer, first: event.first },
        { pageOrigin: input.origin, now: now() },
      );
      const lead = await decideLeadSourceFor(trx, businessId, {
        medium: 'form',
        visit: arrival.visit,
        pageUrl: arrival.pageUrl,
        address: arrival.address,
      });
      const contact = await resolveContact(trx, command, mapped, lead.label, true);
      const contactId = contact.outcome === 'unresolved' ? null : contact.contactId;
      const made = await trx.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow();

      let identified = 0;
      if (contact.outcome !== 'unresolved') {
        const known = contact.contactId;
        await recordTouch(trx, businessId, {
          contactId: known,
          medium: 'form',
          visit: arrival.visit,
          page: { url: arrival.pageUrl, carried: arrival.carried },
          decision: lead,
          subject: { kind: 'external_submission', id: made.id },
        });
        await applyLeadSourceRules(trx, command, known, lead, LEAD_SOURCE_LIMITS.tagsPerSubmission);
        const filled = await fillCustomFields(trx, command, known, mapped.unmapped);
        await writeIntakeReview(
          trx,
          command,
          known,
          [
            ...contact.review,
            ...(contact.phoneLeft ? [`Phone: "${mapped.phone ?? ''}"`] : []),
            ...mapped.unmapped.filter((field) => !filled.has(field)).map(reviewLine),
          ],
          'form',
        );
        // The visitor is this contact from now on, and so are their earlier page views.
        if (input.visitorId !== null) {
          await trx
            .insertInto('forms.tracking_visitors')
            .values({ business_id: businessId, visitor_id: input.visitorId, contact_id: known })
            .onConflict((conflict) =>
              conflict.columns(['business_id', 'visitor_id']).doUpdateSet({
                contact_id: known,
                last_seen_at: sql<Date>`now()`,
              }),
            )
            .execute();
          const linked = await trx
            .updateTable('forms.tracking_events')
            .set({ contact_id: known })
            .where('visitor_id', '=', input.visitorId)
            .where('contact_id', 'is', null)
            .executeTakeFirst();
          identified = Number(linked.numUpdatedRows);
        }
      }

      await trx
        .insertInto('forms.external_submissions')
        .values({
          business_id: businessId,
          id: made.id,
          contact_id: contactId,
          form_name: formNameOf(event),
          page_host: facts.page.host,
          page_path: facts.page.path,
          // With no contact there is nobody to show the fields to or erase them with, so
          // nothing the visitor typed is kept: only that the form was sent.
          fields: asJson(contactId === null ? [] : mapped.kept),
          lead_source: lead.label,
          client_submission_id: event.clientSubmissionId,
          view_mark: input.mark,
        })
        .execute();
      const row = await trx
        .insertInto('forms.tracking_events')
        .values({
          business_id: businessId,
          kind: 'form_submission',
          page_host: facts.page.host,
          page_path: facts.page.path,
          page_title: titleOf(event),
          referrer_domain: facts.visit.referrerDomain,
          campaign: asJson(campaignOf(facts.visit)),
          visitor_id: input.visitorId,
          session_id: event.sessionId,
          device_type: event.deviceType ?? null,
          form_name: formNameOf(event),
          contact_id: contactId,
          submission_id: made.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await countDay(trx, businessId, facts.page, 'form_submissions');
      if (contactId === null) return;
      if (identified > 0)
        await command.emit({
          type: 'external_tracking.visitor_identified',
          subject: { kind: 'tracking_event', id: row.id },
          payload: { pageViews: identified },
          records: [contactId],
        });
      await command.emit({
        type: 'external_tracking.form_submitted',
        subject: { kind: 'external_submission', id: made.id },
        // What a workflow trigger filters on, and ids: no field value.
        payload: {
          submissionId: made.id,
          contactId,
          formName: formNameOf(event),
          ...triggerFacts(facts.page, facts.visit),
        },
        records: [contactId],
      });
    },
  });

  /** Whether the visitor's id may be kept, by the business's setting and the browser's signal. */
  const visitorOf = (
    setting: string,
    event: PublicTrackingEvent,
    request: TrackingRequest,
  ): string | null => {
    if (event.visitorId === undefined || setting === 'never') return null;
    if (setting === 'unless_opted_out' && request.gpc) return null;
    return event.visitorId;
  };

  return {
    async admit(trackingId, originHeader) {
      if (!/^tk_[a-z0-9]{32}$/.test(trackingId)) return undefined;
      // The one way across businesses: the id names its business, while it is active, and
      // the websites the business lists.
      const {
        rows: [found],
      } = await sql<{ agency_id: string; business_id: string; allowed_domains: string[] }>`
        select agency_id, business_id, allowed_domains
        from private.resolve_tracking(${trackingId})
      `.execute(db);
      if (found === undefined) return undefined;
      const origin = admittedOrigin(originHeader, found.allowed_domains);
      return origin === undefined
        ? undefined
        : { agencyId: found.agency_id, businessId: found.business_id, origin };
    },

    async record(admission, event, request) {
      const { context } = invocation(admission, request.requestId);
      const visitor = visitorSource(request.ipAddress).key;
      const page = { businessId: admission.businessId, visitor };
      const read = await withTenant(db, context, async (trx) => {
        if (!(await holdActiveBusiness(trx, context))) return undefined;
        const settings = await trackingSettingsOf(trx, admission.businessId);
        const visitorId = visitorOf(settings.visitor_ids, event, request);
        const known =
          visitorId === null
            ? undefined
            : await trx
                .selectFrom('forms.tracking_visitors')
                .select('contact_id')
                .where('visitor_id', '=', visitorId)
                .executeTakeFirst();
        return { settings, visitorId, contactId: known?.contact_id ?? null };
      });
      if (read === undefined) return { outcome: 'unavailable' };
      const facts = factsOf(event, admission.origin, read.visitorId);
      if (facts === undefined) return { outcome: 'unavailable' };

      if (event.type === 'page_view') {
        const receipt = { ...RECEIVED, viewToken: issueViewToken(secret, page, now()) };
        if (!read.settings.page_views) return { outcome: 'ok', receipt };
        if (read.contactId === null)
          await withTenant(db, context, (trx) =>
            writePageView(trx, admission.businessId, event, facts, null),
          );
        else
          await runCommand(
            services,
            pageViewCommand,
            {
              businessId: admission.businessId,
              origin: admission.origin,
              page: facts.page,
              event,
              visitorId: read.visitorId,
              contactId: read.contactId,
            },
            invocation(admission, request.requestId),
          );
        return { outcome: 'ok', receipt };
      }

      if (!read.settings.form_capture) return { outcome: 'ok', receipt: RECEIVED };
      const shown = checkViewToken(secret, page, event.viewToken, now());
      if (!shown.accepted)
        return shown.reason === 'too_fast'
          ? { outcome: 'limited', retryAfterSeconds: shown.retryAfterSeconds }
          : { outcome: 'stale' };
      const mapped = mapFields(event.fields);

      const limited = await withTenant(db, context, async (trx) => {
        const counts = await trx
          .selectFrom('forms.external_submissions')
          .select([
            sql<number>`count(*) filter (where view_mark = ${shown.mark})::integer`.as('view'),
            sql<number>`count(*) filter (where submitted_at > now() - interval '1 hour')::integer`.as(
              'hour',
            ),
            sql<number>`count(*) filter (where client_submission_id = ${event.clientSubmissionId})::integer`.as(
              'repeat',
            ),
          ])
          .executeTakeFirstOrThrow();
        if (counts.repeat > 0) return false;
        if (counts.view >= limits.perView) return 60;
        if (counts.hour >= limits.perBusinessHour) return 600;
        return false;
      });
      if (limited !== false) return { outcome: 'limited', retryAfterSeconds: limited };

      if (mapped.email === undefined && mapped.phone === undefined) {
        // Nothing to find a contact by: only that a form was sent, on which page.
        await withTenant(db, context, async (trx) => {
          await trx
            .insertInto('forms.tracking_events')
            .values({
              business_id: admission.businessId,
              kind: 'form_submission',
              page_host: facts.page.host,
              page_path: facts.page.path,
              referrer_domain: facts.visit.referrerDomain,
              campaign: asJson(campaignOf(facts.visit)),
              visitor_id: read.visitorId,
              session_id: event.sessionId,
              device_type: event.deviceType ?? null,
              form_name: formNameOf(event),
              contact_id: read.contactId,
            })
            .execute();
          await countDay(trx, admission.businessId, facts.page, 'form_submissions');
        });
        return { outcome: 'ok', receipt: RECEIVED };
      }

      await runCommand(
        services,
        submit,
        {
          businessId: admission.businessId,
          origin: admission.origin,
          page: facts.page,
          event,
          visitorId: read.visitorId,
          mark: shown.mark,
        },
        invocation(admission, request.requestId),
      );
      return { outcome: 'ok', receipt: RECEIVED };
    },
  };
}
