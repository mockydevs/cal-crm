// Publishing, pausing, versions and runs (AUTOMATIONS.md section 5). Only a valid
// draft, and the draft the caller saw, becomes live; a pause stops new enrolments; versions
// never change; and a run shows each step it took. Real Postgres, real CRM events.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { applyJsonPatch, type AutomationSetup } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, NotFoundError, toPublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createDraftCommands } from './drafts.js';
import { matchEvent } from './enrolment.js';
import { diffVersions, readRun, readRuns, readVersion, readVersions } from './history.js';
import { createLifecycleCommands } from './lifecycle.js';
import { contactValues } from './values.js';

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const VIP = toPublicId('tag', '01890a5d-ac96-774b-bcce-b302099a8057');
const setup: AutomationSetup = {
  fields: { contact: [], deal: [] },
  forms: [],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [],
  pipelines: [],
  lostReasons: [],
  tags: [{ id: VIP, name: 'VIP' }],
  users: [],
  automations: [],
  values: [],
  channels: { email: false, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};
const read = () => Promise.resolve(setup);
const drafts = createDraftCommands({ setup: read });
const lifecycle = createLifecycleCommands({ setup: read });

const welcome = {
  name: 'Welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'pause',
  steps: {
    pause: { type: 'wait', config: { duration: 'P1D' }, next: 'tag' },
    tag: { type: 'tag.add', config: { tag: 'VIP' } },
  },
};

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}
const as = (context: TenantContext) => ({ context, permissions: 'all' as const });
const create = async (context: TenantContext, document: Record<string, unknown> = welcome) =>
  (await runCommand(services, drafts.create, { document }, as(context))).automation;

/** Creates a contact through the CRM's own command, then matches its real event. */
async function contactCreated(context: TenantContext): Promise<number> {
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`] },
    as(context),
  );
  return withTenant(db, context, async (trx) => {
    const event = await trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'contact.created')
      .orderBy('recorded_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    return (await matchEvent(trx, context, event.id, contactValues)).enrolled.length;
  });
}

it('publishes only a valid draft, from the version the caller saw, with names resolved', async () => {
  const context = await business();
  const broken = await create(context, { ...welcome, start: 'nowhere' });
  const refused = runCommand(
    services,
    lifecycle.publish,
    { id: broken.id, baseDraftVersion: 1 },
    as(context),
  );
  await expect(refused).rejects.toMatchObject({ name: 'ValidationError' });
  await expect(refused).rejects.toMatchObject({
    issues: expect.arrayContaining([expect.objectContaining({ path: '/draft/start' })]) as unknown,
  });

  const automation = await create(context);
  await expect(
    runCommand(
      services,
      lifecycle.publish,
      { id: automation.id, baseDraftVersion: 7 },
      as(context),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  const live = await runCommand(
    services,
    lifecycle.publish,
    { id: automation.id, baseDraftVersion: 1, changeSummary: ' First version ' },
    as(context),
  );
  expect(live).toMatchObject({
    status: 'active',
    liveVersion: 1,
    draftVersion: 1,
    live: { version: 1, changeSummary: 'First version' },
  });
  // What runs is the resolved document: the tag by id, so renaming the tag changes nothing.
  expect(live.live?.document).toMatchObject({ steps: { tag: { config: { tag: VIP } } } });
  expect(live.draft).toMatchObject({ steps: { tag: { config: { tag: 'VIP' } } } });
  const events = await database.withTenant(context, (sql) =>
    sql.query<{ payload: unknown }>(
      "select payload from events.events where type = 'automation.published'",
    ),
  );
  expect(events).toEqual([{ payload: { version: 1, draftVersion: 1 } }]);
});

it('stops new enrolments while paused, keeps the pause across a publish, and resumes', async () => {
  const context = await business();
  const automation = await create(context);
  await expect(
    runCommand(services, lifecycle.pause, { id: automation.id }, as(context)),
  ).rejects.toBeInstanceOf(ConflictError);
  await runCommand(
    services,
    lifecycle.publish,
    { id: automation.id, baseDraftVersion: 1 },
    as(context),
  );
  expect(await contactCreated(context)).toBe(1);

  const paused = await runCommand(services, lifecycle.pause, { id: automation.id }, as(context));
  expect(paused.status).toBe('paused');
  expect(await contactCreated(context)).toBe(0);
  // Pausing twice is not an error, and says so once.
  await runCommand(services, lifecycle.pause, { id: automation.id }, as(context));
  const republished = await runCommand(
    services,
    lifecycle.publish,
    { id: automation.id, baseDraftVersion: 1 },
    as(context),
  );
  expect(republished).toMatchObject({ status: 'paused', liveVersion: 2 });
  expect(await contactCreated(context)).toBe(0);

  const resumed = await runCommand(services, lifecycle.resume, { id: automation.id }, as(context));
  expect(resumed.status).toBe('active');
  expect(await contactCreated(context)).toBe(1);
  const types = await database.withTenant(context, (sql) =>
    sql.query<{ type: string }>(
      `select type from events.events
       where type in ('automation.paused', 'automation.resumed') order by recorded_at, id`,
    ),
  );
  expect(types.map((event) => event.type)).toEqual(['automation.paused', 'automation.resumed']);
});

it('keeps every version, newest first, and says what changed between two', async () => {
  const context = await business();
  const automation = await create(context);
  const publish = (baseDraftVersion: number, changeSummary: string) =>
    runCommand(
      services,
      lifecycle.publish,
      { id: automation.id, baseDraftVersion, changeSummary },
      as(context),
    );
  await publish(1, 'First');
  await runCommand(
    services,
    drafts.patch,
    {
      id: automation.id,
      baseDraftVersion: 1,
      patch: [{ op: 'replace', path: '/steps/pause/config/duration', value: 'P2D' }],
    },
    as(context),
  );
  await publish(2, 'Wait longer');

  const tenant = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant(db, context, work);
  const list = await tenant((trx) => readVersions(trx, automation.id, {}));
  expect(list.items.map((version) => [version.version, version.changeSummary])).toEqual([
    [2, 'Wait longer'],
    [1, 'First'],
  ]);
  expect(list.nextCursor).toBeNull();
  expect(
    (await tenant((trx) => readVersions(trx, automation.id, { after: 2 }))).items.map(
      (version) => version.version,
    ),
  ).toEqual([1]);

  const [first, second] = [
    await tenant((trx) => readVersion(trx, automation.id, 1)),
    await tenant((trx) => readVersion(trx, automation.id, 2)),
  ];
  const diff = await tenant((trx) => diffVersions(trx, automation.id, 1, 2));
  expect(diff).toEqual({
    from: 1,
    to: 2,
    patch: [{ op: 'replace', path: '/steps/pause/config/duration', value: 'P2D' }],
  });
  expect(applyJsonPatch(first.document, diff.patch)).toEqual({
    ok: true,
    document: second.document,
  });
  await expect(tenant((trx) => readVersion(trx, automation.id, 3))).rejects.toBeInstanceOf(
    NotFoundError,
  );
  const other = await business();
  await expect(
    withTenant(db, other, (trx) => readVersions(trx, automation.id, {})),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('lists real runs and shows a run with its version, record and state', async () => {
  const context = await business();
  const automation = await create(context);
  await runCommand(
    services,
    lifecycle.publish,
    { id: automation.id, baseDraftVersion: 1 },
    as(context),
  );
  expect(await contactCreated(context)).toBe(1);
  expect(await contactCreated(context)).toBe(1);
  const list = await withTenant(db, context, (trx) => readRuns(trx, automation.id, {}));
  expect(list.items).toHaveLength(2);
  expect(list.items[0]).toMatchObject({
    automationId: automation.id,
    version: 1,
    status: 'running',
    currentStep: 'pause',
    finishedAt: null,
  });
  expect(list.items[0]?.recordId).toMatch(/^con_/);
  expect(
    (await withTenant(db, context, (trx) => readRuns(trx, automation.id, { status: 'failed' })))
      .items,
  ).toEqual([]);
  const [newest] = list.items;
  if (newest === undefined) throw new Error('A run is listed.');
  const run = await withTenant(db, context, (trx) => readRun(trx, newest.id));
  expect(run).toMatchObject({ id: newest.id, steps: [] });
  const other = await business();
  await expect(withTenant(db, other, (trx) => readRun(trx, newest.id))).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(
    withTenant(db, other, (trx) => readRuns(trx, automation.id, {})),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('has nothing to pause or resume under an id that is not one, or for an archived automation', async () => {
  const context = await business();
  for (const command of [lifecycle.pause, lifecycle.resume])
    await expect(
      runCommand(services, command, { id: 'welcome' }, as(context)),
    ).rejects.toBeInstanceOf(NotFoundError);

  const automation = await create(context);
  await runCommand(
    services,
    lifecycle.publish,
    { id: automation.id, baseDraftVersion: 1 },
    as(context),
  );
  await database.withTenant(context, (sql) =>
    sql.query("update automation.automations set status = 'archived', archived_at = now()"),
  );
  for (const command of [lifecycle.pause, lifecycle.resume])
    await expect(
      runCommand(services, command, { id: automation.id }, as(context)),
    ).rejects.toBeInstanceOf(NotFoundError);
  const events = await database.withTenant(context, (sql) =>
    sql.query<{ type: string }>(
      "select type from events.events where type in ('automation.paused', 'automation.resumed')",
    ),
  );
  expect(events).toEqual([]);
});
