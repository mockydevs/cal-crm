// Why an automation did not start: the short-lived record the match job keeps when an event
// a published automation listens for does not enrol a record, and the two reads over it.
// Everything said here is read from rows: the reason and what was compared as the match
// wrote them, and the record's runs. Nothing is inferred, and "nothing on record" is an
// answer of its own.
import type { Services } from '@repo/commands';
import {
  automationContactExplanation,
  automationTriggerEvaluation,
  parseRecordId,
  recordKinds,
  TRIGGER_EVALUATION_DAYS,
  type AutomationContactExplanation,
  type AutomationTriggerEvaluation,
  type AutomationTriggerEvaluationList,
  type AutomationTriggerEvaluationReason,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { readRuns } from './history.js';
import { endingWords, explainEvaluation } from './trigger-evaluation-words.js';

export { endingWords, explainEvaluation };

/** One finding of a match: an automation that did not start for a record, and why. */
export interface EvaluationNote {
  readonly automationId: string;
  /** The trigger judged, by its id in the document; null when none was. */
  readonly triggerId: string | null;
  /** The record, by its stored id; null when the event was about none. */
  readonly recordId: string | null;
  readonly reason: AutomationTriggerEvaluationReason;
  readonly detail: Readonly<Record<string, unknown>>;
}

// A value as JSON keeps it: what JSON has no word for is written as null.
const plain = (value: unknown): unknown => (value === undefined ? null : value);

/**
 * Writes a match's findings in one statement, in the match's own transaction. A match job
 * that runs twice for an event writes each finding once.
 */
export async function writeTriggerEvaluations(
  trx: DatabaseTransaction,
  businessId: string,
  event: { readonly id: string; readonly type: string },
  notes: readonly EvaluationNote[],
): Promise<void> {
  if (notes.length === 0) return;
  const rows = notes.map((note) => ({
    automation_id: note.automationId,
    trigger_id: note.triggerId,
    record_id: note.recordId,
    reason: note.reason,
    detail: JSON.parse(
      JSON.stringify(note.detail, (_key, value: unknown) => plain(value)),
    ) as unknown,
  }));
  await sql`
    insert into automation.trigger_evaluations
      (business_id, automation_id, trigger_id, record_id, event_id, event_type, reason, detail)
    select ${businessId}, found.automation_id, found.trigger_id, found.record_id,
           ${event.id}, ${event.type}, found.reason, coalesce(found.detail, '{}'::jsonb)
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      as found(automation_id uuid, trigger_id text, record_id uuid, reason text, detail jsonb)
    on conflict do nothing
  `.execute(trx);
}

/** The automation, or a 404 when it is not this business's. */
async function automationOf(trx: DatabaseTransaction, id: string) {
  const uuid = parsePublicId('automation', id);
  const row =
    uuid === undefined
      ? undefined
      : await trx
          .selectFrom('automation.automations as automation')
          .leftJoin('automation.versions as version', (join) =>
            join
              .onRef('version.business_id', '=', 'automation.business_id')
              .onRef('version.id', '=', 'automation.published_version_id'),
          )
          .select(['automation.id', 'automation.name', 'automation.status', 'version.document'])
          .where('automation.id', '=', uuid)
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('automation', id);
  return row;
}

// Only the triggers' ids and types are read from the live version's document.
const liveTriggers = z.looseObject({
  triggers: z.array(z.looseObject({ id: z.string(), type: z.string() })).catch([]),
});

interface EvaluationRow {
  readonly id: string;
  readonly trigger_id: string | null;
  readonly record_id: string | null;
  readonly record_kind: string | null;
  readonly event_id: string;
  readonly event_type: string;
  readonly reason: string;
  readonly detail: unknown;
  readonly evaluated_at: Date;
}

export interface EvaluationsPage {
  readonly contactId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly after?: string | undefined;
  readonly limit: number;
}

/** An automation's evaluations, newest first: each time it did not start, and why. */
export async function readTriggerEvaluations(
  trx: DatabaseTransaction,
  id: string,
  page: EvaluationsPage,
): Promise<AutomationTriggerEvaluationList> {
  const automation = await automationOf(trx, id);
  // A record that is not this business's has no evaluations here; its id is not looked for.
  const record = page.contactId === undefined ? undefined : parseRecordId(page.contactId);
  if (page.contactId !== undefined && record === undefined) return { items: [], nextCursor: null };
  if (page.after !== undefined) {
    const known = await sql<{ id: string }>`
      select id from automation.trigger_evaluations
      where id = ${page.after} and automation_id = ${automation.id}
    `.execute(trx);
    if (known.rows.length === 0)
      throw new ValidationError([
        {
          path: '/after',
          code: 'invalid_cursor',
          message: 'That evaluation is no longer there to continue from. Start the list again.',
        },
      ]);
  }
  const { rows } = await sql<EvaluationRow>`
    select evaluation.id, evaluation.trigger_id, evaluation.record_id, record.kind as record_kind,
           evaluation.event_id, evaluation.event_type, evaluation.reason, evaluation.detail,
           evaluation.evaluated_at
    from automation.trigger_evaluations evaluation
    left join crm.records record
      on record.business_id = evaluation.business_id and record.id = evaluation.record_id
    where evaluation.automation_id = ${automation.id}
      and (${record?.id ?? null}::uuid is null or evaluation.record_id = ${record?.id ?? null}::uuid)
      and (${page.from ?? null}::timestamptz is null
           or evaluation.evaluated_at >= ${page.from ?? null}::timestamptz)
      and (${page.to ?? null}::timestamptz is null
           or evaluation.evaluated_at < ${page.to ?? null}::timestamptz)
      and (${page.after ?? null}::uuid is null or (evaluation.evaluated_at, evaluation.id) < (
        select anchor.evaluated_at, anchor.id from automation.trigger_evaluations anchor
        where anchor.id = ${page.after ?? null}::uuid))
    order by evaluation.evaluated_at desc, evaluation.id desc
    limit ${page.limit + 1}
  `.execute(trx);
  const types = new Map(
    liveTriggers.parse(automation.document ?? {}).triggers.map((each) => [each.id, each.type]),
  );
  const items = rows.slice(0, page.limit).map((row): AutomationTriggerEvaluation => {
    const reason = row.reason as AutomationTriggerEvaluationReason;
    const detail = z.record(z.string(), z.unknown()).catch({}).parse(row.detail);
    const kind = z.enum(recordKinds).safeParse(row.record_kind);
    return automationTriggerEvaluation.parse({
      id: row.id,
      evaluatedAt: row.evaluated_at.toISOString(),
      eventId: row.event_id,
      eventType: row.event_type,
      trigger:
        row.trigger_id === null
          ? null
          : { id: row.trigger_id, type: types.get(row.trigger_id) ?? null },
      recordId:
        row.record_id === null || !kind.success ? null : toPublicId(kind.data, row.record_id),
      reason,
      detail,
      explanation: explainEvaluation(reason, detail),
    });
  });
  return {
    items,
    nextCursor: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null,
  };
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  draft: ' The workflow is a draft now: only a published workflow starts.',
  paused: ' The workflow is paused now: a paused workflow starts for nobody.',
  archived: ' The workflow is in the Deleted list now.',
  active: '',
};

/**
 * What an automation did, or did not do, for one record: its latest run when it has one,
 * and otherwise the latest times an event did not start it, each with why. From rows only.
 */
export async function explainContact(
  trx: DatabaseTransaction,
  id: string,
  contactId: string,
): Promise<AutomationContactExplanation> {
  const automation = await automationOf(trx, id);
  const parsed = parseRecordId(contactId);
  const named =
    parsed === undefined
      ? undefined
      : (
          await sql<{ name: string | null }>`
            select coalesce(contact.display_name, company.name, deal.name, custom.title) as name
            from crm.records record
            left join crm.contacts contact
              on contact.business_id = record.business_id and contact.id = record.id
            left join crm.companies company
              on company.business_id = record.business_id and company.id = record.id
            left join crm.deals deal
              on deal.business_id = record.business_id and deal.id = record.id
            left join crm.custom_records custom
              on custom.business_id = record.business_id and custom.id = record.id
            where record.id = ${parsed.id} and record.kind = ${parsed.kind}
          `.execute(trx)
        ).rows[0];
  if (parsed === undefined || named === undefined) throw new NotFoundError('record', contactId);
  const who = named.name ?? 'This record';
  const publicId = toPublicId('automation', automation.id);
  const [latest] = (await readRuns(trx, publicId, { record: contactId })).items;
  const counted = await sql<{ runs: number }>`
    select count(*)::int as runs from automation.enrolments
    where automation_id = ${automation.id} and record_id = ${parsed.id}
  `.execute(trx);
  const runs = counted.rows[0]?.runs ?? 0;
  const failed =
    latest?.status === 'failed'
      ? (
          await sql<{ step_key: string }>`
            select step_key from automation.step_runs
            where enrolment_id = ${parsePublicId('automation_enrolment', latest.id) ?? null}
              and status = 'failed'
            order by started_at desc, id desc limit 1
          `.execute(trx)
        ).rows[0]
      : undefined;
  const ended = latest === undefined ? null : endingWords(latest, failed?.step_key);
  const { items: evaluations } = await readTriggerEvaluations(trx, publicId, {
    contactId,
    limit: 5,
  });
  const name = `"${automation.name}"`;
  const status = STATUS_WORDS[automation.status] ?? '';
  const [newest] = evaluations;
  let summary: string;
  if (latest !== undefined) {
    const at = latest.currentAction;
    const where = at === null || at === undefined ? '' : ` at the step "${at.label ?? at.step}"`;
    const live =
      ended === null
        ? `${who} has a run of ${name} that is ${latest.status}${where}. It started ${latest.startedAt}${latest.wakeAt === null ? '' : ` and waits until ${latest.wakeAt}`}.`
        : `${who}'s latest run of ${name} started ${latest.startedAt} and ended ${latest.finishedAt ?? 'at a time not kept'}. ${ended}`;
    const more = runs > 1 ? ` The record has ${String(runs)} runs of it in all.` : '';
    // An event that came after the latest run began and did not start another.
    const since =
      newest !== undefined && newest.evaluatedAt > latest.startedAt
        ? ` Since that run began, the most recent event that did not start another (${newest.eventType}, ${newest.evaluatedAt}): ${newest.explanation}`
        : '';
    summary = `${live}${more}${since}`;
  } else if (newest !== undefined)
    summary = `No run of ${name} is on record for ${who}. The most recent event that could have started it (${newest.eventType}, ${newest.evaluatedAt}) did not: ${newest.explanation}${status}`;
  else
    summary = `No run of ${name} is on record for ${who}, and no event it listens for was matched for this record in the last ${String(TRIGGER_EVALUATION_DAYS)} days.${status}`;
  return automationContactExplanation.parse({
    automationId: publicId,
    automationName: automation.name,
    automationStatus: automation.status,
    recordId: toPublicId(parsed.kind, parsed.id),
    state:
      latest !== undefined ? 'has_run' : newest !== undefined ? 'not_started' : 'nothing_on_record',
    runs,
    run: latest ?? null,
    ended,
    evaluations,
    evaluationsKeptDays: TRIGGER_EVALUATION_DAYS,
    summary,
  });
}

/**
 * The worker's sweep: removes evaluations past their days, in every business, in bounded
 * batches until none is left or the pass has done its share. Gives how many it removed.
 */
export async function expireTriggerEvaluations(services: Services, batch = 5000): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < 200; pass++) {
    const { rows } = await sql<{ removed: number }>`
      select private.expire_trigger_evaluations(${TRIGGER_EVALUATION_DAYS}, ${batch}) as removed
    `.execute(services.db);
    const removed = rows[0]?.removed ?? 0;
    total += removed;
    if (removed < batch) break;
  }
  return total;
}
