// Reading a form's submissions, and discarding one that reached no contact. A submission is
// never changed. One attached to a contact is erased with that contact; one that was not
// attached has no contact to be erased with, so the team can delete it.
import { defineCommand, requireBusiness, type Command, type Invocation } from '@repo/commands';
import {
  formConsentOutcomes,
  type FormSubmission,
  type FormSubmissionList,
  type LeadSourceKey,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

/** What a stored submission keeps of its answers, in the order the form asked them. */
export interface StoredAnswers {
  readonly answers: readonly {
    readonly key: string;
    readonly label: string;
    /** Text, a tick, or the keys of the chosen choices of a question that takes several. */
    readonly value: string | boolean | readonly string[] | null;
  }[];
  /** Questions whose answer could not be written to the contact's custom field. */
  readonly skipped: readonly string[];
  /**
   * Each terms box with the wording and link it was shown with, and whether it was ticked.
   * Left out by a submission stored before forms had terms boxes.
   */
  readonly terms?: readonly {
    readonly key: string;
    readonly wording: string;
    readonly linkUrl: string | null;
    readonly accepted: boolean;
  }[];
}

/** What a stored submission keeps of its consent boxes. The proof is in the consent ledger. */
export interface StoredConsents {
  readonly boxes: readonly {
    readonly key: string;
    readonly channel: string;
    readonly wording: string;
    readonly outcome: (typeof formConsentOutcomes)[number];
  }[];
}

const storedAnswers = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: z.union([z.string(), z.boolean(), z.array(z.string())]).nullable(),
    }),
  ),
  skipped: z.array(z.string()),
  terms: z
    .array(
      z.object({
        key: z.string(),
        wording: z.string(),
        linkUrl: z.string().nullable(),
        accepted: z.boolean(),
      }),
    )
    .default([]),
});
const storedConsents = z.object({
  boxes: z.array(
    z.object({
      key: z.string(),
      channel: z.string(),
      wording: z.string(),
      outcome: z.enum(formConsentOutcomes),
    }),
  ),
});
const storedUtm = z.record(z.string(), z.string());

/**
 * The answers of a row. One written before the builder (0008 took any JSON object) is
 * shown as it is: each of its entries as an answer under its own key.
 */
function answersOf(data: unknown): Pick<FormSubmission, 'answers' | 'skippedFields' | 'terms'> {
  const stored = storedAnswers.safeParse(data);
  if (stored.success)
    return {
      answers: stored.data.answers,
      skippedFields: stored.data.skipped,
      terms: stored.data.terms,
    };
  const legacy = typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {};
  return {
    answers: Object.entries(legacy).map(([key, value]: [string, unknown]) => ({
      key,
      label: key,
      value:
        typeof value === 'string' || typeof value === 'boolean'
          ? value
          : value === null
            ? null
            : JSON.stringify(value),
    })),
    skippedFields: [],
    terms: [],
  };
}

function formId(publicId: string): string {
  const id = parsePublicId('form', publicId);
  if (id === undefined) throw new NotFoundError('Form', publicId);
  return id;
}
function submissionId(publicId: string): string {
  const id = parsePublicId('form_submission', publicId);
  if (id === undefined) throw new NotFoundError('Form submission', publicId);
  return id;
}

/**
 * A form's submissions, newest first, as anyone in the business may read them. With
 * `leadSourceRule`, only those that rule named (forms.submissions.lead_source_rule): the
 * rule's key and not the name, so a built-in name reworded later still finds its leads.
 */
export async function readSubmissions(
  trx: DatabaseTransaction,
  invocation: Invocation,
  formPublicId: string,
  input: {
    readonly after?: string | undefined;
    readonly limit: number;
    readonly leadSourceRule?: LeadSourceKey | undefined;
  },
): Promise<FormSubmissionList> {
  requireBusiness(invocation.context);
  const form = await trx
    .selectFrom('forms.forms')
    .select('id')
    .where('id', '=', formId(formPublicId))
    .executeTakeFirst();
  if (form === undefined) throw new NotFoundError('Form', formPublicId);
  let query = trx
    .selectFrom('forms.submissions')
    .select([
      'id',
      'contact_id',
      'contact_outcome',
      'data',
      'consent',
      'utm',
      'origin',
      'page_url',
      'lead_source',
      'lead_source_rule',
      'submitted_at',
      sql<string | null>`host(ip)`.as('ip_address'),
    ])
    .where('form_id', '=', form.id)
    // Ids are UUIDv7: newest first is highest first, and the id is the keyset.
    .orderBy('id', 'desc');
  if (input.after !== undefined) query = query.where('id', '<', submissionId(input.after));
  if (input.leadSourceRule !== undefined)
    query = query.where('lead_source_rule', '=', input.leadSourceRule);
  const found = await query.limit(input.limit + 1).execute();
  const rows = found.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row): FormSubmission => {
      const consents = storedConsents.safeParse(row.consent);
      const utm = storedUtm.safeParse(row.utm);
      const outcome = row.contact_outcome;
      return {
        id: toPublicId('form_submission', row.id),
        submittedAt: row.submitted_at.toISOString(),
        contactId: row.contact_id === null ? null : toPublicId('contact', row.contact_id),
        contactOutcome:
          outcome === 'created' || outcome === 'updated' || outcome === 'unresolved'
            ? outcome
            : null,
        ...answersOf(row.data),
        consents: consents.success ? consents.data.boxes : [],
        origin: row.origin,
        pageUrl: row.page_url,
        ipAddress: row.ip_address,
        utm: utm.success ? utm.data : {},
        leadSource: row.lead_source,
        leadSourceRule: row.lead_source_rule,
      };
    }),
    nextCursor:
      found.length > input.limit && last !== undefined
        ? toPublicId('form_submission', last.id)
        : null,
    canManage: invocation.permissions === 'all' || invocation.permissions.has('forms.manage'),
  };
}

const discardInput = z.strictObject({ id: z.string(), submissionId: z.string() });

/**
 * Deletes a submission that reached no contact. The database allows the application to
 * delete no other (0049); this says why, instead of deleting nothing in silence.
 */
export const discardSubmissionCommand: Command<typeof discardInput, undefined> = defineCommand({
  name: 'forms.discard_submission',
  permission: 'forms.manage',
  input: discardInput,
  async handle(trx, input, command): Promise<undefined> {
    requireBusiness(command.context);
    const row = await trx
      .selectFrom('forms.submissions')
      .select(['id', 'contact_id'])
      .where('form_id', '=', formId(input.id))
      .where('id', '=', submissionId(input.submissionId))
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Form submission', input.submissionId);
    if (row.contact_id !== null)
      throw new ConflictError(
        'This submission belongs to a contact. It is erased when the contact is.',
      );
    await trx.deleteFrom('forms.submissions').where('id', '=', row.id).execute();
    await command.emit({
      type: 'form.submission_discarded',
      subject: { kind: 'form_submission', id: row.id },
      payload: { formId: formId(input.id) },
    });
    return undefined;
  },
});
