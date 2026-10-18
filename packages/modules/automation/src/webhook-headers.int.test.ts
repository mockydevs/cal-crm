// A webhook.call step's headers and the business's named webhook secrets (tasks/edge-cases/
// automation.md, finding 15), end to end: a secret is sealed in the vault and the table
// holds only its vault id; the delivery carries the header; nothing the database keeps
// besides the vault holds the value; and a deleted secret fails the step without sending.
// Real Postgres and the real commands; the vault and the network are stand-ins.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { createRunStepCommand } from './runner.js';
import { contactValues } from './values.js';
import type { WebhookHeaderValue } from './webhook.js';
import {
  createWebhookSecretCommands,
  readWebhookSecretNames,
  readWebhookSecrets,
  WEBHOOK_HEADER_SECRET_PURPOSE,
  type WebhookSecretVault,
} from './webhook-secrets.js';
import { createRotateWebhookSecretCommand, type SecretOpener } from './webhook-signing.js';
import { createCallWebhookTask } from './webhook-task.js';

const KEY = `sk_live_${randomUUID().replaceAll('-', '')}`;
const URL_KEY = `urlkey${randomUUID().replaceAll('-', '')}`;

const runStepCommand = createRunStepCommand({
  tasks: {
    actorNames: {},
    assignees: {
      resolve: () => Promise.resolve(null),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map<string, string>()),
    },
  },
});

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

// Stands in for the vault: real rows in vault.secrets, as crm_app writes them, with the
// plaintext kept here in place of real sealing.
function standInVault(): WebhookSecretVault & SecretOpener & { readonly reads: string[] } {
  const plaintexts = new Map<string, string>();
  const reads: string[] = [];
  const sealed = () => sql<Buffer>`decode(repeat('ab', 32), 'hex')`;
  return {
    reads,
    async store(trx: DatabaseTransaction, owner, plaintext) {
      const { id } = await trx
        .insertInto('vault.secrets')
        .values({
          agency_id: owner.agencyId,
          business_id: owner.businessId,
          purpose: owner.purpose,
          key_version: 1,
          enc: sealed(),
          ciphertext: sealed(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      plaintexts.set(id, plaintext);
      return id;
    },
    replace: (_trx, secretId, plaintext) => {
      plaintexts.set(secretId, plaintext);
      return Promise.resolve();
    },
    async remove(trx: DatabaseTransaction, secretId) {
      const removed = await trx.deleteFrom('vault.secrets').where('id', '=', secretId).execute();
      if (removed[0]?.numDeletedRows !== 1n) throw new NotFoundError('secret', secretId);
      plaintexts.delete(secretId);
    },
    async read(trx: DatabaseTransaction, secretId, purpose) {
      reads.push(purpose);
      // Only a secret of the purpose asked for, as the real vault finds it.
      await trx
        .selectFrom('vault.secrets')
        .select('id')
        .where('id', '=', secretId)
        .where('purpose', '=', purpose)
        .executeTakeFirstOrThrow();
      const plaintext = plaintexts.get(secretId);
      if (plaintext === undefined) throw new Error('No such secret.');
      return plaintext;
    },
  };
}

const lockBusiness = () => Promise.resolve();

interface Sent {
  readonly url: string;
  readonly headers: readonly WebhookHeaderValue[];
}

/** A business with a signing secret, a header secret, and a contact enrolled in a webhook. */
async function scene() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  const as = { context, permissions: 'all' as const };
  const vault = standInVault();
  const secrets = createWebhookSecretCommands({ vault, lockBusiness });
  await runCommand(services, createRotateWebhookSecretCommand({ vault, lockBusiness }), {}, as);
  const stored = await runCommand(
    services,
    secrets.put,
    { name: 'crm_key', value: `Bearer ${KEY}` },
    as,
  );
  const document: AutomationDocumentInput = {
    name: 'Tell the warehouse',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'tell',
    steps: {
      tell: {
        type: 'webhook.call',
        config: {
          url: `https://hooks.example.test/crm?api_key=${URL_KEY}`,
          headers: [
            { name: 'Authorization', secret: 'crm_key' },
            { name: 'X-Customer', value: 'For {{contact.firstName}}' },
          ],
        },
      },
    },
  };
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`] },
    as,
  );
  const enrolmentId = await withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: business.id,
        name: document.name,
        draft: JSON.stringify(document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
    const event = await trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow();
    const [first] = (await matchEvent(trx, context, event.id, contactValues)).enrolled;
    if (first === undefined) throw new Error('Nothing enrolled.');
    return first.enrolmentId;
  });
  const sent: Sent[] = [];
  const enrolment = async () => {
    const [row] = await database.withTenant(context, (client) =>
      client.query<{ status: string; state: { sequence: number; webhook?: { attempt: number } } }>(
        'select status, state from automation.enrolments where id = $1',
        [enrolmentId],
      ),
    );
    if (row === undefined) throw new Error('The enrolment exists.');
    return row;
  };
  return {
    context,
    as,
    vault,
    secrets,
    stored,
    sent,
    business,
    step: async () =>
      runCommand(
        services,
        runStepCommand,
        { enrolmentId, sequence: (await enrolment()).state.sequence },
        as,
      ),
    deliver: async () => {
      const current = await enrolment();
      const task = createCallWebhookTask({
        vault,
        call: (config, _body, options) => {
          sent.push({ url: config.url, headers: options.headers ?? [] });
          return Promise.resolve({ ok: true, status: 200, body: '', truncated: false });
        },
      });
      await task.run(
        {
          enrolmentId,
          sequence: current.state.sequence,
          attempt: current.state.webhook?.attempt ?? 0,
        },
        { invocation: as, services },
      );
    },
    stepRuns: () =>
      database.withTenant(context, (client) =>
        client.query<{ status: string; input: unknown; error: unknown; explanation: string }>(
          `select status, input, error, explanation from automation.step_runs
           where enrolment_id = $1 order by started_at, id`,
          [enrolmentId],
        ),
      ),
  };
}

/** Where, outside the vault, the database keeps a text. */
const kept = (text: string) =>
  database.as('postgres', (client) =>
    client.query<{ found: string }>(
      `select 'event' as found from events.events where payload::text like '%' || $1 || '%'
       union all
       select 'audit' from audit.commands c where to_jsonb(c)::text like '%' || $1 || '%'
       union all
       select 'secrets' from automation.webhook_secrets s where to_jsonb(s)::text like '%' || $1 || '%'
       union all
       select 'step_runs' from automation.step_runs r where to_jsonb(r)::text like '%' || $1 || '%'
       union all
       select 'enrolments' from automation.enrolments e where to_jsonb(e)::text like '%' || $1 || '%'
       union all
       select 'jobs' from graphile_worker._private_jobs j where to_jsonb(j)::text like '%' || $1 || '%'`,
      [text],
    ),
  );

it('sends the stored secret in its header, and keeps it nowhere but the vault', async () => {
  const s = await scene();
  expect(s.stored).toMatchObject({ name: 'crm_key' });

  // The table holds the name and the vault id; the vault row is filed under the purpose.
  const [row] = await database.withTenant(s.context, (client) =>
    client.query<{ name: string; purpose: string }>(
      `select w.name, v.purpose from automation.webhook_secrets w
       join vault.secrets v on v.business_id = w.business_id and v.id = w.secret_id`,
    ),
  );
  expect(row).toEqual({ name: 'crm_key', purpose: WEBHOOK_HEADER_SECRET_PURPOSE });
  expect(await withTenant(db, s.context, readWebhookSecrets)).toMatchObject({
    items: [{ name: 'crm_key' }],
  });
  expect(await withTenant(db, s.context, readWebhookSecretNames)).toEqual(['crm_key']);

  expect(await s.step()).toBe('ran');
  await s.deliver();
  expect(s.sent).toEqual([
    {
      url: `https://hooks.example.test/crm?api_key=${URL_KEY}`,
      headers: [
        { name: 'Authorization', value: `Bearer ${KEY}` },
        { name: 'X-Customer', value: 'For Ada' },
      ],
    },
  ]);
  expect(s.vault.reads).toContain(WEBHOOK_HEADER_SECRET_PURPOSE);
  expect(await s.step()).toBe('ran');

  const runs = await s.stepRuns();
  expect(runs.map((run) => run.status)).toEqual(['succeeded', 'succeeded']);
  // The run's history names the secret, never its value, and hides the URL's key.
  expect(JSON.stringify(runs)).toContain('crm_key');
  expect(JSON.stringify(runs)).toContain('api_key=redacted');
  expect(await kept(KEY)).toEqual([]);
  expect(await kept(URL_KEY)).not.toContainEqual({ found: 'step_runs' });
});

it('replaces a value in place, and a deleted secret fails the step without sending', async () => {
  const s = await scene();
  const replacement = `Bearer ${randomUUID()}`;
  const again = await runCommand(
    services,
    s.secrets.put,
    { name: 'crm_key', value: replacement },
    s.as,
  );
  expect(again.name).toBe('crm_key');
  const count = () =>
    database.withTenant(s.context, (client) =>
      client.query<{ secrets: number; vault: number }>(
        `select (select count(*)::int from automation.webhook_secrets) as secrets,
                (select count(*)::int from vault.secrets where purpose = $1) as vault`,
        [WEBHOOK_HEADER_SECRET_PURPOSE],
      ),
    );
  expect(await count()).toEqual([{ secrets: 1, vault: 1 }]);

  expect(await s.step()).toBe('ran');
  // Deleted after the step armed: its sealed value goes too.
  await runCommand(services, s.secrets.remove, { name: 'crm_key' }, s.as);
  expect(await count()).toEqual([{ secrets: 0, vault: 0 }]);
  await expect(
    runCommand(services, s.secrets.remove, { name: 'crm_key' }, s.as),
  ).rejects.toBeInstanceOf(NotFoundError);

  await s.deliver();
  expect(s.sent).toEqual([]);
  expect(await s.step()).toBe('ran');
  const runs = await s.stepRuns();
  expect(runs.at(-1)).toMatchObject({
    status: 'failed',
    explanation: 'The webhook failed after 1 attempt: There is no webhook secret named crm_key.',
  });
  expect(JSON.stringify(runs.at(-1)?.error)).toContain('secret_missing');
  const events = await database.withTenant(s.context, (client) =>
    client.query<{ type: string; payload: unknown }>(
      `select type, payload from events.events
       where type like 'automation.webhook_header_secret_%' order by recorded_at, id`,
    ),
  );
  expect(events).toEqual([
    { type: 'automation.webhook_header_secret_stored', payload: { name: 'crm_key', first: true } },
    {
      type: 'automation.webhook_header_secret_stored',
      payload: { name: 'crm_key', first: false },
    },
    { type: 'automation.webhook_header_secret_deleted', payload: { name: 'crm_key' } },
  ]);
  expect(await kept(replacement)).toEqual([]);
});
