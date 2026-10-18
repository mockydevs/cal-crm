// The upgrade test: an automation waiting mid-run
// survives its worker being killed, a migration and a restart, and then resumes from the
// saved step, on the version it began on, with no step run twice.
//
// Nothing of the engine is stood in for. The worker is the built server as a process
// (ROLE=worker), as the container runs it. It is killed outright while two contacts wait.
// The release that follows applies a migration the database has not seen and publishes a
// new version of the automation. A second worker process then starts on the same database.
// One contact's pending job survived in the queue; the other's is removed while the worker
// is down, as a job lost with a dying worker would be, so only the sweeper can resume it.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, migrate, withTenant, workerPreset, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { publishAutomationVersion } from '@repo/module-automation';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { runMigrations } from 'graphile-worker';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const migrations = fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url));

let database: TestDatabase;
let db: Database;
let services: Services;
const children: ChildProcess[] = [];
const temporary: string[] = [];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

interface WorkerProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  /** Settles when the process has gone, however it went. */
  readonly exited: Promise<void>;
}

/**
 * How long a start may hang before the test gives up on it. Not how long a start takes: a
 * worker that cannot start exits, and that ends the wait at once, with what it wrote. Only
 * a process that neither answers nor exits is left to this.
 */
const START_HANG_MS = 300_000;

/**
 * The built server in the worker role, as a process of its own, once it answers /health.
 * The start is over when the process answers or when it has gone; how fast the machine is
 * does not come into it.
 */
async function startWorkerProcess(): Promise<WorkerProcess> {
  const port = await freePort();
  let output = '';
  const child = spawn(process.execPath, ['--import', './dist/instrumentation.js', 'dist/main.js'], {
    cwd: serverRoot,
    // Only what the test sets, so nothing from the developer's environment leaks in.
    env: {
      PATH: process.env['PATH'] ?? '',
      ROLE: 'worker',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_APP_URL: database.url('crm_app'),
      DATABASE_WORKER_URL: database.url('crm_worker'),
      PUBLIC_URL: 'http://127.0.0.1',
      SECRETS_KEYS: '1:private-dev-only-vault-key-not-for-production-use-0',
    },
  });
  children.push(child);
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      resolve();
    }),
  );
  const healthy = () =>
    fetch(`http://127.0.0.1:${String(port)}/health`).then(
      (response) => response.ok,
      () => false,
    );
  const hung = Date.now() + START_HANG_MS;
  while (!(await healthy())) {
    // Gone, however it went: by its own exit code or by a signal.
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`The worker exited before it answered /health:\n${output}`);
    if (Date.now() > hung)
      throw new Error(
        `The worker neither answered /health nor exited in ${String(START_HANG_MS / 1000)} seconds:\n${output}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, output: () => output, exited };
}

const WAIT_SECONDS = 15;

/** The automation as each release publishes it: only what follows the wait differs. */
const version = (finishTag: string): AutomationDocumentInput => ({
  name: 'Welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'mark',
  steps: {
    mark: { type: 'tag.add', config: { tag: 'Started' }, next: 'pause' },
    pause: { type: 'wait', config: { duration: `PT${String(WAIT_SECONDS)}S` }, next: 'finish' },
    finish: { type: 'tag.add', config: { tag: finishTag } },
  },
});

it(
  'resumes each waiting contact from its saved step after the worker is killed, the database migrated and a new version published',
  async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const context: TenantContext = { ...business.context, correlationId: randomUUID() };

    // The business's tags, and each version's document with its tags by id, as publishing
    // through the API stores them.
    const tags = new Map<string, string>();
    for (const name of ['Started', 'Finished on version 1', 'Finished on version 2']) {
      const [row] = await database.as('postgres', (sql) =>
        sql.query<{ id: string }>(
          `insert into crm.tags (business_id, name, created_by_kind) values ($1, $2, 'user') returning id`,
          [business.id, name],
        ),
      );
      if (row === undefined) throw new Error('The tag was not made.');
      tags.set(name, toPublicId('tag', row.id));
    }
    const withTagIds = (document: AutomationDocumentInput) =>
      automationDocument.parse(
        JSON.parse(
          JSON.stringify(document, (key, value: unknown) =>
            key === 'tag' && typeof value === 'string' ? tags.get(value) : value,
          ),
        ),
      );
    const automationId = await withTenant(db, context, async (trx) => {
      const { id } = await trx
        .insertInto('automation.automations')
        .values({
          business_id: business.id,
          name: 'Welcome',
          draft: JSON.stringify(version('Finished on version 1')),
          created_by_kind: 'user',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await publishAutomationVersion(
        trx,
        context,
        id,
        withTagIds(version('Finished on version 1')),
        'First release',
      );
      return id;
    });

    /** A contact made through the CRM's own command: its event is what starts the automation. */
    const addContact = async (firstName: string): Promise<string> => {
      await runCommand(
        services,
        createContactCommand,
        { firstName, emails: [`${randomUUID()}@example.test`] },
        { context: { ...context, correlationId: randomUUID() }, permissions: 'all' },
      );
      const [row] = await database.withTenant(context, (sql) =>
        sql.query<{ id: string }>('select id from crm.contacts where first_name = $1', [firstName]),
      );
      if (row === undefined) throw new Error('The contact was not made.');
      return row.id;
    };
    interface Enrolment {
      id: string;
      status: string;
      current_step: string | null;
      version: number;
      mid_wait: boolean;
      exit_reason: string | null;
    }
    const enrolmentOf = async (contactId: string): Promise<Enrolment | undefined> => {
      const [row] = await database.withTenant(context, (sql) =>
        sql.query<Enrolment>(
          `select e.id, e.status, e.current_step, v.version, e.exit_reason,
                coalesce(e.wake_at > now(), false) as mid_wait
         from automation.enrolments e join automation.versions v on v.id = e.version_id
         where e.record_id = $1`,
          [contactId],
        ),
      );
      return row;
    };
    const stepsOf = (enrolmentId: string) =>
      database.withTenant(context, (sql) =>
        sql.query<{ step_key: string; status: string }>(
          'select step_key, status from automation.step_runs where enrolment_id = $1 order by started_at, id',
          [enrolmentId],
        ),
      );
    const tagsOf = async (contactId: string): Promise<string[]> =>
      (
        await database.withTenant(context, (sql) =>
          sql.query<{ name: string }>(
            `select t.name from crm.record_tags a join crm.tags t on t.id = a.tag_id
           where a.record_id = $1 order by t.name`,
            [contactId],
          ),
        )
      ).map((row) => row.name);

    // 1. The release before: its worker enrols two contacts and takes them to the wait.
    const before = await startWorkerProcess();
    const ada = await addContact('Ada');
    const grace = await addContact('Grace');
    for (const contact of [ada, grace])
      await expect
        .poll(() => enrolmentOf(contact), { timeout: 30_000, message: before.output() })
        .toMatchObject({ status: 'waiting', current_step: 'finish', version: 1 });

    // 2. The worker is killed outright, while both still wait.
    before.child.kill('SIGKILL');
    await before.exited;
    const waiting = { ada: await enrolmentOf(ada), grace: await enrolmentOf(grace) };
    expect(waiting.ada).toMatchObject({ status: 'waiting', mid_wait: true });
    expect(waiting.grace).toMatchObject({ status: 'waiting', mid_wait: true });
    const adaRun = waiting.ada?.id ?? '';
    const graceRun = waiting.grace?.id ?? '';
    for (const run of [adaRun, graceRun])
      expect(await stepsOf(run)).toEqual([
        { step_key: 'mark', status: 'succeeded' },
        { step_key: 'pause', status: 'waiting' },
      ]);
    // Grace's pending job is lost with the worker; Ada's stays in the queue.
    const jobKeys = async () =>
      (
        await database.as('crm_owner', (sql) =>
          sql.query<{ key: string }>(
            `select key from graphile_worker.jobs where key like 'automation-enrolment:%' order by key`,
          ),
        )
      ).map((row) => row.key);
    expect(await jobKeys()).toEqual(
      [`automation-enrolment:${adaRun}`, `automation-enrolment:${graceRun}`].sort(),
    );
    await database.as('crm_owner', (sql) =>
      sql.query('select graphile_worker.remove_job($1)', [`automation-enrolment:${graceRun}`]),
    );
    expect(await jobKeys()).toEqual([`automation-enrolment:${adaRun}`]);

    // 3. The next release migrates the database: every migration so far, and one it has not
    //    seen, which changes the very tables the waiting runs are kept in.
    const release = await mkdtemp(join(tmpdir(), 'crm-upgrade-'));
    temporary.push(release);
    await cp(migrations, release, { recursive: true });
    await writeFile(
      join(release, '9000_upgrade_probe.sql'),
      `alter table automation.enrolments add column upgrade_probe text;
     alter table automation.step_runs add column upgrade_probe text;
     comment on column automation.enrolments.upgrade_probe is 'Added by the upgrade test.';`,
    );
    const upgraded = await migrate({
      connectionString: database.url('crm_owner'),
      directory: release,
    });
    expect(upgraded.applied).toEqual(['9000_upgrade_probe.sql']);
    // Then the job queue's own migrations, as the release's migration step runs them
    // (migrateDatabase): the queue the killed worker left is the one the new worker reads.
    await runMigrations({ connectionString: database.url('crm_owner'), preset: workerPreset });
    expect(await jobKeys()).toEqual([`automation-enrolment:${adaRun}`]);

    // 4. The new release also publishes a new version of the automation, and a contact
    //    arrives while no worker is running.
    await withTenant(db, context, (trx) =>
      publishAutomationVersion(
        trx,
        context,
        automationId,
        withTagIds(version('Finished on version 2')),
        'Second release',
      ),
    );
    const linus = await addContact('Linus');
    expect(await enrolmentOf(linus)).toBeUndefined();

    // 5. The new worker starts on the migrated database. The waits end on their own time.
    const after = await startWorkerProcess();
    for (const contact of [ada, grace])
      await expect
        .poll(() => enrolmentOf(contact), {
          // Ada's own job runs when its wait ends; Grace's is found by the sweeper, which
          // passes once a minute.
          timeout: (WAIT_SECONDS + 100) * 1000,
          interval: 500,
          message: after.output(),
        })
        .toMatchObject({ status: 'completed', current_step: null, exit_reason: null });

    // Each went on from the saved step, on the version it began on, and no step ran twice.
    for (const [contact, run] of [
      [ada, adaRun],
      [grace, graceRun],
    ] as const) {
      expect(await enrolmentOf(contact)).toMatchObject({ id: run, version: 1 });
      // The wait it was in when the worker was killed is over: gone on from, it succeeded.
      expect(await stepsOf(run)).toEqual([
        { step_key: 'mark', status: 'succeeded' },
        { step_key: 'pause', status: 'succeeded' },
        { step_key: 'finish', status: 'succeeded' },
      ]);
      expect(await tagsOf(contact)).toEqual(['Finished on version 1', 'Started']);
    }
    // The contact who arrived during the upgrade is enrolled by the new worker, on the new
    // version, and finishes on it.
    await expect
      .poll(() => enrolmentOf(linus), {
        timeout: (WAIT_SECONDS + 30) * 1000,
        interval: 500,
        message: after.output(),
      })
      .toMatchObject({ status: 'completed', version: 2 });
    expect(await tagsOf(linus)).toEqual(['Finished on version 2', 'Started']);
    // Nobody was enrolled twice, and the migration's column is on the rows that waited.
    const [counts] = await database.withTenant(context, (sql) =>
      sql.query<{ enrolments: number; probed: number }>(
        `select count(*)::int as enrolments, count(*) filter (where upgrade_probe is null)::int as probed
       from automation.enrolments`,
      ),
    );
    expect(counts).toEqual({ enrolments: 3, probed: 3 });
  },
  2 * START_HANG_MS + 300_000,
);
