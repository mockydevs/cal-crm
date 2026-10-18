import { randomUUID } from 'node:crypto';

import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  createSealingVault,
  createVault,
  newSecretsKey,
  parseSecretsKeys,
  parseSecretsPublicKey,
} from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { vault } from './vault-cli.js';

// The vault's command: node dist/vault.js new-key makes the install's keys, and node
// dist/vault.js rotate, run in the worker, re-seals every secret under the current one.
let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

function output() {
  const lines = { stdout: '', stderr: '' };
  return {
    lines,
    stdout: { write: (text: string) => (lines.stdout += text) },
    stderr: { write: (text: string) => (lines.stderr += text) },
  };
}

/** A secret under the key given, in a new business. */
async function storedUnder(publicKey: string, value: string) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const app = await createSealingVault(parseSecretsPublicKey(publicKey));
  const context = { ...business.context, correlationId: randomUUID() };
  const id = await withTenant(db, context, (trx) =>
    app.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.password' },
      value,
    ),
  );
  return { id, context };
}

describe('new-key', () => {
  it('prints a new pair of settings under the version given, and what to do with them', async () => {
    const printed = output();

    expect(await vault(['new-key', '3'], {}, printed)).toBe(0);

    const secretsKey = /^SECRETS_KEYS=(3:private-[\w-]{43})$/m.exec(printed.lines.stdout)?.[1];
    const publicKey = /^SECRETS_PUBLIC_KEY=(3:public-[\w-]{43})$/m.exec(printed.lines.stdout)?.[1];
    expect(secretsKey).toBeDefined();
    expect(publicKey).toBeDefined();
    // A rotation adds the key to the worker before anything seals with it.
    expect(printed.lines.stdout).toContain('after the current one');
    expect(printed.lines.stdout).toContain('node dist/vault.js rotate');
    // The pair works: what the public key seals, the private key opens.
    if (secretsKey === undefined || publicKey === undefined) return;
    const { id, context } = await storedUnder(publicKey, 'from-a-new-key');
    const opened = await createVault(parseSecretsKeys(secretsKey));
    await expect(
      withTenant(db, { ...context, correlationId: randomUUID() }, (trx) =>
        opened.read(trx, id, 'mailbox.password'),
      ),
    ).resolves.toBe('from-a-new-key');
  });

  it('refuses a missing or impossible version', async () => {
    for (const args of [['new-key'], ['new-key', '0'], ['new-key', 'two'], ['new-key', '1', '2']]) {
      const printed = output();
      expect(await vault(args, {}, printed)).toBe(2);
      expect(printed.lines.stderr).toContain('Usage:');
    }
  });
});

/** The worker's settings, as its container has them. */
const workerEnv = (secretsKeys: string) => ({
  ROLE: 'worker',
  PUBLIC_URL: 'https://crm.example.test',
  DATABASE_APP_URL: database.url('crm_app'),
  DATABASE_WORKER_URL: database.url('crm_worker'),
  SECRETS_KEYS: secretsKeys,
});

describe('rotate', () => {
  // Rotation runs across every tenant, so each test starts with no secrets at all.
  beforeEach(async () => {
    await database.as('crm_owner', (sql) => sql.query('delete from vault.secrets'));
  });

  it('re-seals every secret under the current key, and says the old one can go', async () => {
    const [one, two] = await Promise.all([newSecretsKey(1), newSecretsKey(2)]);
    const stored = await storedUnder(one.publicKey, 'rotate-me');
    const printed = output();
    const env = workerEnv(`${two.secretsKey},${one.secretsKey}`);

    expect(await vault(['rotate', '--batch-size', '1'], env, printed)).toBe(0);

    expect(printed.lines.stdout).toMatch(/Re-sealed \d+ secrets? under key version 2\./);
    expect(printed.lines.stdout).toContain('remove the older keys from SECRETS_KEYS');
    const onlyTwo = await createVault(parseSecretsKeys(two.secretsKey));
    await expect(
      withTenant(db, { ...stored.context, correlationId: randomUUID() }, (trx) =>
        onlyTwo.read(trx, stored.id, 'mailbox.password'),
      ),
    ).resolves.toBe('rotate-me');
  });

  it("names the secrets it couldn't open, and keeps the old key needed", async () => {
    const [one, three] = await Promise.all([newSecretsKey(1), newSecretsKey(3)]);
    const stored = await storedUnder(one.publicKey, 'tampered-with');
    await database.as('crm_owner', (sql) =>
      sql.query(
        'update vault.secrets set ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) where id = $1',
        [stored.id],
      ),
    );
    const printed = output();
    const env = workerEnv(`${three.secretsKey},${one.secretsKey}`);

    expect(await vault(['rotate'], env, printed)).toBe(1);

    expect(printed.lines.stderr).toContain(stored.id);
    expect(printed.lines.stderr).toContain('keep the older keys');
  });

  it("checks the worker's settings as the worker does, never repeating a key", async () => {
    const { secretsKey, publicKey } = await newSecretsKey(1);
    const { DATABASE_APP_URL: _none, ...noDatabase } = workerEnv(secretsKey);
    const app = {
      ROLE: 'app',
      PUBLIC_URL: 'https://crm.example.test',
      DATABASE_APP_URL: database.url('crm_app'),
      DATABASE_AUTH_URL: database.url('crm_auth'),
      AUTH_SECRET: 'a-test-secret-that-is-at-least-32-characters-long',
      SMTP_URL: 'smtp://127.0.0.1:1',
      MAIL_FROM: 'crm@bluebird.example',
      FILES_DIR: '/tmp/crm-files',
      FILES_LINK_SECRET: 'a-files-link-secret-of-32-characters-or-more',
      SECRETS_PUBLIC_KEY: publicKey,
    };
    const cases: [Record<string, string>, string][] = [
      [noDatabase, '  DATABASE_APP_URL: '],
      [workerEnv('1:private-short-hunter2'), 'SECRETS_KEYS: key version 1 must be private-'],
      [
        {
          ...workerEnv('1:private-dev-only-vault-key-not-for-production-use-0'),
          NODE_ENV: 'production',
        },
        "SECRETS_KEYS: must be your own keys in production, not .env.example's",
      ],
      [app, "rotate runs in the worker's container"],
    ];
    for (const [env, message] of cases) {
      const printed = output();
      expect(await vault(['rotate'], env, printed)).toBe(2);
      expect(printed.lines.stderr).toContain(message);
      expect(printed.lines.stderr).not.toContain('hunter2');
    }
    const badBatch = output();
    expect(await vault(['rotate', '--batch-size', 'lots'], workerEnv(secretsKey), badBatch)).toBe(
      2,
    );
    expect(badBatch.lines.stderr).toContain('Usage:');
  });

  it('reports a database it can’t reach', async () => {
    const { secretsKey } = await newSecretsKey(1);
    const printed = output();
    const env = {
      ...workerEnv(secretsKey),
      DATABASE_APP_URL: 'postgres://crm_app:wrong@127.0.0.1:1/crm',
    };

    expect(await vault(['rotate'], env, printed)).toBe(1);
    expect(printed.lines.stderr).toMatch(/^Rotation failed: /);
  });
});

describe('anything else', () => {
  it('prints the usage', async () => {
    for (const args of [[], ['help'], ['open'], ['rotate', '--now']]) {
      const printed = output();
      expect(await vault(args, {}, printed)).toBe(2);
      expect(printed.lines.stderr).toContain('node dist/vault.js new-key <version>');
    }
  });
});
