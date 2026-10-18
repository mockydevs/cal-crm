// Drafts (AUTOMATIONS.md section 5): a stale draft version is a 409 and never a silent
// overwrite, JSON Patch applies whole or not at all, and each save reports validation.
// Real Postgres, through the command layer.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import type { AutomationSetup } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, NotFoundError, ValidationError, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  AUTOMATION_PAGE_SIZE,
  createDraftCommands,
  MAX_DRAFT_SIZE,
  readAutomation,
  readAutomations,
} from './drafts.js';

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
  tags: [{ id: 'tag_01890a5dac96774bbcceb302099a8057', name: 'VIP' }],
  users: [],
  automations: [],
  values: [],
  channels: { email: false, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};
const { create, replace, patch } = createDraftCommands({ setup: () => Promise.resolve(setup) });

const welcome = {
  name: 'Welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'tag',
  steps: { tag: { type: 'tag.add', config: { tag: 'VIP' } } },
};

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}
const as = (context: TenantContext) => ({ context, permissions: 'all' as const });

const events = (context: TenantContext) =>
  database.withTenant(context, (sql) =>
    sql.query<{ type: string; payload: { draftVersion?: number } }>(
      "select type, payload from events.events where type like 'automation.%' order by recorded_at, id",
    ),
  );

describe('creating a draft', () => {
  it('saves even an unfinished draft at version 1, and says what validation found', async () => {
    const context = await business();
    const unfinished = await runCommand(
      services,
      create,
      { document: { name: '  Half done ', steps: {} } },
      as(context),
    );
    expect(unfinished.automation).toMatchObject({
      name: 'Half done',
      status: 'draft',
      draftVersion: 1,
      liveVersion: null,
      lastRunAt: null,
      live: null,
    });
    expect(unfinished.validation.valid).toBe(false);
    expect(unfinished.validation.errors.length).toBeGreaterThan(0);

    const finished = await runCommand(services, create, { document: welcome }, as(context));
    expect(finished.validation).toEqual({ valid: true, errors: [], warnings: [] });
    expect(finished.automation.draft).toEqual(welcome);
    expect((await events(context)).map((event) => event.type)).toEqual([
      'automation.created',
      'automation.created',
    ]);
  });

  it('needs a name, the one thing the list must show', async () => {
    const context = await business();
    await expect(
      runCommand(services, create, { document: { steps: {} } }, as(context)),
    ).rejects.toMatchObject({ issues: [{ path: '/document/name', code: 'invalid_name' }] });
  });

  it('refuses a draft over the size limit, or one that is not JSON', async () => {
    const context = await business();
    const huge = { name: 'Huge', notes: 'x'.repeat(MAX_DRAFT_SIZE) };
    await expect(
      runCommand(services, create, { document: huge }, as(context)),
    ).rejects.toMatchObject({ issues: [{ path: '/document', code: 'too_large' }] });
    await expect(
      runCommand(services, create, { document: { name: 'Bad', at: new Date(0) } }, as(context)),
    ).rejects.toMatchObject({ issues: [{ path: '/document', code: 'invalid_value' }] });
  });
});

describe('saving a draft', () => {
  it('replaces the draft from the current version, and refuses a stale one with 409', async () => {
    const context = await business();
    const { automation } = await runCommand(services, create, { document: welcome }, as(context));
    const renamed = { ...welcome, name: 'Welcome, renamed' };
    const saved = await runCommand(
      services,
      replace,
      { id: automation.id, baseDraftVersion: 1, document: renamed },
      as(context),
    );
    expect(saved.automation).toMatchObject({ name: 'Welcome, renamed', draftVersion: 2 });

    const stale = runCommand(
      services,
      replace,
      { id: automation.id, baseDraftVersion: 1, document: { ...welcome, name: 'Lost?' } },
      as(context),
    );
    await expect(stale).rejects.toBeInstanceOf(ConflictError);
    await expect(stale).rejects.toThrow(/version 2, not 1/);
    const current = await withTenant(db, context, (trx) => readAutomation(trx, automation.id));
    expect(current).toMatchObject({ name: 'Welcome, renamed', draftVersion: 2 });
    expect(
      (await events(context)).map((event) => [event.type, event.payload.draftVersion]),
    ).toEqual([
      ['automation.created', undefined],
      ['automation.draft_updated', 2],
    ]);
  });

  it('lets exactly one of two overlapping saves from the same version win', async () => {
    const context = await business();
    const { automation } = await runCommand(services, create, { document: welcome }, as(context));
    // The first save stops inside its transaction, after writing, until the second save is
    // waiting on the database; only then does the first commit. So the two truly overlap.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const atSetup = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let calls = 0;
    const gated = createDraftCommands({
      setup: async () => {
        calls += 1;
        if (calls === 1) {
          reached();
          await held;
        }
        return setup;
      },
    });
    const save = (name: string) =>
      runCommand(
        services,
        gated.replace,
        { id: automation.id, baseDraftVersion: 1, document: { ...welcome, name } },
        as({ ...context, correlationId: randomUUID() }),
      );
    const first = save('First');
    await atSetup;
    const second = save('Second');
    // Another role's wait events are hidden from crm_app, so the superuser watches.
    await expect
      .poll(
        () =>
          database.as('postgres', async (sql) => {
            const [row] = await sql.query<{ waiting: number }>(
              `select count(*)::int as waiting from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'`,
            );
            return row?.waiting ?? 0;
          }),
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);
    release();
    const [won, lost] = await Promise.allSettled([first, second]);
    expect(won).toMatchObject({ status: 'fulfilled' });
    expect(lost).toMatchObject({ status: 'rejected' });
    expect(lost.status === 'rejected' && lost.reason).toBeInstanceOf(ConflictError);
    const current = await withTenant(db, context, (trx) => readAutomation(trx, automation.id));
    expect(current).toMatchObject({ name: 'First', draftVersion: 2 });
  });

  it('edits with JSON Patch, whole or not at all', async () => {
    const context = await business();
    const { automation } = await runCommand(services, create, { document: welcome }, as(context));
    const edited = await runCommand(
      services,
      patch,
      {
        id: automation.id,
        baseDraftVersion: 1,
        patch: [
          { op: 'test', path: '/steps/tag/config/tag', value: 'VIP' },
          { op: 'replace', path: '/name', value: 'Welcome VIPs' },
          { op: 'add', path: '/steps/tag/label', value: 'Mark as VIP' },
        ],
      },
      as(context),
    );
    expect(edited.automation).toMatchObject({ name: 'Welcome VIPs', draftVersion: 2 });
    expect(edited.automation.draft).toMatchObject({
      steps: { tag: { label: 'Mark as VIP' } },
    });
    expect(edited.validation.valid).toBe(true);

    const failing = runCommand(
      services,
      patch,
      {
        id: automation.id,
        baseDraftVersion: 2,
        patch: [
          { op: 'replace', path: '/name', value: 'Should not stick' },
          { op: 'remove', path: '/steps/missing' },
        ],
      },
      as(context),
    );
    await expect(failing).rejects.toBeInstanceOf(ValidationError);
    await expect(failing).rejects.toMatchObject({
      issues: [{ path: '/patch/1', code: 'path_not_found' }],
    });
    const current = await withTenant(db, context, (trx) => readAutomation(trx, automation.id));
    expect(current).toMatchObject({ name: 'Welcome VIPs', draftVersion: 2 });
  });

  it('refuses a patch that would empty the name or grow the draft past the limit', async () => {
    const context = await business();
    const { automation } = await runCommand(services, create, { document: welcome }, as(context));
    await expect(
      runCommand(
        services,
        patch,
        { id: automation.id, baseDraftVersion: 1, patch: [{ op: 'remove', path: '/name' }] },
        as(context),
      ),
    ).rejects.toMatchObject({ issues: [{ path: '/name', code: 'invalid_name' }] });
    const doubling = Array.from({ length: 40 }, (_, position) => ({
      op: 'copy' as const,
      from: '',
      path: `/copy${String(position)}`,
    }));
    await expect(
      runCommand(
        services,
        patch,
        { id: automation.id, baseDraftVersion: 1, patch: doubling },
        as(context),
      ),
    ).rejects.toMatchObject({ issues: [{ code: 'too_large' }] });
  });

  it("never reads or saves another business's draft, nor an archived one", async () => {
    const context = await business();
    const other = await business();
    const { automation } = await runCommand(services, create, { document: welcome }, as(context));
    await expect(
      withTenant(db, other, (trx) => readAutomation(trx, automation.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      runCommand(
        services,
        replace,
        { id: automation.id, baseDraftVersion: 1, document: welcome },
        as(other),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    await database.withTenant(context, (sql) =>
      sql.query("update automation.automations set status = 'archived', archived_at = now()"),
    );
    await expect(
      runCommand(
        services,
        patch,
        {
          id: automation.id,
          baseDraftVersion: 1,
          patch: [{ op: 'replace', path: '/name', value: 'Revived?' }],
        },
        as(context),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('what the list shows', () => {
  it('keeps the description beside the name, and shows none when it is too long to', async () => {
    const context = await business();
    const described = await runCommand(
      services,
      create,
      { document: { ...welcome, description: '  Greets every new contact. ' } },
      as(context),
    );
    expect(described.automation).toMatchObject({
      name: 'Welcome',
      description: 'Greets every new contact.',
    });
    const long = await runCommand(
      services,
      create,
      { document: { ...welcome, description: 'x'.repeat(2001) } },
      as(context),
    );
    // The draft is saved as written, and validation says what is wrong with it.
    expect(long.automation.description).toBe('');
    expect(long.automation.draft).toMatchObject({ description: 'x'.repeat(2001) });
    expect(long.validation.valid).toBe(false);
  });

  it('refuses a patch that leaves something other than a JSON object', async () => {
    const context = await business();
    const { automation } = await runCommand(services, create, { document: welcome }, as(context));
    await expect(
      runCommand(
        services,
        patch,
        {
          id: automation.id,
          baseDraftVersion: 1,
          patch: [{ op: 'replace', path: '', value: ['not', 'a', 'draft'] }],
        },
        as(context),
      ),
    ).rejects.toMatchObject({ issues: [{ path: '', code: 'invalid_document' }] });
    const current = await withTenant(db, context, (trx) => readAutomation(trx, automation.id));
    expect(current).toMatchObject({ draft: welcome, draftVersion: 1 });
  });

  it('lists newest first, a page at a time, and continues from a cursor', async () => {
    const context = await business();
    await database.withTenant(context, (sql) =>
      sql.query(
        `insert into automation.automations (business_id, name, draft, created_by_kind)
         select app.business_id(), 'Automation ' || series.n, $1::jsonb, 'system'
         from generate_series(1, $2::int) as series (n)`,
        [JSON.stringify(welcome), AUTOMATION_PAGE_SIZE + 1],
      ),
    );
    const list = (after?: string) =>
      withTenant(db, context, (trx) => readAutomations(trx, { after }));
    const first = await list();
    expect(first.items).toHaveLength(AUTOMATION_PAGE_SIZE);
    const last = first.items.at(-1)?.id;
    expect(first.nextCursor).toBe(last);
    const rest = await list(last);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect(first.items.map((automation) => automation.id)).not.toContain(rest.items[0]?.id);

    await expect(list('page-two')).rejects.toMatchObject({
      name: 'ValidationError',
      issues: [{ path: '/after', code: 'invalid_cursor' }],
    });
    await expect(
      withTenant(db, context, (trx) => readAutomation(trx, 'welcome')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
