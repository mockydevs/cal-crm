// Applying a batch of an import's rows. One command, one transaction, for each batch: the
// rows' changes, what became of each row (imports.job_rows) and the import's place in the
// file (processed_count) are written together or not at all. So a worker that dies, or a
// batch that fails, leaves nothing half done, and the rows it had in hand are applied by
// the next run exactly once.
//
// Each row is written by the CRM's own commands, as the import (actor kind `import`, its
// id the import's): contact.create or contact.update, tag.assign and field.value.set, with
// the events and the checks each has when a person runs it. A row is all or nothing: it
// has a savepoint of its own, and whatever refuses any part of it undoes the whole row and
// records why.
import { defineCommand, requireBusiness, type CommandContext } from '@repo/commands';
import {
  createContactInput,
  parseInput,
  updateContactCommandInput,
  type ImportRowIssue,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { AppError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import {
  createContactCommand,
  lockContact,
  lockContactsInOrder,
  readContact,
  updateContactCommand,
} from '../contacts/contacts.js';
import { readRecordField } from '../fields/value-read.js';
import { setRecordFieldCommand } from '../fields/value-writes.js';
import { assignRecordTagCommand } from '../tags/assignments.js';
import {
  loadPlanContext,
  planRow,
  type EarlierRows,
  type PlanContext,
  type PlannedContact,
  type RowPlan,
} from './plan.js';
import { planOf } from './store.js';

/** The most rows one batch holds: what one transaction applies. */
export const MAX_IMPORT_BATCH = 500;

// Kept with the change in no event, and asked for by the contact's own contract.
const DO_NOT_CONTACT_REASON = 'Marked do not contact in the file this import read.';

export type RowOutcome = 'created' | 'updated' | 'skipped' | 'failed';

export const applyImportRowsInput = z.strictObject({
  importId: z.uuid(),
  /** The run of the job these rows come from; another run's rows are not applied. */
  runner: z.uuid(),
  /** How many rows of data come before these in the file. */
  offset: z.int().min(0),
  rows: z
    .array(z.strictObject({ row: z.int().min(2), cells: z.array(z.string()) }))
    .min(1)
    .max(MAX_IMPORT_BATCH),
});

export type ApplyResult =
  | ({ readonly state: 'applied' } & Readonly<Record<RowOutcome, number>>)
  /** Someone asked for the import to stop: these rows were not applied. */
  | { readonly state: 'cancelled' }
  /** The import has ended, or another run of the job has taken it up. */
  | { readonly state: 'superseded' };

type Issues = readonly [ImportRowIssue, ...ImportRowIssue[]];

/** What a row's problems say, for the record and the error file: never the row's values. */
export function reasonOf(
  issues: Issues,
  header: readonly string[],
): { code: string; detail: string } {
  // A column is called what its header calls it, or by its place when the header is empty.
  const named = (column: number): string => {
    const name = header[column];
    return name === undefined || name === '' ? `Column ${String(column + 1)}` : name;
  };
  const detail = issues
    .map((issue) =>
      issue.column === null ? issue.message : `${named(issue.column)}: ${issue.message}`,
    )
    .join(' ');
  const [{ code }] = issues;
  return {
    // What imports.job_rows takes as a code; a contract's own code is always one.
    code: /^[a-z][a-z0-9_]*$/.test(code) ? code : 'invalid',
    detail: detail.length > 2000 ? `${detail.slice(0, 1999)}…` : detail,
  };
}

const union = (saved: readonly string[], added: readonly string[]): string[] => [
  ...new Set([...saved, ...added]),
];

/** Writes a planned row through the contact's own commands, and gives the contact's stored id. */
async function write(
  trx: DatabaseTransaction,
  command: CommandContext,
  businessId: string,
  plan: Extract<RowPlan, { outcome: 'create' | 'update' }>,
): Promise<string> {
  const { contact } = plan;
  let contactId: string;
  if (plan.outcome === 'create') {
    const created = await createContactCommand.handle(
      trx,
      parseInput(createContactInput, {
        firstName: contact.firstName ?? null,
        lastName: contact.lastName ?? null,
        emails: [...contact.emails],
        phones: [...contact.phones],
      }),
      command,
    );
    contactId = created.id;
    if (contact.timeZone !== undefined || contact.doNotContact)
      await updateContactCommand.handle(
        trx,
        parseInput(updateContactCommandInput, {
          id: created.id,
          ...preferences(contact, created),
        }),
        command,
      );
  } else {
    contactId = toPublicId('contact', plan.contactId);
    // Held from here to the batch's end, so what is read is what is changed.
    await lockContact(trx, businessId, contactId);
    const saved = await readContact(trx, command, contactId);
    // An import adds to a contact and never takes away: an empty cell changes nothing, and
    // the addresses a contact has stay, with the one it had first still first.
    const emails = union(saved.emails, contact.emails);
    const phones = union(
      saved.phones.map((phone) => phone.number),
      contact.phones,
    );
    await updateContactCommand.handle(
      trx,
      parseInput(updateContactCommandInput, {
        id: contactId,
        ...(contact.firstName === undefined ? {} : { firstName: contact.firstName }),
        ...(contact.lastName === undefined ? {} : { lastName: contact.lastName }),
        ...(emails.length === saved.emails.length ? {} : { emails }),
        ...(phones.length === saved.phones.length ? {} : { phones }),
        ...preferences(contact, saved),
      }),
      command,
    );
  }
  for (const tagId of contact.tagIds)
    await assignRecordTagCommand.handle(trx, { id: contactId, tagId }, command);
  for (const { fieldId, value } of contact.fields) {
    const current = await readRecordField(trx, command, contactId, fieldId);
    await setRecordFieldCommand.handle(
      trx,
      { id: contactId, fieldId, value, revision: current.revision },
      command,
    );
  }
  const stored = parsePublicId('contact', contactId);
  if (stored === undefined) throw new Error('A contact was written with no id.');
  return stored;
}

/**
 * The time zone and do-not-contact part of a contact change, based on what the contact
 * has. Do not contact is turned on when the row says so and never turned off.
 */
function preferences(
  contact: PlannedContact,
  saved: { readonly doNotContact: boolean; readonly preferencesRevision: string },
): Record<string, unknown> {
  const turnOn = contact.doNotContact && !saved.doNotContact;
  if (contact.timeZone === undefined && !turnOn) return {};
  return {
    ...(contact.timeZone === undefined ? {} : { timeZone: contact.timeZone }),
    ...(turnOn ? { doNotContact: true, doNotContactReason: DO_NOT_CONTACT_REASON } : {}),
    preferencesRevision: saved.preferencesRevision,
  };
}

/** Why the CRM's own commands refused a row, in their words. */
function refusalOf(error: AppError): Issues {
  const whole = ({ code, message }: { code: string; message: string }): ImportRowIssue => ({
    column: null,
    code,
    message,
  });
  if (error instanceof ValidationError) {
    const [first, ...rest] = error.issues;
    return [whole(first), ...rest.map(whole)];
  }
  // The kind of refusal as a code: ConflictError is conflict, NotFoundError not_found.
  const code = error.name
    .replace(/Error$/, '')
    .replace(/(?<!^)[A-Z]/g, (letter) => `_${letter}`)
    .toLowerCase();
  return [whole({ code, message: error.message })];
}

// For finding a batch's contacts only: every row is planned as if no other row came first.
const NO_EARLIER_ROWS: EarlierRows = {
  rowOfContact: () => Promise.resolve(undefined),
  rowOfNewIdentity: () => undefined,
};

/**
 * The contacts already in the business that the rows would update (stored ids), as the
 * rows are planned now. Nothing is written; a row that is refused names none.
 */
async function contactsOfRows(
  trx: DatabaseTransaction,
  context: PlanContext,
  rows: readonly { readonly row: number; readonly cells: readonly string[] }[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    try {
      const { plan } = await planRow(trx, context, { ...row, index: 0 }, NO_EARLIER_ROWS);
      if (plan.outcome === 'update') ids.push(plan.contactId);
    } catch (error) {
      // Refused by name: the row is applied, and its refusal recorded, as ever.
      if (!(error instanceof AppError)) throw error;
    }
  }
  return ids;
}

/** Applies one row inside a savepoint of its own, and records what became of it. */
async function applyRow(
  trx: DatabaseTransaction,
  command: CommandContext,
  context: PlanContext,
  importId: string,
  row: { readonly row: number; readonly cells: readonly string[] },
  earlier: EarlierRows,
): Promise<RowOutcome> {
  const record = async (
    outcome: RowOutcome,
    values: { recordId?: string; issues?: Issues },
  ): Promise<RowOutcome> => {
    const reason =
      values.issues === undefined ? undefined : reasonOf(values.issues, context.header);
    await trx
      .insertInto('imports.job_rows')
      .values({
        business_id: context.businessId,
        job_id: importId,
        row_number: row.row,
        outcome,
        record_id: values.recordId ?? null,
        code: reason?.code ?? null,
        detail: reason?.detail ?? null,
      })
      .execute();
    return outcome;
  };

  await sql`savepoint import_row`.execute(trx);
  try {
    const { plan } = await planRow(trx, context, { ...row, index: 0 }, earlier);
    const outcome =
      plan.outcome === 'create' || plan.outcome === 'update'
        ? await record(plan.outcome === 'create' ? 'created' : 'updated', {
            recordId: await write(trx, command, context.businessId, plan),
          })
        : await record(plan.outcome === 'skip' ? 'skipped' : 'failed', { issues: plan.issues });
    await sql`release savepoint import_row`.execute(trx);
    return outcome;
  } catch (error) {
    await sql`rollback to savepoint import_row`.execute(trx);
    await sql`release savepoint import_row`.execute(trx);
    // Anything the commands did not refuse by name is a fault: the whole batch fails, and
    // the job tries it again.
    if (!(error instanceof AppError)) throw error;
    return record('failed', { issues: refusalOf(error) });
  }
}

export const applyImportRowsCommand = defineCommand({
  name: 'import.apply_rows',
  permission: 'contacts.import',
  input: applyImportRowsInput,
  // Which import, which rows and how many: nothing a row holds reaches the audit log.
  audit: ({ importId, offset, rows }) => ({
    importId,
    offset,
    rows: rows.length,
    firstRow: rows[0]?.row,
    lastRow: rows.at(-1)?.row,
  }),
  async handle(trx, input, command): Promise<ApplyResult> {
    const businessId = requireBusiness(command.context);
    // Held for the batch: a second run of the job waits here, then finds it has no claim.
    const job = await trx
      .selectFrom('imports.jobs')
      .selectAll()
      .where('business_id', '=', businessId)
      .where('id', '=', input.importId)
      .forUpdate()
      .executeTakeFirst();
    if (job?.status !== 'running' || job.runner !== input.runner) return { state: 'superseded' };
    if (job.cancel_requested_at !== null) return { state: 'cancelled' };
    const plan = planOf(job);
    if (plan === undefined) throw new Error(`Import ${input.importId} has no plan to apply.`);
    // The claim makes this run the only one applying rows, so its place in the file is the
    // import's. Anything else is a fault that must not write a row.
    if (job.processed_count !== input.offset)
      throw new Error(
        `Import ${input.importId} has dealt with ${String(job.processed_count)} rows; a batch from row ${String(input.offset)} was handed over.`,
      );

    // The file's columns, each mapped one by the name its header gave it.
    const header = Array.from({ length: plan.columns }, () => '');
    for (const { column, header: name } of plan.mapping) header[column] = name;
    const context = await loadPlanContext(trx, command, {
      businessId,
      mode: plan.mode,
      mapping: plan.mapping.map(({ column, target }) => ({ column, target })),
      header,
      tagIds: plan.tagIds,
    });
    const earlier: EarlierRows = {
      rowOfNewIdentity: () => undefined,
      async rowOfContact(inTrx, contactId) {
        const written = await inTrx
          .selectFrom('imports.job_rows')
          .select('row_number')
          .where('business_id', '=', businessId)
          .where('job_id', '=', job.id)
          .where('record_id', '=', contactId)
          .executeTakeFirst();
        return written?.row_number;
      },
    };

    // The contacts the rows update, held in id order before the first row is applied, as a
    // merge and a bulk action hold theirs; the rows are still applied in the file's order.
    await lockContactsInOrder(trx, businessId, await contactsOfRows(trx, context, input.rows));
    const counts: Record<RowOutcome, number> = { created: 0, updated: 0, skipped: 0, failed: 0 };
    for (const row of input.rows)
      counts[await applyRow(trx, command, context, job.id, row, earlier)] += 1;

    await trx
      .updateTable('imports.jobs')
      .set({
        processed_count: sql<number>`processed_count + ${input.rows.length}`,
        created_count: sql<number>`created_count + ${counts.created}`,
        updated_count: sql<number>`updated_count + ${counts.updated}`,
        skipped_count: sql<number>`skipped_count + ${counts.skipped}`,
        failed_count: sql<number>`failed_count + ${counts.failed}`,
        heartbeat_at: sql<Date>`now()`,
      })
      .where('business_id', '=', businessId)
      .where('id', '=', job.id)
      .execute();
    return { state: 'applied', ...counts };
  },
});
