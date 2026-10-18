// The import API. Three of its routes change nothing and so run no command: inspect and
// preview read a file, and the error file link signs a link. All of them, and the two
// reads, still need contacts.import: an import's file and its error file hold whatever the
// uploaded file held.
import {
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Route,
  type Services,
} from '@repo/commands';
import {
  cancelImport,
  contactImportAttributes,
  createImportErrorFileLink,
  getImport,
  importPlanInput,
  inspectImportFile,
  inspectImportFileInput,
  listImportRows,
  listImports,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_PREVIEW_ROWS,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_TAGS,
  parseInput,
  previewImport,
  previewImportInput,
  startImport,
  type ImportPreviewRow,
  type StoredFile,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  toPublicId,
  ValidationError,
  type CsvDelimiter,
} from '@repo/kernel';

import type { ActorNames } from '../activity/activity.js';
import { readFields } from '../fields/fields.js';
import {
  cellOf,
  ImportFileError,
  IMPORT_FILE_LIMITS,
  openCsvFile,
  type CsvFile,
  type CsvFileLimits,
} from './csv-file.js';
import {
  cancelImportCommand,
  checkImportPlan,
  readImport,
  readImportList,
  readImportRows,
  startImportCommand,
} from './imports.js';
import { importable, suggestMapping } from './mapping.js';
import { loadPlanContext, planRow, rememberedRows } from './plan.js';
import type { ImportFiles } from './run.js';
import { findImport } from './store.js';

export interface ImportRouteOptions {
  readonly files: ImportFiles;
  /** PUBLIC_URL/api/v1: a link to the error file is absolute, under it. */
  readonly apiUrl: string;
  /** Names who started an import. */
  readonly actorNames?: ActorNames;
  /** The most a file may hold. Tests lower them; an install takes the contract's. */
  readonly limits?: CsvFileLimits;
}

/** How long a link to an import's error file works. */
export const ERROR_FILE_LINK_SECONDS = 900;

// The types the files service stores a CSV file under (its types.ts).
const CSV_TYPES = ['text/csv', 'text/plain'];

const fileIssue = (code: string, message: string): ValidationError =>
  new ValidationError([{ path: '/fileId', code, message }]);

/** Reading for an import is a read that needs a permission, and a refusal is audited. */
function requireImportAccess(
  services: Services,
  invocation: Invocation,
  name: string,
): Promise<void> {
  return requirePermission(services, { name, permission: 'contacts.import' }, invocation);
}

/** Runs the work on a file's rows, saying what is wrong with the file where it can't. */
async function reading<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ImportFileError) throw fileIssue(error.code, error.message);
    throw error;
  }
}

export function createImportRoutes(options: ImportRouteOptions): ApiRoute[] {
  const { files, apiUrl } = options;
  const actorNames = options.actorNames ?? {};
  const limits = options.limits ?? IMPORT_FILE_LIMITS;

  /** The business's own stored file, opened as CSV. The caller reads it or closes it. */
  async function open(
    services: Services,
    invocation: Invocation,
    fileId: string,
    delimiter: CsvDelimiter | undefined,
  ): Promise<{ stored: StoredFile; csv: CsvFile }> {
    const content = await files.content(services, invocation, fileId);
    if (content === undefined) throw fileIssue('not_found', 'There is no file with this id.');
    if (content.shared)
      throw fileIssue(
        'file_shared',
        'This file belongs to the agency, not to this business. Upload it in the business.',
      );
    if (!CSV_TYPES.includes(content.file.contentType))
      throw fileIssue('not_csv', 'This file is not a CSV file. Upload it as CSV.');
    const csv = await reading(async () => openCsvFile(await content.open(), { delimiter, limits }));
    return { stored: content.file, csv };
  }

  const inspect = {
    endpoint: inspectImportFile,
    async run({ invocation, body }, services) {
      await requireImportAccess(services, invocation, 'import.inspect');
      const input = parseInput(inspectImportFileInput, body);
      const { stored, csv } = await open(services, invocation, input.fileId, input.delimiter);
      const columns = csv.header.map((header, index) => ({
        index,
        header,
        samples: [] as string[],
      }));
      const rowCount = await reading(async () => {
        let rows = 0;
        for await (const row of csv.rows()) {
          rows += 1;
          for (const column of columns) {
            const cell = cellOf(row, column.index);
            if (cell !== '' && column.samples.length < 3) column.samples.push(cell.slice(0, 100));
          }
        }
        return rows;
      });
      const { items } = await withTenant(services.db, invocation.context, (trx) =>
        readFields(trx, invocation),
      );
      const fields = items.filter(
        (field) => field.objectKey === 'contact' && !field.archived && importable(field),
      );
      return {
        file: { id: stored.id, filename: stored.filename, size: stored.size },
        delimiter: csv.delimiter,
        columns,
        rowCount,
        suggestedMapping: suggestMapping(csv.header, fields),
        attributes: [...contactImportAttributes],
        fields: fields.map(({ id, key, label, valueType }) => ({ id, key, label, valueType })),
        limits: {
          rows: Math.min(limits.rows, MAX_IMPORT_ROWS),
          columns: Math.min(limits.columns, MAX_IMPORT_COLUMNS),
          previewRows: MAX_IMPORT_PREVIEW_ROWS,
          tags: MAX_IMPORT_TAGS,
        },
      };
    },
  } satisfies Route<typeof inspectImportFile>;

  const preview = {
    endpoint: previewImport,
    async run({ invocation, body }, services) {
      await requireImportAccess(services, invocation, 'import.preview');
      const input = parseInput(previewImportInput, body);
      const businessId = requireBusiness(invocation.context);
      const { csv } = await open(services, invocation, input.fileId, input.delimiter);
      try {
        return await withTenant(services.db, invocation.context, async (trx) => {
          await checkImportPlan(trx, invocation, input, csv.header.length);
          const context = await loadPlanContext(trx, invocation, {
            businessId,
            mode: input.mode,
            mapping: input.mapping,
            header: csv.header,
            tagIds: input.tagIds,
          });
          const earlier = rememberedRows();
          const rows: ImportPreviewRow[] = [];
          await reading(async () => {
            for await (const row of csv.rows()) {
              const planned = await planRow(trx, context, row, earlier);
              earlier.note(planned);
              rows.push({
                row: planned.row,
                outcome: planned.plan.outcome,
                values: planned.values.map((value) => ({ ...value })),
                issues:
                  planned.plan.outcome === 'skip' || planned.plan.outcome === 'fail'
                    ? [...planned.plan.issues]
                    : [],
              });
              if (rows.length >= input.rows) break;
            }
          });
          return { rows };
        });
      } finally {
        csv.close();
      }
    },
  } satisfies Route<typeof previewImport>;

  const start = {
    endpoint: startImport,
    command: startImportCommand,
    async run({ invocation, body }, services) {
      // Before the file is read: someone whose role can't import reads nothing in vain.
      await requirePermission(services, startImportCommand, invocation);
      const plan = parseInput(importPlanInput, body);
      const { stored, csv } = await open(services, invocation, plan.fileId, plan.delimiter);
      // The whole file, once: how many rows it holds, and that all of it can be read.
      const rowCount = await reading(async () => {
        const rows = csv.rows();
        let count = 0;
        while ((await rows.next()).done !== true) count += 1;
        return count;
      });
      if (rowCount === 0)
        throw fileIssue('file_empty', 'This file has a header and no rows of data.');
      const { id } = await runCommand(
        services,
        startImportCommand,
        {
          plan,
          file: {
            name: stored.filename,
            header: [...csv.header],
            rowCount,
            delimiter: csv.delimiter,
          },
        },
        invocation,
      );
      return withTenant(services.db, invocation.context, (trx) =>
        readImport(trx, invocation, id, actorNames),
      );
    },
  } satisfies Route<typeof startImport>;

  const list = {
    endpoint: listImports,
    async run({ invocation, query }, services) {
      await requireImportAccess(services, invocation, 'import.list');
      const parsed = parseInput(listImports.query, query);
      return withTenant(services.db, invocation.context, (trx) =>
        readImportList(trx, invocation, parsed, actorNames),
      );
    },
  } satisfies Route<typeof listImports>;

  const read = {
    endpoint: getImport,
    async run({ invocation, params }, services) {
      await requireImportAccess(services, invocation, 'import.read');
      const { id } = parseInput(getImport.params, params);
      return withTenant(services.db, invocation.context, (trx) =>
        readImport(trx, invocation, id, actorNames),
      );
    },
  } satisfies Route<typeof getImport>;

  const rows = {
    endpoint: listImportRows,
    async run({ invocation, params, query }, services) {
      await requireImportAccess(services, invocation, 'import.rows');
      const { id } = parseInput(listImportRows.params, params);
      // The import before its query: another business's import is not found, whatever
      // was asked about it.
      await withTenant(services.db, invocation.context, async (trx) => {
        if ((await findImport(trx, requireBusiness(invocation.context), id)) === undefined)
          throw new NotFoundError('Import', id);
      });
      const parsed = parseInput(listImportRows.query, query);
      return withTenant(services.db, invocation.context, (trx) =>
        readImportRows(trx, invocation, id, parsed),
      );
    },
  } satisfies Route<typeof listImportRows>;

  const cancel = {
    endpoint: cancelImport,
    command: cancelImportCommand,
    async run({ invocation, params }, services) {
      const { id } = await runCommand(
        services,
        cancelImportCommand,
        parseInput(cancelImport.params, params),
        invocation,
      );
      return withTenant(services.db, invocation.context, (trx) =>
        readImport(trx, invocation, id, actorNames),
      );
    },
  } satisfies Route<typeof cancelImport>;

  const errorFileLink = {
    endpoint: createImportErrorFileLink,
    async run({ invocation, params }, services) {
      await requireImportAccess(services, invocation, 'import.error_file');
      const { id } = parseInput(createImportErrorFileLink.params, params);
      const row = await withTenant(services.db, invocation.context, (trx) =>
        findImport(trx, requireBusiness(invocation.context), id),
      );
      if (row === undefined) throw new NotFoundError('Import', id);
      if (row.error_file_id === null)
        throw new ConflictError('This import has no file of rows that were not applied.');
      const link = await files.link(services, invocation, toPublicId('file', row.error_file_id), {
        seconds: ERROR_FILE_LINK_SECONDS,
      });
      return { url: `${apiUrl}${link.path}`, expiresAt: link.expiresAt };
    },
  } satisfies Route<typeof createImportErrorFileLink>;

  return [inspect, preview, start, list, read, rows, cancel, errorFileLink];
}
