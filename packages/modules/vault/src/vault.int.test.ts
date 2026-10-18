// The vault against a migrated Postgres. Its acceptance criteria: tampering with stored
// ciphertext is detected; rotation re-seals everything without downtime, so every secret
// opens before, during and after it.
import { randomUUID } from 'node:crypto';

import { connectDatabase, withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import {
  createSealingVault,
  createVault,
  newSecretsKey,
  parseSecretsKeys,
  parseSecretsPublicKey,
  SecretUnreadableError,
  type RotationReport,
  type SealingVault,
  type SecretsKey,
  type SecretsPublicKey,
  type Vault,
} from './index.js';

let database: TestDatabase;
let db: Database;
let one: { secretsKey: SecretsKey; publicKey: SecretsPublicKey };
let two: { secretsKey: SecretsKey; publicKey: SecretsPublicKey };
/** The app's vault: it seals under version 1, and can't read. */
let app: SealingVault;
/** The worker's, holding version 1 only. */
let worker: Vault;

async function keys(version: number) {
  const made = await newSecretsKey(version);
  return {
    secretsKey: parseSecretsKeys(made.secretsKey)[0],
    publicKey: parseSecretsPublicKey(made.publicKey),
  };
}

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  [one, two] = await Promise.all([keys(1), keys(2)]);
  app = await createSealingVault(one.publicKey);
  worker = await createVault([one.secretsKey]);
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

/** A new agency with a business, and contexts for working in each. */
async function tenant() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const { businessId: _business, ...atAgency } = business.context;
  return { agencyId: agency.id, businessId: business.id, inBusiness: business.context, atAgency };
}

function inTenant<T>(context: TenantContext, work: (trx: DatabaseTransaction) => Promise<T>) {
  return withTenant(db, { ...context, correlationId: randomUUID() }, work);
}

/** The row as the database holds it, whatever its tenant. */
async function row(id: string) {
  const [found] = await database.as('crm_owner', (sql) =>
    sql.query<{
      agency_id: string;
      business_id: string | null;
      purpose: string;
      key_version: number;
      enc: Buffer;
      ciphertext: Buffer;
      rotated_at: Date | null;
    }>(
      'select agency_id, business_id, purpose, key_version, enc, ciphertext, rotated_at from vault.secrets where id = $1',
      [id],
    ),
  );
  if (found === undefined) throw new Error(`secret ${id} isn't stored`);
  return found;
}

async function unreadable(
  vault: Vault,
  context: TenantContext,
  id: string,
  purpose = 'mailbox.password',
) {
  try {
    await inTenant(context, (trx) => vault.read(trx, id, purpose));
  } catch (error) {
    if (error instanceof SecretUnreadableError) return error;
    throw error;
  }
  throw new Error('expected the secret not to open');
}

describe('storing and reading', () => {
  it('stores a sealed secret that only the worker reads', async () => {
    const { agencyId, businessId, inBusiness } = await tenant();

    const id = await inTenant(inBusiness, (trx) =>
      app.store(trx, { agencyId, businessId, purpose: 'mailbox.password' }, 'smtp-password-1'),
    );

    const stored = await row(id);
    expect(stored).toMatchObject({
      agency_id: agencyId,
      business_id: businessId,
      purpose: 'mailbox.password',
      key_version: 1,
      rotated_at: null,
    });
    expect(stored.enc).toHaveLength(32);
    expect(stored.ciphertext.includes('smtp-password-1')).toBe(false);
    expect(Object.keys(app).sort()).toEqual(['remove', 'replace', 'store']);
    await expect(
      inTenant(inBusiness, (trx) => worker.read(trx, id, 'mailbox.password')),
    ).resolves.toBe('smtp-password-1');
  });

  it("stores the agency's own secrets, which its businesses' work can read", async () => {
    const { agencyId, inBusiness, atAgency } = await tenant();

    const id = await inTenant(atAgency, (trx) =>
      app.store(trx, { agencyId, businessId: null, purpose: 'ai.anthropic_key' }, 'sk-ant-1'),
    );

    const read = (context: TenantContext) =>
      inTenant(context, (trx) => worker.read(trx, id, 'ai.anthropic_key'));
    await expect(read(inBusiness)).resolves.toBe('sk-ant-1');
    await expect(read(atAgency)).resolves.toBe('sk-ant-1');
  });

  it("can't store or read another business's secret", async () => {
    const first = await tenant();
    const second = await tenant();
    const owner = {
      agencyId: first.agencyId,
      businessId: first.businessId,
      purpose: 'mailbox.password',
    };
    const id = await inTenant(first.inBusiness, (trx) => app.store(trx, owner, 'first-business'));

    await expect(
      inTenant(second.inBusiness, (trx) => worker.read(trx, id, 'mailbox.password')),
    ).rejects.toThrow(new NotFoundError('secret', id));
    await expect(
      inTenant(second.inBusiness, (trx) => app.store(trx, owner, 'into-the-first')),
    ).rejects.toThrow(/row-level security/);
  });

  it('reads a secret only for the purpose asked', async () => {
    const { agencyId, businessId, inBusiness } = await tenant();
    const id = await inTenant(inBusiness, (trx) =>
      app.store(trx, { agencyId, businessId, purpose: 'mailbox.password' }, 'not-an-ai-key'),
    );

    // A reference that names a mailbox's password as an AI key gets nothing.
    await expect(
      inTenant(inBusiness, (trx) => worker.read(trx, id, 'ai.openai_key')),
    ).rejects.toThrow(new NotFoundError('secret', id));
  });

  it('replaces a secret, under the current key', async () => {
    const { agencyId, businessId, inBusiness } = await tenant();
    const id = await inTenant(inBusiness, (trx) =>
      app.store(trx, { agencyId, businessId, purpose: 'mailbox.password' }, 'old-password'),
    );
    const workerOnTwo = await createVault([two.secretsKey, one.secretsKey]);

    await inTenant(inBusiness, (trx) => workerOnTwo.replace(trx, id, 'new-password'));

    expect((await row(id)).key_version).toBe(2);
    await expect(
      inTenant(inBusiness, (trx) => workerOnTwo.read(trx, id, 'mailbox.password')),
    ).resolves.toBe('new-password');
    await expect(
      inTenant(inBusiness, (trx) => app.replace(trx, randomUUID(), 'nothing-there')),
    ).rejects.toThrow(NotFoundError);
  });

  it('removes a secret', async () => {
    const { agencyId, businessId, inBusiness } = await tenant();
    const id = await inTenant(inBusiness, (trx) =>
      app.store(trx, { agencyId, businessId, purpose: 'mailbox.password' }, 'to-be-removed'),
    );

    await inTenant(inBusiness, (trx) => app.remove(trx, id));

    await expect(
      inTenant(inBusiness, (trx) => worker.read(trx, id, 'mailbox.password')),
    ).rejects.toThrow(NotFoundError);
    await expect(inTenant(inBusiness, (trx) => app.remove(trx, id))).rejects.toThrow(NotFoundError);
  });
});

describe('tampering in the database', () => {
  it('is detected when a byte of the ciphertext or the encapsulated key changes', async () => {
    const { agencyId, businessId, inBusiness } = await tenant();
    const store = (value: string) =>
      inTenant(inBusiness, (trx) =>
        app.store(trx, { agencyId, businessId, purpose: 'mailbox.password' }, value),
      );
    const [inCiphertext, inEnc] = await Promise.all([store('changed-1'), store('changed-2')]);

    await database.as('crm_owner', async (sql) => {
      await sql.query(
        `update vault.secrets set ciphertext = set_byte(ciphertext, 3, get_byte(ciphertext, 3) # 1) where id = $1`,
        [inCiphertext],
      );
      await sql.query(
        `update vault.secrets set enc = set_byte(enc, 0, get_byte(enc, 0) # 1) where id = $1`,
        [inEnc],
      );
    });

    expect((await unreadable(worker, inBusiness, inCiphertext)).reason).toBe('tampered');
    expect((await unreadable(worker, inBusiness, inEnc)).reason).toBe('tampered');
  });

  it('is detected when a sealed secret is copied into another row, business or purpose', async () => {
    const { agencyId, businessId, inBusiness } = await tenant();
    const other = await database.fixtures.business(agencyId);
    const store = (value: string, purpose = 'mailbox.password') =>
      inTenant(inBusiness, (trx) => app.store(trx, { agencyId, businessId, purpose }, value));
    const [source, target] = await Promise.all([store('the-real-one'), store('another')]);
    const moved = await store('moved-to-another-business');
    const repurposed = await store('given-another-purpose');

    await database.as('crm_owner', async (sql) => {
      await sql.query(
        `update vault.secrets t set enc = s.enc, ciphertext = s.ciphertext
           from vault.secrets s where s.id = $1 and t.id = $2`,
        [source, target],
      );
      await sql.query('update vault.secrets set business_id = $1 where id = $2', [other.id, moved]);
      await sql.query(`update vault.secrets set purpose = 'ai.anthropic_key' where id = $1`, [
        repurposed,
      ]);
    });

    expect((await unreadable(worker, inBusiness, target)).reason).toBe('tampered');
    expect((await unreadable(worker, other.context, moved)).reason).toBe('tampered');
    // Asked for under its new purpose, it's found, and fails its integrity check.
    expect((await unreadable(worker, inBusiness, repurposed, 'ai.anthropic_key')).reason).toBe(
      'tampered',
    );
    await expect(
      inTenant(inBusiness, (trx) => worker.read(trx, source, 'mailbox.password')),
    ).resolves.toBe('the-real-one');
  });
});

describe('rotation', () => {
  // Rotation runs across every tenant, so each test starts with no secrets at all.
  beforeEach(async () => {
    await database.as('crm_owner', (sql) => sql.query('delete from vault.secrets'));
  });

  /** Secrets under version 1 in two tenants, at the agency and in a business. */
  async function storedUnderOne(count: number) {
    const tenants = await Promise.all([tenant(), tenant()]);
    const stored: { id: string; value: string; context: TenantContext }[] = [];
    for (let index = 0; index < count; index += 1) {
      const where = tenants[index % 2];
      if (where === undefined) throw new Error('two tenants were made');
      const atAgency = index % 3 === 0;
      const context = atAgency ? where.atAgency : where.inBusiness;
      const value = `secret-${String(index)}-${randomUUID()}`;
      const id = await inTenant(context, (trx) =>
        app.store(
          trx,
          {
            agencyId: where.agencyId,
            businessId: atAgency ? null : where.businessId,
            purpose: 'mailbox.password',
          },
          value,
        ),
      );
      stored.push({ id, value, context });
    }
    return stored;
  }

  async function readEach(vault: Vault, stored: { id: string; context: TenantContext }[]) {
    return Promise.all(
      stored.map(({ id, context }) =>
        inTenant(context, (trx) => vault.read(trx, id, 'mailbox.password')),
      ),
    );
  }

  it('re-seals every secret under the current key, and each still opens', async () => {
    const stored = await storedUnderOne(5);
    const rotating = await createVault([two.secretsKey, one.secretsKey]);

    const report = await rotating.rotate(db, { batchSize: 2 });

    expect(report).toEqual({ keyVersion: 2, rotated: 5, failed: [], remaining: 0 });
    for (const { id } of stored) {
      const after = await row(id);
      expect(after.key_version).toBe(2);
      expect(after.rotated_at).toBeInstanceOf(Date);
    }
    const onlyTwo = await createVault([two.secretsKey]);
    expect(await readEach(onlyTwo, stored)).toEqual(stored.map(({ value }) => value));
    for (const { id, context } of stored) {
      expect((await unreadable(worker, context, id)).reason).toBe('unknown_key_version');
    }
  });

  it('keeps every secret readable between its batches, and leaves new ones alone', async () => {
    const stored = await storedUnderOne(6);
    const rotating = await createVault([two.secretsKey, one.secretsKey]);
    const appOnTwo = await createSealingVault(two.publicKey);
    const [first] = stored;
    if (first === undefined) throw new Error('six were stored');
    const readable: boolean[] = [];
    let addedDuring: string | undefined;

    const afterBatch = vi.fn(async () => {
      const values = await readEach(rotating, stored);
      readable.push(values.every((value, index) => value === stored[index]?.value));
      addedDuring ??= await inTenant(first.context, (trx) =>
        appOnTwo.store(
          trx,
          { agencyId: first.context.agencyId, businessId: null, purpose: 'ai.anthropic_key' },
          'added-during-rotation',
        ),
      );
    });
    await rotating.rotate(db, { batchSize: 2, afterBatch });

    expect(afterBatch).toHaveBeenCalledTimes(3);
    expect(readable.every(Boolean)).toBe(true);
    if (addedDuring === undefined) throw new Error('a secret was added during rotation');
    expect((await row(addedDuring)).rotated_at).toBeNull();
  });

  it('reports a secret it cannot open, and rotates the rest', async () => {
    const stored = await storedUnderOne(3);
    const [, broken] = stored;
    if (broken === undefined) throw new Error('three were stored');
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update vault.secrets set ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) where id = $1`,
        [broken.id],
      ),
    );
    const rotating = await createVault([two.secretsKey, one.secretsKey]);

    const report = await rotating.rotate(db, { batchSize: 1 });

    expect(report.failed).toEqual([broken.id]);
    expect(report.remaining).toBe(1);
    expect((await row(broken.id)).key_version).toBe(1);
    for (const { id } of stored.filter((secret) => secret !== broken)) {
      expect((await row(id)).key_version).toBe(2);
    }
  });

  /**
   * Waits until a transaction is waiting for a lock in this test's database. A row lock is
   * waited for on the holder's transaction id, which pg_locks gives no database, so the
   * waiting session's says where it is.
   */
  async function untilSomethingWaits() {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const { waiting } = await database.as('crm_owner', (sql) =>
        sql.one<{ waiting: number }>(
          `select count(*)::int as waiting
           from pg_locks l join pg_stat_activity a on a.pid = l.pid
           where not l.granted and a.datname = current_database()`,
        ),
      );
      if (waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('rotation never waited for the row');
  }

  /** Runs the change in the app's transaction, starting rotation once the row is locked. */
  async function rotateDuring(
    rotating: Vault,
    context: TenantContext,
    change: (trx: DatabaseTransaction) => Promise<void>,
  ): Promise<RotationReport> {
    let rotation: Promise<RotationReport> | undefined;
    try {
      await inTenant(context, async (trx) => {
        await change(trx);
        rotation = rotating.rotate(db);
        await untilSomethingWaits();
      });
    } catch (error) {
      // Rotation goes on once the transaction ends; let it finish before the pool closes.
      await rotation?.catch(() => undefined);
      throw error;
    }
    if (rotation === undefined) throw new Error('rotation was started');
    return rotation;
  }

  it('never overwrites a secret replaced while it waits for it', async () => {
    const [stored] = await storedUnderOne(1);
    if (stored === undefined) throw new Error('one was stored');
    const rotating = await createVault([two.secretsKey, one.secretsKey]);
    const appOnTwo = await createSealingVault(two.publicKey);

    const report = await rotateDuring(rotating, stored.context, (trx) =>
      appOnTwo.replace(trx, stored.id, 'changed-during-rotation'),
    );

    expect(report).toEqual({ keyVersion: 2, rotated: 0, failed: [], remaining: 0 });
    await expect(
      inTenant(stored.context, (trx) => rotating.read(trx, stored.id, 'mailbox.password')),
    ).resolves.toBe('changed-during-rotation');
    expect((await row(stored.id)).rotated_at).toBeNull();
  });

  it('passes over a secret removed while it waits for it', async () => {
    const [stored] = await storedUnderOne(1);
    if (stored === undefined) throw new Error('one was stored');
    const rotating = await createVault([two.secretsKey, one.secretsKey]);

    const report = await rotateDuring(rotating, stored.context, (trx) =>
      app.remove(trx, stored.id),
    );

    expect(report).toEqual({ keyVersion: 2, rotated: 0, failed: [], remaining: 0 });
  });

  it('counts a secret sealed under an older key behind it, so the key is kept', async () => {
    const stored = await storedUnderOne(4);
    const [first] = stored;
    if (first === undefined) throw new Error('four were stored');
    const rotating = await createVault([two.secretsKey, one.secretsKey]);
    let replaced = false;

    // An app still on the old public key replaces a secret rotation has passed.
    const report = await rotating.rotate(db, {
      batchSize: 2,
      afterBatch: async () => {
        if (replaced) return;
        replaced = true;
        await inTenant(first.context, (trx) => app.replace(trx, first.id, 'replaced-late'));
      },
    });

    expect(report).toMatchObject({ rotated: 4, failed: [], remaining: 1 });
    expect((await row(first.id)).key_version).toBe(1);
  });

  it('refuses to re-seal under an older key than one already in use', async () => {
    const [stored] = await storedUnderOne(1);
    if (stored === undefined) throw new Error('one was stored');
    const appOnTwo = await createSealingVault(two.publicKey);
    await inTenant(stored.context, (trx) => appOnTwo.replace(trx, stored.id, 'under-two'));
    const misordered = await createVault([one.secretsKey, two.secretsKey]);

    await expect(misordered.rotate(db)).rejects.toThrow(
      'Secrets are sealed under key version 2, newer than the current key, version 1. List the newest key first in SECRETS_KEYS.',
    );
    expect((await row(stored.id)).key_version).toBe(2);
  });

  it('has nothing to do when every secret is under the current key', async () => {
    await storedUnderOne(1);
    const rotating = await createVault([two.secretsKey, one.secretsKey]);
    await rotating.rotate(db);

    await expect(rotating.rotate(db)).resolves.toEqual({
      keyVersion: 2,
      rotated: 0,
      failed: [],
      remaining: 0,
    });
  });
});
