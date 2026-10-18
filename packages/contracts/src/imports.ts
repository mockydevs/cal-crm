// Imports: records read from a CSV file into the business, and the history of every import.
// A file is uploaded through the files service, looked at (inspect), tried (preview) and
// then imported by the worker, a batch of rows at a time; an import is a record that says
// who started it, how its columns were mapped and what became of its rows. The limits match
// imports.jobs and imports.job_rows.
import { actorKinds, csvDelimiters } from '@repo/kernel';
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { fieldValueTypes } from './fields.js';
import { fileLink } from './files.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The most rows of data one file may hold, not counting its header or its blank rows. */
export const MAX_IMPORT_ROWS = 100_000;
/** The most columns a file may have. */
export const MAX_IMPORT_COLUMNS = 200;
/** The most characters one cell may hold: the longest value any field takes. */
export const MAX_IMPORT_CELL_LENGTH = 100_000;
/** The most characters the cells of one row may hold together. */
export const MAX_IMPORT_ROW_LENGTH = 1_000_000;
/** The most tags an import may add to every contact it writes. */
export const MAX_IMPORT_TAGS = 20;
/** How many rows a preview shows unless asked for another number, and the most it shows. */
export const IMPORT_PREVIEW_ROWS = 10;
export const MAX_IMPORT_PREVIEW_ROWS = 50;
/** How many imports a page of the history holds unless asked, and the most it holds. */
export const IMPORT_PAGE_SIZE = 20;
export const MAX_IMPORT_PAGE_SIZE = 100;

/** Where an import reads from. Only a CSV file can be started through this API today. */
export const importSources = ['csv', 'ghl'] as const;
export type ImportSource = (typeof importSources)[number];

/** The kinds of record an import can be started for. */
export const importObjects = ['contact'] as const;
export type ImportObject = (typeof importObjects)[number];

/** The kinds of record a finished import may list: other sources write more kinds. */
export const importedObjects = ['contact', 'company', 'deal'] as const;

/**
 * Waiting for the worker, being applied, and the three ways it ends. An import that
 * completed may still have rows that failed: its counts say so.
 */
export const importStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export type ImportStatus = (typeof importStatuses)[number];

/**
 * What to do with a row, by whether its email address or phone number already belongs to
 * a contact:
 * - create: add new contacts only; a row whose contact exists is skipped;
 * - update: change existing contacts only; a row with no contact is skipped;
 * - create_and_update: both.
 * Whichever is chosen, no second contact is ever made for an address a contact holds.
 */
export const importModes = ['create', 'update', 'create_and_update'] as const;
export type ImportMode = (typeof importModes)[number];
/**
 * The mode of an import that names none: the one that changes no record the business
 * already has. A screen preselects the same one.
 */
export const DEFAULT_IMPORT_MODE: ImportMode = 'create';

/**
 * What a column can fill on a contact, besides its custom fields.
 * - additionalEmails, additionalPhones and tags take several values in one cell, separated
 *   by commas or semicolons. A tag is named as it is in Settings; none is created.
 * - doNotContact takes yes or no. Yes turns it on. No, or an empty cell, changes nothing:
 *   an import never turns do not contact off.
 */
export const contactImportAttributes = [
  'firstName',
  'lastName',
  'email',
  'additionalEmails',
  'phone',
  'additionalPhones',
  'timeZone',
  'doNotContact',
  'tags',
] as const;
export type ContactImportAttribute = (typeof contactImportAttributes)[number];

export const importTarget = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('attribute'),
      attribute: z.enum(contactImportAttributes),
    }),
    z.strictObject({ kind: z.literal('field'), fieldId: publicId('field') }),
  ])
  .meta({
    id: 'ImportTarget',
    description: "What a column fills: one of the contact's own attributes, or a custom field.",
  });
export type ImportTarget = z.infer<typeof importTarget>;

const columnIndex = z
  .int()
  .min(0)
  .max(MAX_IMPORT_COLUMNS - 1)
  .meta({ description: "The column's place in the file, from 0." });

export const importColumnMapping = z
  .strictObject({ column: columnIndex, target: importTarget })
  .meta({ id: 'ImportColumnMapping' });
export type ImportColumnMapping = z.infer<typeof importColumnMapping>;

/** The same target, whichever way it is written. */
export function importTargetKey(target: ImportTarget): string {
  return target.kind === 'attribute' ? `attribute:${target.attribute}` : `field:${target.fieldId}`;
}

const mapping = z
  .array(importColumnMapping)
  .min(1, { error: 'Map at least one column.' })
  .max(MAX_IMPORT_COLUMNS, { error: `Map at most ${String(MAX_IMPORT_COLUMNS)} columns.` })
  .superRefine((entries, context) => {
    const columns = new Set<number>();
    const targets = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (columns.has(entry.column))
        context.addIssue({
          code: 'custom',
          path: [index, 'column'],
          message: 'This column is already mapped.',
          params: { code: 'column_repeated' },
        });
      columns.add(entry.column);
      const key = importTargetKey(entry.target);
      if (targets.has(key))
        context.addIssue({
          code: 'custom',
          path: [index, 'target'],
          message: 'Another column already fills this.',
          params: { code: 'target_repeated' },
        });
      targets.add(key);
    }
  })
  .meta({
    description:
      'One entry for each column to import; a column left out is ignored. A column is mapped once, and nothing is filled by two columns.',
  });

const delimiter = z.enum(csvDelimiters).meta({
  description:
    'What separates the columns: a comma, a semicolon, a tab or a vertical bar. Left out, it is read from the first row.',
  examples: [','],
});

export const inspectImportFileInput = z
  .strictObject({
    fileId: publicId('file'),
    object: z.enum(importObjects),
    delimiter: delimiter.optional(),
  })
  .meta({ id: 'InspectImportFileInput' });

export const importPlanInput = z
  .strictObject({
    fileId: publicId('file'),
    object: z.enum(importObjects),
    mode: z.enum(importModes).default(DEFAULT_IMPORT_MODE).meta({
      description: 'Left out, it is create: new records are added and no existing one is changed.',
    }),
    mapping,
    delimiter: delimiter.optional(),
    tagIds: z
      .array(publicId('tag'))
      .max(MAX_IMPORT_TAGS, { error: `Add at most ${String(MAX_IMPORT_TAGS)} tags.` })
      .refine((ids) => new Set(ids).size === ids.length, { error: 'List each tag once.' })
      .default([])
      .meta({
        description: 'Tags to add to every contact the import creates or updates.',
      }),
  })
  .meta({
    id: 'ImportPlanInput',
    description:
      'A file and how to import it. Nothing here gives a contact consent to be messaged: an imported contact has the consent it had before, which for a new one is none.',
  });
export type ImportPlanInput = z.input<typeof importPlanInput>;

export const previewImportInput = importPlanInput
  .extend({
    rows: z
      .int()
      .min(1)
      .max(MAX_IMPORT_PREVIEW_ROWS)
      .default(IMPORT_PREVIEW_ROWS)
      .meta({ description: 'How many rows to show, from the first row of data.' }),
  })
  .meta({ id: 'PreviewImportInput' });

const importFile = z.looseObject({
  id: publicId('file'),
  filename: z.string().meta({ examples: ['contacts.csv'] }),
  size: z.int().min(0).meta({ description: 'In bytes.' }),
});

export const importFileColumn = z
  .looseObject({
    index: columnIndex,
    header: z.string().meta({ description: 'The first row’s cell.', examples: ['Email'] }),
    samples: z
      .array(z.string())
      .meta({ description: 'Up to three values from the first rows, cut to 100 characters.' }),
  })
  .meta({ id: 'ImportFileColumn' });

export const importableField = z
  .looseObject({
    id: publicId('field'),
    key: z.string().meta({ examples: ['event_date'] }),
    label: z.string().meta({ examples: ['Event date'] }),
    valueType: z.enum(fieldValueTypes),
  })
  .meta({ id: 'ImportableField', description: 'A custom field a column can fill.' });

export const importFileInspection = z
  .looseObject({
    file: importFile,
    delimiter: z.enum(csvDelimiters),
    columns: z.array(importFileColumn),
    rowCount: z.int().min(0).meta({
      description: 'The rows of data found: every row after the header that is not blank.',
    }),
    suggestedMapping: z.array(importColumnMapping).meta({
      description:
        'A mapping worked out from the column headers. Send it back as it is, or changed.',
    }),
    attributes: z.array(z.enum(contactImportAttributes)),
    fields: z.array(importableField),
    limits: z.looseObject({
      rows: z.int(),
      columns: z.int(),
      previewRows: z.int(),
      tags: z.int(),
    }),
  })
  .meta({ id: 'ImportFileInspection', description: 'What a file holds, before it is imported.' });
export type ImportFileInspection = z.infer<typeof importFileInspection>;

/** What a row would become: the outcomes a finished row has, said before the fact. */
export const importPreviewOutcomes = ['create', 'update', 'skip', 'fail'] as const;

export const importRowIssue = z
  .looseObject({
    column: columnIndex
      .nullable()
      .meta({ description: 'The column the problem is in; null when it is the whole row’s.' }),
    code: z.string().meta({ examples: ['invalid_format'] }),
    message: z.string().meta({ examples: ['Enter an email address, such as maya@example.com.'] }),
  })
  .meta({ id: 'ImportRowIssue' });
export type ImportRowIssue = z.infer<typeof importRowIssue>;

export const importPreviewRow = z
  .looseObject({
    row: z.int().min(2).meta({ description: 'The row’s number in the file; the header is row 1.' }),
    outcome: z.enum(importPreviewOutcomes),
    values: z.array(
      z.looseObject({
        column: columnIndex,
        target: importTarget,
        value: z
          .union([z.string(), z.boolean(), z.array(z.string())])
          .nullable()
          .meta({
            description:
              'The value as it would be stored: an email address in lower case, a phone number in E.164, a choice by its key. Null for an empty cell, which changes nothing.',
          }),
      }),
    ),
    issues: z.array(importRowIssue).meta({
      description: 'Why the row would be skipped or fail. Empty when it would be imported.',
    }),
  })
  .meta({ id: 'ImportPreviewRow' });
export type ImportPreviewRow = z.infer<typeof importPreviewRow>;

export const importPreview = z
  .looseObject({
    rows: z.array(importPreviewRow),
  })
  .meta({
    id: 'ImportPreview',
    description:
      'The first rows as the import would apply them now. Nothing is written. A row may come out differently when the import runs, if contacts change in between.',
  });
export type ImportPreview = z.infer<typeof importPreview>;

export const importCounts = z
  .looseObject({
    found: z.int().min(0).meta({ description: 'The rows of data the file holds.' }),
    processed: z.int().min(0).meta({ description: 'The rows dealt with so far.' }),
    created: z.int().min(0),
    updated: z.int().min(0),
    skipped: z.int().min(0).meta({
      description:
        'Rows left alone on purpose: the contact exists and only new ones are added, there is none and only existing ones are changed, or an earlier row of the file is the same contact.',
    }),
    failed: z.int().min(0).meta({ description: 'Rows that could not be imported.' }),
  })
  .meta({
    id: 'ImportCounts',
    description: 'processed is always created + updated + skipped + failed.',
  });

export const importJob = z
  .looseObject({
    id: publicId('import'),
    source: z.enum(importSources),
    objects: z.array(z.enum(importedObjects)),
    status: z.enum(importStatuses),
    fileName: z
      .string()
      .nullable()
      .meta({ examples: ['contacts.csv'] }),
    mode: z
      .enum(importModes)
      .nullable()
      .meta({ description: 'Null for an import that was not started from a file.' }),
    mapping: z.array(
      z.looseObject({
        column: columnIndex,
        header: z.string(),
        target: importTarget,
      }),
    ),
    tagIds: z.array(publicId('tag')),
    counts: importCounts,
    hasErrorFile: z.boolean().meta({
      description:
        'Whether a file of the rows that were skipped or failed, each with its reason, can be downloaded.',
    }),
    error: z
      .looseObject({ code: z.string(), message: z.string() })
      .nullable()
      .meta({ description: 'Why the import failed as a whole. Null unless its status is failed.' }),
    cancelRequested: z.boolean().meta({
      description: 'Someone asked for it to stop; it stops after the batch of rows in hand.',
    }),
    startedBy: z.looseObject({
      kind: z.enum(actorKinds),
      name: z.string().nullable().meta({ description: 'Null when they are gone.' }),
      you: z.boolean(),
    }),
    createdAt: timestamp.meta({ description: 'When it was started and queued.' }),
    startedAt: timestamp.nullable().meta({ description: 'When the worker took it up.' }),
    finishedAt: timestamp.nullable(),
    canCancel: z.boolean().meta({ description: 'Whether it can still be stopped, by you.' }),
  })
  .meta({ id: 'Import', description: 'One import, while it runs and in the history afterwards.' });
// Not Import, which TypeScript reserves in type positions next to import().
export type ImportJob = z.infer<typeof importJob>;

/**
 * What the history can be ordered by: one for each column of the Import data page. An
 * import that has not finished comes after every finished one when ordered by completed.
 */
export const importSorts = [
  'started',
  'completed',
  'source',
  'importedBy',
  'status',
  'objects',
  'found',
  'errors',
] as const;
export type ImportSort = (typeof importSorts)[number];

export const listImportsQuery = z
  .strictObject({
    sort: z.enum(importSorts).default('started'),
    direction: z.enum(['asc', 'desc']).default('desc').meta({
      description:
        'Ascending or descending. Imports equal in what they are ordered by keep the order they were started in.',
    }),
    status: z.enum(importStatuses).optional(),
    source: z.enum(importSources).optional(),
    object: z.enum(importedObjects).optional(),
    startedFrom: timestamp.optional().meta({ description: 'Started at or after this moment.' }),
    startedBefore: timestamp.optional().meta({ description: 'Started before this moment.' }),
    after: publicId('import')
      .optional()
      .meta({ description: "Start after this import: the previous page's next." }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_IMPORT_PAGE_SIZE)
      .default(IMPORT_PAGE_SIZE)
      .meta({ description: 'How many imports a page holds.' }),
  })
  .meta({ id: 'ListImportsQuery' });
export type ListImportsQuery = z.input<typeof listImportsQuery>;

export const importList = z
  .looseObject({
    items: z.array(importJob),
    next: publicId('import')
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    total: z.int().min(0).meta({ description: 'How many imports match the filters in all.' }),
  })
  .meta({
    id: 'ImportList',
    description: 'The history of imports: newest first unless another order is asked for.',
  });
export type ImportList = z.infer<typeof importList>;

/** Which import: as a path parameter, and as a command's input. */
export const importIdInput = z.object({ id: publicId('import') });

const group = 'Imports';

export const inspectImportFile = defineEndpoint({
  operationId: 'inspectImportFile',
  method: 'post',
  path: '/imports/inspect',
  summary: 'Read the columns of an uploaded CSV file and suggest a mapping',
  group,
  body: inspectImportFileInput,
  response: {
    status: 200,
    description:
      'The file’s columns, how many rows it holds and a suggested mapping. Nothing is saved. A file that is not UTF-8 CSV, or is over a limit, is refused with the row that shows it.',
    schema: importFileInspection,
  },
});

export const previewImport = defineEndpoint({
  operationId: 'previewImport',
  method: 'post',
  path: '/imports/preview',
  summary: 'Show the first rows of a file as an import would apply them',
  group,
  body: previewImportInput,
  response: {
    status: 200,
    description: 'What each of the first rows would become. Nothing is saved.',
    schema: importPreview,
  },
});

export const startImport = defineEndpoint({
  operationId: 'startImport',
  method: 'post',
  path: '/imports',
  summary: 'Start importing a CSV file',
  group,
  body: importPlanInput,
  response: {
    status: 201,
    description:
      'The import, waiting for the worker. One import waits or runs in a business at a time: a second is refused with 409 until the first has ended.',
    schema: importJob,
  },
});

export const listImports = defineEndpoint({
  operationId: 'listImports',
  method: 'get',
  path: '/imports',
  summary: 'List the history of imports, newest first',
  group,
  query: listImportsQuery,
  response: { status: 200, description: 'A page of imports.', schema: importList },
});

export const getImport = defineEndpoint({
  operationId: 'getImport',
  method: 'get',
  path: '/imports/{id}',
  summary: 'Read an import and how far it has got',
  group,
  params: importIdInput,
  response: { status: 200, description: 'The import.', schema: importJob },
});

export const cancelImport = defineEndpoint({
  operationId: 'cancelImport',
  method: 'post',
  path: '/imports/{id}/cancel',
  summary: 'Stop an import',
  group,
  params: importIdInput,
  response: {
    status: 200,
    description:
      'The import. One that was waiting is cancelled at once; one that is running stops after the batch of rows in hand, and the rows already imported stay. An import that has ended is returned as it is.',
    schema: importJob,
  },
});

export const createImportErrorFileLink = defineEndpoint({
  operationId: 'createImportErrorFileLink',
  method: 'post',
  path: '/imports/{id}/error-file-link',
  summary: 'Create a link to the file of rows an import did not apply',
  group,
  params: importIdInput,
  response: {
    status: 201,
    description:
      'A link that opens the CSV file for fifteen minutes: each row that was skipped or failed, as it was in the file, with its row number and the reason. Every cell is written so that a spreadsheet shows it as text.',
    schema: fileLink,
  },
});

/** How many of an import's rows a page holds unless asked, and the most it holds. */
export const IMPORT_ROWS_PAGE_SIZE = 50;
export const MAX_IMPORT_ROWS_PAGE_SIZE = 200;

/** What became of a row: it made a record, changed one, was left alone, or could not be read. */
export const importRowOutcomes = ['created', 'updated', 'skipped', 'failed'] as const;

export const listImportRowsQuery = z
  .strictObject({
    outcome: z
      .enum([...importRowOutcomes, 'not_applied'])
      .default('not_applied')
      .meta({
        description:
          'Which rows: one outcome, or not_applied for every row that was skipped or failed, which is what the error file lists.',
      }),
    after: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .meta({ description: "Start after this row: the previous page's next." }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_IMPORT_ROWS_PAGE_SIZE)
      .default(IMPORT_ROWS_PAGE_SIZE),
  })
  .meta({ id: 'ListImportRowsQuery' });

export const importRow = z
  .looseObject({
    row: z.int().min(2).meta({
      description:
        "The row's number in the file, as the preview and the error file give it; the header is row 1.",
    }),
    outcome: z.enum(importRowOutcomes),
    code: z
      .string()
      .nullable()
      .meta({
        description:
          'Why the row was skipped or failed, as a code. Null for a row that was applied.',
        examples: ['contact_exists'],
      }),
    message: z.string().nullable().meta({
      description:
        'The same in words, naming the column by its header. It never holds anything the row contained.',
    }),
  })
  .meta({ id: 'ImportRow' });
export type ImportRow = z.infer<typeof importRow>;

export const importRowList = z
  .looseObject({
    items: z.array(importRow),
    next: z
      .int()
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    total: z.int().min(0).meta({ description: 'How many rows match in all.' }),
  })
  .meta({ id: 'ImportRowList', description: "An import's rows, in the file's order." });
export type ImportRowList = z.infer<typeof importRowList>;

export const listImportRows = defineEndpoint({
  operationId: 'listImportRows',
  method: 'get',
  path: '/imports/{id}/rows',
  summary: 'Read what became of an import’s rows, without the error file',
  group,
  params: importIdInput,
  query: listImportRowsQuery,
  response: {
    status: 200,
    description:
      'A page of rows with the outcome of each and, for a row that was not applied, the reason. Unless another outcome is asked for, the rows that were skipped or failed.',
    schema: importRowList,
  },
});

export const importEndpoints = [
  inspectImportFile,
  previewImport,
  startImport,
  listImports,
  getImport,
  listImportRows,
  cancelImport,
  createImportErrorFileLink,
] as const;
