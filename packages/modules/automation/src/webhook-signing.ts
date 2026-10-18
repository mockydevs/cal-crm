// The secret a business's automation webhooks are signed with. An authorized person makes
// or replaces it and sees it once, then; it is sealed in the vault, which the app can write
// to but never read back. Only the worker opens it, to sign a delivery.
import { randomBytes } from 'node:crypto';

import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

/** What the vault files this secret under; a reference to any other kind opens nothing. */
export const WEBHOOK_SIGNING_PURPOSE = 'automation.webhook_signing';

/** Marks the value as a webhook signing secret, wherever someone pastes it. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** The app's side of the vault: it seals and stores, and can't read. */
export interface SecretSealer {
  store(
    trx: DatabaseTransaction,
    owner: {
      readonly agencyId: string;
      readonly businessId: string | null;
      readonly purpose: string;
    },
    plaintext: string,
  ): Promise<string>;
  replace(trx: DatabaseTransaction, secretId: string, plaintext: string): Promise<void>;
}

/** The worker's side of the vault: it opens a secret of the purpose named. */
export interface SecretOpener {
  read(trx: DatabaseTransaction, secretId: string, purpose: string): Promise<string>;
}

/**
 * Locks the caller's business until the transaction ends, and refuses one that isn't
 * active. Tenancy owns the business row and supplies this.
 */
export type LockBusiness = (trx: DatabaseTransaction, context: TenantContext) => Promise<void>;

export interface WebhookSigningStatus {
  /** Whether webhooks can be signed, and so sent, for this business. */
  readonly configured: boolean;
  readonly rotatedAt: string | null;
}

export interface RotatedWebhookSecret {
  /** Shown once: it can't be read again, only replaced. */
  readonly secret: string;
  readonly rotatedAt: string;
}

const rotateInput = z.strictObject({});

/** Whether this business has a signing secret, without opening it. */
export async function readWebhookSigningStatus(
  trx: DatabaseTransaction,
): Promise<WebhookSigningStatus> {
  const row = await trx
    .selectFrom('automation.webhook_signing')
    .select('rotated_at')
    .executeTakeFirst();
  return { configured: row !== undefined, rotatedAt: row?.rotated_at.toISOString() ?? null };
}

/** The business's signing secret, for the worker; undefined when none has been made. */
export async function openWebhookSecret(
  trx: DatabaseTransaction,
  vault: SecretOpener,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('automation.webhook_signing')
    .select('secret_id')
    .executeTakeFirst();
  return row === undefined ? undefined : vault.read(trx, row.secret_id, WEBHOOK_SIGNING_PURPOSE);
}

/**
 * Makes the business's signing secret, or replaces it, and returns it this once. Deliveries
 * signed from then on use the new secret, so receivers must be given it before they check.
 */
export function createRotateWebhookSecretCommand({
  vault,
  lockBusiness,
}: {
  vault: SecretSealer;
  lockBusiness: LockBusiness;
}): Command<typeof rotateInput, RotatedWebhookSecret> {
  return defineCommand({
    name: 'automation.rotate_webhook_secret',
    permission: 'automations.publish',
    input: rotateInput,
    async handle(trx, _input, command): Promise<RotatedWebhookSecret> {
      const businessId = requireBusiness(command.context);
      // One rotation at a time for a business, so two can't each store a secret. Tenancy
      // owns the business row, so the lock comes through its port.
      await lockBusiness(trx, command.context);
      const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
      const actor = {
        rotated_by_kind: command.context.actorKind,
        rotated_by_id: command.context.actorId ?? null,
      };
      const existing = await trx
        .selectFrom('automation.webhook_signing')
        .select('secret_id')
        .executeTakeFirst();
      if (existing === undefined) {
        const secretId = await vault.store(
          trx,
          { agencyId: command.context.agencyId, businessId, purpose: WEBHOOK_SIGNING_PURPOSE },
          secret,
        );
        await trx
          .insertInto('automation.webhook_signing')
          .values({ business_id: businessId, secret_id: secretId, ...actor })
          .execute();
      } else {
        await vault.replace(trx, existing.secret_id, secret);
      }
      const { rotated_at: rotatedAt } = await trx
        .updateTable('automation.webhook_signing')
        .set({ ...actor, rotated_at: sql<Date>`now()` })
        .returning('rotated_at')
        .executeTakeFirstOrThrow();
      // The event says that it changed, never what to.
      await command.emit({
        type: 'automation.webhook_secret_rotated',
        subject: { kind: 'business', id: businessId },
        records: [],
        payload: { first: existing === undefined },
      });
      return { secret, rotatedAt: rotatedAt.toISOString() };
    },
  });
}
