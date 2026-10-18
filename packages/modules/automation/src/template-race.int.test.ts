// Publishing a workflow that sends a template, while someone deletes or archives that
// template, against real Postgres and the real commands of both modules. Whichever comes
// first, no active workflow ends up sending a template that is gone: the publish holds the
// templates it sends until it commits, and deleting or archiving one holds it for update,
// then refuses while a workflow sends it.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, parsePublicId, ValidationError, type TenantContext } from '@repo/kernel';
import { createTemplateCommands } from '@repo/module-messaging';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createDraftCommands, type ReadSetup } from './drafts.js';
import { createLifecycleCommands } from './lifecycle.js';
import { readAutomationSetup } from './setup.js';
import { readTemplateUses } from './template-uses.js';

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

/** A promise and the function that settles it, to hold a step until the test lets it go. */
function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

// The business's real setup; no mailbox is connected, and these tests only publish.
const realSetup: ReadSetup = async (trx, context) => ({
  ...(await readAutomationSetup(trx, context, () => Promise.resolve([]), {
    webhookDelivery: false,
    smsDelivery: false,
  })),
  channels: { email: true, sms: false, whatsapp: false },
});
// Set by a test to hold a publish just after it read the setup, before it locks anything.
let afterSetup: (() => Promise<void>) | undefined;
const setup: ReadSetup = async (trx, context) => {
  const read = await realSetup(trx, context);
  await afterSetup?.();
  return read;
};
const drafts = createDraftCommands({ setup: realSetup });
const lifecycle = createLifecycleCommands({ setup });
const templates = createTemplateCommands({ uses: readTemplateUses });

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}
const as = (context: TenantContext) => ({ context, permissions: 'all' as const });

const sending = (template: string): AutomationDocumentInput => ({
  name: 'Sender',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'send',
  steps: { send: { type: 'email.send', config: { template } } },
});

/** A live template and a draft workflow that sends it, not published yet. */
async function prepare(context: TenantContext) {
  const template = await runCommand(
    services,
    templates.create,
    { name: 'Welcome', subject: 'Hi', body: 'Hello' },
    as(context),
  );
  const { automation } = await runCommand(
    services,
    drafts.create,
    { document: sending(template.id) },
    as(context),
  );
  const publish = () =>
    runCommand(
      services,
      lifecycle.publish,
      { id: automation.id, baseDraftVersion: automation.draftVersion },
      as(context),
    );
  const change = (action: 'delete' | 'archive') =>
    runCommand(
      services,
      action === 'delete' ? templates.remove : templates.archive,
      { id: template.id, revision: template.revision },
      as(context),
    );
  return { template, automation, publish, change };
}

/** How many statements of this test's database are waiting for a lock now. */
const waiting = async (): Promise<number> =>
  // Only a superuser sees what other roles' sessions wait for.
  (
    await database.as('postgres', (sql) =>
      sql.one<{ count: number }>(
        `select count(*)::integer as count from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      ),
    )
  ).count;

/**
 * Waits until this many statements wait for a lock (true), or until `settled` has settled
 * or ten seconds have passed (false).
 */
async function untilWaiting(count: number, settled: Promise<unknown>): Promise<boolean> {
  const state = { done: false };
  void settled.then(
    () => (state.done = true),
    () => (state.done = true),
  );
  for (const started = Date.now(); !state.done && Date.now() - started < 10_000;) {
    if ((await waiting()) >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe.each(['delete', 'archive'] as const)('a template to %s', (action) => {
  it('is refused to a publish that read it before the change committed', async () => {
    const context = await business();
    const { template, automation, publish, change } = await prepare(context);
    const reached = gate();
    const held = gate();
    afterSetup = () => {
      reached.open();
      return held.opened;
    };
    try {
      const publishing = publish();
      // The publish has read the live template and validates against it; now the change
      // commits before the publish goes on.
      await reached.opened;
      const changed = await change(action);
      expect(changed.archivedAt).not.toBeNull();
      held.open();
      const refused = await publishing.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(ValidationError);
      expect(refused).toMatchObject({
        issues: [{ path: '/draft/steps/send/config/template', code: 'template_unavailable' }],
      });
    } finally {
      held.open();
      afterSetup = undefined;
    }
    // Nothing went live, so nothing sends the template that is gone.
    expect(
      await withTenant(db, context, (trx) => readTemplateUses(trx, context, template.id)),
    ).toEqual([]);
    const row = await database.withTenant(context, (sql) =>
      sql.one<{ status: string; published_version_id: string | null }>(
        `select status, published_version_id from automation.automations where id = $1`,
        [parsePublicId('automation', automation.id)],
      ),
    );
    expect(row).toEqual({ status: 'draft', published_version_id: null });
  });

  it('waits for a publish that holds it, then refuses, naming the workflow that sends it', async () => {
    const context = await business();
    const { template, publish, change } = await prepare(context);
    // Holds the publish after it has locked its templates: it waits to write its version.
    const versions = gate();
    const released = gate();
    const holding = database.as('crm_owner', async (sql) => {
      await sql.query('lock table automation.versions in share mode');
      versions.open();
      await released.opened;
    });
    await versions.opened;
    try {
      const publishing = publish();
      expect(await untilWaiting(1, publishing)).toBe(true);
      const changing = change(action).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      // The change waits for the publish, which still holds the template.
      await untilWaiting(2, changing);
      released.open();
      await holding;
      await publishing;
      const outcome = await changing;
      // Refused, naming the workflow it now waited for.
      expect(outcome).toMatchObject({ error: expect.any(ConflictError) as unknown });
      expect(outcome).toMatchObject({
        error: { message: expect.stringContaining('"Sender" sends this template') as unknown },
      });
    } finally {
      released.open();
      await holding;
    }
    // The template stays live, and the workflow that went live sends it.
    expect(
      await withTenant(db, context, (trx) => readTemplateUses(trx, context, template.id)),
    ).toMatchObject([{ name: 'Sender', status: 'active' }]);
  });
});
