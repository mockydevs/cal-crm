// A business's named webhook secrets: values a webhook step's header sends, such as an API
// key, so none has to go in the URL. Each is sealed in the vault, which the app can write
// to but never read back; only the worker opens one, to send it. The table holds the name
// and the vault id, never the value, and nothing a step or a run keeps names more than the
// secret's name.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  MAX_WEBHOOK_SECRETS,
  putAutomationWebhookSecretInput,
  webhookSecretName,
  type AutomationWebhookSecret,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import type { LockBusiness, SecretOpener, SecretSealer } from './webhook-signing.js';

/** What the vault files these secrets under; a reference to any other kind opens nothing. */
export const WEBHOOK_HEADER_SECRET_PURPOSE = 'automation.webhook_header';

/** The app's side of the vault for these secrets: it also removes one. */
export interface WebhookSecretVault extends SecretSealer {
  remove(trx: DatabaseTransaction, secretId: string): Promise<void>;
}

/** The business's webhook secrets, by name, without their values. */
export async function readWebhookSecrets(
  trx: DatabaseTransaction,
): Promise<{ items: AutomationWebhookSecret[] }> {
  const rows = await trx
    .selectFrom('automation.webhook_secrets')
    .select(['name', 'rotated_at'])
    .orderBy('name')
    .execute();
  return {
    items: rows.map((row) => ({ name: row.name, rotatedAt: row.rotated_at.toISOString() })),
  };
}

/** The names of the business's webhook secrets, for the validator. */
export async function readWebhookSecretNames(trx: DatabaseTransaction): Promise<string[]> {
  const rows = await trx
    .selectFrom('automation.webhook_secrets')
    .select('name')
    .orderBy('name')
    .execute();
  return rows.map((row) => row.name);
}

/** A secret's value, for the worker; undefined when there is none by that name. */
export async function openWebhookHeaderSecret(
  trx: DatabaseTransaction,
  vault: SecretOpener,
  name: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('automation.webhook_secrets')
    .select('secret_id')
    .where('name', '=', name)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : vault.read(trx, row.secret_id, WEBHOOK_HEADER_SECRET_PURPOSE);
}

const putInput = putAutomationWebhookSecretInput.extend({ name: webhookSecretName });
const deleteInput = z.strictObject({ name: webhookSecretName });

export interface WebhookSecretCommands {
  readonly put: Command<typeof putInput, AutomationWebhookSecret>;
  readonly remove: Command<typeof deleteInput, undefined>;
}

/**
 * Stores a secret by name, or replaces the value of the one by that name, and removes one.
 * The value is never answered, logged, audited or put in an event.
 */
export function createWebhookSecretCommands({
  vault,
  lockBusiness,
}: {
  vault: WebhookSecretVault;
  lockBusiness: LockBusiness;
}): WebhookSecretCommands {
  const put = defineCommand({
    name: 'automation.put_webhook_secret',
    permission: 'automations.publish',
    input: putInput,
    // The value stays out of the audit log.
    audit: ({ name }) => ({ name }),
    async handle(trx, input, command): Promise<AutomationWebhookSecret> {
      const businessId = requireBusiness(command.context);
      // One change at a time for a business, so two can't each store a secret by one name.
      await lockBusiness(trx, command.context);
      const actor = {
        rotated_by_kind: command.context.actorKind,
        rotated_by_id: command.context.actorId ?? null,
      };
      const existing = await trx
        .selectFrom('automation.webhook_secrets')
        .select('secret_id')
        .where('name', '=', input.name)
        .executeTakeFirst();
      let rotatedAt: Date;
      if (existing === undefined) {
        const { count } = await trx
          .selectFrom('automation.webhook_secrets')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .executeTakeFirstOrThrow();
        if (Number(count) >= MAX_WEBHOOK_SECRETS)
          throw new ConflictError(
            `A business keeps at most ${String(MAX_WEBHOOK_SECRETS)} webhook secrets. Delete one first.`,
          );
        const secretId = await vault.store(
          trx,
          {
            agencyId: command.context.agencyId,
            businessId,
            purpose: WEBHOOK_HEADER_SECRET_PURPOSE,
          },
          input.value,
        );
        ({ rotated_at: rotatedAt } = await trx
          .insertInto('automation.webhook_secrets')
          .values({ business_id: businessId, name: input.name, secret_id: secretId, ...actor })
          .returning('rotated_at')
          .executeTakeFirstOrThrow());
      } else {
        await vault.replace(trx, existing.secret_id, input.value);
        ({ rotated_at: rotatedAt } = await trx
          .updateTable('automation.webhook_secrets')
          .set({ ...actor, rotated_at: sql<Date>`now()` })
          .where('name', '=', input.name)
          .returning('rotated_at')
          .executeTakeFirstOrThrow());
      }
      // The event says which secret changed, never what to.
      await command.emit({
        type: 'automation.webhook_header_secret_stored',
        subject: { kind: 'business', id: businessId },
        records: [],
        payload: { name: input.name, first: existing === undefined },
      });
      return { name: input.name, rotatedAt: rotatedAt.toISOString() };
    },
  });

  const remove = defineCommand({
    name: 'automation.delete_webhook_secret',
    permission: 'automations.publish',
    input: deleteInput,
    async handle(trx, input, command): Promise<undefined> {
      const businessId = requireBusiness(command.context);
      const removed = await trx
        .deleteFrom('automation.webhook_secrets')
        .where('name', '=', input.name)
        .returning('secret_id')
        .executeTakeFirst();
      if (removed === undefined) throw new NotFoundError('webhook_secret', input.name);
      // The sealed value goes too: nothing else names it, and a secret by this name stored
      // later is sealed afresh.
      await vault.remove(trx, removed.secret_id);
      await command.emit({
        type: 'automation.webhook_header_secret_deleted',
        subject: { kind: 'business', id: businessId },
        records: [],
        payload: { name: input.name },
      });
      return undefined;
    },
  });

  return { put, remove };
}
