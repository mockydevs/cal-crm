// The public side of forms: what a visitor's browser may do with a form key from an allowed
// website, with no sign-in. The transport (apps/server) owns HTTP: the shared rate limit,
// the Origin header, CORS, body limits and generic errors. This file owns everything
// stored.
//
// The rules it keeps:
// - a form answers only while it is published, its business is active, and for a website
//   on its list; each is checked again inside the transaction that stores a submission;
// - a submission is stored once for the id the embed chose, whoever sends it how often;
// - one submission of a form is stored at a time, and the ones behind it wait holding no
//   connection (submit-gate.ts), so a flood on one form cannot take the server's
//   connections from every other business;
// - the contact is made or found by the CRM's own intake, written to by its own commands,
//   and nothing about it is ever sent back: every submission gets the same one-word answer;
// - consent is recorded by the messaging module, with the form, the submission, the
//   wording and the address the server saw as its proof.
//
// Two more websites than a form lists:
// - the CRM's own address shows every published form, on the page it serves for it
//   (`/f/{formKey}`). The owner lists nothing for that: only the CRM serves pages there,
//   so no other website gains anything from it;
// - a preview shows a form's draft to whoever holds a link that someone signed in asked
//   for (preview-token.ts), on the CRM's own address and nowhere else. Sending a preview
//   checks the answers against the draft and writes nothing: no submission, no contact,
//   no consent, no tag, no event, no count.
import { createHash, randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  requireBusiness,
  runCommand,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  FORM_LIMITS,
  formPublicKey,
  LEAD_SOURCE_LIMITS,
  publicFormSubmissionInput,
  type BotChallengeView,
  type FormDefinition,
  type PublicForm,
  type PublicFormReceipt,
  type PublicFormSubmissionInput,
  type RecordField,
} from '@repo/contracts';
import { withTenant, type Database, type DatabaseTransaction, type Json } from '@repo/db';
import { AppError, ConflictError, toPublicId, ValidationError, type Issue } from '@repo/kernel';
import {
  applyLeadSourceRules,
  assignRecordTagCommand,
  decideLeadSourceFor,
  intakeContact,
  readRecordField,
  readArrival,
  recordTouch,
  setRecordFieldCommand,
  taggedAs,
  tagLeadSource,
  writeIntakeReview,
  type LeadSource,
} from '@repo/module-crm';
import {
  allowedOrigin,
  canonicalWebOrigin,
  MAX_ORIGIN_LENGTH,
  readPhoneNumbers,
  recordFormConsent,
} from '@repo/module-messaging';
import { holdActiveBusiness } from '@repo/module-tenancy';
import { sql } from 'kysely';
import { isIP } from 'node:net';
import * as z from 'zod';

import { fillSeconds } from './analytics-rules.js';
import { countTimedSubmission, countView } from './analytics.js';
import { readAnswers, readPage, type Answer, type TickedConsent } from './answers.js';
import { hiddenChoiceValue, publicView, storedDefinition } from './definition.js';
import { evaluateSubmission, type FormSubmissionLimits } from './policy.js';
import { readPreviewToken } from './preview-token.js';
import { createAltchaBotChallenge, type BotChallenge } from './bot-challenge.js';
import { checkRenderToken, issueRenderToken, renderMarkOf } from './render-token.js';
import {
  createSubmitGate,
  GATE_FULL,
  GATE_RETRY_SECONDS,
  type SubmitGateOptions,
} from './submit-gate.js';
import type { StoredAnswers, StoredConsents } from './submissions.js';
import { visitorSource } from './visitor-source.js';

/**
 * A request that passed the gate: the form it names is published, its business is active,
 * and the website it comes from is on the form's list or is the CRM's own. The transport
 * passes it back unchanged and builds nothing from it but the CORS header, which carries
 * `origin`: the stored value, never the header's.
 *
 * With `preview`, it passed the other gate: it holds a link to the form's draft, and comes
 * from the CRM's own address. Such a request is shown the draft and stores nothing.
 */
export interface FormAdmission {
  readonly agencyId: string;
  readonly businessId: string;
  readonly formId: string;
  readonly origin: string;
  readonly preview?: true;
}

/** What the transport says about a request. The address is the one the server saw. */
export interface PublicFormRequest {
  readonly requestId: string;
  readonly ipAddress: string;
  readonly userAgent?: string | undefined;
}

/** Why a request stored nothing. The transport gives each one generic answer. */
export type FormRefusal =
  /** The form is not published, its business is off, or the website is no longer listed. */
  | { readonly outcome: 'unavailable' }
  /** Sent too soon after the form was shown, or the form has stored all it takes for now. */
  | { readonly outcome: 'limited'; readonly retryAfterSeconds: number }
  /** The form was shown too long ago, or has been published again since. Show it again. */
  | { readonly outcome: 'stale' }
  /** The answers do not fit the questions. Each issue points at /values/<key> or /consents/<key>. */
  | { readonly outcome: 'invalid'; readonly issues: readonly [Issue, ...Issue[]] }
  /** The same submission id with different answers. */
  | { readonly outcome: 'changed' };

export interface PublicFormHandlers {
  /** The gate. Undefined for an unknown key, a form that is not published, or a website not listed. */
  readonly admit: (formKey: string, originHeader: unknown) => Promise<FormAdmission | undefined>;
  /**
   * The gate of a preview. Undefined for a link that is not this server's or has run out,
   * a form that is gone or archived, a business that is not active, and any website but
   * the CRM's own.
   */
  readonly admitPreview: (
    previewToken: string,
    originHeader: unknown,
  ) => Promise<FormAdmission | undefined>;
  /**
   * What the form shows, and a token for this showing, bound to the source that asked
   * (visitor-source.ts) and good for one submission.
   */
  readonly form: (
    admission: FormAdmission,
    request: Pick<PublicFormRequest, 'ipAddress'>,
  ) => Promise<{ readonly outcome: 'ok'; readonly form: PublicForm } | FormRefusal>;
  readonly submit: (
    admission: FormAdmission,
    input: PublicFormSubmissionInput,
    request: PublicFormRequest,
  ) => Promise<{ readonly outcome: 'ok'; readonly receipt: PublicFormReceipt } | FormRefusal>;
  /**
   * A bot challenge for one showing of a form that asks for one, bound to the render token
   * it was shown with. 'unavailable' when the form asks for none, 'stale' for a token that
   * is not this form's, this source's, or recent.
   */
  readonly challenge: (
    admission: FormAdmission,
    input: { readonly renderToken: string },
    request: Pick<PublicFormRequest, 'ipAddress'>,
  ) => Promise<{ readonly outcome: 'ok'; readonly challenge: BotChallengeView } | FormRefusal>;
}

export interface PublicFormOptions {
  readonly db: Database;
  /**
   * Keys the proof of when a form was shown. The server passes its public intake secret
   * (PUBLIC_INTAKE_SECRET); the digests are labelled, so they are no use anywhere else.
   */
  readonly secret: string;
  /**
   * The install's own public address. Its origin shows every published form (the page the
   * CRM serves for a form) and is the only one a preview answers. Left out, or not a
   * secure address, forms answer only the websites they list and there are no previews.
   */
  readonly publicUrl?: string | undefined;
  /** The clock, in milliseconds. Tests pass their own. */
  readonly now?: () => number;
  /** Told when a submission is dropped without being stored, for the server's log. */
  readonly onDropped?: (reason: 'trap') => void;
  /**
   * How many submissions of one form may wait, in this process, for the one being stored
   * (submit-gate.ts). One past that is told to wait and send again.
   */
  readonly gate?: SubmitGateOptions;
  /** A form's limits (policy.ts); FORM_LIMITS by default. Tests pass smaller ones. */
  readonly limits?: Partial<FormSubmissionLimits>;
  /**
   * The bot protection a form may ask for: ALTCHA's proof of work keyed by secret by
   * default (bot-challenge.ts). Tests pass one that asks for less work.
   */
  readonly bot?: BotChallenge;
}

const RECEIVED: PublicFormReceipt = { status: 'received' };

interface LiveForm {
  readonly id: string;
  readonly name: string;
  readonly allowedOrigins: readonly string[];
  readonly definition: FormDefinition;
  readonly publishedAt: Date;
}

/** The CRM's own origin, as a browser writes it, or undefined when it has no secure one. */
export function ownOrigin(publicUrl: string | undefined): string | undefined {
  if (publicUrl === undefined || !URL.canParse(publicUrl)) return undefined;
  return canonicalWebOrigin(new URL(publicUrl).origin);
}

/**
 * The form while it may answer: published, with a definition the builder wrote. With
 * `lock`, its row is held until the transaction ends, so submissions of one form are
 * stored one after the other (each counts the ones before it, and finds a repeat of
 * itself), and a publish, unpublish or archive either commits first, and is seen here, or
 * waits. The caller holds the business already, as the lock order asks.
 */
async function liveForm(
  trx: DatabaseTransaction,
  formId: string,
  lock: boolean,
): Promise<LiveForm | undefined> {
  const query = trx
    .selectFrom('forms.forms')
    .select(['id', 'name', 'allowed_origins', 'published_definition', 'published_at'])
    .where('id', '=', formId)
    .where('status', '=', 'published');
  const row = await (lock ? query.forNoKeyUpdate() : query).executeTakeFirst();
  if (row === undefined) return undefined;
  // A definition the builder did not write (a row from before 0049) serves nothing. The
  // database keeps the time with the definition, so a published form has both.
  const definition = storedDefinition(row.published_definition);
  const publishedAt = row.published_at;
  if (definition === undefined || publishedAt === null) return undefined;
  return {
    id: row.id,
    name: row.name,
    allowedOrigins: row.allowed_origins,
    definition,
    publishedAt,
  };
}

/**
 * A form's draft, for a preview: whatever its status but archived, as the builder last
 * saved it. Undefined when the draft is not one the builder wrote.
 */
async function draftForm(
  trx: DatabaseTransaction,
  formId: string,
): Promise<FormDefinition | undefined> {
  const row = await trx
    .selectFrom('forms.forms')
    .select(['definition'])
    .where('id', '=', formId)
    .where('status', '<>', 'archived')
    .executeTakeFirst();
  return row === undefined ? undefined : storedDefinition(row.definition);
}

/** When a draft is shown, for the proof a preview hands back: a draft has no publication. */
const NEVER_PUBLISHED = new Date(0);

const gate = z.strictObject({
  formId: z.uuid(),
  /** The stored origin the request matched; never the header's own text. */
  origin: z.string().min(1).max(MAX_ORIGIN_LENGTH),
});

const submitInput = gate.extend({
  submission: publicFormSubmissionInput,
  ipAddress: z
    .string()
    .max(45)
    .refine((value) => isIP(value) !== 0),
  userAgent: z.string().max(500).optional(),
});

/** The same for the same answers, whatever order their keys were sent in. */
function requestDigest(submission: PublicFormSubmissionInput): string {
  const sorted = (entries: Readonly<Record<string, unknown>>) =>
    // An object's keys are distinct, so two are never equal.
    Object.entries(entries).sort(([left], [right]) => (left < right ? -1 : 1));
  return createHash('sha256')
    .update(
      JSON.stringify([
        sorted(submission.values),
        sorted(submission.consents),
        submission.pageUrl ?? null,
        // How the visit began is part of what was sent: the same id with another arrival
        // is another request. Left out when there is none, so a submission from before
        // this was read has the digest it had.
        ...(submission.first === undefined
          ? []
          : [
              [
                submission.first.pageUrl,
                submission.first.referrer ?? null,
                submission.first.at ?? null,
              ],
            ]),
      ]),
    )
    .digest('hex');
}

const valueOf = (answers: readonly Answer[], attribute: string): string | undefined => {
  const answer = answers.find(
    (each) => each.target.kind === 'contact' && each.target.attribute === attribute,
  );
  return typeof answer?.value === 'string' ? answer.value : undefined;
};

type Resolved =
  | {
      readonly outcome: 'created' | 'updated';
      readonly contactId: string;
      /** What the contact did not take from the details, for the review note. */
      readonly review: readonly string[];
    }
  | { readonly outcome: 'unresolved' }
  | { readonly outcome: 'invalid'; readonly issues: readonly [Issue, ...Issue[]] };

/**
 * Makes or finds the contact through the CRM's intake, inside a savepoint: whatever the
 * intake wrote before it refused is undone, and the submission goes on.
 *
 * The intake never refuses a lead for who holds its details: two contacts, or one in the
 * trash, still give a contact. What is left `unresolved` is only details that kept changing
 * under it, and the submission is kept for the team to read. Nothing of this is said to the
 * visitor: it would tell anyone who types an address something about the contact that holds
 * it. The business's SMS lines are its own numbers, never a match key.
 */
async function resolveContact(
  trx: DatabaseTransaction,
  command: CommandContext,
  answers: readonly Answer[],
  source: string | undefined,
): Promise<Resolved> {
  const email = valueOf(answers, 'email');
  const phone = valueOf(answers, 'phone');
  const firstName = valueOf(answers, 'firstName');
  const lastName = valueOf(answers, 'lastName');
  const dateOfBirth = valueOf(answers, 'dateOfBirth');
  const ownPhones = (await readPhoneNumbers(trx)).map((number) => number.e164);
  await sql`savepoint form_contact`.execute(trx);
  try {
    const contact = await intakeContact(
      trx,
      {
        // A name left blank is left out, so a contact that has one keeps it. The same
        // goes for a date of birth.
        ...(firstName === undefined ? {} : { firstName }),
        ...(lastName === undefined ? {} : { lastName }),
        ...(dateOfBirth === undefined ? {} : { dateOfBirth }),
        emails: email === undefined ? [] : [email],
        phones: phone === undefined ? [] : [phone],
        // Written by the intake only to a contact that has no source yet.
        ...(source === undefined ? {} : { source }),
      },
      command,
      undefined,
      { ownPhones, deferReview: true },
    );
    await sql`release savepoint form_contact`.execute(trx);
    return {
      outcome: contact.created ? 'created' : 'updated',
      contactId: contact.contactId,
      review: contact.review,
    };
  } catch (error) {
    await sql`rollback to savepoint form_contact`.execute(trx);
    await sql`release savepoint form_contact`.execute(trx);
    if (error instanceof ConflictError) return { outcome: 'unresolved' };
    if (!(error instanceof ValidationError)) throw error;
    // The CRM's own check of the details: the country's rules for a phone number, and so
    // on. Each problem is put by the question it came from, in this file's own words.
    // The form's own check of an email address is the CRM's, so what is left to refuse is a
    // phone number: the message goes by the question it came from. Anything else (a form
    // that asks for no address at all, which publishing refuses) is said once, in general.
    const keyOf = (attribute: string): string | undefined =>
      answers.find((each) => each.target.kind === 'contact' && each.target.attribute === attribute)
        ?.key;
    const phoneKey = keyOf('phone');
    const bornKey = keyOf('dateOfBirth');
    const placed = (issue: Issue): Issue => {
      if (issue.path.startsWith('/phones') && phoneKey !== undefined)
        return {
          path: `/values/${phoneKey}`,
          code: 'invalid_phone',
          message: 'Enter a phone number, with its country code.',
        };
      // The CRM takes no date of birth after today.
      if (issue.path === '/dateOfBirth' && bornKey !== undefined)
        return {
          path: `/values/${bornKey}`,
          code: 'invalid_date',
          message: 'Enter a date that is not in the future.',
        };
      return { path: '', code: 'invalid', message: 'Check your details and try again.' };
    };
    const [first, ...rest] = error.issues;
    return { outcome: 'invalid', issues: [placed(first), ...rest.map(placed)] };
  }
}

const UNKNOWN_HIDDEN_CHOICE: Issue = {
  path: '',
  code: 'unknown_choice',
  message: "The hidden answer names none of the contact field's choices.",
};

/**
 * Writes the answers that fill custom fields, each in a savepoint, and says which could
 * not be written. A field archived or deleted since the form was published, or a value
 * the CRM refuses, must not lose a lead: the answer stays with the submission.
 */
/**
 * The value an answer gives its field, or undefined for a hidden question whose text names
 * none of the field's choices.
 */
function fieldValueOf(
  answer: Answer & { readonly value: NonNullable<Answer['value']> },
  current: RecordField,
): string | boolean | string[] | undefined {
  const { valueType, options } = current.definition;
  // A hidden question's text names a choice by key or label.
  if (
    answer.type === 'hidden' &&
    typeof answer.value === 'string' &&
    (valueType === 'single_choice' || valueType === 'multi_choice')
  )
    return hiddenChoiceValue(valueType, options, answer.value);
  // Several choices go as a list of their own; the rest as they are.
  return typeof answer.value === 'object' ? [...answer.value] : answer.value;
}

/** A field value as text, to compare and to show the team: choices in any order. */
function valueText(value: RecordField['value'] | string[] | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return [...(value as readonly unknown[])].map(String).sort().join(', ');
  // A text box list: each box's text under its key, in key order.
  if (typeof value === 'object')
    return Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, text]) => `${key}: ${text}`)
      .join('; ');
  return String(value);
}

/**
 * The answers that would replace a value the found contact already has: they are not
 * written, and each becomes a line of the review note. Read before anything this submission
 * writes, so a lead source rule's value is not mistaken for the contact's own.
 */
async function heldAnswers(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string,
  answers: readonly Answer[],
): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  const record = toPublicId('contact', contactId);
  for (const answer of answers) {
    if (answer.target.kind !== 'field' || answer.value === null) continue;
    await sql`savepoint form_field_read`.execute(trx);
    try {
      const current = await readRecordField(trx, command, record, answer.target.fieldId);
      await sql`release savepoint form_field_read`.execute(trx);
      const has = valueText(current.value);
      const sent = valueText(fieldValueOf({ ...answer, value: answer.value }, current));
      if (has !== '' && sent !== '' && has !== sent)
        held.set(
          answer.key,
          `${answer.label} given: "${sent}" (the contact has "${has}"). It was not applied.`,
        );
    } catch (error) {
      await sql`rollback to savepoint form_field_read`.execute(trx);
      await sql`release savepoint form_field_read`.execute(trx);
      // A field gone since publishing: fillFields skips it, as it always has.
      if (!(error instanceof AppError)) throw error;
    }
  }
  return held;
}

async function fillFields(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string,
  answers: readonly Answer[],
  held: ReadonlyMap<string, string>,
): Promise<string[]> {
  const skipped: string[] = [];
  const record = toPublicId('contact', contactId);
  for (const answer of answers) {
    // A question left empty changes nothing: a form never clears what the contact has.
    if (answer.target.kind !== 'field' || answer.value === null) continue;
    // Nor does it replace what a contact it found already has.
    if (held.has(answer.key)) {
      skipped.push(answer.key);
      continue;
    }
    await sql`savepoint form_field`.execute(trx);
    try {
      const current = await readRecordField(trx, command, record, answer.target.fieldId);
      // A hidden question that names none of the choices is not written, and stays with
      // the submission.
      const value = fieldValueOf({ ...answer, value: answer.value }, current);
      if (value === undefined) throw new ValidationError([UNKNOWN_HIDDEN_CHOICE]);
      await setRecordFieldCommand.handle(
        trx,
        { id: record, fieldId: answer.target.fieldId, value, revision: current.revision },
        command,
      );
      await sql`release savepoint form_field`.execute(trx);
    } catch (error) {
      await sql`rollback to savepoint form_field`.execute(trx);
      await sql`release savepoint form_field`.execute(trx);
      if (!(error instanceof AppError)) throw error;
      skipped.push(answer.key);
    }
  }
  return skipped;
}

/**
 * Adds the form's tags to the contact through the CRM's own command, so each one is on the
 * timeline with the form as its source and automations see it. Each in a savepoint: a tag
 * deleted since the form was published is skipped, and the lead is kept. A tag the contact
 * already carries is left as it is, by the command.
 */
async function addTags(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string,
  tagIds: readonly string[],
): Promise<void> {
  const record = toPublicId('contact', contactId);
  for (const tagId of tagIds) {
    await sql`savepoint form_tag`.execute(trx);
    try {
      await assignRecordTagCommand.handle(trx, { id: record, tagId }, command);
      await sql`release savepoint form_tag`.execute(trx);
    } catch (error) {
      await sql`rollback to savepoint form_tag`.execute(trx);
      await sql`release savepoint form_tag`.execute(trx);
      if (!(error instanceof AppError)) throw error;
    }
  }
}

/**
 * The source a submission gives a contact that has none: how the visitor arrived, by the
 * lead source rules; or a name the business wrote, which beats the rules; or the form's
 * name; or nothing.
 */
export function sourceOf(
  form: Pick<LiveForm, 'name' | 'definition'>,
  lead: Pick<LeadSource, 'label'>,
): string | undefined {
  const source = form.definition.contactActions?.source;
  if (source === undefined || source.kind === 'none') return undefined;
  if (source.kind === 'arrived') return lead.label;
  return source.kind === 'text' ? source.text : form.name.trim();
}

/**
 * The tags one submission adds, at most ten: the form's own, in their order, and then,
 * when the form asks for it and there is room, the tag of the lead source.
 */
export function tagsOf(definition: FormDefinition): {
  readonly tagIds: readonly string[];
  readonly bySource: boolean;
} {
  const actions = definition.contactActions;
  const tagIds = (actions?.tagIds ?? []).slice(0, LEAD_SOURCE_LIMITS.tagsPerSubmission);
  return {
    tagIds,
    bySource: actions?.tagBySource === true && tagIds.length < LEAD_SOURCE_LIMITS.tagsPerSubmission,
  };
}

/**
 * Adds the tag named after the lead source ("Source: Google Ads"), in a savepoint as the
 * form's own tags are: whatever stops it, the lead is kept.
 */
async function addSourceTag(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string,
  lead: LeadSource,
): Promise<void> {
  await sql`savepoint form_source_tag`.execute(trx);
  try {
    await tagLeadSource(trx, command, contactId, lead);
    await sql`release savepoint form_source_tag`.execute(trx);
  } catch (error) {
    await sql`rollback to savepoint form_source_tag`.execute(trx);
    await sql`release savepoint form_source_tag`.execute(trx);
    if (!(error instanceof AppError)) throw error;
  }
}

interface Proof {
  readonly formId: string;
  readonly submissionId: string;
  readonly ipAddress: string;
  readonly pageUrl: string | null;
  readonly userAgent: string | undefined;
}

async function recordConsents(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string | undefined,
  answers: readonly Answer[],
  consents: readonly TickedConsent[],
  proof: Proof,
): Promise<StoredConsents['boxes']> {
  const boxes: StoredConsents['boxes'][number][] = [];
  for (const consent of consents) {
    const box = { key: consent.key, channel: consent.channel, wording: consent.wording };
    // The address this submission gave for the channel: consent is for that, not for
    // whatever else the contact already holds.
    const address = valueOf(answers, consent.channel === 'email' ? 'email' : 'phone');
    if (!consent.ticked) boxes.push({ ...box, outcome: 'not_ticked' });
    else if (contactId === undefined || address === undefined)
      boxes.push({ ...box, outcome: 'no_address' });
    else
      boxes.push({
        ...box,
        outcome: await recordFormConsent(trx, command, {
          contactId,
          channel: consent.channel,
          address,
          wording: consent.wording,
          formId: proof.formId,
          submissionId: proof.submissionId,
          ipAddress: proof.ipAddress,
          ...(proof.pageUrl === null ? {} : { pageUrl: proof.pageUrl }),
          ...(proof.userAgent === undefined ? {} : { userAgent: proof.userAgent }),
        }),
      });
  }
  return boxes;
}

const asJson = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;

export function createPublicFormHandlers(options: PublicFormOptions): PublicFormHandlers {
  const { db, secret } = options;
  const now = options.now ?? (() => Date.now());
  const services = { db, authorize: allowEveryone };
  const gate = createSubmitGate(options.gate);
  const own = ownOrigin(options.publicUrl);
  const limits = { ...FORM_LIMITS, ...options.limits };
  const bot = options.bot ?? createAltchaBotChallenge(secret);
  // Each showing this process signs gets a moment of its own, a millisecond on from the last
  // when two fall together: two visitors behind one address loading the form at once get
  // two tokens, each good for its own submission.
  let lastShown = 0;
  const shownNow = (): number => {
    lastShown = Math.max(Math.trunc(now()), lastShown + 1);
    return lastShown;
  };
  /** The stored origin a request's Origin is: one the form lists, or the CRM's own. */
  const admitted = (form: LiveForm, origin: unknown): string | undefined =>
    allowedOrigin(origin, own === undefined ? form.allowedOrigins : [...form.allowedOrigins, own]);
  // Every write is made as the form: its id is who acted, in events, audit and the
  // sources of the values it filled. It has no signed-in user's powers.
  const invocation = (admission: FormAdmission, correlationId: string): Invocation => ({
    context: {
      agencyId: admission.agencyId,
      businessId: admission.businessId,
      actorKind: 'form',
      actorId: admission.formId,
      correlationId: z.uuid().parse(correlationId),
    },
    // No ip and no userAgent: the audit log keeps neither for a visitor. The address is
    // kept where it is proof: with the submission, and with a consent it gave.
    permissions: 'all',
  });

  const submit = defineCommand({
    name: 'forms.submit',
    permission: 'contacts.manage',
    input: submitInput,
    // Identifiers only: no answer and no address reaches the audit log.
    audit: (input) => ({
      formId: input.formId,
      origin: input.origin,
      clientSubmissionId: input.submission.clientSubmissionId,
    }),
    async handle(
      trx,
      input,
      command,
    ): Promise<{ outcome: 'ok'; receipt: PublicFormReceipt } | FormRefusal> {
      const businessId = requireBusiness(command.context);
      // The business, then the form (forms.ts takes them in the same order). Share-locked:
      // a business switched off meanwhile commits first, and is seen, or waits.
      if (!(await holdActiveBusiness(trx, command.context))) return { outcome: 'unavailable' };
      const form = await liveForm(trx, input.formId, true);
      if (form === undefined || admitted(form, input.origin) === undefined)
        return { outcome: 'unavailable' };
      const { submission } = input;

      // A repeat of a stored submission is answered as the first was, and stores nothing.
      const digest = requestDigest(submission);
      const repeated = await trx
        .selectFrom('forms.submissions')
        .select('request_digest')
        .where('form_id', '=', form.id)
        .where('client_submission_id', '=', submission.clientSubmissionId)
        .executeTakeFirst();
      if (repeated !== undefined)
        return repeated.request_digest === digest
          ? { outcome: 'ok', receipt: RECEIVED }
          : { outcome: 'changed' };

      // Who sent it, as far as the server can tell: the address it saw, widened to what one
      // visitor holds (visitor-source.ts). What is refused is counted per source.
      const source = visitorSource(input.ipAddress);
      // The database's clock, so every app instance counts the same hour. An aggregate
      // with no grouping is always one row.
      const hour = sql<boolean>`submitted_at > clock_timestamp() - interval '1 hour'`;
      const mine = sql<boolean>`ip <<= ${source.network}::inet`;
      const facts = await trx
        .selectFrom('forms.submissions')
        .select([
          sql<Date>`clock_timestamp()`.as('now'),
          sql<string>`count(*) filter (where ${hour})`.as('hour'),
          sql<string>`count(*)`.as('day'),
          sql<Date | null>`min(submitted_at) filter (where ${hour})`.as('oldest_hour'),
          sql<Date | null>`min(submitted_at)`.as('oldest_day'),
          sql<string>`count(*) filter (where ${hour} and ${mine})`.as('source_hour'),
          sql<string>`count(*) filter (where ${mine})`.as('source_day'),
          sql<Date | null>`min(submitted_at) filter (where ${hour} and ${mine})`.as(
            'source_oldest_hour',
          ),
          sql<Date | null>`min(submitted_at) filter (where ${mine})`.as('source_oldest_day'),
        ])
        .where('business_id', '=', businessId)
        .where('form_id', '=', form.id)
        .where('submitted_at', '>', sql<Date>`clock_timestamp() - interval '1 day'`)
        .executeTakeFirstOrThrow();
      const decision = evaluateSubmission(
        {
          form: {
            hour: { stored: Number(facts.hour), oldest: facts.oldest_hour },
            day: { stored: Number(facts.day), oldest: facts.oldest_day },
          },
          source: {
            hour: { stored: Number(facts.source_hour), oldest: facts.source_oldest_hour },
            day: { stored: Number(facts.source_day), oldest: facts.source_oldest_day },
          },
          now: facts.now,
        },
        limits,
      );
      if (!decision.allowed)
        return { outcome: 'limited', retryAfterSeconds: decision.retryAfterSeconds };

      // The token must be this form's, shown to this source, long enough ago (longer while
      // the form is busy), and not spent on a submission already.
      const taken = now();
      const shown = checkRenderToken(
        secret,
        { formId: form.id, publishedAt: form.publishedAt, visitor: source.key },
        submission.renderToken,
        taken,
        { minFillSeconds: decision.minFillSeconds, renderHours: limits.renderHours },
      );
      if (!shown.accepted)
        return shown.reason === 'too_fast'
          ? { outcome: 'limited', retryAfterSeconds: shown.retryAfterSeconds }
          : { outcome: 'stale' };
      const spent = await trx
        .selectFrom('forms.submissions')
        .select('id')
        .where('business_id', '=', businessId)
        .where('form_id', '=', form.id)
        .where('render_mark', '=', shown.mark)
        .executeTakeFirst();
      // One showing, one lead: the embed shows the form again, with what was typed.
      if (spent !== undefined) return { outcome: 'stale' };
      // A form that asks for bot protection takes only a proof solved for this showing.
      // Without one, or with a wrong or expired one, the embed shows the form again, solves
      // a new challenge and sends what was typed.
      if (
        form.definition.botProtection === 'altcha' &&
        !(await bot.verify(shown.mark, submission.botProof))
      )
        return { outcome: 'stale' };

      const read = readAnswers(form.definition, submission);
      if (!read.ok) return { outcome: 'invalid', issues: read.issues };
      // Where the visitor came from: the labels and click ids of the page's address, read
      // as the page itself is (only from the website the request was admitted from), and
      // the host of the site before it. Then the lead source those facts give: the
      // business's own rules first, which is one read of at most 50 small rows by their
      // index, then the rules that ship in the code, all in memory. Nothing waits on
      // anything outside this transaction. When the page's own address says nothing of the
      // arrival and the visit began on another page of the same website, the facts are that
      // first page's (readArrival: stage 2 of the lead source plan).
      const arrival = readArrival(
        { pageUrl: submission.pageUrl, referrer: submission.referrer, first: submission.first },
        { pageOrigin: input.origin, now: facts.now.getTime() },
      );
      const { visit } = arrival;
      const lead = await decideLeadSourceFor(trx, businessId, {
        medium: 'form',
        visit,
        pageUrl: arrival.pageUrl,
        address: arrival.address,
      });
      const contact = await resolveContact(trx, command, read.answers, sourceOf(form, lead));
      if (contact.outcome === 'invalid') return contact;
      const contactId = contact.outcome === 'unresolved' ? undefined : contact.contactId;

      // The submission's id comes first: the consent proof names it, and the row itself is
      // written last and never changed.
      const made = await trx.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow();
      const page = readPage(submission.pageUrl, input.origin);
      // The touch is kept on the contact, never without one: a click id identifies a visit.
      // It names the same lead source, by the same rules.
      if (contactId !== undefined)
        await recordTouch(trx, businessId, {
          contactId,
          medium: 'form',
          visit,
          page: { url: arrival.pageUrl, carried: arrival.carried },
          decision: lead,
          subject: { kind: 'form_submission', id: made.id },
        });
      // The form's own tags first, then the lead source's, then what is left of the ten for
      // the tags of the business's matching rules. A rule's field values are written before
      // the visitor's own answers, so an answer to a question that fills the same field is
      // what the contact keeps.
      const tags = tagsOf(form.definition);
      // What a contact this submission found already has stays: read before the rules write
      // anything. A contact it made is all the visitor's own.
      const held =
        contact.outcome === 'updated'
          ? await heldAnswers(trx, command, contact.contactId, read.answers)
          : new Map<string, string>();
      if (contactId !== undefined)
        await applyLeadSourceRules(
          trx,
          command,
          contactId,
          lead,
          LEAD_SOURCE_LIMITS.tagsPerSubmission - tags.tagIds.length - (tags.bySource ? 1 : 0),
        );
      const skipped =
        contactId === undefined
          ? []
          : await fillFields(trx, command, contactId, read.answers, held);
      if (contactId !== undefined) {
        await addTags(trx, command, contactId, tags.tagIds);
        if (tags.bySource) await addSourceTag(trx, command, contactId, taggedAs(lead));
      }
      // One note for the team of everything the contact did not take.
      if (contact.outcome === 'created' || contact.outcome === 'updated')
        await writeIntakeReview(
          trx,
          command,
          contact.contactId,
          [...contact.review, ...held.values()],
          'form',
        );
      const boxes = await recordConsents(trx, command, contactId, read.answers, read.consents, {
        formId: form.id,
        submissionId: made.id,
        ipAddress: input.ipAddress,
        pageUrl: page.pageUrl,
        userAgent: input.userAgent,
      });
      const stored: StoredAnswers = {
        answers: read.answers.map(({ key, label, value }) => ({ key, label, value })),
        skipped,
        terms: read.terms,
      };
      await trx
        .insertInto('forms.submissions')
        .values({
          business_id: businessId,
          id: made.id,
          form_id: form.id,
          contact_id: contactId ?? null,
          contact_outcome: contact.outcome,
          data: asJson(stored),
          consent: asJson({ boxes } satisfies StoredConsents),
          // The campaign labels of the arrival the lead source was read from: the first
          // page's when they were carried here, else this page's own.
          utm: asJson(
            arrival.carried ? readPage(submission.first?.pageUrl, input.origin).utm : page.utm,
          ),
          ip: input.ipAddress,
          user_agent: input.userAgent ?? null,
          client_submission_id: submission.clientSubmissionId,
          request_digest: digest,
          origin: input.origin,
          page_url: page.pageUrl,
          lead_source: lead.label,
          lead_source_rule: lead.rule,
          render_mark: shown.mark,
          submitted_at: facts.now,
        })
        .execute();
      await command.emit({
        type: 'form.submitted',
        subject: { kind: 'form_submission', id: made.id },
        // Identifiers only: events are kept forever and read by automations and webhooks.
        payload: {
          formId: form.id,
          submissionId: made.id,
          ...(contactId === undefined ? {} : { contactId }),
        },
        records: contactId === undefined ? [] : [contactId],
      });
      // How long this visitor took, by the server's own two readings of its clock: when it
      // signed the proof and when it checked it.
      await countTimedSubmission(trx, businessId, form.id, fillSeconds(shown.shownAt, taken));
      return { outcome: 'ok', receipt: RECEIVED };
    },
  });

  /** The context a form's own business is read in, before any request is admitted. */
  const contextOf = (form: Omit<FormAdmission, 'origin'>) =>
    invocation({ ...form, origin: '' }, randomUUID()).context;

  return {
    async admit(formKey, originHeader) {
      if (!formPublicKey.safeParse(formKey).success) return undefined;
      // The one way across businesses: a key names its form, its business and its agency,
      // and only while the form is published and the business active.
      const {
        rows: [found],
      } = await sql<{ agency_id: string; business_id: string; form_id: string }>`
        select agency_id, business_id, form_id from private.resolve_form(${formKey})
      `.execute(db);
      if (found === undefined) return undefined;
      const admission = {
        agencyId: found.agency_id,
        businessId: found.business_id,
        formId: found.form_id,
      };
      const form = await withTenant(db, contextOf(admission), (trx) =>
        liveForm(trx, found.form_id, false),
      );
      if (form === undefined) return undefined;
      const origin = admitted(form, originHeader);
      return origin === undefined ? undefined : { ...admission, origin };
    },

    async admitPreview(previewToken, originHeader) {
      // Only the page the CRM serves shows a draft: any other website is refused before
      // the link is even read.
      const origin = own === undefined ? undefined : allowedOrigin(originHeader, [own]);
      if (origin === undefined) return undefined;
      const named = readPreviewToken(secret, previewToken, now());
      if (named === undefined) return undefined;
      // The link names its form's business: the draft is read there, under row-level
      // security, and only while that business is active.
      const context = contextOf(named);
      const draft = await withTenant(db, context, async (trx) =>
        (await holdActiveBusiness(trx, context)) ? draftForm(trx, named.formId) : undefined,
      );
      return draft === undefined ? undefined : { ...named, origin, preview: true };
    },

    form: (admission, request) => {
      const { context } = invocation(admission, randomUUID());
      const visitor = visitorSource(request.ipAddress).key;
      return withTenant(db, context, async (trx) => {
        if (!(await holdActiveBusiness(trx, context))) return { outcome: 'unavailable' };
        if (admission.preview === true) {
          const draft = await draftForm(trx, admission.formId);
          if (draft === undefined) return { outcome: 'unavailable' };
          return {
            outcome: 'ok',
            form: publicView(
              draft,
              issueRenderToken(
                secret,
                { formId: admission.formId, publishedAt: NEVER_PUBLISHED, visitor },
                shownNow(),
              ),
            ),
          };
        }
        const form = await liveForm(trx, admission.formId, false);
        if (form === undefined || admitted(form, admission.origin) === undefined)
          return { outcome: 'unavailable' };
        await countView(trx, admission.businessId, form.id);
        return {
          outcome: 'ok',
          form: publicView(
            form.definition,
            issueRenderToken(
              secret,
              { formId: form.id, publishedAt: form.publishedAt, visitor },
              shownNow(),
            ),
          ),
        };
      });
    },

    challenge: (admission, input, request) => {
      const { context } = invocation(admission, randomUUID());
      const visitor = visitorSource(request.ipAddress).key;
      return withTenant(db, context, async (trx) => {
        if (!(await holdActiveBusiness(trx, context))) return { outcome: 'unavailable' };
        let shownAs: { definition: FormDefinition; publishedAt: Date } | undefined;
        if (admission.preview === true) {
          const draft = await draftForm(trx, admission.formId);
          shownAs =
            draft === undefined ? undefined : { definition: draft, publishedAt: NEVER_PUBLISHED };
        } else {
          const form = await liveForm(trx, admission.formId, false);
          shownAs =
            form === undefined || admitted(form, admission.origin) === undefined ? undefined : form;
        }
        if (shownAs?.definition.botProtection !== 'altcha') return { outcome: 'unavailable' };
        // Bound to the showing the visitor holds, which it may ask for at once: the pause a
        // person takes is checked when the form is sent.
        const mark = renderMarkOf(
          secret,
          { formId: admission.formId, publishedAt: shownAs.publishedAt, visitor },
          input.renderToken,
          now(),
          limits.renderHours,
        );
        if (mark === undefined) return { outcome: 'stale' };
        return { outcome: 'ok', challenge: await bot.issue(mark) };
      });
    },

    async submit(admission, input, request) {
      if (admission.preview === true) {
        // A preview is a rehearsal: the answers are read against the draft as a real
        // submission's are against the published form, and nothing is written. The proof
        // of time, the hidden field and the form's limits guard what is stored, and
        // nothing is.
        const { context } = invocation(admission, request.requestId);
        return withTenant(db, context, async (trx) => {
          if (!(await holdActiveBusiness(trx, context))) return { outcome: 'unavailable' };
          const draft = await draftForm(trx, admission.formId);
          if (draft === undefined) return { outcome: 'unavailable' };
          const read = readAnswers(draft, input);
          return read.ok
            ? { outcome: 'ok', receipt: RECEIVED }
            : { outcome: 'invalid', issues: read.issues };
        });
      }
      // Anything in the field people cannot see means a program filled the form. It gets
      // the answer a person gets, and nothing is stored or looked up.
      if (input.trap !== '') {
        options.onDropped?.('trap');
        return { outcome: 'ok', receipt: RECEIVED };
      }
      const stored = await gate(admission.formId, () =>
        runCommand(
          services,
          submit,
          {
            formId: admission.formId,
            origin: admission.origin,
            submission: input,
            ipAddress: request.ipAddress,
            ...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
          },
          invocation(admission, request.requestId),
        ),
      );
      // Too many of this form's submissions are waiting already: this one waits on the
      // visitor's page instead, and is sent again under the same id.
      return stored === GATE_FULL
        ? { outcome: 'limited', retryAfterSeconds: GATE_RETRY_SECONDS }
        : stored;
    },
  };
}
