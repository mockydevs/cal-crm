// The worker's side of an import: the job that reads the file and hands its rows over a
// batch at a time, the file of rows it did not apply, and the sweep that takes up an import
// whose worker died.
//
// A job can run more than once, and two runs can overlap: after a crash, a retry, or the
// sweep queueing an import whose first job is only slow. So a run first claims the import
// (begin), every batch names that claim, and the batch command refuses a run whose claim
// has been taken over. Where the import is in its file is kept with the rows themselves
// (apply.ts), so a run that takes over goes on from the last batch that committed.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type AnyTask,
  type Invocation,
  type Services,
} from '@repo/commands';
import type { ImportStatus, StoredFile } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ContentTooLargeError, formatCsvRecord, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { applyImportRowsCommand, type ApplyResult } from './apply.js';
import { ImportFileError, openCsvFile, type CsvRow } from './csv-file.js';
import { runImportReference } from './imports.js';
import { planOf, type ImportPlan } from './store.js';

/** What an import needs of the files service: read a stored file, store one, link to one. */
export interface ImportFiles {
  content(
    services: Services,
    invocation: Invocation,
    fileId: string,
  ): Promise<
    { readonly file: StoredFile; readonly shared: boolean; open(): Promise<Readable> } | undefined
  >;
  upload(
    services: Services,
    invocation: Invocation,
    upload: {
      readonly body: Readable;
      readonly contentType: string | undefined;
      readonly filename: string;
    },
  ): Promise<StoredFile>;
  link(
    services: Services,
    invocation: Invocation,
    fileId: string,
    lifetime: { readonly seconds: number },
  ): Promise<{ path: string; expiresAt: string }>;
}

/** What a run tells whoever listens: ids and counts, never anything a row holds. */
export interface ImportProgress {
  readonly importId: string;
  readonly businessId: string;
  readonly event: 'batch' | 'ended';
  readonly status: ImportStatus;
  /** Rows dealt with so far, of the rows found. */
  readonly processed: number;
  readonly found: number;
  /** The reason an import failed as a whole. */
  readonly errorCode?: string;
}

export interface ImportTaskOptions {
  /**
   * The files service. A role without file storage has none, and an import it takes up
   * fails saying so rather than waiting for ever.
   */
  readonly files: ImportFiles | undefined;
  /** Rows applied in one transaction. */
  readonly batchSize?: number;
  /** Not-applied rows read from the database at a time, for the error file. */
  readonly outcomePageSize?: number;
  /**
   * Told after each batch has committed, and when the import ends: for structured logs.
   * A promise it returns is waited for, and a failure of it fails the run, as a crash
   * between two batches would.
   */
  readonly onProgress?: (progress: ImportProgress) => void | Promise<void>;
}

/** Rows one transaction applies unless told otherwise: short enough to hold no lock long. */
export const IMPORT_BATCH_SIZE = 50;

const claimInput = z.strictObject({ importId: z.uuid() });

type Claim =
  | {
      readonly state: 'running';
      readonly runner: string;
      readonly processed: number;
      readonly found: number;
      readonly fileId: string | null;
      readonly fileName: string;
      readonly plan: ImportPlan;
    }
  | { readonly state: 'ended' };

/**
 * Claims an import for one run of the job: marks it running and puts the run's mark on it.
 * A run that held it before finds its mark gone at its next batch, and stops.
 */
export const beginImportRunCommand = defineCommand({
  name: 'import.begin_run',
  permission: 'contacts.import',
  input: claimInput,
  async handle(trx, input, command): Promise<Claim> {
    const businessId = requireBusiness(command.context);
    const job = await trx
      .selectFrom('imports.jobs')
      .selectAll()
      .where('business_id', '=', businessId)
      .where('id', '=', input.importId)
      .forUpdate()
      .executeTakeFirst();
    const plan = job === undefined ? undefined : planOf(job);
    if (job === undefined || plan === undefined) return { state: 'ended' };
    if (job.status !== 'pending' && job.status !== 'running') return { state: 'ended' };
    const runner = randomUUID();
    await trx
      .updateTable('imports.jobs')
      .set({
        status: 'running',
        runner,
        heartbeat_at: sql<Date>`now()`,
        ...(job.started_at === null ? { started_at: sql<Date>`now()` } : {}),
      })
      .where('business_id', '=', businessId)
      .where('id', '=', job.id)
      .execute();
    return {
      state: 'running',
      runner,
      processed: job.processed_count,
      found: job.row_count,
      fileId: job.file_id,
      fileName: job.file_name ?? 'import.csv',
      plan,
    };
  },
});

const held = { importId: z.uuid(), runner: z.uuid() };

// How an import ends: at its last row or because someone stopped it, perhaps with a file
// of the rows it did not apply; or failed as a whole, with the reason.
const finishInput = z.discriminatedUnion('status', [
  z.strictObject({
    ...held,
    status: z.enum(['completed', 'cancelled']),
    errorFileId: z.uuid().optional(),
  }),
  z.strictObject({
    ...held,
    status: z.literal('failed'),
    errorCode: z.string().regex(/^[a-z][a-z0-9_]*$/),
    error: z.string().max(2000),
  }),
]);

/** Ends an import the run still holds. Ending one that has ended changes nothing. */
export const finishImportCommand = defineCommand({
  name: 'import.finish',
  permission: 'contacts.import',
  input: finishInput,
  async handle(trx, input, command): Promise<{ ended: boolean }> {
    const businessId = requireBusiness(command.context);
    const job = await trx
      .selectFrom('imports.jobs')
      .select(['id', 'status', 'runner', 'processed_count', 'created_count', 'updated_count'])
      .select(['skipped_count', 'failed_count'])
      .where('business_id', '=', businessId)
      .where('id', '=', input.importId)
      .forUpdate()
      .executeTakeFirst();
    if (job?.status !== 'running' || job.runner !== input.runner) return { ended: false };
    const failure =
      input.status === 'failed' ? { code: input.errorCode, message: input.error } : undefined;
    await trx
      .updateTable('imports.jobs')
      .set({
        status: input.status,
        finished_at: sql<Date>`now()`,
        error_file_id: input.status === 'failed' ? null : (input.errorFileId ?? null),
        error_code: failure?.code ?? null,
        error: failure?.message ?? null,
      })
      .where('business_id', '=', businessId)
      .where('id', '=', job.id)
      .execute();
    await command.emit({
      type: `import.${input.status}`,
      subject: { kind: 'import', id: job.id },
      // Counts only: events are kept for good and read by automations and webhooks.
      payload: {
        processed: job.processed_count,
        created: job.created_count,
        updated: job.updated_count,
        skipped: job.skipped_count,
        failed: job.failed_count,
        ...(failure === undefined ? {} : { errorCode: failure.code }),
      },
    });
    return { ended: true };
  },
});

/** The name the file of rows not applied is stored under, from the source file's name. */
export function errorFileName(source: string): string {
  const stem = source.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 200);
  return `${stem === '' ? 'import' : stem}-not-imported.csv`;
}

// A byte order mark, so a spreadsheet reads the file as UTF-8 rather than guessing.
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * The file of rows an import did not apply, a line at a time: its header, then each row
 * that was skipped or failed as it was in the source file, with its number in that file,
 * what became of it and why. The rows hold whatever the uploaded file held, so every cell
 * is written as a spreadsheet will show it, never as a formula it will run (OWASP, "CSV
 * Injection": a leading apostrophe on a cell that starts with one of the characters it
 * lists, every cell quoted, every quote doubled; formatCsvRecord in the kernel).
 */
export async function* errorFileLines(
  source: {
    readonly header: readonly string[];
    rows(): AsyncGenerator<CsvRow, void, void>;
  },
  outcomes: AsyncIterable<{ row_number: number; outcome: string; detail: string | null }>,
): AsyncGenerator<string, void, void> {
  const line = (cells: readonly string[]): string =>
    formatCsvRecord(cells, { spreadsheetSafe: true });
  yield BYTE_ORDER_MARK + line(['Row', 'Result', 'Reason', ...source.header]);
  const rows = source.rows();
  try {
    let current = await rows.next();
    for await (const outcome of outcomes) {
      while (current.done !== true && current.value.row < outcome.row_number)
        current = await rows.next();
      if (current.done === true) return;
      if (current.value.row !== outcome.row_number) continue;
      yield line([
        String(outcome.row_number),
        outcome.outcome === 'skipped' ? 'Skipped' : 'Failed',
        outcome.detail ?? '',
        ...current.value.cells,
      ]);
    }
  } finally {
    await rows.return();
  }
}

/** How many of an import's not-applied rows are read from the database at a time. */
export const IMPORT_OUTCOME_PAGE = 1000;

/** An import's skipped and failed rows, in the file's order, a page at a time. */
async function* notApplied(
  services: Services,
  invocation: Invocation,
  importId: string,
  pageSize: number,
): AsyncGenerator<{ row_number: number; outcome: string; detail: string | null }, void, void> {
  let after = 0;
  for (;;) {
    const page = await withTenant(services.db, invocation.context, (trx) =>
      trx
        .selectFrom('imports.job_rows')
        .select(['row_number', 'outcome', 'detail'])
        .where('business_id', '=', requireBusiness(invocation.context))
        .where('job_id', '=', importId)
        .where('outcome', 'in', ['skipped', 'failed'])
        .where('row_number', '>', after)
        .orderBy('row_number')
        .limit(pageSize)
        .execute(),
    );
    yield* page;
    // A page that isn't full is the last; so is an empty one after a last full page.
    const last = page.at(-1);
    if (last === undefined || page.length < pageSize) return;
    after = last.row_number;
  }
}

/** The task that applies an import, and what it needs. */
export function createImportTasks(options: ImportTaskOptions): readonly AnyTask[] {
  const { files } = options;
  const batchSize = options.batchSize ?? IMPORT_BATCH_SIZE;
  const outcomePage = options.outcomePageSize ?? IMPORT_OUTCOME_PAGE;

  const runImport = defineTask({
    ...runImportReference,
    async run({ importId }, job) {
      const { services } = job;
      const businessId = requireBusiness(job.invocation.context);
      // Every change is made as the import: its id is who acted, in events, in the source
      // of each value it set and of each tag it added. It has the system's powers, since
      // whoever started it was checked for what it does (imports.ts).
      const invocation: Invocation = {
        ...job.invocation,
        context: { ...job.invocation.context, actorKind: 'import', actorId: importId },
        permissions: 'all',
      };
      const claim = await runCommand(services, beginImportRunCommand, { importId }, invocation);
      if (claim.state === 'ended') return;
      const { runner, plan } = claim;

      const report = async (
        event: ImportProgress['event'],
        status: ImportStatus,
        processed: number,
        errorCode?: string,
      ): Promise<void> => {
        await options.onProgress?.({
          importId,
          businessId,
          event,
          status,
          processed,
          found: claim.found,
          ...(errorCode === undefined ? {} : { errorCode }),
        });
      };
      const end = async (
        status: 'completed' | 'cancelled',
        processed: number,
        errorFileId: string | undefined,
      ): Promise<void> => {
        const { ended } = await runCommand(
          services,
          finishImportCommand,
          { importId, runner, status, ...(errorFileId === undefined ? {} : { errorFileId }) },
          invocation,
        );
        if (ended) await report('ended', status, processed);
      };
      const fail = async (processed: number, errorCode: string, error: string): Promise<void> => {
        const { ended } = await runCommand(
          services,
          finishImportCommand,
          { importId, runner, status: 'failed', errorCode, error },
          invocation,
        );
        if (ended) await report('ended', 'failed', processed, errorCode);
      };

      if (files === undefined)
        return fail(
          claim.processed,
          'storage_unavailable',
          "The worker can't reach the stored files. Whoever runs this install must give the worker the same file storage settings as the app.",
        );
      const sourceId = claim.fileId === null ? undefined : toPublicId('file', claim.fileId);
      const open = async () => {
        const stored =
          sourceId === undefined ? undefined : await files.content(services, invocation, sourceId);
        return stored === undefined
          ? undefined
          : openCsvFile(await stored.open(), { delimiter: plan.delimiter });
      };

      let processed = claim.processed;
      const apply = async (batch: readonly CsvRow[]): Promise<ApplyResult['state']> => {
        const [first] = batch;
        if (first === undefined) return 'applied';
        const result = await runCommand(
          services,
          applyImportRowsCommand,
          {
            importId,
            runner,
            offset: first.index,
            rows: batch.map(({ row, cells }) => ({ row, cells: [...cells] })),
          },
          invocation,
        );
        if (result.state !== 'applied') return result.state;
        processed += batch.length;
        await report('batch', 'running', processed);
        return 'applied';
      };

      try {
        const source = await open();
        if (source === undefined) {
          await fail(processed, 'file_missing', 'The file this import reads is gone.');
          return;
        }
        let batch: CsvRow[] = [];
        let state: ApplyResult['state'] = 'applied';
        for await (const row of source.rows()) {
          // Dealt with by an earlier run of the job.
          if (row.index < claim.processed) continue;
          batch.push(row);
          if (batch.length < batchSize) continue;
          state = await apply(batch);
          batch = [];
          if (state !== 'applied') break;
        }
        if (state === 'applied') state = await apply(batch);
        // Another run has it, or it has ended: this run has nothing more to do.
        if (state === 'superseded') return;

        // The rows that were skipped or failed, as a file of their own.
        const some = await withTenant(services.db, invocation.context, (trx) =>
          trx
            .selectFrom('imports.job_rows')
            .select('row_number')
            .where('business_id', '=', businessId)
            .where('job_id', '=', importId)
            .where('outcome', 'in', ['skipped', 'failed'])
            .limit(1)
            .executeTakeFirst(),
        );
        const again = some === undefined ? undefined : await open();
        let errorFileId: string | undefined;
        if (again !== undefined) {
          try {
            const stored = await files.upload(services, invocation, {
              body: Readable.from(
                errorFileLines(again, notApplied(services, invocation, importId, outcomePage)),
              ),
              contentType: 'text/csv',
              filename: errorFileName(claim.fileName),
            });
            errorFileId = parsePublicId('file', stored.id);
          } catch (error) {
            // The rows not applied, with their reasons beside them, can be more than the
            // install takes as one file. The import still ends, with its counts and no file.
            again.close();
            if (!(error instanceof ContentTooLargeError)) throw error;
          }
        }
        await end(state === 'cancelled' ? 'cancelled' : 'completed', processed, errorFileId);
      } catch (error) {
        // The file itself can't be read as it was when the import began: the import ends,
        // with the rows already applied left as they are. Anything else is retried.
        if (!(error instanceof ImportFileError)) throw error;
        await fail(processed, error.code, error.message);
      }
    },
  });

  return [runImport];
}

const requeueInput = z.strictObject({ importId: z.uuid(), giveUpAfterHours: z.int().min(1) });

/**
 * Takes up an import that has made no progress: queues its job again, or, when it was
 * started too long ago to be worth it, ends it as failed so the business can import again.
 */
export const requeueImportCommand = defineCommand({
  name: 'import.requeue',
  permission: 'contacts.import',
  input: requeueInput,
  async handle(trx, input, command): Promise<'queued' | 'failed' | 'left'> {
    const businessId = requireBusiness(command.context);
    const job = await trx
      .selectFrom('imports.jobs')
      .select(['id', 'status', 'processed_count'])
      .select(
        sql<boolean>`created_at < now() - make_interval(hours => ${input.giveUpAfterHours})`.as(
          'old',
        ),
      )
      .where('business_id', '=', businessId)
      .where('id', '=', input.importId)
      .forUpdate()
      .executeTakeFirst();
    if (job?.status !== 'pending' && job?.status !== 'running') return 'left';
    if (job.old) {
      await trx
        .updateTable('imports.jobs')
        .set({
          status: 'failed',
          finished_at: sql<Date>`now()`,
          error_code: 'stalled',
          error:
            'The import stopped making progress and was closed. The rows it had applied are kept; import the rest again.',
        })
        .where('business_id', '=', businessId)
        .where('id', '=', job.id)
        .execute();
      await command.emit({
        type: 'import.failed',
        subject: { kind: 'import', id: job.id },
        payload: { processed: job.processed_count, errorCode: 'stalled' },
      });
      return 'failed';
    }
    // Touched, so the next sweep leaves it alone while this job waits its turn.
    await trx
      .updateTable('imports.jobs')
      .set({ heartbeat_at: sql<Date>`now()` })
      .where('business_id', '=', businessId)
      .where('id', '=', job.id)
      .execute();
    command.enqueue(runImportReference, { importId: job.id });
    return 'queued';
  },
});

/** How long an import may go without progress before the sweep takes it up. */
export const IMPORT_STALLED_AFTER_SECONDS = 300;
/** How long after it was started an import that still makes no progress is given up on. */
export const IMPORT_GIVE_UP_AFTER_HOURS = 24;

/**
 * The worker's sweep: every import, in any business, that waits or runs and has made no
 * progress for a while is queued again in its own business, as the system. Gives how many
 * were queued and how many were given up on.
 */
export async function recoverStalledImports(
  services: Services,
  options: { readonly stalledAfterSeconds?: number; readonly giveUpAfterHours?: number } = {},
): Promise<{ queued: number; failed: number }> {
  const stalledAfter = options.stalledAfterSeconds ?? IMPORT_STALLED_AFTER_SECONDS;
  const { rows } = await sql<{ agency_id: string; business_id: string; job_id: string }>`
    select agency_id, business_id, job_id
    from private.stalled_imports(make_interval(secs => ${stalledAfter}), ${100})
  `.execute(services.db);
  const done = { queued: 0, failed: 0 };
  for (const row of rows) {
    const outcome = await runCommand(
      services,
      requeueImportCommand,
      {
        importId: row.job_id,
        giveUpAfterHours: options.giveUpAfterHours ?? IMPORT_GIVE_UP_AFTER_HOURS,
      },
      {
        context: {
          agencyId: row.agency_id,
          businessId: row.business_id,
          actorKind: 'system',
          correlationId: randomUUID(),
        },
        permissions: 'all',
      },
    );
    if (outcome !== 'left') done[outcome] += 1;
  }
  return done;
}
