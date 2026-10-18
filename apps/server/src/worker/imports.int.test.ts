// A CSV import from end to end, as an install runs it: start with the server's own routes
// and the worker's own tasks, over HTTP, the files service on disk, the queue and
// PostgreSQL. A file is uploaded, looked at, previewed and imported; the worker applies it;
// the history shows it; the rows it did not apply come back as a file through a signed
// link. What an import's events start is decided in the automation module and proved here
// for the whole path.
//
// Nothing here waits on a clock: each wait reads the import, or the queue's own tables,
// until what it waits for is there.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  automationDraftSaved,
  contactList,
  fileLink,
  importFileInspection,
  importJob,
  importList,
  importPreview,
  recordTagList,
  storedFile,
  tag as tagSchema,
  type ImportJob,
} from '@repo/contracts';
import { createCsvParser, parsePublicId, toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';

import { apiRoutes } from '../api-routes.js';
import type { Config } from '../config.js';
import { start, type Running } from '../start.js';
import { workerTasks } from '../worker-tasks.js';
import { RECOVER_IMPORTS } from './worker.js';

let database: TestDatabase;
let root: string;
const running: Running[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  root = await mkdtemp(join(tmpdir(), 'crm-imports-'));
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((each) => each.stop()));
});
afterAll(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});

async function eventually<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`Did not settle: ${what}.`);
    await delay(25);
  }
}

/** An install with file storage on disk, and a business whose owner calls its API. */
async function install(options: { role?: 'all' | 'app'; workerHasFiles?: boolean } = {}) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  const files: Config['files'] = {
    storage: { kind: 'local', directory: join(root, `files-${randomUUID()}`) },
    maxBytes: 1024 * 1024,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  };
  const config: Config = {
    nodeEnv: 'test',
    role: options.role ?? 'all',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: options.role === 'app' ? undefined : database.url('crm_worker'),
    databasePoolSize: 4,
    shutdownTimeoutMs: 1000,
    dashboardDir: undefined,
    devTenantContext: { agencyId: agency.id, businessId: business.id, userId: user.id },
    publicUrl: 'https://crm.example.test',
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files,
    vault: undefined,
  };
  const app = await start(config, apiRoutes, workerTasks);
  running.push(app);
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ) => {
    const response = await fetch(`${app.address}/api/v1${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': contentType },
            body: typeof body === 'string' ? body : JSON.stringify(body),
          }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
  };
  const api = async (method: string, path: string, body?: unknown, contentType?: string) => {
    const answer = await call(method, path, body, contentType);
    if (answer.status >= 400)
      throw new Error(
        `${method} ${path} answered ${String(answer.status)}: ${JSON.stringify(answer.body)}`,
      );
    return answer.body;
  };
  const upload = async (name: string, content: string) =>
    storedFile.parse(
      await api('POST', `/files?filename=${encodeURIComponent(name)}`, content, 'text/csv'),
    );
  const ended = (id: string): Promise<ImportJob> =>
    eventually(`import ${id} has ended`, async () => {
      const job = importJob.parse(await api('GET', `/imports/${id}`));
      return job.status === 'pending' || job.status === 'running' ? undefined : job;
    });
  return { app, config, agency, business, user, call, api, upload, ended };
}

const mapping = [
  { column: 0, target: { kind: 'attribute', attribute: 'firstName' } },
  { column: 1, target: { kind: 'attribute', attribute: 'email' } },
  { column: 2, target: { kind: 'attribute', attribute: 'tags' } },
];

it('imports a CSV file through the API and the worker, and gives back the rows it did not apply', async () => {
  const { api, upload, ended, business, user, app } = await install();
  const vip = tagSchema.parse(await api('POST', '/tags', { name: 'VIP' }));
  const imported = tagSchema.parse(await api('POST', '/tags', { name: 'Imported October' }));
  await api('POST', '/contacts', { firstName: 'Already', emails: ['here@example.test'] });
  const file = await upload(
    'October leads.csv',
    'First Name,Email,Tags\r\n' +
      'Maya,Maya@Example.test,VIP\r\n' +
      'Here,here@example.test,\r\n' +
      '=cmd,not-an-email,\r\n' +
      'Kip,kip@example.test,\r\n' +
      'Maya again,maya@example.test,\r\n',
  );

  // Look at the file: its columns, its rows and a mapping read from its headers.
  const inspection = importFileInspection.parse(
    await api('POST', '/imports/inspect', { fileId: file.id, object: 'contact' }),
  );
  expect(inspection).toMatchObject({ delimiter: ',', rowCount: 5, suggestedMapping: mapping });
  const plan = {
    fileId: file.id,
    object: 'contact',
    mode: 'create',
    mapping: inspection.suggestedMapping,
    tagIds: [imported.id],
  };

  // Preview it: what each row would become, with nothing written.
  const preview = importPreview.parse(await api('POST', '/imports/preview', plan));
  expect(preview.rows.map(({ row, outcome }) => [row, outcome])).toEqual([
    [2, 'create'],
    [3, 'skip'],
    [4, 'fail'],
    [5, 'create'],
    [6, 'skip'],
  ]);
  expect(contactList.parse(await api('GET', '/contacts')).items).toHaveLength(1);

  // Start it, and the worker applies it.
  const started = importJob.parse(await api('POST', '/imports', plan));
  expect(started).toMatchObject({
    status: 'pending',
    fileName: 'October leads.csv',
    counts: { found: 5, processed: 0 },
    startedBy: { kind: 'user', you: true },
  });
  const done = await ended(started.id);
  expect(done).toMatchObject({
    status: 'completed',
    counts: { found: 5, processed: 5, created: 2, updated: 0, skipped: 2, failed: 1 },
    hasErrorFile: true,
    error: null,
    canCancel: false,
  });
  expect(done.startedAt).not.toBeNull();
  expect(done.finishedAt).not.toBeNull();

  // The contacts are there, each with the import's tag, and the row's own where it had one.
  const contacts = contactList.parse(await api('GET', '/contacts?sort=name')).items;
  expect(contacts.map(({ name, email }) => [name, email])).toEqual([
    ['Already', 'here@example.test'],
    ['Kip', 'kip@example.test'],
    ['Maya', 'maya@example.test'],
  ]);
  const tagsOf = async (name: string) =>
    recordTagList
      .parse(
        await api('GET', `/records/${contacts.find((each) => each.name === name)?.id ?? ''}/tags`),
      )
      .items.map((each) => [each.tag.id, each.source.kind]);
  expect(await tagsOf('Maya')).toEqual([
    [imported.id, 'import'],
    [vip.id, 'import'],
  ]);
  expect(await tagsOf('Kip')).toEqual([[imported.id, 'import']]);
  expect(await tagsOf('Already')).toEqual([]);
  // Nobody was given consent by being imported.
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query('select 1 from messaging.consents where business_id = $1', [business.id]),
    ),
  ).toEqual([]);

  // The history shows it, with who started it.
  const history = importList.parse(await api('GET', '/imports?status=completed&source=csv'));
  expect(history).toMatchObject({ total: 1, next: null });
  expect(history.items[0]).toEqual(done);

  // The rows it did not apply, through a signed link that needs no sign-in.
  const link = fileLink.parse(await api('POST', `/imports/${started.id}/error-file-link`));
  const download = await fetch(link.url.replace('https://crm.example.test', app.address));
  expect(download.status).toBe(200);
  expect(download.headers.get('content-type')).toContain('text/csv');
  expect(download.headers.get('content-disposition')).toContain('October leads-not-imported.csv');
  const bytes = Buffer.from(await download.arrayBuffer());
  // A byte order mark first, so a spreadsheet reads the file as UTF-8.
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  const parser = createCsvParser();
  expect([...parser.push(text), ...parser.end()].map((record) => record.fields)).toEqual([
    ['Row', 'Result', 'Reason', 'First Name', 'Email', 'Tags'],
    [
      '3',
      'Skipped',
      'A contact already has this email address or phone number, and this import only adds new contacts.',
      'Here',
      'here@example.test',
      '',
    ],
    [
      '4',
      'Failed',
      'Email: Enter an email address, such as maya@example.com.',
      // Written so a spreadsheet shows it and does not run it.
      "'=cmd",
      'not-an-email',
      '',
    ],
    [
      '6',
      'Skipped',
      'Row 2 of this file is the same contact.',
      'Maya again',
      'maya@example.test',
      '',
    ],
  ]);
  expect(text.startsWith('\uFEFF"Row","Result","Reason",')).toBe(true);

  // What the import did is on the contact's timeline, as the import.
  const events = await database.as('crm_owner', (sql) =>
    sql.query<{ type: string; actor_kind: string; actor_id: string; user_started: boolean }>(
      `select e.type, e.actor_kind, e.actor_id,
              exists (select 1 from imports.jobs j
                      where j.id = e.actor_id and j.created_by_id = $2) as user_started
       from events.events e
       where e.business_id = $1 and e.type in ('contact.created', 'tag.assigned')
         and e.actor_kind = 'import'`,
      [business.id, user.id],
    ),
  );
  expect(events).toHaveLength(5);
  expect(new Set(events.map((event) => event.actor_id))).toEqual(
    new Set([parsePublicId('import', started.id)]),
  );
  expect(events.every((event) => event.user_started)).toBe(true);
});

it('starts no automation for the contacts an import creates, and starts one for a tag it adds', async () => {
  const { api, upload, ended, business } = await install();
  const vip = tagSchema.parse(await api('POST', '/tags', { name: 'VIP' }));
  const publish = async (name: string, trigger: Record<string, unknown>) => {
    const { automation } = automationDraftSaved.parse(
      await api('POST', '/automations', {
        document: {
          name,
          triggers: [trigger],
          start: 'pause',
          steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
        },
      }),
    );
    await api('POST', `/automations/${automation.id}/publish`, {
      baseDraftVersion: 1,
      changeSummary: 'First version.',
    });
    return parsePublicId('automation', automation.id) ?? '';
  };
  const welcome = await publish('Welcome', { id: 'created', type: 'contact.created', config: {} });
  const tagged = await publish('Tagged', {
    id: 'tagged',
    type: 'tag.added',
    config: { tag: vip.id },
  });
  // A contact a person adds starts the welcome automation, as before.
  await api('POST', '/contacts', { firstName: 'By hand', emails: ['hand@example.test'] });
  const file = await upload(
    'contacts.csv',
    'First Name,Email,Tags\r\nMaya,maya@example.test,VIP\r\nKip,kip@example.test,\r\n',
  );

  const started = importJob.parse(
    await api('POST', '/imports', { fileId: file.id, object: 'contact', mode: 'create', mapping }),
  );
  expect((await ended(started.id)).counts).toMatchObject({ created: 2, failed: 0 });

  // Every match the events queued has run before the enrolments are counted.
  await eventually('the queue has no automation match left', async () => {
    const [left] = await database.as('crm_owner', (sql) =>
      sql.query<{ count: string }>(
        `select count(*) from graphile_worker.jobs
         where task_identifier = 'automations.match_event'`,
      ),
    );
    return left?.count === '0' ? true : undefined;
  });
  const enrolled = await database.as('crm_owner', (sql) =>
    sql.query<{ automation_id: string; first_name: string }>(
      `select e.automation_id, c.first_name
       from automation.enrolments e join crm.contacts c on c.id = e.record_id
       where e.business_id = $1 order by c.first_name`,
      [business.id],
    ),
  );
  expect(enrolled).toEqual([
    { automation_id: welcome, first_name: 'By hand' },
    { automation_id: tagged, first_name: 'Maya' },
  ]);
});

it('refuses a second import while one waits, and lets it be stopped', async () => {
  // The app alone: nothing takes the import up, so it waits.
  const { api, call, upload } = await install({ role: 'app' });
  const file = await upload('contacts.csv', 'First Name,Email,Tags\r\nMaya,maya@example.test,\r\n');
  const plan = { fileId: file.id, object: 'contact', mode: 'create', mapping };
  const waiting = importJob.parse(await api('POST', '/imports', plan));

  const second = await call('POST', '/imports', plan);
  expect(second.status).toBe(409);
  expect(second.body).toMatchObject({
    detail:
      'An import is already waiting or running in this business. Wait for it to finish, or stop it.',
  });

  expect(importJob.parse(await api('POST', `/imports/${waiting.id}/cancel`))).toMatchObject({
    status: 'cancelled',
    counts: { processed: 0 },
  });
  expect(importJob.parse(await api('POST', '/imports', plan)).status).toBe('pending');
});

it('says what is wrong with a file before anything is imported', async () => {
  const { call, upload } = await install({ role: 'app' });
  const broken = await upload('broken.csv', 'First Name,Email\r\nMaya,"maya@example.test\r\n');
  const missing = toPublicId('file', '01890a5d-ac96-774b-bcce-b302099a8057');

  for (const [fileId, code, message] of [
    [broken.id, 'unterminated_quote', 'Row 2 opens a quotation mark that is never closed.'],
    [missing, 'not_found', 'There is no file with this id.'],
  ] as const) {
    const answer = await call('POST', '/imports/inspect', { fileId, object: 'contact' });
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ errors: [{ path: '/fileId', code, message }] });
  }
});

it('takes up an import whose worker died, through the worker’s own sweep', async () => {
  // The app starts the import and its job is lost with the worker that took it: the queue
  // has nothing for it, and the import says it is running.
  const { api, upload, ended, business, config } = await install({ role: 'app' });
  const file = await upload('contacts.csv', 'First Name,Email,Tags\r\nMaya,maya@example.test,\r\n');
  const stalled = importJob.parse(
    await api('POST', '/imports', { fileId: file.id, object: 'contact', mode: 'create', mapping }),
  );
  // Its job is taken from the queue and never run: lost, as with the worker that had it.
  const lost = await database.runJobs(['imports.run']);
  expect(
    lost.map((job) => (job.payload as { data: { importId: string } }).data.importId),
  ).toContain(parsePublicId('import', stalled.id));
  await database.as('crm_owner', (sql) =>
    sql.query(
      `update imports.jobs set status = 'running', started_at = now(), runner = uuidv7(),
              heartbeat_at = now() - interval '10 minutes'
       where id = $1`,
      [parsePublicId('import', stalled.id)],
    ),
  );

  // A worker starts, with the same file storage, and its sweep runs.
  const worker = await start(
    { ...config, role: 'worker', databaseWorkerUrl: database.url('crm_worker') },
    apiRoutes,
    workerTasks,
  );
  running.push(worker);
  await database.as('crm_owner', (sql) =>
    sql.query(`select graphile_worker.add_job($1, '{}'::json)`, [RECOVER_IMPORTS]),
  );

  expect(await ended(stalled.id)).toMatchObject({
    status: 'completed',
    counts: { processed: 1, created: 1 },
  });
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query('select first_name from crm.contacts where business_id = $1', [business.id]),
    ),
  ).toEqual([{ first_name: 'Maya' }]);
});

it('ends an import saying why when the worker has no file storage', async () => {
  const { api, upload, ended, config } = await install({ role: 'app' });
  const file = await upload('contacts.csv', 'First Name,Email,Tags\r\nMaya,maya@example.test,\r\n');
  const started = importJob.parse(
    await api('POST', '/imports', { fileId: file.id, object: 'contact', mode: 'create', mapping }),
  );
  // A worker as an install had it before imports: no files settings at all.
  const worker = await start(
    { ...config, role: 'worker', files: undefined, databaseWorkerUrl: database.url('crm_worker') },
    apiRoutes,
    workerTasks,
  );
  running.push(worker);

  expect(await ended(started.id)).toMatchObject({
    status: 'failed',
    error: { code: 'storage_unavailable' },
    counts: { processed: 0 },
  });
});
