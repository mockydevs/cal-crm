// What an automation has done (AUTOMATIONS.md section 5): its published versions, the
// difference between two of them, its real runs with each step taken (the enrollment
// history), and every step its runs took (the execution logs). One source for all of it:
// automation.enrolments and automation.step_runs. All of it is read under the tenant
// context, so another business's is simply not found.
import {
  automationBranchNames,
  automationRun,
  automationRunSummary,
  automationStepRunEntry,
  diffJson,
  parseRecordId,
  recordKinds,
  type AutomationRun,
  type AutomationRunList,
  type AutomationStepType,
  type AutomationStepRunList,
  type AutomationVersion,
  type AutomationVersionDiff,
  type AutomationVersionList,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

/** How many versions or runs one page holds. */
export const HISTORY_PAGE_SIZE = 50;

async function automationIdOf(trx: DatabaseTransaction, id: string): Promise<string> {
  const uuid = parsePublicId('automation', id);
  const row =
    uuid === undefined
      ? undefined
      : await trx
          .selectFrom('automation.automations')
          .select('id')
          .where('id', '=', uuid)
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('automation', id);
  return row.id;
}

const versions = (trx: DatabaseTransaction, automationId: string) =>
  trx
    .selectFrom('automation.versions')
    .select(['id', 'version', 'change_summary', 'published_at', 'published_by_kind'])
    .where('automation_id', '=', automationId);

type VersionRow = Awaited<ReturnType<ReturnType<typeof versions>['executeTakeFirstOrThrow']>>;

const presentVersion = (row: VersionRow): AutomationVersionList['items'][number] => ({
  id: toPublicId('automation_version', row.id),
  version: row.version,
  changeSummary: row.change_summary,
  publishedAt: row.published_at.toISOString(),
  publishedByKind: row.published_by_kind,
});

/** Published versions, newest first; `after` continues with the versions before a number. */
export async function readVersions(
  trx: DatabaseTransaction,
  id: string,
  { after }: { after?: number | undefined },
): Promise<AutomationVersionList> {
  let query = versions(trx, await automationIdOf(trx, id))
    .orderBy('version', 'desc')
    .limit(HISTORY_PAGE_SIZE + 1);
  if (after !== undefined) query = query.where('version', '<', after);
  const rows = await query.execute();
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  return {
    items: page.map(presentVersion),
    nextCursor: rows.length > HISTORY_PAGE_SIZE ? (page.at(-1)?.version ?? null) : null,
  };
}

/** One published version with its document, or a 404. */
export async function readVersion(
  trx: DatabaseTransaction,
  id: string,
  version: number,
): Promise<AutomationVersion> {
  const row = await versions(trx, await automationIdOf(trx, id))
    .select('document')
    .where('version', '=', version)
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('automation_version', String(version));
  return {
    ...presentVersion(row),
    document: z.record(z.string(), z.unknown()).parse(row.document),
  };
}

/** The JSON Patch that turns one published version's document into another's. */
export async function diffVersions(
  trx: DatabaseTransaction,
  id: string,
  from: number,
  to: number,
): Promise<AutomationVersionDiff> {
  const [before, after] = [await readVersion(trx, id, from), await readVersion(trx, id, to)];
  // Stored documents came through the draft checks, so they are JSON within the limits.
  const json = z.json();
  return {
    from,
    to,
    patch: diffJson(json.parse(before.document), json.parse(after.document)),
  };
}

// A run with its automation and its record as they are named now. Only the kinds of record
// the CRM names can be enrolled, so the inner join on kind loses nothing.
const runs = (trx: DatabaseTransaction) =>
  trx
    .selectFrom('automation.enrolments as enrolment')
    .innerJoin('automation.automations as automation', (join) =>
      join
        .onRef('automation.id', '=', 'enrolment.automation_id')
        .onRef('automation.business_id', '=', 'enrolment.business_id'),
    )
    .innerJoin('automation.versions as version', (join) =>
      join
        .onRef('version.id', '=', 'enrolment.version_id')
        .onRef('version.business_id', '=', 'enrolment.business_id'),
    )
    .innerJoin('crm.records as record', (join) =>
      join
        .onRef('record.id', '=', 'enrolment.record_id')
        .onRef('record.business_id', '=', 'enrolment.business_id'),
    )
    .leftJoin('crm.contacts as contact', (join) =>
      join
        .onRef('contact.business_id', '=', 'record.business_id')
        .onRef('contact.id', '=', 'record.id'),
    )
    .leftJoin('crm.companies as company', (join) =>
      join
        .onRef('company.business_id', '=', 'record.business_id')
        .onRef('company.id', '=', 'record.id'),
    )
    .leftJoin('crm.deals as deal', (join) =>
      join.onRef('deal.business_id', '=', 'record.business_id').onRef('deal.id', '=', 'record.id'),
    )
    .leftJoin('crm.custom_records as custom', (join) =>
      join
        .onRef('custom.business_id', '=', 'record.business_id')
        .onRef('custom.id', '=', 'record.id'),
    )
    .select([
      'enrolment.id',
      'enrolment.automation_id',
      'automation.name as automation_name',
      'enrolment.status',
      'enrolment.record_id',
      'enrolment.current_step',
      'enrolment.exit_reason',
      'enrolment.wake_at',
      'enrolment.started_at',
      'enrolment.finished_at',
      'enrolment.trigger_key',
      'enrolment.state',
      'enrolment.version_id',
      'version.version',
      'record.kind as record_kind',
    ])
    // As the CRM names a record in its own lists (tasks.ts): a contact without a name goes
    // by its first address.
    .select(
      sql<string | null>`case record.kind when 'contact' then coalesce(contact.display_name, (
        select identity.value_normalized from crm.contact_identities identity
        where identity.business_id = contact.business_id and identity.contact_id = contact.id
          and identity.is_primary
        order by identity.kind limit 1))
        when 'company' then company.name when 'deal' then deal.name
        when 'custom' then custom.title end`.as('record_name'),
    )
    .select(
      sql<boolean>`case record.kind when 'contact' then contact.deleted_at is not null
        when 'company' then company.deleted_at is not null
        when 'deal' then deal.deleted_at is not null
        when 'custom' then custom.deleted_at is not null else true end`.as('record_trashed'),
    );

type RunRow = Awaited<ReturnType<ReturnType<typeof runs>['executeTakeFirstOrThrow']>>;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** What a published version calls its triggers and steps, and its number. */
interface VersionNames {
  readonly version: number;
  readonly triggers: ReadonlyMap<string, string>;
  readonly steps: ReadonlyMap<
    string,
    { readonly type: string | null; readonly label: string | null; readonly config: unknown }
  >;
}

/**
 * Names where a run stands, for whoever continues it: it changes each time the run moves,
 * as the engine's own count of the run's steps does.
 */
export function runRevisionOf(state: unknown): string {
  const sequence =
    typeof state === 'object' && state !== null
      ? (state as Readonly<Record<string, unknown>>)['sequence']
      : undefined;
  return String(typeof sequence === 'number' ? sequence : 0);
}

const WAITS_WITH_BRANCHES: ReadonlySet<string> = new Set([
  'wait.event',
  'wait.condition',
  'wait.appointment',
]);

/**
 * Whether a run that waits at this step may be continued by a person, and between which
 * branches: a wait for a time has none. Nothing for any other kind of waiting.
 */
function continuableAt(
  step: { readonly type: string | null; readonly config: unknown } | undefined,
): { branches: readonly string[] } | null {
  const type = step?.type ?? null;
  if (type === 'wait' || type === 'wait.until') return { branches: [] };
  if (type === null || !WAITS_WITH_BRANCHES.has(type)) return null;
  return { branches: automationBranchNames(type as AutomationStepType, step?.config) ?? [] };
}

// Only what the lists name is read from a stored document, so one a later format would
// refuse still names its steps.
const namedDocument = z.looseObject({
  triggers: z.array(z.looseObject({ id: z.string(), type: z.string() })).catch([]),
  steps: z
    .record(
      z.string(),
      z.looseObject({ type: z.string().optional(), label: z.string().optional() }),
    )
    .catch({}),
});

/** The names in each of these versions, read once for a page of runs or steps. */
async function versionNames(
  trx: DatabaseTransaction,
  versionIds: readonly string[],
): Promise<ReadonlyMap<string, VersionNames>> {
  const ids = [...new Set(versionIds)];
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('automation.versions')
    .select(['id', 'version', 'document'])
    .where('id', 'in', ids)
    .execute();
  return new Map(
    rows.map((row) => {
      const document = namedDocument.parse(row.document);
      return [
        row.id,
        {
          version: row.version,
          triggers: new Map(document.triggers.map((trigger) => [trigger.id, trigger.type])),
          steps: new Map(
            Object.entries(document.steps).map(([key, step]) => [
              key,
              { type: step.type ?? null, label: step.label ?? null, config: step['config'] },
            ]),
          ),
        },
      ];
    }),
  );
}

// What a run another automation's step started keeps of who started it (enrolment.ts).
const startedBy = z.looseObject({
  startedBy: z.looseObject({ enrolmentId: z.uuid(), automationId: z.uuid(), stepKey: z.string() }),
});

/** The run and step that started this one from another automation, if one did. */
function starterOf(state: unknown) {
  const parsed = startedBy.safeParse(state);
  if (!parsed.success) return null;
  const { enrolmentId, automationId, stepKey } = parsed.data.startedBy;
  return {
    runId: toPublicId('automation_enrolment', enrolmentId),
    automationId: toPublicId('automation', automationId),
    step: stepKey,
  };
}

const namedStep = (names: VersionNames | undefined, step: string) => ({
  step,
  type: names?.steps.get(step)?.type ?? null,
  label: names?.steps.get(step)?.label ?? null,
});

/**
 * Presents runs: each with the trigger that enrolled it and the step it is at. A run that
 * waits is at the step whose row is waiting (a wait keeps its run's next step as the
 * current one, so the row says where the run really is); one that runs is at its next step.
 */
async function presentRuns(
  trx: DatabaseTransaction,
  rows: readonly RunRow[],
): Promise<AutomationRunList['items']> {
  const names = await versionNames(
    trx,
    rows.map((row) => row.version_id),
  );
  const waitingIds = rows.filter((row) => row.status === 'waiting').map((row) => row.id);
  const waiting =
    waitingIds.length === 0
      ? []
      : await trx
          .selectFrom('automation.step_runs')
          .select(['enrolment_id', 'step_key'])
          .where('enrolment_id', 'in', waitingIds)
          .where('status', '=', 'waiting')
          .execute();
  const waitingAt = new Map(waiting.map((row) => [row.enrolment_id, row.step_key]));
  // Parsed, not assumed: stored statuses and kinds are checked against the contract.
  return rows.map((row) => {
    const recordId = toPublicId(z.enum(recordKinds).parse(row.record_kind), row.record_id);
    const version = names.get(row.version_id);
    const live = row.status === 'running' || row.status === 'waiting';
    const at = waitingAt.get(row.id) ?? row.current_step;
    return automationRunSummary.parse({
      id: toPublicId('automation_enrolment', row.id),
      automationId: toPublicId('automation', row.automation_id),
      automationName: row.automation_name,
      version: row.version,
      status: row.status,
      recordId,
      record: { id: recordId, name: row.record_name ?? '', trashed: row.record_trashed },
      currentStep: row.current_step,
      exitReason: row.exit_reason,
      wakeAt: iso(row.wake_at),
      startedAt: row.started_at.toISOString(),
      finishedAt: iso(row.finished_at),
      trigger:
        row.trigger_key === null
          ? null
          : { id: row.trigger_key, type: version?.triggers.get(row.trigger_key) ?? null },
      startedBy: starterOf(row.state),
      currentAction: live && at !== null ? namedStep(version, at) : null,
      revision: runRevisionOf(row.state),
      continuable:
        row.status === 'waiting' && waitingAt.has(row.id)
          ? continuableAt(version?.steps.get(waitingAt.get(row.id) ?? ''))
          : null,
    });
  });
}

interface RunsPage {
  readonly status?: string | undefined;
  readonly after?: string | undefined;
  /** Runs that started at or after this moment, and before that one. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Runs for this record, by its public id. */
  readonly record?: string | undefined;
  /** Runs this trigger enrolled. */
  readonly trigger?: string | undefined;
}

const invalidCursor = (message: string) =>
  new ValidationError([{ path: '/after', code: 'invalid_cursor', message }]);

// One page of runs, newest first by when each started; runs that started together keep
// the order they were made in, by id. The cursor is the last run's id: where it stands is
// read back from the run itself, so a page continues exactly after it.
async function pageOfRuns(
  trx: DatabaseTransaction,
  query: ReturnType<typeof runs>,
  { status, after, from, to, record, trigger }: RunsPage,
): Promise<AutomationRunList> {
  let paged = query
    .orderBy('enrolment.started_at', 'desc')
    .orderBy('enrolment.id', 'desc')
    .limit(HISTORY_PAGE_SIZE + 1);
  if (status !== undefined) paged = paged.where('enrolment.status', '=', status);
  if (from !== undefined) paged = paged.where('enrolment.started_at', '>=', new Date(from));
  if (to !== undefined) paged = paged.where('enrolment.started_at', '<', new Date(to));
  if (trigger !== undefined) paged = paged.where('enrolment.trigger_key', '=', trigger);
  if (record !== undefined) {
    const parsed = parseRecordId(record);
    // A record that is not this business's has no runs here; its id is not looked for.
    if (parsed === undefined) return { items: [], nextCursor: null };
    paged = paged.where('enrolment.record_id', '=', parsed.id);
  }
  if (after !== undefined) {
    const anchor = parsePublicId('automation_enrolment', after);
    if (anchor === undefined) throw invalidCursor('Start after a run id.');
    const known = await trx
      .selectFrom('automation.enrolments')
      .select('id')
      .where('id', '=', anchor)
      .executeTakeFirst();
    if (known === undefined)
      throw invalidCursor('That run is no longer there to continue from. Start the list again.');
    paged = paged.where(
      sql<boolean>`(enrolment.started_at, enrolment.id) < (
        select anchor.started_at, anchor.id from automation.enrolments anchor
        where anchor.id = ${anchor})`,
    );
  }
  const rows = await paged.execute();
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: await presentRuns(trx, page),
    nextCursor:
      rows.length > HISTORY_PAGE_SIZE && last !== undefined
        ? toPublicId('automation_enrolment', last.id)
        : null,
  };
}

/** An automation's real runs, newest first: its enrollment history. */
export async function readRuns(
  trx: DatabaseTransaction,
  id: string,
  page: RunsPage,
): Promise<AutomationRunList> {
  return pageOfRuns(
    trx,
    runs(trx).where('enrolment.automation_id', '=', await automationIdOf(trx, id)),
    page,
  );
}

/**
 * Every automation a record has been through, newest first, or a 404 for a record this
 * business doesn't have. A record in the trash still shows its runs.
 */
export async function readRecordRuns(
  trx: DatabaseTransaction,
  recordId: string,
  page: Pick<RunsPage, 'status' | 'after'>,
): Promise<AutomationRunList> {
  const parsed = parseRecordId(recordId);
  const record =
    parsed === undefined
      ? undefined
      : await trx
          .selectFrom('crm.records')
          .select('id')
          .where('id', '=', parsed.id)
          .where('kind', '=', parsed.kind)
          .executeTakeFirst();
  if (record === undefined) throw new NotFoundError('record', recordId);
  return pageOfRuns(trx, runs(trx).where('enrolment.record_id', '=', record.id), page);
}

const storedObject = z.record(z.string(), z.unknown());

const stepColumns = [
  'id',
  'enrolment_id',
  'version_id',
  'step_key',
  'status',
  'input',
  'output',
  'branch',
  'explanation',
  'error',
  'attempt',
  'started_at',
  'finished_at',
] as const;

interface StepRow {
  readonly step_key: string;
  readonly status: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly branch: string | null;
  readonly explanation: string;
  readonly error: unknown;
  readonly attempt: number;
  readonly started_at: Date;
  readonly finished_at: Date | null;
}

// One step as a run's page and the execution logs both show it.
function presentStep(step: StepRow) {
  // The engine's own bookkeeping (which visit this was) is not what the step was given.
  const { sequence: _sequence, type, ...input } = storedObject.parse(step.input);
  return {
    step: step.step_key,
    type: typeof type === 'string' ? type : null,
    status: step.status,
    input,
    output: storedObject.parse(step.output),
    branch: step.branch,
    explanation: step.explanation,
    error: step.error,
    attempt: step.attempt,
    startedAt: step.started_at.toISOString(),
    finishedAt: iso(step.finished_at),
  };
}

/** One real run with every step it took, in order, or a 404. */
export async function readRun(trx: DatabaseTransaction, runId: string): Promise<AutomationRun> {
  const uuid = parsePublicId('automation_enrolment', runId);
  const row =
    uuid === undefined
      ? undefined
      : await runs(trx).where('enrolment.id', '=', uuid).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('automation_run', runId);
  const steps = await trx
    .selectFrom('automation.step_runs')
    .select(stepColumns)
    .where('enrolment_id', '=', row.id)
    .orderBy('started_at')
    .orderBy('id')
    .execute();
  const [summary] = await presentRuns(trx, [row]);
  return automationRun.parse({ ...summary, steps: steps.map(presentStep) });
}

interface StepRunsPage {
  readonly status?: string | undefined;
  /** Only this step, by its key; only steps of this type. */
  readonly step?: string | undefined;
  readonly type?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly record?: string | undefined;
  readonly after?: string | undefined;
}

/**
 * The execution logs: every step an automation's runs took, newest first by when each
 * began, with the record, the run and what the step did. The same rows a run's own page
 * shows, read across the automation's runs; the cursor is the last step's id.
 */
export async function readStepRuns(
  trx: DatabaseTransaction,
  id: string,
  { status, step, type, from, to, record, after }: StepRunsPage,
): Promise<AutomationStepRunList> {
  const automationId = await automationIdOf(trx, id);
  let paged = trx
    .selectFrom('automation.step_runs as step')
    .select(stepColumns.map((column) => `step.${column}` as const))
    .where('step.automation_id', '=', automationId)
    .orderBy('step.started_at', 'desc')
    .orderBy('step.id', 'desc')
    .limit(HISTORY_PAGE_SIZE + 1);
  if (status !== undefined) paged = paged.where('step.status', '=', status);
  if (step !== undefined) paged = paged.where('step.step_key', '=', step);
  if (type !== undefined) paged = paged.where(sql<boolean>`step.input ->> 'type' = ${type}`);
  if (from !== undefined) paged = paged.where('step.started_at', '>=', new Date(from));
  if (to !== undefined) paged = paged.where('step.started_at', '<', new Date(to));
  if (record !== undefined) {
    const parsed = parseRecordId(record);
    if (parsed === undefined) return { items: [], nextCursor: null };
    paged = paged.where('step.enrolment_id', 'in', (inner) =>
      inner
        .selectFrom('automation.enrolments as of_record')
        .select('of_record.id')
        .where('of_record.automation_id', '=', automationId)
        .where('of_record.record_id', '=', parsed.id),
    );
  }
  if (after !== undefined) {
    const anchor = parsePublicId('automation_step_run', after);
    if (anchor === undefined) throw invalidCursor('Start after a step run id.');
    const known = await trx
      .selectFrom('automation.step_runs')
      .select('id')
      .where('id', '=', anchor)
      .where('automation_id', '=', automationId)
      .executeTakeFirst();
    if (known === undefined)
      throw invalidCursor('That step is no longer there to continue from. Start the list again.');
    paged = paged.where(
      sql<boolean>`(step.started_at, step.id) < (
        select anchor.started_at, anchor.id from automation.step_runs anchor
        where anchor.id = ${anchor})`,
    );
  }
  const rows = await paged.execute();
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  const last = page.at(-1);
  // The record and version of each step are its run's: read with the runs themselves.
  const enrolmentIds = [...new Set(page.map((row) => row.enrolment_id))];
  const ofRuns =
    enrolmentIds.length === 0
      ? []
      : await presentRuns(trx, await runs(trx).where('enrolment.id', 'in', enrolmentIds).execute());
  const runOf = new Map(ofRuns.map((run) => [run.id, run]));
  const names = await versionNames(
    trx,
    page.map((row) => row.version_id),
  );
  return {
    items: page.flatMap((row) => {
      const run = runOf.get(toPublicId('automation_enrolment', row.enrolment_id));
      // A step whose run's record has just been purged goes with it, a moment later.
      if (run === undefined) return [];
      const presented = presentStep(row);
      const named = namedStep(names.get(row.version_id), row.step_key);
      return [
        automationStepRunEntry.parse({
          ...presented,
          type: presented.type ?? named.type,
          id: toPublicId('automation_step_run', row.id),
          runId: run.id,
          version: run.version,
          label: named.label,
          record: run.record,
        }),
      ];
    }),
    nextCursor:
      rows.length > HISTORY_PAGE_SIZE && last !== undefined
        ? toPublicId('automation_step_run', last.id)
        : null,
  };
}
