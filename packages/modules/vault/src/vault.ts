// The vault: secrets sealed for the worker, in vault.secrets. The app's vault seals and
// stores; the worker's also reads, and rotates every secret to the current key. Each call
// works in the caller's transaction, so row-level security keeps it to the caller's tenant;
// only rotation finds secrets across tenants, and it opens each one in its own.
import { randomUUID } from 'node:crypto';

import { withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { NotFoundError } from '@repo/kernel';
import { sql } from 'kysely';

import type { SecretsKey, SecretsPublicKey } from './keys.js';
import {
  createOpener,
  createSealer,
  SecretUnreadableError,
  type SealedSecret,
  type Sealer,
  type SecretAddress,
} from './sealing.js';

/** Whose a secret is, and what it's for. */
export interface SecretOwner {
  readonly agencyId: string;
  /** Null for a secret the whole agency uses, such as its AI key. */
  readonly businessId: string | null;
  /** What it's for, such as mailbox.password. */
  readonly purpose: string;
}

export interface SealingVault {
  /** Seals and stores a secret, and gives its id. */
  store(trx: DatabaseTransaction, owner: SecretOwner, plaintext: string): Promise<string>;
  /**
   * Seals a new value for a secret, under the current key. Unlike read, it takes no
   * purpose: it hands nothing out, and the caller is replacing a secret it owns.
   */
  replace(trx: DatabaseTransaction, secretId: string, plaintext: string): Promise<void>;
  /** Removes a secret the caller owns; like replace, it hands nothing out. */
  remove(trx: DatabaseTransaction, secretId: string): Promise<void>;
}

export interface RotationReport {
  /** The version every secret is being re-sealed under. */
  readonly keyVersion: number;
  readonly rotated: number;
  /** The secrets that couldn't be opened, which keep their old key. */
  readonly failed: readonly string[];
  /**
   * The secrets still under an older key when it ended: those that failed, and any an app
   * still on the old public key sealed meanwhile. The older keys stay until it's none.
   */
  readonly remaining: number;
}

/** Rotation so far: what's left is known only once it ends. */
export type RotationProgress = Omit<RotationReport, 'remaining'>;

export interface RotateOptions {
  /** How many secrets each batch lists; 100 by default, at most 1000. */
  readonly batchSize?: number;
  /** Called after each batch, with what it has done so far. */
  readonly afterBatch?: (progress: RotationProgress) => Promise<void> | void;
}

export interface Vault extends SealingVault {
  /**
   * Opens a secret, checking it hasn't changed and belongs to its row. Only a secret for
   * the purpose given is found, so a reference to the wrong kind of secret gets nothing.
   */
  read(trx: DatabaseTransaction, secretId: string, purpose: string): Promise<string>;
  /**
   * Re-seals every secret sealed under an older key with the current one, a secret per
   * transaction, each in its own tenant. Every secret stays readable throughout, as long
   * as the worker holds both keys. A secret that can't be opened is reported, not retried.
   * It refuses to start when secrets are sealed under a newer key than the current one.
   */
  rotate(db: Database, options?: RotateOptions): Promise<RotationReport>;
}

interface StoredSecret {
  readonly address: SecretAddress;
  readonly sealed: SealedSecret;
}

/** A secret's row, locked for the rest of the transaction when it's to be rewritten. */
async function find(
  trx: DatabaseTransaction,
  secretId: string,
  options: { lock: boolean; purpose?: string; sealedUnderAnotherVersionThan?: number },
): Promise<StoredSecret | undefined> {
  let query = trx
    .selectFrom('vault.secrets')
    .select(['id', 'agency_id', 'business_id', 'purpose', 'key_version', 'enc', 'ciphertext'])
    .where('id', '=', secretId);
  if (options.purpose !== undefined) {
    query = query.where('purpose', '=', options.purpose);
  }
  if (options.sealedUnderAnotherVersionThan !== undefined) {
    query = query.where('key_version', '<>', options.sealedUnderAnotherVersionThan);
  }
  const found = await (options.lock ? query.forUpdate() : query).executeTakeFirst();
  return (
    found && {
      address: {
        id: found.id,
        agencyId: found.agency_id,
        businessId: found.business_id,
        purpose: found.purpose,
      },
      sealed: { keyVersion: found.key_version, enc: found.enc, ciphertext: found.ciphertext },
    }
  );
}

async function update(
  trx: DatabaseTransaction,
  secretId: string,
  sealed: SealedSecret,
  rotated: boolean,
): Promise<void> {
  await trx
    .updateTable('vault.secrets')
    .set({
      key_version: sealed.keyVersion,
      enc: Buffer.from(sealed.enc),
      ciphertext: Buffer.from(sealed.ciphertext),
      ...(rotated ? { rotated_at: sql<Date>`now()` } : {}),
    })
    .where('id', '=', secretId)
    .execute();
}

function sealingVault(sealer: Sealer): SealingVault {
  return {
    store: async (trx, owner, plaintext) => {
      // The id comes first: the sealed secret is bound to it.
      const { id } = await trx
        .selectNoFrom(sql<string>`uuidv7()`.as('id'))
        .executeTakeFirstOrThrow();
      const sealed = await sealer.seal({ id, ...owner }, plaintext);
      await trx
        .insertInto('vault.secrets')
        .values({
          id,
          agency_id: owner.agencyId,
          business_id: owner.businessId,
          purpose: owner.purpose,
          key_version: sealed.keyVersion,
          enc: Buffer.from(sealed.enc),
          ciphertext: Buffer.from(sealed.ciphertext),
        })
        .execute();
      return id;
    },
    replace: async (trx, secretId, plaintext) => {
      const found = await find(trx, secretId, { lock: true });
      if (found === undefined) throw new NotFoundError('secret', secretId);
      await update(trx, secretId, await sealer.seal(found.address, plaintext), false);
    },
    remove: async (trx, secretId) => {
      const removed = await trx
        .deleteFrom('vault.secrets')
        .where('id', '=', secretId)
        .executeTakeFirst();
      if (removed.numDeletedRows === 0n) throw new NotFoundError('secret', secretId);
    },
  };
}

/** How many secrets each key version seals, across every tenant. */
async function secretsByVersion(db: Database): Promise<Map<number, number>> {
  const { rows } = await sql<{ key_version: number; secrets: string }>`
    select key_version, secrets from private.secret_key_versions()
  `.execute(db);
  return new Map(rows.map((row) => [row.key_version, Number(row.secrets)]));
}

interface RotationCandidate {
  readonly agency_id: string;
  readonly business_id: string | null;
  readonly secret_id: string;
}

/** The app's vault: it seals under the current public key, and can't read. */
export async function createSealingVault(key: SecretsPublicKey): Promise<SealingVault> {
  return sealingVault(await createSealer(key));
}

/** The worker's vault: it reads under any key it holds, and seals under the first. */
export async function createVault(keys: readonly [SecretsKey, ...SecretsKey[]]): Promise<Vault> {
  const opener = await createOpener(keys);

  /** Re-seals one secret in its own tenant; false when it was replaced or removed since. */
  const rotateOne = (db: Database, secret: RotationCandidate, correlationId: string) =>
    withTenant(
      db,
      {
        agencyId: secret.agency_id,
        ...(secret.business_id === null ? {} : { businessId: secret.business_id }),
        actorKind: 'system',
        correlationId,
      },
      async (trx) => {
        // Locked, so a password changed meanwhile is never overwritten with the old one.
        const found = await find(trx, secret.secret_id, {
          lock: true,
          sealedUnderAnotherVersionThan: opener.keyVersion,
        });
        if (found === undefined) return false;
        const plaintext = await opener.open(found.address, found.sealed);
        await update(trx, found.address.id, await opener.seal(found.address, plaintext), true);
        return true;
      },
    );

  return {
    ...sealingVault(opener),
    read: async (trx, secretId, purpose) => {
      const found = await find(trx, secretId, { lock: false, purpose });
      if (found === undefined) throw new NotFoundError('secret', secretId);
      return opener.open(found.address, found.sealed);
    },
    rotate: async (db, options = {}) => {
      const newer = [...(await secretsByVersion(db)).keys()].filter(
        (version) => version > opener.keyVersion,
      );
      if (newer.length > 0) {
        throw new Error(
          `Secrets are sealed under key version ${newer.join(', ')}, newer than the current key, version ${String(opener.keyVersion)}. List the newest key first in SECRETS_KEYS.`,
        );
      }
      const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1000);
      const correlationId = randomUUID();
      let rotated = 0;
      const failed: string[] = [];
      let after: string | null = null;
      for (;;) {
        const { rows } = await sql<RotationCandidate>`
          select agency_id, business_id, secret_id
          from private.secrets_to_rotate(${opener.keyVersion}::smallint, ${after}::uuid, ${batchSize})
        `.execute(db);
        const last = rows.at(-1);
        if (last === undefined) break;
        for (const secret of rows) {
          try {
            if (await rotateOne(db, secret, correlationId)) rotated += 1;
          } catch (error) {
            if (!(error instanceof SecretUnreadableError)) throw error;
            failed.push(secret.secret_id);
          }
        }
        after = last.secret_id;
        await options.afterBatch?.({ keyVersion: opener.keyVersion, rotated, failed: [...failed] });
      }
      let remaining = 0;
      for (const [version, secrets] of await secretsByVersion(db)) {
        if (version !== opener.keyVersion) remaining += secrets;
      }
      return { keyVersion: opener.keyVersion, rotated, failed, remaining };
    },
  };
}
