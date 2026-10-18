// An import as the worker applies it, against a migrated Postgres: each row written by the
// CRM's own commands, a row all or nothing, no second contact for an address a contact
// holds, no row applied twice whatever dies or overlaps, stopping, the file of rows not
// applied, and the sweep that takes up an import whose worker died.
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { importJob, type ImportJob } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ContentTooLargeError, createCsvParser, parsePublicId, toPublicId } from '@repo/kernel';
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
import { trashContactCommand } from '../contacts/contacts.js';
import { createFieldCommand, updateFieldCommand } from '../fields/fields.js';
import { createTagCommand } from '../tags/tags.js';
import { applyImportRowsCommand, reasonOf } from './apply.js';
import {
  beginImportRunCommand,
  errorFileLines,
  errorFileName,
  finishImportCommand,
  recoverStalledImports,
  requeueImportCommand,
} from './run.js';
import { readImportNames } from './store.js';

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
  api = importApi(services, files);
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const NAME_EMAIL = [
  { column: 0, target: attribute('firstName') },
  { column: 1, target: attribute('email') },
];

/** Uploads the text, starts an import of it and gives the import as it was queued. */
async function started(
  space: Workspace,
  content: string,
  changes: Record<string, unknown> = {},
  filename = 'contacts.csv',
): Promise<ImportJob> {
  const file = await uploadCsv(files, services, space.owner, content, filename);
  return importJob.parse(
    await api.call('startImport', space.owner, {
      body: { fileId: file.id, object: 'contact', mode: 'create', mapping: NAME_EMAIL, ...changes },
    }),
  );
}

const read = async (space: Workspace, id: string): Promise<ImportJob> =>
  importJob.parse(await api.call('getImport', space.owner, { params: { id } }));

/** Starts an import of the text and runs its job to the end, as the worker would. */
async function imported(
  space: Workspace,
  content: string,
  changes: Record<string, unknown> = {},
  options: { batchSize?: number; outcomePageSize?: number; filename?: string } = {},
): Promise<ImportJob> {
  const job = await started(space, content, changes, options.filename);
  await runImportJob(services, files, space.system, job.id, options);
  return read(space, job.id);
}

interface StoredContact {
  first_name: string | null;
  last_name: string | null;
  timezone: string | null;
  do_not_contact: boolean;
  created_by_kind: string;
  created_by_id: string | null;
  emails: string[];
  phones: string[];
}

/** The business's contacts as the database holds them, in the order they were made. */
const contacts = (space: Workspace): Promise<StoredContact[]> =>
  database.as('crm_owner', (sql) =>
    sql.query<StoredContact>(
      `select c.first_name, c.last_name, c.timezone, c.do_not_contact, c.created_by_kind,
              c.created_by_id,
              array(select i.value_normalized from crm.contact_identities i
                    where i.contact_id = c.id and i.kind = 'email'
                    order by i.is_primary desc, i.id) as emails,
              array(select i.value_normalized from crm.contact_identities i
                    where i.contact_id = c.id and i.kind = 'phone'
                    order by i.is_primary desc, i.id) as phones
       from crm.contacts c where c.business_id = $1 order by c.id`,
      [space.businessId],
    ),
  );

/** What became of each row of an import, in the file's order. */
const outcomes = (id: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ row: number; outcome: string; code: string | null; detail: string | null }>(
      `select row_number as row, outcome, code, detail from imports.job_rows
       where job_id = $1 order by row_number`,
      [parsePublicId('import', id)],
    ),
  );

const eventsOf = (space: Workspace, like: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{
      type: string;
      actor_kind: string;
      actor_id: string | null;
      causation_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `select type, actor_kind, actor_id, causation_id, payload from events.events
       where business_id = $1 and type like $2 order by recorded_at, id`,
      [space.businessId, like],
    ),
  );

const count = async (table: string, space: Workspace): Promise<number> =>
  Number(
    (
      await database.as('crm_owner', (sql) =>
        sql.one<{ count: string }>(`select count(*) from ${table} where business_id = $1`, [
          space.businessId,
        ]),
      )
    ).count,
  );

/** A contact already in the business, made by a person. */
async function existing(
  space: Workspace,
  values: { firstName?: string; lastName?: string; email?: string; phone?: string },
): Promise<string> {
  const contact = await database.fixtures.contact(space.owner.context, values);
  if (values.phone !== undefined)
    await database.withTenant(space.owner.context, (sql) =>
      sql.query(
        `insert into crm.contact_identities
           (business_id, contact_id, kind, value, value_normalized, is_primary)
         values (app.business_id(), $1, 'phone', $2, $2, true)`,
        [contact.id, values.phone],
      ),
    );
  return contact.id;
}

const tag = (who: Invocation, name: string) =>
  runCommand(services, createTagCommand, { name, description: '' }, who);

function field(who: Invocation, key: string, valueType = 'text', options: string[] = []) {
  return runCommand(
    services,
    createFieldCommand,
    {
      objectKey: 'contact',
      key,
      label: key,
      description: 'For the import tests.',
      valueType,
      currency: valueType === 'money' ? 'KES' : null,
      options: options.map((label) => ({
        key: `opt_${label.toLowerCase()}`,
        label,
        description: '',
        archived: false,
      })),
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
    },
    who,
  );
}

/** The error file an import stored, as text, and as the rows a spreadsheet would show. */
async function errorFile(id: string): Promise<{ name: string; text: string; rows: string[][] }> {
  const [job] = await database.as('crm_owner', (sql) =>
    sql.query<{ error_file_id: string | null }>(
      'select error_file_id from imports.jobs where id = $1',
      [parsePublicId('import', id)],
    ),
  );
  const stored = files.stored.get(job?.error_file_id ?? '');
  if (stored === undefined) throw new Error('The import has no error file.');
  const text = stored.bytes.toString('utf8');
  const parser = createCsvParser();
  return {
    name: stored.filename,
    text,
    rows: [...parser.push(text), ...parser.end()].map((record) => record.fields),
  };
}

describe('an import that runs to its end', () => {
  it('makes each contact through the contact’s own command, as the import', async () => {
    const space = await workspace(database);
    const job = await started(
      space,
      'First,Email\r\nMaya,Maya@Example.test\r\nKip,kip@example.test\r\nZoë,zoe@example.test\r\n',
    );
    const importId = parsePublicId('import', job.id) ?? '';
    // The job as the queue hands it to the worker: in the import's business, as the
    // system, under the request that started it and caused by the event it wrote.
    const [queued] = await database.runJobs(['imports.run']);
    const envelope = queued?.payload as {
      agencyId: string;
      businessId: string;
      correlationId: string;
      causationId: string;
    };
    const asQueued: Invocation = {
      context: {
        agencyId: envelope.agencyId,
        businessId: envelope.businessId,
        actorKind: 'system',
        correlationId: envelope.correlationId,
      },
      permissions: 'all',
      causationId: envelope.causationId,
    };

    const reported = await runImportJob(services, files, asQueued, job.id);

    expect(await read(space, job.id)).toMatchObject({
      status: 'completed',
      counts: { found: 3, processed: 3, created: 3, updated: 0, skipped: 0, failed: 0 },
      hasErrorFile: false,
      error: null,
      canCancel: false,
    });
    expect(await contacts(space)).toEqual(
      [
        ['Maya', 'maya@example.test'],
        ['Kip', 'kip@example.test'],
        ['Zoë', 'zoe@example.test'],
      ].map(([first_name, email]) => ({
        first_name,
        last_name: null,
        timezone: null,
        do_not_contact: false,
        // Who made it: the import, by its id.
        created_by_kind: 'import',
        created_by_id: importId,
        emails: [email],
        phones: [],
      })),
    );
    expect(await outcomes(job.id)).toEqual(
      [2, 3, 4].map((row) => ({ row, outcome: 'created', code: null, detail: null })),
    );
    // The same event a person's new contact writes, caused by the import having started.
    const [begun] = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>(
        `select id from events.events where subject_id = $1 and type = 'import.started'`,
        [importId],
      ),
    );
    const created = await eventsOf(space, 'contact.%');
    expect(created).toEqual(
      [1, 2, 3].map(() => ({
        type: 'contact.created',
        actor_kind: 'import',
        actor_id: importId,
        causation_id: begun?.id,
        payload: {},
      })),
    );
    expect(await count('crm.timeline_entries', space)).toBe(3);
    expect((await eventsOf(space, 'import.completed')).map((event) => event.payload)).toEqual([
      { processed: 3, created: 3, updated: 0, skipped: 0, failed: 0 },
    ]);
    // What the run told its listener: ids and counts, and nothing a row held.
    expect(reported).toEqual([
      {
        importId,
        businessId: space.businessId,
        event: 'batch',
        status: 'running',
        processed: 3,
        found: 3,
      },
      {
        importId,
        businessId: space.businessId,
        event: 'ended',
        status: 'completed',
        processed: 3,
        found: 3,
      },
    ]);
  });

  it('audits each batch by its rows’ numbers, never by what they hold', async () => {
    const space = await workspace(database);
    const job = await imported(
      space,
      'First,Email\r\nMaya,maya@example.test\r\n\r\nKip,kip@example.test\r\nZoë,zoe@example.test\r\n',
      {},
      { batchSize: 2 },
    );
    const importId = parsePublicId('import', job.id);

    const audited = await database.as('crm_owner', (sql) =>
      sql.query<{ command: string; actor_kind: string; outcome: string; input: unknown }>(
        `select command, actor_kind, outcome, input from audit.commands
         where business_id = $1 and command <> 'import.start' order by recorded_at, id`,
        [space.businessId],
      ),
    );
    expect(
      audited.map(({ command, actor_kind, outcome }) => [command, actor_kind, outcome]),
    ).toEqual([
      ['import.begin_run', 'import', 'ok'],
      ['import.apply_rows', 'import', 'ok'],
      ['import.apply_rows', 'import', 'ok'],
      ['import.finish', 'import', 'ok'],
    ]);
    expect(
      audited.filter((row) => row.command === 'import.apply_rows').map((row) => row.input),
    ).toEqual([
      { importId, offset: 0, rows: 2, firstRow: 2, lastRow: 4 },
      { importId, offset: 2, rows: 1, firstRow: 5, lastRow: 5 },
    ]);
    expect(JSON.stringify(audited)).not.toMatch(/maya|kip|zoe|example\.test/i);
  });

  it('keeps a value that looks like a formula as the text it is', async () => {
    const space = await workspace(database);
    const notes = await field(space.owner, 'notes');
    await imported(
      space,
      'First,Last,Email,Notes\r\n=1+1,+SUM(A1),formula@example.test,"=HYPERLINK(""http://x.test"",""click"")"\r\n@handle,-minus,at@example.test,@mention\r\n',
      {
        mapping: [
          { column: 0, target: attribute('firstName') },
          { column: 1, target: attribute('lastName') },
          { column: 2, target: attribute('email') },
          { column: 3, target: customField(notes.id) },
        ],
      },
    );

    expect(
      (await contacts(space)).map(({ first_name, last_name }) => [first_name, last_name]),
    ).toEqual([
      ['=1+1', '+SUM(A1)'],
      ['@handle', '-minus'],
    ]);
    const values = await database.as('crm_owner', (sql) =>
      sql.query<{ value_text: string }>(
        'select value_text from crm.field_values where business_id = $1 order by record_id',
        [space.businessId],
      ),
    );
    expect(values.map((value) => value.value_text)).toEqual([
      '=HYPERLINK("http://x.test","click")',
      '@mention',
    ]);
  });

  it('gives nobody consent: an imported contact has none on any channel', async () => {
    const space = await workspace(database, { country: 'KE' });
    await imported(space, 'First,Email,Phone\r\nMaya,maya@example.test,0712 345678\r\n', {
      mapping: [...NAME_EMAIL, { column: 2, target: attribute('phone') }],
    });

    expect(await contacts(space)).toHaveLength(1);
    expect(await count('messaging.consents', space)).toBe(0);
    expect(await eventsOf(space, 'consent%')).toEqual([]);
  });
});

describe('a row that cannot be imported', () => {
  it('fails alone, with its reason, and writes nothing of itself', async () => {
    const space = await workspace(database, { country: 'KE' });
    const budget = await field(space.owner, 'budget', 'money');
    const eventDate = await field(space.owner, 'event_date', 'date');
    const site = await field(space.owner, 'site', 'url');
    const job = await imported(
      space,
      [
        'First,Email,Phone,Zone,Budget,Event date,Site',
        'Good,good@example.test,0712 345678,Africa/Nairobi,1250,2026-12-24,https://example.test',
        'NoAt,not-an-email,,,,,',
        'BadPhone,phone@example.test,12,,,,',
        'BadZone,zone@example.test,,Mars/Olympus,,,',
        'BadBudget,budget@example.test,,,lots,,',
        'BadDate,date@example.test,,,,24/12/2026,',
        'NoSuchDay,day@example.test,,,,2026-13-45,',
        'BadSite,site@example.test,,,,,ftp://example.test',
        ',,,,,,https://example.test',
        'Extra,extra@example.test,,,,,,one too many',
        'Fine,fine@example.test,,,,,',
      ].join('\r\n'),
      {
        mapping: [
          ...NAME_EMAIL,
          { column: 2, target: attribute('phone') },
          { column: 3, target: attribute('timeZone') },
          { column: 4, target: customField(budget.id) },
          { column: 5, target: customField(eventDate.id) },
          { column: 6, target: customField(site.id) },
        ],
      },
    );

    expect(job).toMatchObject({
      status: 'completed',
      counts: { found: 11, processed: 11, created: 2, updated: 0, skipped: 0, failed: 9 },
      hasErrorFile: true,
    });
    expect(await outcomes(job.id)).toEqual([
      { row: 2, outcome: 'created', code: null, detail: null },
      {
        row: 3,
        outcome: 'failed',
        code: 'invalid_format',
        detail: 'Email: Enter an email address, such as maya@example.com.',
      },
      {
        row: 4,
        outcome: 'failed',
        code: 'phone_invalid',
        detail: 'Phone: Enter a phone number, such as +1 212 555 0142.',
      },
      {
        row: 5,
        outcome: 'failed',
        code: 'time_zone_unknown',
        detail: "Zone: This isn't a time zone, such as Africa/Nairobi.",
      },
      {
        row: 6,
        outcome: 'failed',
        code: 'number_unreadable',
        detail: 'Budget: Enter a number, such as 1250.50.',
      },
      {
        row: 7,
        outcome: 'failed',
        code: 'date_unreadable',
        detail: 'Event date: Enter a date with the year first, such as 2026-10-09.',
      },
      {
        row: 8,
        outcome: 'failed',
        code: 'field_value_invalid',
        detail: 'Event date: Enter a date with the year first, such as 2026-10-09.',
      },
      {
        row: 9,
        outcome: 'failed',
        code: 'field_value_invalid',
        detail: 'Site: Enter a web address that starts with http:// or https://.',
      },
      {
        row: 10,
        outcome: 'failed',
        code: 'contact_empty',
        detail: 'Give the contact a name, an email address or a phone number.',
      },
      {
        row: 11,
        outcome: 'failed',
        code: 'too_many_cells',
        detail:
          'This row has 8 values and the header has 7 columns. A value with a comma in it must be inside quotation marks.',
      },
      { row: 12, outcome: 'created', code: null, detail: null },
    ]);
    // All or nothing: a row with a good contact and one bad value made no contact at all.
    expect((await contacts(space)).map((contact) => contact.first_name)).toEqual(['Good', 'Fine']);
    expect(await count('crm.field_values', space)).toBe(3);
    expect(await eventsOf(space, 'contact.created')).toHaveLength(2);
  });

  it('fails when the contact’s own command refuses it, and undoes what the row had begun', async () => {
    const space = await workspace(database);
    const vip = await tag(space.owner, 'VIP');
    const job = await started(
      space,
      'First,Email\r\nMaya,maya@example.test\r\nKip,kip@example.test\r\n',
      {
        tagIds: [vip.id],
      },
    );
    // The tag is deleted after the import began: adding it is refused for every row, after
    // the row's contact was already made.
    await database.as('crm_owner', (sql) =>
      sql.query('delete from crm.tags where id = $1', [parsePublicId('tag', vip.id)]),
    );

    await runImportJob(services, files, space.system, job.id);

    expect(await read(space, job.id)).toMatchObject({
      status: 'completed',
      counts: { processed: 2, created: 0, failed: 2 },
    });
    expect((await outcomes(job.id)).map(({ outcome, code }) => [outcome, code])).toEqual([
      ['failed', 'not_found'],
      ['failed', 'not_found'],
    ]);
    expect(await contacts(space)).toEqual([]);
    expect(await eventsOf(space, 'contact.%')).toEqual([]);
  });
});

describe('a row whose contact exists', () => {
  const rows =
    'First,Last,Email,Phone\r\n' +
    'Maya,,MAYA@example.test,\r\n' +
    ',Stone,,+254 733 000 111\r\n' +
    'New,Person,new@example.test,\r\n';
  const mapping = [
    { column: 0, target: attribute('firstName') },
    { column: 1, target: attribute('lastName') },
    { column: 2, target: attribute('email') },
    { column: 3, target: attribute('phone') },
  ];
  async function seeded() {
    const space = await workspace(database, { country: 'KE' });
    await existing(space, { firstName: 'Old', lastName: 'Name', email: 'maya@example.test' });
    await existing(space, { firstName: 'Kip', lastName: 'Old', phone: '+254733000111' });
    return space;
  }
  const names = async (space: Workspace) =>
    (await contacts(space)).map(({ first_name, last_name, created_by_kind }) =>
      [first_name, last_name, created_by_kind].join(' '),
    );

  it('is skipped when the import only adds new contacts', async () => {
    const space = await seeded();
    const job = await imported(space, rows, { mode: 'create', mapping });

    expect(job.counts).toMatchObject({ created: 1, updated: 0, skipped: 2, failed: 0 });
    expect((await outcomes(job.id)).map(({ row, outcome, code }) => [row, outcome, code])).toEqual([
      [2, 'skipped', 'exists'],
      [3, 'skipped', 'exists'],
      [4, 'created', null],
    ]);
    expect(await names(space)).toEqual(['Old Name user', 'Kip Old user', 'New Person import']);
  });

  it('is updated, and a row with no contact skipped, when the import only updates', async () => {
    const space = await seeded();
    const job = await imported(space, rows, { mode: 'update', mapping });

    expect(job.counts).toMatchObject({ created: 0, updated: 2, skipped: 1, failed: 0 });
    expect((await outcomes(job.id)).map(({ row, outcome, code }) => [row, outcome, code])).toEqual([
      [2, 'updated', null],
      [3, 'updated', null],
      [4, 'skipped', 'no_contact'],
    ]);
    // A name in the row replaces the contact's; an empty cell leaves what the contact has.
    expect(await names(space)).toEqual(['Maya Name user', 'Kip Stone user']);
    expect((await eventsOf(space, 'contact.updated')).map((event) => event.payload)).toEqual([
      { changed: ['firstName'] },
      { changed: ['lastName'] },
    ]);
  });

  it('is updated, and a new one made, when the import does both', async () => {
    const space = await seeded();
    const job = await imported(space, rows, { mode: 'create_and_update', mapping });

    expect(job.counts).toMatchObject({ created: 1, updated: 2, skipped: 0, failed: 0 });
    expect(await names(space)).toEqual(['Maya Name user', 'Kip Stone user', 'New Person import']);
  });

  it('gains the row’s other addresses and never loses one it has', async () => {
    const space = await workspace(database, { country: 'KE' });
    await existing(space, { email: 'maya@example.test', phone: '+254733000111' });
    await imported(
      space,
      'Email,More emails,Phone,More phones\r\nmaya@example.test,"second@example.test; MAYA@example.test",0712 345678,"+254 733 000 111, 0700 111222"\r\n',
      {
        mode: 'update',
        mapping: [
          { column: 0, target: attribute('email') },
          { column: 1, target: attribute('additionalEmails') },
          { column: 2, target: attribute('phone') },
          { column: 3, target: attribute('additionalPhones') },
        ],
      },
    );

    const [contact] = await contacts(space);
    // What it had first stays first.
    expect(contact?.emails).toEqual(['maya@example.test', 'second@example.test']);
    expect(contact?.phones).toEqual(['+254733000111', '+254712345678', '+254700111222']);
  });

  it('is found by an address that is not its primary one, and its number keeps its label', async () => {
    const space = await workspace(database, { country: 'KE' });
    const maya = await existing(space, { firstName: 'Maya', email: 'maya@example.test' });
    // A second email address and a labelled number, as the contact page adds them.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, label)
         select c.business_id, c.id, more.kind, more.value, more.value, more.label
         from crm.contacts c,
           (values ('email', 'second@example.test', null), ('phone', '+254712345678', 'work'))
             as more (kind, value, label)
         where c.id = $1`,
        [maya],
      ),
    );
    const mapping = [...NAME_EMAIL, { column: 2, target: attribute('phone') }];
    const made = await imported(
      space,
      'First,Email,Phone\r\nBy email,SECOND@example.test,\r\nBy phone,,0712 345678\r\n',
      { mode: 'create', mapping },
    );
    expect(made.counts).toMatchObject({ created: 0, skipped: 2, failed: 0 });
    const changed = await imported(space, 'First,Email,Phone\r\nRenamed,,0712 345678\r\n', {
      mode: 'create_and_update',
      mapping,
    });
    expect(changed.counts).toMatchObject({ created: 0, updated: 1, failed: 0 });

    const [contact, ...others] = await contacts(space);
    expect(others).toEqual([]);
    expect(contact?.emails).toEqual(['maya@example.test', 'second@example.test']);
    expect(contact?.phones).toEqual(['+254712345678']);
    const labels = await database.as('crm_owner', (sql) =>
      sql.query<{ label: string | null }>(
        `select label from crm.contact_identities where contact_id = $1 and kind = 'phone'`,
        [maya],
      ),
    );
    expect(labels).toEqual([{ label: 'work' }]);
  });

  it('is never made a second time, however its address is written', async () => {
    const space = await workspace(database, { country: 'KE' });
    await existing(space, { email: 'maya@example.test', phone: '+254712345678' });
    const job = await imported(
      space,
      'First,Email,Phone\r\n' +
        'Case,MAYA@Example.TEST,\r\n' +
        'National,,0712 345678\r\n' +
        'Spaced,,+254 712 345 678\r\n' +
        "Marked,,'+254712345678\r\n",
      { mode: 'create', mapping: [...NAME_EMAIL, { column: 2, target: attribute('phone') }] },
    );

    expect(job.counts).toMatchObject({ created: 0, skipped: 4 });
    expect(await contacts(space)).toHaveLength(1);
    expect(await count('crm.contact_identities', space)).toBe(2);
  });

  it('fails when its contact is in the trash, or its addresses are two different contacts’', async () => {
    const space = await workspace(database, { country: 'KE' });
    const gone = await existing(space, { email: 'gone@example.test' });
    await runCommand(
      services,
      trashContactCommand,
      { id: toPublicId('contact', gone) },
      space.owner,
    );
    await existing(space, { firstName: 'A', email: 'a@example.test' });
    await existing(space, { firstName: 'B', phone: '+254733000111' });
    const job = await imported(
      space,
      'First,Email,Phone\r\nGone,gone@example.test,\r\nBoth,a@example.test,+254733000111\r\n',
      {
        mode: 'create_and_update',
        mapping: [...NAME_EMAIL, { column: 2, target: attribute('phone') }],
      },
    );

    expect(await outcomes(job.id)).toEqual([
      {
        row: 2,
        outcome: 'failed',
        code: 'contact_in_trash',
        detail: 'Email: A contact in the trash has this email address. Restore it first.',
      },
      {
        row: 3,
        outcome: 'failed',
        code: 'taken',
        detail: 'Phone: Another contact has this phone number.',
      },
    ]);
    expect(await contacts(space)).toHaveLength(3);
    expect(await eventsOf(space, 'contact.updated')).toEqual([]);
  });
});

describe('rows of one file that are the same contact', () => {
  it('write the contact once: the first row does, and each later one is skipped naming it', async () => {
    const space = await workspace(database, { country: 'KE' });
    await existing(space, { firstName: 'Old', email: 'here@example.test' });
    const job = await imported(
      space,
      'First,Email,Phone\r\n' +
        'Maya,maya@example.test,0712 345678\r\n' +
        'Here,here@example.test,\r\n' +
        'Maya again,MAYA@example.test,\r\n' +
        'Maya by phone,,+254712345678\r\n' +
        'Here again,here@example.test,\r\n' +
        'Kip,kip@example.test,\r\n',
      {
        mode: 'create_and_update',
        mapping: [...NAME_EMAIL, { column: 2, target: attribute('phone') }],
      },
      // Two rows to a batch, so a later batch must know what an earlier one wrote.
      { batchSize: 2 },
    );

    expect(job.counts).toMatchObject({ created: 2, updated: 1, skipped: 3, failed: 0 });
    expect(await outcomes(job.id)).toEqual([
      { row: 2, outcome: 'created', code: null, detail: null },
      { row: 3, outcome: 'updated', code: null, detail: null },
      {
        row: 4,
        outcome: 'skipped',
        code: 'duplicate_in_file',
        detail: 'Row 2 of this file is the same contact.',
      },
      {
        row: 5,
        outcome: 'skipped',
        code: 'duplicate_in_file',
        detail: 'Row 2 of this file is the same contact.',
      },
      {
        row: 6,
        outcome: 'skipped',
        code: 'duplicate_in_file',
        detail: 'Row 3 of this file is the same contact.',
      },
      { row: 7, outcome: 'created', code: null, detail: null },
    ]);
    expect((await contacts(space)).map((contact) => contact.first_name)).toEqual([
      'Here',
      'Maya',
      'Kip',
    ]);
  });
});

describe('tags, fields and settings', () => {
  it('adds the import’s tags to every contact it writes, and a row’s own tags by name', async () => {
    const space = await workspace(database);
    const vip = await tag(space.owner, 'VIP');
    await tag(space.owner, 'Hot-Lead');
    await existing(space, { email: 'here@example.test' });
    const job = await imported(
      space,
      'First,Email,Tags\r\n' +
        'Maya,maya@example.test,"hot lead; VIP"\r\n' +
        'Here,here@example.test,\r\n' +
        'Kip,kip@example.test,Nobody made this\r\n' +
        'Nameonly,,\r\n',
      {
        mode: 'create_and_update',
        tagIds: [vip.id],
        mapping: [...NAME_EMAIL, { column: 2, target: attribute('tags') }],
      },
    );
    const importId = parsePublicId('import', job.id);

    expect(await outcomes(job.id)).toMatchObject([
      { row: 2, outcome: 'created' },
      { row: 3, outcome: 'updated' },
      {
        row: 4,
        outcome: 'failed',
        code: 'tag_unknown',
        detail:
          "Tags: This row names a tag that doesn't exist. Create the tag in Settings first, or take it out of the row.",
      },
      { row: 5, outcome: 'created' },
    ]);
    const tagged = await database.as('crm_owner', (sql) =>
      sql.query<{ first_name: string; name: string; source_kind: string; source_id: string }>(
        `select c.first_name, t.name, rt.source_kind, rt.source_id
         from crm.record_tags rt
         join crm.tags t on t.id = rt.tag_id
         join crm.contacts c on c.id = rt.record_id
         where rt.business_id = $1 order by c.first_name, t.name`,
        [space.businessId],
      ),
    );
    expect(tagged).toEqual(
      [
        ['Here', 'VIP'],
        ['Maya', 'Hot-Lead'],
        ['Maya', 'VIP'],
        ['Nameonly', 'VIP'],
      ].map(([first_name, name]) => ({
        first_name,
        name,
        source_kind: 'import',
        source_id: importId,
      })),
    );
    // No tag was made by the import: the one nobody made is still not there.
    expect(await count('crm.tags', space)).toBe(2);
    expect(await eventsOf(space, 'tag.assigned')).toHaveLength(4);
  });

  it('fills custom fields with typed values, as the import, and leaves a value alone for an empty cell', async () => {
    const space = await workspace(database);
    const budget = await field(space.owner, 'budget', 'money');
    const guests = await field(space.owner, 'guests', 'number');
    const eventDate = await field(space.owner, 'event_date', 'date');
    const confirmed = await field(space.owner, 'confirmed', 'boolean');
    const tier = await field(space.owner, 'tier', 'single_choice', ['Gold', 'Silver']);
    const extras = await field(space.owner, 'extras', 'multi_choice', ['Lights', 'Sound', 'Stage']);
    const mapping = [
      { column: 0, target: attribute('email') },
      { column: 1, target: customField(budget.id) },
      { column: 2, target: customField(guests.id) },
      { column: 3, target: customField(eventDate.id) },
      { column: 4, target: customField(confirmed.id) },
      { column: 5, target: customField(tier.id) },
      { column: 6, target: customField(extras.id) },
    ];
    const header = 'Email,Budget,Guests,Event date,Confirmed,Tier,Extras\r\n';
    const first = await imported(
      space,
      `${header}maya@example.test,"12,500.75",120,2026/12/24,yes,gold,"Lights; stage"\r\n`,
      { mapping },
    );
    const values = () =>
      database.as('crm_owner', (sql) =>
        sql.query(
          `select d.key, v.value_number::text as number, v.value_date::text as date,
                  v.value_bool as bool, v.value_options as options, v.source_kind, v.source_id
           from crm.field_values v join crm.field_definitions d on d.id = v.field_id
           where v.business_id = $1 order by d.key`,
          [space.businessId],
        ),
      );
    const by = (id: string) => ({ source_kind: 'import', source_id: parsePublicId('import', id) });
    const none = { number: null, date: null, bool: null, options: null };
    const stored = [
      { ...none, key: 'budget', number: '12500.75', ...by(first.id) },
      { ...none, key: 'confirmed', bool: true, ...by(first.id) },
      { ...none, key: 'event_date', date: '2026-12-24', ...by(first.id) },
      { ...none, key: 'extras', options: ['opt_lights', 'opt_stage'], ...by(first.id) },
      { ...none, key: 'guests', number: '120', ...by(first.id) },
      { ...none, key: 'tier', options: ['opt_gold'], ...by(first.id) },
    ];
    expect(await values()).toEqual(stored);

    // A second import with one new value and the rest empty changes that one value only.
    const second = await imported(space, `${header}maya@example.test,,150,,,,\r\n`, {
      mode: 'update',
      mapping,
    });
    expect(second.counts).toMatchObject({ updated: 1, failed: 0 });
    expect(await values()).toEqual(
      stored.map((value) =>
        value.key === 'guests' ? { ...value, number: '150', ...by(second.id) } : value,
      ),
    );
  });

  it('sets a time zone as the server spells it, turns do not contact on, and never off', async () => {
    const space = await workspace(database);
    await existing(space, { firstName: 'Quiet', email: 'quiet@example.test' });
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update crm.contacts set do_not_contact = true where business_id = $1 and first_name = 'Quiet'`,
        [space.businessId],
      ),
    );
    const job = await imported(
      space,
      'First,Email,Zone,DND\r\n' +
        'Maya,maya@example.test,africa/nairobi,yes\r\n' +
        'Kip,kip@example.test,,no\r\n' +
        'Quiet,quiet@example.test,Europe/London,no\r\n' +
        'Unsure,unsure@example.test,,maybe\r\n',
      {
        mode: 'create_and_update',
        mapping: [
          ...NAME_EMAIL,
          { column: 2, target: attribute('timeZone') },
          { column: 3, target: attribute('doNotContact') },
        ],
      },
    );

    expect(job.counts).toMatchObject({ created: 2, updated: 1, failed: 1 });
    expect(
      (await contacts(space)).map(({ first_name, timezone, do_not_contact }) => [
        first_name,
        timezone,
        do_not_contact,
      ]),
    ).toEqual([
      // "no" did not let Quiet be messaged again.
      ['Quiet', 'Europe/London', true],
      ['Maya', 'Africa/Nairobi', true],
      ['Kip', null, false],
    ]);
    expect((await outcomes(job.id))[3]).toEqual({
      row: 5,
      outcome: 'failed',
      code: 'do_not_contact_unreadable',
      detail: 'DND: Use yes or no for do not contact.',
    });
    expect((await eventsOf(space, 'contact.do_not_contact%')).map((event) => event.type)).toEqual([
      'contact.do_not_contact_set',
    ]);
  });
});

describe('the file of rows that were not applied', () => {
  it('lists each skipped and failed row as it was, with its number and reason, safe to open in a spreadsheet', async () => {
    const space = await workspace(database);
    await existing(space, { email: 'here@example.test' });
    const job = await imported(
      space,
      '\uFEFFFirst,Email,Note\r\n' +
        'Maya,maya@example.test,fine\r\n' +
        '"=HYPERLINK(""http://x.test"")",not-an-email,"=1+1"\r\n' +
        '\r\n' +
        '+Here,here@example.test,"said ""hi"", twice"\r\n' +
        '@cmd,-also bad,"two\r\nlines"\r\n' +
        'Kip,kip@example.test,\tfine\r\n',
      {},
      { filename: 'October leads.csv', batchSize: 2 },
    );

    expect(job).toMatchObject({
      counts: { found: 5, created: 2, skipped: 1, failed: 2 },
      hasErrorFile: true,
    });
    const file = await errorFile(job.id);
    expect(file.name).toBe('October leads-not-imported.csv');
    // Every cell quoted, every quote doubled, and an apostrophe before each cell a
    // spreadsheet would otherwise run (OWASP, CSV Injection).
    expect(file.text).toBe(
      '\uFEFF"Row","Result","Reason","First","Email","Note"\r\n' +
        '"3","Failed","Email: Enter an email address, such as maya@example.com.","\'=HYPERLINK(""http://x.test"")","not-an-email","\'=1+1"\r\n' +
        '"5","Skipped","A contact already has this email address or phone number, and this import only adds new contacts.","\'+Here","here@example.test","said ""hi"", twice"\r\n' +
        '"6","Failed","Email: Enter an email address, such as maya@example.com.","\'@cmd","\'-also bad","two\r\nlines"\r\n',
    );
    for (const cell of file.rows.flat()) expect(cell).not.toMatch(/^[=+\-@\t\r\n＝＋－＠]/);
    // Stored as the import's own file, in its business.
    const [stored] = await database.as('crm_owner', (sql) =>
      sql.query<{ business_id: string; content_type: string; uploaded_by_kind: string }>(
        `select f.business_id, f.content_type, f.uploaded_by_kind
         from files.files f join imports.jobs j on j.error_file_id = f.id where j.id = $1`,
        [parsePublicId('import', job.id)],
      ),
    );
    expect(stored).toEqual({
      business_id: space.businessId,
      content_type: 'text/csv',
      uploaded_by_kind: 'import',
    });
  });

  it('is named after the file the import read', () => {
    expect(errorFileName('contacts.csv')).toBe('contacts-not-imported.csv');
    expect(errorFileName('contacts.backup.CSV')).toBe('contacts.backup-not-imported.csv');
    expect(errorFileName('list')).toBe('list-not-imported.csv');
    expect(errorFileName('.csv')).toBe('import-not-imported.csv');
    expect(errorFileName(`${'x'.repeat(250)}.csv`)).toHaveLength(217);
  });
});

describe('a job that dies or overlaps', () => {
  const people = (count: number) =>
    `First,Email\r\n${Array.from({ length: count }, (_row, at) => `P${String(at)},p${String(at)}@example.test`).join('\r\n')}\r\n`;

  /** Every row applied once: one contact, one event and one recorded outcome for each. */
  async function expectAppliedOnce(space: Workspace, id: string, rows: number): Promise<void> {
    expect(await read(space, id)).toMatchObject({
      status: 'completed',
      counts: { found: rows, processed: rows, created: rows, failed: 0 },
    });
    expect((await contacts(space)).map((contact) => contact.emails[0])).toEqual(
      Array.from({ length: rows }, (_row, at) => `p${String(at)}@example.test`),
    );
    expect(await eventsOf(space, 'contact.created')).toHaveLength(rows);
    expect((await outcomes(id)).map((row) => row.row)).toEqual(
      Array.from({ length: rows }, (_row, at) => at + 2),
    );
    expect(await eventsOf(space, 'import.completed')).toHaveLength(1);
  }

  it('goes on from the last batch that committed when it died between two batches', async () => {
    const space = await workspace(database);
    const job = await started(space, people(7));

    // The process dies after the second batch committed, before the queue hears of it.
    await expect(
      runImportJob(services, files, space.system, job.id, {
        batchSize: 2,
        onProgress: ({ processed }) => {
          if (processed === 4) throw new Error('the worker was killed');
        },
      }),
    ).rejects.toThrow('the worker was killed');
    expect(await read(space, job.id)).toMatchObject({
      status: 'running',
      counts: { processed: 4, created: 4 },
    });
    expect(await contacts(space)).toHaveLength(4);

    // The queue runs the job again.
    const reported = await runImportJob(services, files, space.system, job.id, { batchSize: 2 });

    expect(reported.map((each) => each.processed)).toEqual([6, 7, 7]);
    await expectAppliedOnce(space, job.id, 7);
  });

  it('applies none of a batch that died halfway, then all of it once', async () => {
    const space = await workspace(database);
    const job = await started(
      space,
      'First,Email\r\nP0,p0@example.test\r\nP1,p1@example.test\r\nP2,p2@example.test\r\nP3,p3@example.test\r\nCrash,p4@example.test\r\nP5,p5@example.test\r\n',
    );
    // The database fails while the fifth row is written: the second row of its batch.
    await database.as('crm_owner', async (sql) => {
      await sql.query(
        `create function util.import_test_crash() returns trigger language plpgsql
         as $$ begin raise exception 'the worker died'; end $$`,
      );
      await sql.query(
        `create trigger import_test_crash before insert on crm.contacts
         for each row when (new.first_name = 'Crash') execute function util.import_test_crash()`,
      );
    });
    try {
      await expect(
        runImportJob(services, files, space.system, job.id, { batchSize: 3 }),
      ).rejects.toThrow('the worker died');
    } finally {
      await database.as('crm_owner', (sql) =>
        sql.query('drop trigger import_test_crash on crm.contacts'),
      );
    }
    // The first batch stayed; nothing of the second did, not even its first row.
    expect(await read(space, job.id)).toMatchObject({
      status: 'running',
      counts: { processed: 3, created: 3 },
    });
    expect(await contacts(space)).toHaveLength(3);
    expect(await outcomes(job.id)).toHaveLength(3);

    await runImportJob(services, files, space.system, job.id, { batchSize: 3 });

    expect(await read(space, job.id)).toMatchObject({
      status: 'completed',
      counts: { processed: 6, created: 6, failed: 0 },
    });
    expect((await contacts(space)).map((contact) => contact.first_name)).toEqual([
      'P0',
      'P1',
      'P2',
      'P3',
      'Crash',
      'P5',
    ]);
    expect(await eventsOf(space, 'contact.created')).toHaveLength(6);
    expect((await outcomes(job.id)).map((row) => row.row)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('lets a second run take over, and the first then applies nothing more', async () => {
    const space = await workspace(database);
    const job = await started(space, people(6));

    // While the first run is between two batches, a second run of the same job (a retry,
    // or the sweep) takes the import up and finishes it.
    const first = await runImportJob(services, files, space.system, job.id, {
      batchSize: 2,
      onProgress: async ({ processed, event }) => {
        if (event === 'batch' && processed === 2)
          await runImportJob(services, files, space.system, job.id, { batchSize: 2 });
      },
    });

    // The first run reported its one batch and then stopped, without ending the import.
    expect(first.map((each) => [each.event, each.processed])).toEqual([['batch', 2]]);
    await expectAppliedOnce(space, job.id, 6);
  });

  it('refuses a batch from a run that no longer holds the import, and one out of step', async () => {
    const space = await workspace(database);
    const job = await started(space, people(3));
    const importId = parsePublicId('import', job.id) ?? '';
    const acting: Invocation = {
      context: { ...space.system.context, actorKind: 'import', actorId: importId },
      permissions: 'all',
    };
    const begin = async () => {
      const claim = await runCommand(services, beginImportRunCommand, { importId }, acting);
      if (claim.state !== 'running') throw new Error('The import had ended.');
      return claim.runner;
    };
    const batch = (runner: string, offset: number) =>
      runCommand(
        services,
        applyImportRowsCommand,
        {
          importId,
          runner,
          offset,
          rows: [{ row: offset + 2, cells: ['P', `p${String(offset)}@example.test`] }],
        },
        acting,
      );
    const stale = await begin();
    const current = await begin();

    expect(await batch(stale, 0)).toEqual({ state: 'superseded' });
    expect(await contacts(space)).toEqual([]);
    // The run that holds it, handing over rows from the wrong place in the file.
    await expect(batch(current, 1)).rejects.toThrow(
      `Import ${importId} has dealt with 0 rows; a batch from row 1 was handed over.`,
    );
    expect(await contacts(space)).toEqual([]);
    expect(await batch(current, 0)).toEqual({
      state: 'applied',
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
    // The same rows again are out of step, and the database would refuse them besides.
    await expect(batch(current, 0)).rejects.toThrow('a batch from row 0 was handed over');
    expect(await contacts(space)).toHaveLength(1);
    // A run that lost the import cannot end it either.
    expect(
      await runCommand(
        services,
        finishImportCommand,
        { importId, runner: stale, status: 'completed' },
        acting,
      ),
    ).toEqual({ ended: false });
    expect((await read(space, job.id)).status).toBe('running');
  });
});

describe('stopping an import that is running', () => {
  it('stops before the next batch, keeps what was imported, and says so', async () => {
    const space = await workspace(database);
    const job = await started(
      space,
      'First,Email\r\nMaya,maya@example.test\r\nBad,not-an-email\r\nKip,kip@example.test\r\nZoë,zoe@example.test\r\n',
    );

    const reported = await runImportJob(services, files, space.system, job.id, {
      batchSize: 2,
      onProgress: async ({ event, processed }) => {
        if (event !== 'batch' || processed !== 2) return;
        const asked = importJob.parse(
          await api.call('cancelImport', space.owner, { params: { id: job.id } }),
        );
        // Still running until the worker reaches its next batch.
        expect(asked).toMatchObject({ status: 'running', cancelRequested: true, canCancel: false });
      },
    });

    expect(reported.at(-1)).toMatchObject({ event: 'ended', status: 'cancelled', processed: 2 });
    expect(await read(space, job.id)).toMatchObject({
      status: 'cancelled',
      counts: { found: 4, processed: 2, created: 1, failed: 1 },
      hasErrorFile: true,
      canCancel: false,
    });
    expect((await contacts(space)).map((contact) => contact.first_name)).toEqual(['Maya']);
    expect((await errorFile(job.id)).rows.map((row) => row[0])).toEqual(['Row', '3']);
    expect((await eventsOf(space, 'import.cancel%')).map((event) => event.type)).toEqual([
      'import.cancel_requested',
      'import.cancelled',
    ]);
  });
});

describe('an import the worker cannot read', () => {
  it('fails, saying why, when the worker has no file storage', async () => {
    const space = await workspace(database);
    const job = await started(space, 'First,Email\r\nMaya,maya@example.test\r\n');

    const reported = await runImportJob(services, undefined, space.system, job.id);

    expect(reported).toMatchObject([
      { event: 'ended', status: 'failed', errorCode: 'storage_unavailable' },
    ]);
    expect(await read(space, job.id)).toMatchObject({
      status: 'failed',
      error: {
        code: 'storage_unavailable',
        message:
          "The worker can't reach the stored files. Whoever runs this install must give the worker the same file storage settings as the app.",
      },
      counts: { processed: 0 },
    });
    // The business can import again.
    expect((await started(space, 'First,Email\r\nKip,kip@example.test\r\n')).status).toBe(
      'pending',
    );
  });

  it('fails when its file is gone, and when the file can no longer be read as it was', async () => {
    const space = await workspace(database);
    const gone = await started(space, 'First,Email\r\nMaya,maya@example.test\r\n');
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update files.files set deleted_at = now()
         where id = (select file_id from imports.jobs where id = $1)`,
        [parsePublicId('import', gone.id)],
      ),
    );
    await runImportJob(services, files, space.system, gone.id);
    expect((await read(space, gone.id)).error).toEqual({
      code: 'file_missing',
      message: 'The file this import reads is gone.',
    });

    const changed = await started(
      space,
      'First,Email\r\nMaya,maya@example.test\r\nKip,kip@example.test\r\nZoë,zoe@example.test\r\n',
    );
    const [job] = await database.as('crm_owner', (sql) =>
      sql.query<{ file_id: string }>('select file_id from imports.jobs where id = $1', [
        parsePublicId('import', changed.id),
      ]),
    );
    const original = files.stored.get(job?.file_id ?? '');
    if (original === undefined) throw new Error('The file was not stored.');
    // The bytes change under the import: its third row now opens a quote that never ends.
    files.stored.set(job?.file_id ?? '', {
      ...original,
      bytes: Buffer.from(
        'First,Email\r\nMaya,maya@example.test\r\nKip,kip@example.test\r\n"Zoë,zoe\r\n',
      ),
    });
    await runImportJob(services, files, space.system, changed.id, { batchSize: 2 });

    // What was applied before the fault stays, and is counted.
    expect(await read(space, changed.id)).toMatchObject({
      status: 'failed',
      error: {
        code: 'unterminated_quote',
        message: 'Row 4 opens a quotation mark that is never closed.',
      },
      counts: { found: 3, processed: 2, created: 2 },
    });
    expect(await eventsOf(space, 'import.failed')).toMatchObject([
      { payload: { errorCode: 'file_missing' } },
      { payload: { errorCode: 'unterminated_quote', processed: 2, created: 2 } },
    ]);
  });
});

describe('the sweep for imports that stopped making progress', () => {
  /** Drains the queue of import jobs, and gives the imports they were for. */
  const queued = async () =>
    (await database.runJobs(['imports.run'])).map(
      (job) => (job.payload as { data: { importId: string } }).data.importId,
    );
  const silentSince = (id: string, interval: string) =>
    database.as('crm_owner', (sql) =>
      sql.query(`update imports.jobs set heartbeat_at = now() - $2::interval where id = $1`, [
        parsePublicId('import', id),
        interval,
      ]),
    );

  it('queues an import again when its worker died, once, and leaves a live one alone', async () => {
    const dead = await workspace(database);
    const alive = await workspace(database);
    const stalled = await started(
      dead,
      'First,Email\r\nMaya,maya@example.test\r\nKip,kip@example.test\r\n',
    );
    const busy = await started(alive, 'First,Email\r\nMaya,maya@example.test\r\n');
    // The first job took the import up, applied a batch and was never heard of again.
    await expect(
      runImportJob(services, files, dead.system, stalled.id, {
        batchSize: 1,
        onProgress: () => {
          throw new Error('the worker was killed');
        },
      }),
    ).rejects.toThrow('the worker was killed');
    await queued();
    await silentSince(stalled.id, '6 minutes');
    await silentSince(busy.id, '4 minutes');

    expect(await recoverStalledImports(services)).toEqual({ queued: 1, failed: 0 });

    expect(await queued()).toEqual([parsePublicId('import', stalled.id)]);
    // Touched, so the next sweep does not queue it a second time while its job waits.
    expect(await recoverStalledImports(services)).toEqual({ queued: 0, failed: 0 });
    expect(await queued()).toEqual([]);
    // The job the sweep queued finishes the import, from where the dead one stopped.
    await runImportJob(services, files, dead.system, stalled.id);
    expect(await read(dead, stalled.id)).toMatchObject({
      status: 'completed',
      counts: { processed: 2, created: 2 },
    });
    expect(await contacts(dead)).toHaveLength(2);
  });

  it('leaves alone an import that ended between being found and being taken up', async () => {
    const space = await workspace(database);
    const job = await imported(space, 'First,Email\r\nMaya,maya@example.test\r\n');
    await queued();

    expect(
      await runCommand(
        services,
        requeueImportCommand,
        { importId: parsePublicId('import', job.id) ?? '', giveUpAfterHours: 24 },
        space.system,
      ),
    ).toBe('left');
    expect(await queued()).toEqual([]);
    expect((await read(space, job.id)).status).toBe('completed');
  });

  it('gives up on an import started a day ago, so the business can import again', async () => {
    const space = await workspace(database);
    // An import as starting one stores it, a day and an hour ago, never taken up.
    const { id } = await database.withTenant(space.owner.context, (sql) =>
      sql.one<{ id: string }>(
        `insert into imports.jobs (business_id, source, status, objects, created_by_kind,
                                   file_name, row_count, settings, mapping, heartbeat_at, created_at)
         values (app.business_id(), 'csv', 'pending', '{contact}', 'user', 'old.csv', 4,
                 '{"object": "contact", "mode": "create", "delimiter": ",", "columns": 2, "tagIds": []}',
                 '[{"column": 1, "header": "Email", "target": {"kind": "attribute", "attribute": "email"}}]',
                 now() - interval '25 hours', now() - interval '25 hours')
         returning id`,
      ),
    );

    expect(await recoverStalledImports(services)).toEqual({ queued: 0, failed: 1 });

    expect(await queued()).toEqual([]);
    const [job] = await database.as('crm_owner', (sql) =>
      sql.query<{ status: string; error_code: string; finished: boolean }>(
        'select status, error_code, finished_at is not null as finished from imports.jobs where id = $1',
        [id],
      ),
    );
    expect(job).toEqual({ status: 'failed', error_code: 'stalled', finished: true });
    expect((await eventsOf(space, 'import.failed')).map((event) => event.payload)).toEqual([
      { processed: 0, errorCode: 'stalled' },
    ]);
    expect((await started(space, 'First,Email\r\nMaya,maya@example.test\r\n')).status).toBe(
      'pending',
    );
  });
});

describe('readImportNames', () => {
  it('names an import by the file it read, for showing which import acted', async () => {
    const space = await workspace(database);
    const job = await started(
      space,
      'First,Email\r\nMaya,maya@example.test\r\n',
      {},
      'October leads.csv',
    );
    const importId = parsePublicId('import', job.id) ?? '';
    const other = await workspace(database);

    const names = (who: Workspace, ids: readonly string[]) =>
      withTenant(db, who.owner.context, (trx) => readImportNames(trx, ids));

    expect(await names(space, [importId])).toEqual(new Map([[importId, 'October leads.csv']]));
    expect(await names(space, [])).toEqual(new Map());
    // Another business's import has no name here.
    expect(await names(other, [importId])).toEqual(new Map());
  });
});

describe('what a row is told, at the edges', () => {
  it('names a column by its place when its header is empty, and points at the cell at fault', async () => {
    const space = await workspace(database, { country: 'KE' });
    const alt = await field(space.owner, 'alt_phone', 'phone');
    const job = await imported(
      space,
      [
        'First,,Phone,Alt,Tags,DND',
        `${'x'.repeat(201)},long@example.test,,,,`,
        `Maya,maya@example.test,${'1'.repeat(41)},,,`,
        'Kip,kip@example.test,,12,,',
        'Zoë,zoe@example.test,,,"Nobody; No one",',
        'Quiet,quiet@example.test,,,,yes',
        'Bad,not-an-email,,,,',
      ].join('\r\n'),
      {
        mapping: [
          { column: 0, target: attribute('firstName') },
          { column: 1, target: attribute('email') },
          { column: 2, target: attribute('phone') },
          { column: 3, target: customField(alt.id) },
          { column: 4, target: attribute('tags') },
          { column: 5, target: attribute('doNotContact') },
        ],
      },
    );

    expect(await outcomes(job.id)).toEqual([
      { row: 2, outcome: 'failed', code: 'too_big', detail: 'First: Use at most 200 characters.' },
      {
        row: 3,
        outcome: 'failed',
        code: 'too_big',
        detail:
          'Phone: Use at most 40 characters. Phone: Enter a phone number, such as +1 212 555 0142.',
      },
      {
        row: 4,
        outcome: 'failed',
        code: 'phone_invalid',
        detail: 'Alt: Enter a phone number, such as +1 212 555 0142.',
      },
      {
        row: 5,
        outcome: 'failed',
        code: 'tag_unknown',
        // Said once, however many of the row's tags nobody made.
        detail:
          "Tags: This row names a tag that doesn't exist. Create the tag in Settings first, or take it out of the row.",
      },
      { row: 6, outcome: 'created', code: null, detail: null },
      {
        row: 7,
        outcome: 'failed',
        code: 'invalid_format',
        detail: 'Column 2: Enter an email address, such as maya@example.com.',
      },
    ]);
    // Do not contact with no time zone beside it is turned on all the same.
    expect(
      (await contacts(space)).map(({ first_name, do_not_contact, timezone }) => [
        first_name,
        do_not_contact,
        timezone,
      ]),
    ).toEqual([['Quiet', true, null]]);
  });

  it('says invalid for a reason whose code is no code, and cuts a reason that is too long', () => {
    const long = 'x'.repeat(1500);
    expect(reasonOf([{ column: null, code: 'Not A Code', message: 'Refused.' }], [])).toEqual({
      code: 'invalid',
      detail: 'Refused.',
    });
    const cut = reasonOf(
      [
        { column: 0, code: 'too_big', message: long },
        { column: 1, code: 'too_big', message: long },
      ],
      ['First', 'Second'],
    );
    expect(cut.code).toBe('too_big');
    expect(cut.detail).toHaveLength(2000);
    expect(cut.detail.startsWith('First: xxx')).toBe(true);
    expect(cut.detail.endsWith('…')).toBe(true);
  });
});

describe('a row the contact’s own commands refuse', () => {
  it('fails with what the command said: a contact that would have too many addresses', async () => {
    const space = await workspace(database);
    const contactId = await existing(space, { email: 'e0@example.test' });
    await database.withTenant(space.owner.context, (sql) =>
      sql.query(
        `insert into crm.contact_identities
           (business_id, contact_id, kind, value, value_normalized, is_primary)
         select app.business_id(), $1, 'email', 'e' || n || '@example.test',
                'e' || n || '@example.test', false
         from generate_series(1, 9) as n`,
        [contactId],
      ),
    );
    const job = await imported(
      space,
      'Email,More\r\ne0@example.test,"new1@example.test; new2@example.test"\r\n',
      {
        mode: 'update',
        mapping: [
          { column: 0, target: attribute('email') },
          { column: 1, target: attribute('additionalEmails') },
        ],
      },
    );

    expect(await outcomes(job.id)).toEqual([
      { row: 2, outcome: 'failed', code: 'too_big', detail: 'Add at most 10 email addresses.' },
    ]);
    expect((await contacts(space))[0]?.emails).toHaveLength(10);
  });

  it('fails when its field was archived after the import began, or deleted', async () => {
    const space = await workspace(database);
    const notes = await field(space.owner, 'notes');
    const gone = await field(space.owner, 'gone');
    const job = await started(
      space,
      'First,Email,Notes,Gone\r\nMaya,maya@example.test,hello,\r\nKip,kip@example.test,,bye\r\n',
      {
        mapping: [
          ...NAME_EMAIL,
          { column: 2, target: customField(notes.id) },
          { column: 3, target: customField(gone.id) },
        ],
      },
    );
    const { label, description, options, aiFillSources, aiOverwrite, revision } = notes;
    await runCommand(
      services,
      updateFieldCommand,
      {
        fieldId: notes.id,
        label,
        description,
        options,
        aiFillSources,
        aiOverwrite,
        revision,
        archived: true,
      },
      space.owner,
    );
    await database.as('crm_owner', (sql) =>
      sql.query('delete from crm.field_definitions where id = $1', [
        parsePublicId('field', gone.id),
      ]),
    );

    await runImportJob(services, files, space.system, job.id);

    expect(await outcomes(job.id)).toEqual([
      {
        row: 2,
        outcome: 'failed',
        code: 'conflict',
        detail: 'Restore this field before changing its value.',
      },
      {
        row: 3,
        outcome: 'failed',
        code: 'field_unknown',
        detail: 'Gone: The field this column fills no longer exists.',
      },
    ]);
    // Nothing of either row stayed: not the contact the first had already made.
    expect(await contacts(space)).toEqual([]);
  });
});

describe('the job, at the edges', () => {
  it('does nothing for an import that is not there, or one another source wrote', async () => {
    const space = await workspace(database);
    const { id } = await database.withTenant(space.owner.context, (sql) =>
      sql.one<{ id: string }>(
        `insert into imports.jobs (business_id, source, heartbeat_at)
         values (app.business_id(), 'ghl', now()) returning id`,
      ),
    );

    expect(await runImportJob(services, files, space.system, id)).toEqual([]);
    expect(
      await runImportJob(services, files, space.system, '01890a5d-ac96-774b-bcce-b302099a8057'),
    ).toEqual([]);
    const [job] = await database.as('crm_owner', (sql) =>
      sql.query<{ status: string }>('select status from imports.jobs where id = $1', [id]),
    );
    expect(job).toEqual({ status: 'pending' });
    // Such an import has no file's name to be known by.
    expect(await withTenant(db, space.owner.context, (trx) => readImportNames(trx, [id]))).toEqual(
      new Map(),
    );
  });

  it('refuses rows for an import with no plan to apply them by', async () => {
    const space = await workspace(database);
    const { id, runner } = await database.withTenant(space.owner.context, (sql) =>
      sql.one<{ id: string; runner: string }>(
        `insert into imports.jobs (business_id, source, status, started_at, heartbeat_at, runner,
                                   row_count)
         values (app.business_id(), 'ghl', 'running', now(), now(), uuidv7(), 1)
         returning id, runner`,
      ),
    );

    await expect(
      runCommand(
        services,
        applyImportRowsCommand,
        { importId: id, runner, offset: 0, rows: [{ row: 2, cells: ['Maya'] }] },
        space.system,
      ),
    ).rejects.toThrow(`Import ${id} has no plan to apply.`);
  });

  it('ends with its counts and no file when the rows not applied are more than one file may hold', async () => {
    const space = await workspace(database);
    const job = await started(
      space,
      'First,Email\r\nMaya,maya@example.test\r\nBad,not-an-email\r\n',
    );
    const opened = files.opened.length;
    // A files service whose limit the file of rows not applied goes over.
    const full: typeof files = {
      ...files,
      upload: (_services, _invocation, upload) => {
        upload.body.destroy();
        return Promise.reject(new ContentTooLargeError(16));
      },
    };

    await runImportJob(services, full, space.system, job.id);

    expect(await read(space, job.id)).toMatchObject({
      status: 'completed',
      counts: { found: 2, processed: 2, created: 1, failed: 1 },
      hasErrorFile: false,
    });
    // The source was opened to import it and again for the rows not applied, and let go.
    expect(files.opened.length - opened).toBe(2);
    // Any other failure to store it is a fault, and the job is tried again.
    const elsewhere = await workspace(database);
    const other = await started(elsewhere, 'First,Email\r\nBad,not-an-email\r\n');
    const broken: typeof files = {
      ...files,
      upload: () => Promise.reject(new Error('the disk is full')),
    };
    await expect(runImportJob(services, broken, elsewhere.system, other.id)).rejects.toThrow(
      'the disk is full',
    );
    expect((await read(elsewhere, other.id)).status).toBe('running');
  });

  it('fails an import whose file was deleted outright', async () => {
    const space = await workspace(database);
    const job = await started(space, 'First,Email\r\nMaya,maya@example.test\r\n');
    await database.as('crm_owner', (sql) =>
      sql.query(
        'delete from files.files where id = (select file_id from imports.jobs where id = $1)',
        [parsePublicId('import', job.id)],
      ),
    );

    await runImportJob(services, files, space.system, job.id);

    expect(await read(space, job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'file_missing' },
    });
  });

  it('reads the rows it did not apply a page at a time, and misses none', async () => {
    const space = await workspace(database);
    const rows = Array.from({ length: 9 }, (_row, at) =>
      at % 2 === 0
        ? `Bad${String(at)},not-an-email`
        : `Good${String(at)},g${String(at)}@example.test`,
    );
    // Five rows fail: two full pages of two, and a last page of one.
    const job = await imported(
      space,
      `First,Email\r\n${rows.join('\r\n')}\r\n`,
      {},
      { outcomePageSize: 2 },
    );
    expect(job.counts).toMatchObject({ created: 4, failed: 5 });
    expect((await errorFile(job.id)).rows.map((row) => row[0])).toEqual([
      'Row',
      '2',
      '4',
      '6',
      '8',
      '10',
    ]);

    // Eight rows not applied: four full pages, and then an empty one.
    const even = await imported(
      space,
      `First,Email\r\n${rows.slice(0, 8).join('\r\n')}\r\n`,
      {},
      { outcomePageSize: 2 },
    );
    expect(even.counts).toMatchObject({ created: 0, skipped: 4, failed: 4 });
    expect((await errorFile(even.id)).rows).toHaveLength(9);
  });
});

describe('errorFileLines', () => {
  const source = (rows: readonly number[]) => ({
    header: ['First', 'Email'],
    async *rows() {
      for (const row of rows)
        yield await Promise.resolve({ row, index: row - 2, cells: [`P${String(row)}`, 'x'] });
    },
  });
  async function linesOf(
    rows: readonly number[],
    listed: readonly { row_number: number; outcome: string; detail: string | null }[],
  ): Promise<string[]> {
    const lines: string[] = [];
    const outcomesOf = (async function* () {
      for (const outcome of listed) yield await Promise.resolve(outcome);
    })();
    for await (const line of errorFileLines(source(rows), outcomesOf)) lines.push(line);
    return lines;
  }
  const HEADER = '\uFEFF"Row","Result","Reason","First","Email"\r\n';

  it('writes the header alone when nothing was left out', async () => {
    expect(await linesOf([2, 3], [])).toEqual([HEADER]);
  });

  it('leaves out an outcome whose row the file no longer has, and stops at the file’s end', async () => {
    const failed = (row_number: number) => ({ row_number, outcome: 'failed', detail: null });
    expect(await linesOf([2, 4], [failed(2), failed(3), failed(4), failed(9), failed(10)])).toEqual(
      [HEADER, '"2","Failed","","P2","x"\r\n', '"4","Failed","","P4","x"\r\n'],
    );
  });
});
