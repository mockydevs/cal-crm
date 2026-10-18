// The import API against a migrated Postgres: looking at a file, previewing it, starting
// and stopping an import, and the history of imports. What the worker then does with an
// import is run.int.test.ts.
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  importFileInspection,
  importJob,
  importList,
  importPreview,
  fileLink,
  type ImportJob,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  attribute,
  customField,
  importApi,
  memoryFiles,
  runImportJob,
  uploadCsv,
  workspace,
  type Workspace,
} from '../../test/imports.js';
import { createFieldCommand } from '../fields/fields.js';
import { createTagCommand } from '../tags/tags.js';
import { IMPORT_FILE_LIMITS } from './csv-file.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let files: ReturnType<typeof memoryFiles>;
let api: ReturnType<typeof importApi>;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  files = memoryFiles(db);
  api = importApi(services, files, {
    // As the server's reader of people's names answers, for the people these tests name.
    actorNames: {
      user: (_trx, ids) =>
        Promise.resolve(
          new Map(ids.flatMap((id) => (id === dana?.userId ? [[id, 'Dana Brooks'] as const] : []))),
        ),
    },
  });
});

/** The workspace whose owner the name reader knows as Dana Brooks. */
let dana: Workspace | undefined;
async function danasWorkspace(): Promise<Workspace> {
  dana = await workspace(database);
  return dana;
}
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const upload = (who: Invocation, content: string | Buffer, filename?: string, type?: string) =>
  uploadCsv(files, services, who, content, filename, type);

async function field(who: Invocation, key: string, valueType = 'text', label = key) {
  return runCommand(
    services,
    createFieldCommand,
    {
      objectKey: 'contact',
      key,
      label,
      description: 'For the import tests.',
      valueType,
      currency: valueType === 'money' ? 'KES' : null,
      options:
        valueType === 'single_choice'
          ? [{ key: 'opt_gold', label: 'Gold', description: '', archived: false }]
          : [],
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
    },
    who,
  );
}

const tag = (who: Invocation, name: string) =>
  runCommand(services, createTagCommand, { name, description: '' }, who);

/** A contact already in the business, with an email address and perhaps a phone number. */
async function existing(space: Workspace, email: string, phone?: string): Promise<string> {
  const contact = await database.fixtures.contact(space.owner.context, {
    firstName: 'Already',
    lastName: 'Here',
    email,
  });
  if (phone !== undefined)
    await database.withTenant(space.owner.context, (sql) =>
      sql.query(
        `insert into crm.contact_identities
           (business_id, contact_id, kind, value, value_normalized, is_primary)
         values (app.business_id(), $1, 'phone', $2, $2, true)`,
        [contact.id, phone],
      ),
    );
  return contact.id;
}

async function issuesOf(work: Promise<unknown>): Promise<{ path: string; code: string }[]> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ValidationError)
      return error.issues.map(({ path, code }) => ({ path, code }));
    throw error;
  }
  throw new Error('The request was accepted.');
}

const counts = (table: string, businessId: string): Promise<number> =>
  database
    .as('crm_owner', (sql) =>
      sql.one<{ count: string }>(`select count(*) from ${table} where business_id = $1`, [
        businessId,
      ]),
    )
    .then((row) => Number(row.count));

const plan = (fileId: string, changes: Record<string, unknown> = {}) => ({
  fileId,
  object: 'contact',
  mode: 'create',
  mapping: [
    { column: 0, target: attribute('firstName') },
    { column: 1, target: attribute('email') },
  ],
  ...changes,
});

const start = async (who: Invocation, body: unknown): Promise<ImportJob> =>
  importJob.parse(await api.call('startImport', who, { body }));

describe('inspecting a file', () => {
  it('gives its columns with samples, its row count and a mapping read from the headers', async () => {
    const space = await workspace(database);
    const eventDate = await field(space.owner, 'event_date', 'date', 'Event date');
    await field(space.owner, 'old_notes', 'text', 'Old notes');
    const file = await upload(
      space.owner,
      'First Name;E-mail;Event date;Favourite colour\r\n' +
        'Maya;maya@example.test;2026-12-24;\r\n' +
        ';kip@example.test;;Teal\r\n' +
        '\r\n' +
        'Zoë;;;\r\n' +
        'Ann;ann@example.test;2027-01-02;Red\r\n' +
        'Ben;ben@example.test;;Blue\r\n',
    );

    const inspection = importFileInspection.parse(
      await api.call('inspectImportFile', space.owner, {
        body: { fileId: file.id, object: 'contact' },
      }),
    );

    expect(inspection).toMatchObject({
      file: { id: file.id, filename: 'contacts.csv', size: file.size },
      delimiter: ';',
      rowCount: 5,
      columns: [
        { index: 0, header: 'First Name', samples: ['Maya', 'Zoë', 'Ann'] },
        {
          index: 1,
          header: 'E-mail',
          samples: ['maya@example.test', 'kip@example.test', 'ann@example.test'],
        },
        { index: 2, header: 'Event date', samples: ['2026-12-24', '2027-01-02'] },
        { index: 3, header: 'Favourite colour', samples: ['Teal', 'Red', 'Blue'] },
      ],
      suggestedMapping: [
        { column: 0, target: attribute('firstName') },
        { column: 1, target: attribute('email') },
        { column: 2, target: customField(eventDate.id) },
      ],
      limits: { rows: 100_000, columns: 200, previewRows: 50, tags: 20 },
    });
    expect(inspection.attributes).toContain('doNotContact');
    expect(inspection.attributes).not.toContain('consent');
    expect(inspection.fields.map(({ key, valueType }) => ({ key, valueType }))).toEqual([
      { key: 'event_date', valueType: 'date' },
      { key: 'old_notes', valueType: 'text' },
    ]);
  });

  it('cuts a long sample short, and reads the delimiter it is told', async () => {
    const space = await workspace(database);
    const file = await upload(space.owner, `Name;Note\r\nMaya;${'x'.repeat(300)}\r\n`);
    const told = importFileInspection.parse(
      await api.call('inspectImportFile', space.owner, {
        body: { fileId: file.id, object: 'contact', delimiter: ',' },
      }),
    );
    expect(told.delimiter).toBe(',');
    expect(told.columns).toEqual([
      { index: 0, header: 'Name;Note', samples: [`Maya;${'x'.repeat(95)}`] },
    ]);
  });

  it('refuses a file that is not there, not the business’s own, or not CSV', async () => {
    const space = await workspace(database);
    const other = await workspace(database);
    const theirs = await upload(other.owner, 'Name\r\nMaya\r\n');
    const { businessId: _business, ...agencyContext } = space.owner.context;
    const shared = await upload({ ...space.owner, context: agencyContext }, 'Name\r\nMaya\r\n');
    const image = await upload(space.owner, Buffer.from([0x89, 0x50]), 'logo.png', 'image/png');
    const inspect = (fileId: string) =>
      issuesOf(api.call('inspectImportFile', space.owner, { body: { fileId, object: 'contact' } }));

    expect(await inspect(theirs.id)).toEqual([{ path: '/fileId', code: 'not_found' }]);
    expect(await inspect('file_01h455vb4pex5vsknk084sn02q')).toEqual([
      { path: '/fileId', code: 'not_found' },
    ]);
    expect(await inspect(shared.id)).toEqual([{ path: '/fileId', code: 'file_shared' }]);
    expect(await inspect(image.id)).toEqual([{ path: '/fileId', code: 'not_csv' }]);
  });

  it('refuses a file it cannot read as CSV, saying which row shows it', async () => {
    const space = await workspace(database);
    const refusal = async (content: string | Buffer) => {
      const file = await upload(space.owner, content);
      try {
        await api.call('inspectImportFile', space.owner, {
          body: { fileId: file.id, object: 'contact' },
        });
      } catch (error) {
        if (error instanceof ValidationError) return error.issues;
        throw error;
      }
      throw new Error('The file was read.');
    };

    expect(await refusal(Buffer.from('Name\r\nZoë', 'latin1'))).toEqual([
      {
        path: '/fileId',
        code: 'not_utf8',
        message:
          'This file is not saved as UTF-8. Save it as "CSV UTF-8" in your spreadsheet and upload it again.',
      },
    ]);
    expect(await refusal('Name,Email\r\nMaya,m@example.test\r\nKip,"k@example.test\r\n')).toEqual([
      {
        path: '/fileId',
        code: 'unterminated_quote',
        message: 'Row 3 opens a quotation mark that is never closed.',
      },
    ]);
    expect(await refusal('\r\nMaya,m@example.test\r\n')).toMatchObject([
      { path: '/fileId', code: 'header_missing' },
    ]);
  });

  it('refuses a file over the row limit, and takes one exactly at it', async () => {
    const space = await workspace(database);
    const small = importApi(services, files, { limits: { ...IMPORT_FILE_LIMITS, rows: 3 } });
    const rows = (count: number) =>
      `Email\r\n${Array.from({ length: count }, (_row, at) => `p${String(at)}@example.test`).join('\r\n')}\r\n`;
    const atLimit = await upload(space.owner, rows(3));
    const over = await upload(space.owner, rows(4));

    expect(
      importFileInspection.parse(
        await small.call('inspectImportFile', space.owner, {
          body: { fileId: atLimit.id, object: 'contact' },
        }),
      ),
    ).toMatchObject({ rowCount: 3, limits: { rows: 3 } });
    for (const operation of ['inspectImportFile', 'startImport'])
      expect(
        await issuesOf(
          small.call(operation, space.owner, {
            body:
              operation === 'startImport'
                ? plan(over.id, { mapping: [{ column: 0, target: attribute('email') }] })
                : { fileId: over.id, object: 'contact' },
          }),
        ),
      ).toEqual([{ path: '/fileId', code: 'too_many_rows' }]);
    expect(await counts('imports.jobs', space.businessId)).toBe(0);
  });
});

describe('previewing an import', () => {
  it('shows what each of the first rows would become, with its values as they would be stored', async () => {
    const space = await workspace(database, { country: 'KE' });
    const budget = await field(space.owner, 'budget', 'money', 'Budget');
    const tier = await field(space.owner, 'tier', 'single_choice', 'Tier');
    await existing(space, 'here@example.test');
    const file = await upload(
      space.owner,
      'First,Email,Phone,Zone,Budget,Tier,Other\r\n' +
        ' Maya ,Maya@Example.TEST,0712 345678,africa/nairobi,"1,250.50",gold,ignored\r\n' +
        'Here,here@example.test,,,,,\r\n' +
        'Bad,not-an-email,12,Mars/Olympus,lots,platinum,\r\n' +
        'Maya again,maya@example.test,,,,,\r\n',
    );
    const mapping = [
      { column: 0, target: attribute('firstName') },
      { column: 1, target: attribute('email') },
      { column: 2, target: attribute('phone') },
      { column: 3, target: attribute('timeZone') },
      { column: 4, target: customField(budget.id) },
      { column: 5, target: customField(tier.id) },
    ];

    const preview = importPreview.parse(
      await api.call('previewImport', space.owner, { body: plan(file.id, { mapping }) }),
    );

    expect(preview.rows.map(({ row, outcome }) => ({ row, outcome }))).toEqual([
      { row: 2, outcome: 'create' },
      { row: 3, outcome: 'skip' },
      { row: 4, outcome: 'fail' },
      { row: 5, outcome: 'skip' },
    ]);
    expect(preview.rows[0]?.values.map((each) => each.value)).toEqual([
      'Maya',
      'maya@example.test',
      '+254712345678',
      'Africa/Nairobi',
      '1250.50',
      'opt_gold',
    ]);
    expect(preview.rows[0]?.issues).toEqual([]);
    expect(preview.rows[1]?.issues).toEqual([
      {
        column: null,
        code: 'exists',
        message:
          'A contact already has this email address or phone number, and this import only adds new contacts.',
      },
    ]);
    expect(preview.rows[2]?.issues.map(({ column, code }) => ({ column, code }))).toEqual([
      { column: 4, code: 'number_unreadable' },
      { column: 5, code: 'choice_unknown' },
      { column: 1, code: 'invalid_format' },
      { column: 2, code: 'phone_invalid' },
      { column: 3, code: 'time_zone_unknown' },
    ]);
    expect(preview.rows[3]?.issues).toEqual([
      {
        column: null,
        code: 'duplicate_in_file',
        message: 'Row 2 of this file is the same contact.',
      },
    ]);
  });

  it('writes nothing', async () => {
    const space = await workspace(database);
    const file = await upload(space.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const before = await Promise.all(
      ['crm.contacts', 'events.events', 'imports.jobs'].map((table) =>
        counts(table, space.businessId),
      ),
    );

    await api.call('previewImport', space.owner, { body: plan(file.id) });

    expect(
      await Promise.all(
        ['crm.contacts', 'events.events', 'imports.jobs'].map((table) =>
          counts(table, space.businessId),
        ),
      ),
    ).toEqual(before);
  });

  it('shows as many rows as asked, ten unless said, and reads no further', async () => {
    const space = await workspace(database);
    const body = Array.from(
      { length: 40 },
      (_row, at) => `P${String(at)},p${String(at)}@example.test`,
    );
    // Past what any preview reads, the file is broken: a preview never gets there.
    const file = await upload(space.owner, `First,Email\r\n${body.join('\r\n')}\r\n"broken`);
    const rows = async (asked?: number) =>
      importPreview.parse(
        await api.call('previewImport', space.owner, {
          body: plan(file.id, asked === undefined ? {} : { rows: asked }),
        }),
      ).rows.length;

    expect(await rows()).toBe(10);
    expect(await rows(3)).toBe(3);
    expect(await rows(40)).toBe(40);
  });

  it('follows the mode: updating shows existing contacts as updates and new rows as skipped', async () => {
    const space = await workspace(database);
    await existing(space, 'here@example.test');
    const file = await upload(
      space.owner,
      'First,Email\r\nHere,HERE@example.test\r\nNew,new@example.test\r\nNameless,\r\n',
    );
    const outcomes = async (mode: string) =>
      importPreview
        .parse(await api.call('previewImport', space.owner, { body: plan(file.id, { mode }) }))
        .rows.map((row) => [row.outcome, row.issues[0]?.code ?? null]);

    expect(await outcomes('create')).toEqual([
      ['skip', 'exists'],
      ['create', null],
      ['create', null],
    ]);
    expect(await outcomes('update')).toEqual([
      ['update', null],
      ['skip', 'no_contact'],
      ['skip', 'no_contact'],
    ]);
    expect(await outcomes('create_and_update')).toEqual([
      ['update', null],
      ['create', null],
      ['create', null],
    ]);
  });

  it('refuses a mapping no import could run, pointing at what is wrong', async () => {
    const space = await workspace(database);
    const other = await workspace(database);
    const theirField = await field(other.owner, 'budget');
    const theirTag = await tag(other.owner, 'Theirs');
    const file = await upload(space.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const refused = (changes: Record<string, unknown>) =>
      issuesOf(api.call('previewImport', space.owner, { body: plan(file.id, changes) }));

    expect(await refused({ mapping: [{ column: 2, target: attribute('email') }] })).toEqual([
      { path: '/mapping/0/column', code: 'column_unknown' },
    ]);
    expect(
      await refused({
        mapping: [
          { column: 0, target: attribute('email') },
          { column: 1, target: customField(theirField.id) },
        ],
      }),
    ).toEqual([{ path: '/mapping/1/target/fieldId', code: 'field_unknown' }]);
    expect(await refused({ mapping: [{ column: 0, target: attribute('tags') }] })).toEqual([
      { path: '/mapping', code: 'nothing_to_identify' },
    ]);
    expect(
      await refused({ mode: 'update', mapping: [{ column: 0, target: attribute('firstName') }] }),
    ).toEqual([{ path: '/mapping', code: 'nothing_to_match' }]);
    expect(await refused({ tagIds: [theirTag.id] })).toEqual([
      { path: '/tagIds/0', code: 'not_found' },
    ]);
    // The same answers when the import is started, and nothing is stored.
    expect(
      await issuesOf(
        api.call('startImport', space.owner, {
          body: plan(file.id, { mapping: [{ column: 2, target: attribute('email') }] }),
        }),
      ),
    ).toEqual([{ path: '/mapping/0/column', code: 'column_unknown' }]);
    expect(await counts('imports.jobs', space.businessId)).toBe(0);
  });
});

describe('starting an import', () => {
  it('stores what was asked for, says who asked, and queues the job', async () => {
    const space = await danasWorkspace();
    const vip = await tag(space.owner, 'VIP');
    const file = await upload(
      space.owner,
      'First;Email\r\nMaya;maya@example.test\r\nKip;kip@example.test\r\n',
      'October leads.csv',
    );

    const started = await start(
      space.owner,
      plan(file.id, { mode: 'create_and_update', tagIds: [vip.id] }),
    );

    expect(started).toMatchObject({
      source: 'csv',
      objects: ['contact'],
      status: 'pending',
      fileName: 'October leads.csv',
      mode: 'create_and_update',
      mapping: [
        { column: 0, header: 'First', target: attribute('firstName') },
        { column: 1, header: 'Email', target: attribute('email') },
      ],
      tagIds: [vip.id],
      counts: { found: 2, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
      hasErrorFile: false,
      error: null,
      cancelRequested: false,
      startedBy: { kind: 'user', name: 'Dana Brooks', you: true },
      startedAt: null,
      finishedAt: null,
      canCancel: true,
    });
    const importId = parsePublicId('import', started.id);
    const [stored] = await database.as('crm_owner', (sql) =>
      sql.query<{ settings: unknown; file_id: string; created_by_id: string }>(
        'select settings, file_id, created_by_id from imports.jobs where id = $1',
        [importId],
      ),
    );
    expect(stored).toEqual({
      settings: {
        object: 'contact',
        mode: 'create_and_update',
        delimiter: ';',
        columns: 2,
        tagIds: [vip.id],
      },
      file_id: parsePublicId('file', file.id),
      created_by_id: space.userId,
    });
    // The job, as the worker receives it, in the business that started it.
    expect(await database.runJobs(['imports.run'])).toEqual([
      {
        task: 'imports.run',
        payload: expect.objectContaining({
          businessId: space.businessId,
          data: { importId },
        }) as unknown,
      },
    ]);
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string; subject_id: string; payload: unknown; actor_id: string }>(
        `select type, subject_id, payload, actor_id from events.events
         where business_id = $1 and type like 'import.%'`,
        [space.businessId],
      ),
    );
    expect(events).toEqual([
      {
        type: 'import.started',
        subject_id: importId,
        payload: { source: 'csv', objects: ['contact'], mode: 'create_and_update', rows: 2 },
        actor_id: space.userId,
      },
    ]);
  });

  it('keeps the file’s name, its headers and its values out of the audit log', async () => {
    const space = await workspace(database);
    const file = await upload(
      space.owner,
      'Secret header,Email\r\nMaya,maya@example.test\r\n',
      'private-list.csv',
    );

    await start(space.owner, plan(file.id));

    const audited = await database.as('crm_owner', (sql) =>
      sql.query<{ command: string; outcome: string; input: unknown }>(
        `select command, outcome, input from audit.commands
         where business_id = $1 and command like 'import.%'`,
        [space.businessId],
      ),
    );
    expect(audited).toEqual([
      {
        command: 'import.start',
        outcome: 'ok',
        input: { fileId: file.id, object: 'contact', mode: 'create', columns: 2, tags: 0, rows: 1 },
      },
    ]);
    expect(JSON.stringify(audited)).not.toMatch(/Secret|private-list|maya/i);
  });

  it('lets one import wait or run in a business at a time', async () => {
    const space = await workspace(database);
    const other = await workspace(database);
    const file = await upload(space.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const theirs = await upload(other.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const first = await start(space.owner, plan(file.id));

    await expect(start(space.owner, plan(file.id))).rejects.toThrow(
      new ConflictError(
        'An import is already waiting or running in this business. Wait for it to finish, or stop it.',
      ),
    );
    // Another business is not held up, and this one is free again once the first has ended.
    await start(other.owner, plan(theirs.id));
    await runImportJob(services, files, space.system, first.id);
    expect((await start(space.owner, plan(file.id))).status).toBe('pending');
    expect(await counts('imports.jobs', space.businessId)).toBe(2);
  });

  it('refuses a file with a header and no rows', async () => {
    const space = await workspace(database);
    const file = await upload(space.owner, 'First,Email\r\n\r\n , \r\n');
    expect(await issuesOf(api.call('startImport', space.owner, { body: plan(file.id) }))).toEqual([
      { path: '/fileId', code: 'file_empty' },
    ]);
  });

  it('needs contacts.import, and whatever its rows would need one at a time', async () => {
    const space = await workspace(database);
    const vip = await tag(space.owner, 'VIP');
    const notes = await field(space.owner, 'notes');
    const file = await upload(
      space.owner,
      'First,Email,Notes,Tags\r\nMaya,maya@example.test,x,VIP\r\n',
    );
    const refusedFor = async (permissions: Parameters<Workspace['as']>[0], changes = {}) => {
      try {
        await api.call('startImport', space.as(permissions), { body: plan(file.id, changes) });
      } catch (error) {
        if (error instanceof ForbiddenError) return error.permission;
        throw error;
      }
      return undefined;
    };
    const withField = {
      mapping: [...plan(file.id).mapping, { column: 2, target: customField(notes.id) }],
    };
    const withTagColumn = {
      mapping: [...plan(file.id).mapping, { column: 3, target: attribute('tags') }],
    };

    // Someone whose daily work is contacts, tags and field values may not import.
    expect(await refusedFor(['contacts.manage', 'tags.manage', 'fields.values'])).toBe(
      'contacts.import',
    );
    expect(await refusedFor(['contacts.import'])).toBe('contacts.manage');
    expect(await refusedFor(['contacts.import', 'contacts.manage'], { tagIds: [vip.id] })).toBe(
      'tags.manage',
    );
    expect(await refusedFor(['contacts.import', 'contacts.manage'], withTagColumn)).toBe(
      'tags.manage',
    );
    expect(await refusedFor(['contacts.import', 'contacts.manage'], withField)).toBe(
      'fields.values',
    );
    expect(await counts('imports.jobs', space.businessId)).toBe(0);
    expect(await refusedFor(['contacts.import', 'contacts.manage'])).toBeUndefined();
    expect(await counts('imports.jobs', space.businessId)).toBe(1);
  });

  it('needs contacts.import to look at a file, preview it, read the history or get the error file', async () => {
    const space = await workspace(database);
    const file = await upload(space.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const started = await start(space.owner, plan(file.id));
    const member = space.as(['contacts.manage', 'tags.manage', 'fields.values', 'files.upload']);

    for (const [operation, request] of [
      ['inspectImportFile', { body: { fileId: file.id, object: 'contact' } }],
      ['previewImport', { body: plan(file.id) }],
      ['listImports', {}],
      ['getImport', { params: { id: started.id } }],
      ['cancelImport', { params: { id: started.id } }],
      ['createImportErrorFileLink', { params: { id: started.id } }],
    ] as const)
      await expect(api.call(operation, member, request), operation).rejects.toMatchObject({
        name: 'ForbiddenError',
        permission: 'contacts.import',
      });
    // Each refusal is in the audit log, under the name of what was tried.
    const refused = await database.as('crm_owner', (sql) =>
      sql.query<{ command: string }>(
        `select command from audit.commands
         where business_id = $1 and outcome = 'denied' order by recorded_at, id`,
        [space.businessId],
      ),
    );
    expect(refused.map((row) => row.command)).toEqual([
      'import.inspect',
      'import.preview',
      'import.list',
      'import.read',
      'import.cancel',
      'import.error_file',
    ]);
  });
});

describe('stopping an import', () => {
  it('ends one that is still waiting at once, and its job then does nothing', async () => {
    const space = await workspace(database);
    const file = await upload(space.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const started = await start(space.owner, plan(file.id));

    const cancelled = importJob.parse(
      await api.call('cancelImport', space.owner, { params: { id: started.id } }),
    );

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      canCancel: false,
      counts: { found: 1, processed: 0 },
    });
    expect(cancelled.finishedAt).not.toBeNull();
    expect(await runImportJob(services, files, space.system, started.id)).toEqual([]);
    expect(await counts('crm.contacts', space.businessId)).toBe(0);
    // Stopping it again changes nothing, and answers with the import as it is.
    expect(
      importJob.parse(await api.call('cancelImport', space.owner, { params: { id: started.id } })),
    ).toEqual(cancelled);
  });

  it('finds nothing for another business’s import, or an id that is no import’s', async () => {
    const space = await workspace(database);
    const other = await workspace(database);
    const file = await upload(other.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const theirs = await start(other.owner, plan(file.id));

    for (const operation of ['getImport', 'cancelImport', 'createImportErrorFileLink'])
      for (const id of [theirs.id, toPublicId('import', '01890a5d-ac96-774b-bcce-b302099a8057')])
        await expect(
          api.call(operation, space.owner, { params: { id } }),
          `${operation} ${id}`,
        ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      importJob.parse(await api.call('getImport', other.owner, { params: { id: theirs.id } }))
        .status,
    ).toBe('pending');
  });
});

describe('the history of imports', () => {
  it('lists a business’s imports newest first, a page at a time, with how many there are', async () => {
    const space = await danasWorkspace();
    const other = await workspace(database);
    const made: string[] = [];
    for (const name of ['one.csv', 'two.csv', 'three.csv']) {
      const file = await upload(space.owner, 'First,Email\r\nMaya,maya@example.test\r\n', name);
      const started = await start(space.owner, plan(file.id));
      await runImportJob(services, files, space.system, started.id);
      made.push(started.id);
    }
    const theirs = await upload(other.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    await start(other.owner, plan(theirs.id));
    const page = async (query: Record<string, string>) =>
      importList.parse(await api.call('listImports', space.owner, { query }));

    const first = await page({ limit: '2' });
    expect(first.items.map((each) => each.fileName)).toEqual(['three.csv', 'two.csv']);
    expect(first).toMatchObject({ total: 3, next: made[1] });
    const second = await page({ limit: '2', after: first.next ?? '' });
    expect(second.items.map((each) => each.id)).toEqual([made[0]]);
    expect(second).toMatchObject({ total: 3, next: null });
    expect((await page({})).items).toHaveLength(3);
    // The first import made the contact; the two after it found the contact there.
    expect(first.items[1]).toMatchObject({
      status: 'completed',
      counts: { found: 1, processed: 1, created: 0, skipped: 1 },
      hasErrorFile: true,
      startedBy: { kind: 'user', name: 'Dana Brooks', you: true },
      canCancel: false,
    });
    expect(second.items[0]).toMatchObject({
      counts: { created: 1, skipped: 0 },
      hasErrorFile: false,
    });
  });

  it('filters by status, source, object and when it was started', async () => {
    const space = await workspace(database);
    const file = await upload(space.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const done = await start(space.owner, plan(file.id));
    await runImportJob(services, files, space.system, done.id);
    const waiting = await start(space.owner, plan(file.id));
    // An import another source wrote, as the GoHighLevel import will.
    await database.withTenant(space.owner.context, (sql) =>
      sql.query(
        `insert into imports.jobs (business_id, source, status, objects, created_by_kind,
                                   started_at, finished_at, created_at)
         values (app.business_id(), 'ghl', 'completed', '{contact,deal}', 'system', now(), now(),
                 now() - interval '40 days')`,
      ),
    );
    const ids = async (query: Record<string, string>) => {
      const list = importList.parse(await api.call('listImports', space.owner, { query }));
      expect(list.total).toBe(list.items.length);
      return list.items.map((each) => each.id);
    };
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

    expect(await ids({ status: 'pending' })).toEqual([waiting.id]);
    expect(await ids({ status: 'completed', source: 'csv' })).toEqual([done.id]);
    expect(await ids({ source: 'ghl' })).toHaveLength(1);
    expect(await ids({ object: 'deal' })).toHaveLength(1);
    expect(await ids({ object: 'contact' })).toHaveLength(3);
    expect(await ids({ startedFrom: monthAgo })).toEqual([waiting.id, done.id]);
    expect(await ids({ startedBefore: monthAgo })).toHaveLength(1);
    expect(await ids({ status: 'failed' })).toEqual([]);
    // What another source wrote is shown as far as it goes.
    const [foreign] = importList.parse(
      await api.call('listImports', space.owner, { query: { source: 'ghl' } }),
    ).items;
    expect(foreign).toMatchObject({
      source: 'ghl',
      objects: ['contact', 'deal'],
      mode: null,
      mapping: [],
      fileName: null,
      startedBy: { kind: 'system', name: null, you: false },
    });
  });

  it('says an import failed, in general words when it kept no reason of its own', async () => {
    const space = await workspace(database);
    await database.withTenant(space.owner.context, (sql) =>
      sql.query(
        `insert into imports.jobs (business_id, source, status, error_code, finished_at)
         values (app.business_id(), 'ghl', 'failed', 'unknown', now())`,
      ),
    );

    const [failed] = importList.parse(await api.call('listImports', space.owner)).items;

    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: 'unknown', message: 'The import could not be finished.' },
      canCancel: false,
    });
  });

  it('says you started an import only to the person who did', async () => {
    const space = await danasWorkspace();
    const colleague = await database.fixtures.user({ name: 'Sam Reyes' });
    const file = await upload(space.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const started = await start(space.owner, plan(file.id));
    const sam: Invocation = {
      ...space.owner,
      context: { ...space.owner.context, userId: colleague.id, actorId: colleague.id },
    };

    expect(
      importJob.parse(await api.call('getImport', sam, { params: { id: started.id } })).startedBy,
    ).toEqual({ kind: 'user', name: 'Dana Brooks', you: false });
  });
});

describe('the error file link', () => {
  it('is refused for an import that has no error file', async () => {
    const space = await workspace(database);
    const file = await upload(space.owner, 'First,Email\r\nMaya,maya@example.test\r\n');
    const started = await start(space.owner, plan(file.id));
    await runImportJob(services, files, space.system, started.id);

    await expect(
      api.call('createImportErrorFileLink', space.owner, { params: { id: started.id } }),
    ).rejects.toThrow(new ConflictError('This import has no file of rows that were not applied.'));
  });

  it('links to the error file through the files service, for fifteen minutes', async () => {
    const space = await workspace(database);
    const file = await upload(space.owner, 'First,Email\r\nMaya,not-an-email\r\n');
    const started = await start(space.owner, plan(file.id));
    await runImportJob(services, files, space.system, started.id);
    const [stored] = await database.as('crm_owner', (sql) =>
      sql.query<{ error_file_id: string }>('select error_file_id from imports.jobs where id = $1', [
        parsePublicId('import', started.id),
      ]),
    );

    const link = fileLink.parse(
      await api.call('createImportErrorFileLink', space.owner, { params: { id: started.id } }),
    );

    expect(link).toEqual({
      url: `https://crm.example.test/api/v1/files/${toPublicId('file', stored?.error_file_id ?? '')}/content?lasting=900`,
      expiresAt: '2026-10-10T12:15:00.000Z',
    });
  });
});
