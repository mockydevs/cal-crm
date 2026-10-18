// Webhooks to installed apps. The agency generates an app's signing secret, sealed in the
// vault for the worker. An event an install subscribes to queues a dispatch job (a trigger
// on the event log); the job writes one delivery per install and queues each. A delivery
// is sent with no transaction open, through the request function the server passes in,
// and what happened is recorded under the delivery's lock. Deliveries are kept 30 days.
import { randomBytes } from 'node:crypto';

import { defineCommand, defineTask, type Command, type Task } from '@repo/commands';
import {
  appLifecycleEventTypes,
  generateAppWebhookSecret,
  marketplaceDeliveryStatuses,
  redeliverMarketplaceWebhook,
  type AppWebhookBody,
  type AppWebhookSecret,
  type MarketplaceDelivery,
  type MarketplaceDeliveryStatus,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  NotFoundError,
  parsePublicId,
  publicIdPrefixes,
  toPublicId,
  type PublicIdKind,
  type TenantContext,
} from '@repo/kernel';
import { sql, type NotNull } from 'kysely';
import * as z from 'zod';

import { requirePublisher } from './marketplace.js';

/** What the vault files the secret under; only the worker opens it. */
export const APP_WEBHOOK_SECRET_PURPOSE = 'marketplace.webhook_signing';

/** Marks the value as a webhook signing secret, as automation webhook secrets are. */
const SECRET_PREFIX = 'whsec_';

/** How long deliveries are kept. */
const KEPT_DAYS = 30;

/** The app's side of the vault: it seals and stores, and can't read. */
export interface AppWebhookSealer {
  store(
    trx: DatabaseTransaction,
    owner: { readonly agencyId: string; readonly businessId: null; readonly purpose: string },
    plaintext: string,
  ): Promise<string>;
  replace(trx: DatabaseTransaction, secretId: string, plaintext: string): Promise<void>;
}

/** The worker's side of the vault: it opens a secret of the purpose named. */
export interface AppWebhookOpener {
  read(trx: DatabaseTransaction, secretId: string, purpose: string): Promise<string>;
}

/** One signed POST of JSON, as the automation webhook core makes it. */
export type SendAppWebhook = (
  url: string,
  body: unknown,
  options: { readonly secret: string; readonly deliveryId: string },
) => Promise<
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly message: string;
      readonly status?: number;
      readonly retryAfterMs?: number;
    }
>;

/** When to try again after this many attempts, or undefined when they are used up. */
export type AppWebhookRetryDelay = (attempt: number, retryAfterMs?: number) => number | undefined;

// ---- The agency -----------------------------------------------------------------------

const secretInput = generateAppWebhookSecret.params;

/** Generates the app's webhook signing secret, shown once; the old one stops at once. */
export function generateWebhookSecretCommand(
  vault: AppWebhookSealer,
): Command<typeof secretInput, AppWebhookSecret> {
  return defineCommand({
    name: 'marketplace_app.generate_webhook_secret',
    permission: 'apps.manage',
    input: secretInput,
    async handle(trx, input, command) {
      const { agencyId } = requirePublisher(command.context);
      const appId = parsePublicId('marketplace_app', input.appId);
      if (appId === undefined) throw new NotFoundError('Marketplace app', input.appId);
      // One at a time for an app, so two can't each store a secret.
      const app = await trx
        .selectFrom('tenancy.marketplace_apps')
        .select(['name', 'webhook_secret_id'])
        .where('agency_id', '=', agencyId)
        .where('id', '=', appId)
        .forUpdate()
        .executeTakeFirst();
      if (app === undefined) throw new NotFoundError('Marketplace app', input.appId);
      const secret = `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
      let secretId = app.webhook_secret_id;
      if (secretId === null)
        secretId = await vault.store(
          trx,
          { agencyId, businessId: null, purpose: APP_WEBHOOK_SECRET_PURPOSE },
          secret,
        );
      else await vault.replace(trx, secretId, secret);
      const { webhook_secret_set_at: setAt } = await trx
        .updateTable('tenancy.marketplace_apps')
        .set({ webhook_secret_id: secretId, webhook_secret_set_at: sql<Date>`now()` })
        .where('agency_id', '=', agencyId)
        .where('id', '=', appId)
        .returning('webhook_secret_set_at')
        .$narrowType<{ webhook_secret_set_at: NotNull }>()
        .executeTakeFirstOrThrow();
      // The event says that it changed, never what to.
      await command.emit({
        type: 'marketplace_app.webhook_secret_generated',
        subject: { kind: 'marketplace_app', id: appId },
        payload: { name: app.name, first: app.webhook_secret_id === null },
      });
      return { secret, setAt: setAt.toISOString() };
    },
  });
}

const deliveryColumns = [
  'd.id',
  'd.business_id',
  'd.event_type',
  'd.status',
  'd.attempts',
  'd.last_status',
  'd.last_error',
  'd.last_attempt_at',
  'd.next_attempt_at',
  'd.delivered_at',
  'd.created_at',
  'b.name as business_name',
] as const;

const storedStatus = z.enum(marketplaceDeliveryStatuses);

function deliveriesQuery(trx: DatabaseTransaction, agencyId: string) {
  return trx
    .selectFrom('tenancy.marketplace_webhook_deliveries as d')
    .innerJoin('tenancy.businesses as b', (join) =>
      join.onRef('b.agency_id', '=', 'd.agency_id').onRef('b.id', '=', 'd.business_id'),
    )
    .select(deliveryColumns)
    .where('d.agency_id', '=', agencyId);
}

type DeliveryRow = Awaited<
  ReturnType<ReturnType<typeof deliveriesQuery>['executeTakeFirstOrThrow']>
>;

const asDelivery = (row: DeliveryRow): MarketplaceDelivery => ({
  id: toPublicId('marketplace_delivery', row.id),
  eventType: row.event_type,
  business: { id: toPublicId('business', row.business_id), name: row.business_name },
  status: storedStatus.parse(row.status),
  attempts: row.attempts,
  lastStatus: row.last_status,
  lastError: row.last_error,
  lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
  nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
  deliveredAt: row.delivered_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});

/** The app's latest 50 deliveries across the agency's businesses, newest first. */
export async function readDeliveries(
  trx: DatabaseTransaction,
  context: TenantContext,
  appId: string,
  status: MarketplaceDeliveryStatus | undefined,
): Promise<MarketplaceDelivery[]> {
  const { agencyId } = requirePublisher(context);
  const id = parsePublicId('marketplace_app', appId);
  if (id === undefined) throw new NotFoundError('Marketplace app', appId);
  const app = await trx
    .selectFrom('tenancy.marketplace_apps')
    .select('id')
    .where('agency_id', '=', agencyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (app === undefined) throw new NotFoundError('Marketplace app', appId);
  let query = deliveriesQuery(trx, agencyId).where('d.app_id', '=', id);
  if (status !== undefined) query = query.where('d.status', '=', status);
  const rows = await query
    .orderBy('d.created_at', 'desc')
    .orderBy('d.id', 'desc')
    .limit(50)
    .execute();
  return rows.map(asDelivery);
}

/** Queues an attempt at the delivery now, or at a later time. */
async function enqueueDelivery(
  trx: DatabaseTransaction,
  deliveryId: string,
  runAt?: Date,
): Promise<void> {
  await sql`select private.enqueue_marketplace_delivery(${deliveryId}::uuid, ${runAt ?? new Date()}::timestamptz)`.execute(
    trx,
  );
}

const redeliverInput = redeliverMarketplaceWebhook.params;

/** Sends a delivery again, from its first attempt: the retries apply again too. */
export const redeliverCommand: Command<typeof redeliverInput, MarketplaceDelivery> = defineCommand({
  name: 'marketplace_app.redeliver_webhook',
  permission: 'apps.manage',
  input: redeliverInput,
  async handle(trx, input, command) {
    const { agencyId } = requirePublisher(command.context);
    const id = parsePublicId('marketplace_delivery', input.deliveryId);
    if (id === undefined) throw new NotFoundError('Webhook delivery', input.deliveryId);
    const row = await trx
      .updateTable('tenancy.marketplace_webhook_deliveries')
      .set({
        status: 'pending',
        attempts: 0,
        delivered_at: null,
        next_attempt_at: sql<Date>`now()`,
      })
      .where('agency_id', '=', agencyId)
      .where('id', '=', id)
      .returning(['id', 'app_id', 'event_type'])
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Webhook delivery', input.deliveryId);
    await enqueueDelivery(trx, row.id);
    await command.emit({
      type: 'marketplace_app.webhook_redelivered',
      subject: { kind: 'marketplace_app', id: row.app_id },
      payload: { deliveryId: row.id, eventType: row.event_type },
    });
    const delivery = await deliveriesQuery(trx, agencyId)
      .where('d.id', '=', row.id)
      .executeTakeFirstOrThrow();
    return asDelivery(delivery);
  },
});

// ---- The worker -----------------------------------------------------------------------

const isPublicIdKind = (kind: string): kind is PublicIdKind =>
  Object.hasOwn(publicIdPrefixes, kind);

/** Who a delivery goes to: an install of an app that has a webhook address. */
interface Target {
  readonly installId: string;
  readonly appId: string;
}

export const dispatchEventReference = {
  name: 'marketplace.dispatch_event',
  data: z.strictObject({ eventId: z.uuid(), recordedAt: z.string() }),
} as const;

/** What the event tells, and to whom: one delivery per install, written once. */
async function dispatch(
  trx: DatabaseTransaction,
  context: TenantContext,
  data: z.output<typeof dispatchEventReference.data>,
): Promise<void> {
  const businessId = context.businessId;
  if (businessId === undefined) return;
  const event = await trx
    .selectFrom('events.events')
    .select(['type', 'subject_kind', 'subject_id', 'occurred_at', 'payload'])
    .where('id', '=', data.eventId)
    // Compared in the database: the time has microseconds, which a Date would drop.
    .where('recorded_at', '=', sql<Date>`${data.recordedAt}::timestamptz`)
    .executeTakeFirst();
  if (event === undefined) return;
  const lifecycle = (appLifecycleEventTypes as Readonly<Record<string, string>>)[event.type];
  let targets: Target[];
  if (lifecycle !== undefined) {
    const installId = (event.payload as { installId?: unknown }).installId;
    if (typeof installId !== 'string') return;
    targets = await trx
      .selectFrom('tenancy.marketplace_installs as i')
      .innerJoin('tenancy.marketplace_apps as a', (join) =>
        join.onRef('a.agency_id', '=', 'i.agency_id').onRef('a.id', '=', 'i.app_id'),
      )
      .select(['i.id as installId', 'a.id as appId'])
      .where('i.business_id', '=', businessId)
      .where('i.id', '=', installId)
      .where('a.webhook_url', 'is not', null)
      .execute();
  } else {
    targets = await trx
      .selectFrom('tenancy.marketplace_installs as i')
      .innerJoin('tenancy.marketplace_apps as a', (join) =>
        join.onRef('a.agency_id', '=', 'i.agency_id').onRef('a.id', '=', 'i.app_id'),
      )
      .select(['i.id as installId', 'a.id as appId'])
      .where('i.business_id', '=', businessId)
      .where('i.uninstalled_at', 'is', null)
      .where('a.webhook_url', 'is not', null)
      .where(sql<boolean>`${event.type} = any (a.webhook_events)`)
      .execute();
  }
  const type = lifecycle ?? event.type;
  for (const target of targets) {
    const body: AppWebhookBody = {
      type,
      occurredAt: event.occurred_at.toISOString(),
      appId: toPublicId('marketplace_app', target.appId),
      installId: toPublicId('marketplace_install', target.installId),
      businessId: toPublicId('business', businessId),
      subject:
        lifecycle === undefined && isPublicIdKind(event.subject_kind)
          ? { kind: event.subject_kind, id: toPublicId(event.subject_kind, event.subject_id) }
          : null,
    };
    const row = await trx
      .insertInto('tenancy.marketplace_webhook_deliveries')
      .values({
        business_id: businessId,
        agency_id: context.agencyId,
        install_id: target.installId,
        app_id: target.appId,
        event_id: data.eventId,
        event_type: type,
        body: JSON.stringify(body),
        next_attempt_at: sql<Date>`now()`,
      })
      // A dispatch run twice writes each delivery once.
      .onConflict((conflict) =>
        conflict.columns(['business_id', 'event_id', 'install_id']).doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (row !== undefined) await enqueueDelivery(trx, row.id);
  }
  await trx
    .deleteFrom('tenancy.marketplace_webhook_deliveries')
    .where('business_id', '=', businessId)
    .where('created_at', '<', sql<Date>`now() - make_interval(days => ${KEPT_DAYS})`)
    .execute();
}

/** The worker's task that turns an event into deliveries. */
export const dispatchEventTask: Task<typeof dispatchEventReference.data> = defineTask({
  ...dispatchEventReference,
  async run(data, { invocation, services }) {
    await withTenant(services.db, invocation.context, (trx) =>
      dispatch(trx, invocation.context, data),
    );
  },
});

export const deliverReference = {
  name: 'marketplace.deliver',
  data: z.strictObject({ deliveryId: z.uuid() }),
} as const;

/** A delivery that is due: where to, what, and signed with which secret. */
type Prepared =
  | { readonly send: false }
  | {
      readonly send: true;
      readonly url: string;
      readonly body: unknown;
      readonly secret: string;
    }
  | { readonly send: 'refused'; readonly reason: string };

async function prepare(
  trx: DatabaseTransaction,
  vault: AppWebhookOpener,
  deliveryId: string,
): Promise<Prepared> {
  const row = await trx
    .selectFrom('tenancy.marketplace_webhook_deliveries as d')
    .innerJoin('tenancy.marketplace_installs as i', (join) =>
      join.onRef('i.business_id', '=', 'd.business_id').onRef('i.id', '=', 'd.install_id'),
    )
    .innerJoin('tenancy.marketplace_apps as a', (join) =>
      join.onRef('a.agency_id', '=', 'd.agency_id').onRef('a.id', '=', 'd.app_id'),
    )
    .select(['d.body', 'd.event_type', 'i.uninstalled_at', 'a.webhook_url', 'a.webhook_secret_id'])
    .where('d.id', '=', deliveryId)
    .where('d.status', '=', 'pending')
    .executeTakeFirst();
  if (row === undefined) return { send: false };
  // An uninstalled app hears of nothing more, apart from its being uninstalled.
  if (row.uninstalled_at !== null && row.event_type !== 'app.uninstalled')
    return { send: 'refused', reason: 'The app was uninstalled.' };
  if (row.webhook_url === null)
    return { send: 'refused', reason: 'The app has no webhook address.' };
  if (row.webhook_secret_id === null)
    return { send: 'refused', reason: 'The app has no webhook signing secret.' };
  const secret = await vault.read(trx, row.webhook_secret_id, APP_WEBHOOK_SECRET_PURPOSE);
  return { send: true, url: row.webhook_url, body: row.body, secret };
}

type Outcome = Awaited<ReturnType<SendAppWebhook>> | { readonly refused: string };

/** Records an attempt under the delivery's lock, and queues the next one if it may retry. */
async function record(
  trx: DatabaseTransaction,
  deliveryId: string,
  outcome: Outcome,
  retryDelay: AppWebhookRetryDelay,
): Promise<void> {
  const row = await trx
    .selectFrom('tenancy.marketplace_webhook_deliveries')
    .select(['attempts'])
    .where('id', '=', deliveryId)
    .where('status', '=', 'pending')
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) return;
  const attempts = row.attempts + 1;
  const base = { attempts, last_attempt_at: sql<Date>`now()` };
  if ('refused' in outcome) {
    await trx
      .updateTable('tenancy.marketplace_webhook_deliveries')
      .set({
        ...base,
        status: 'failed',
        last_status: null,
        last_error: outcome.refused,
        next_attempt_at: null,
      })
      .where('id', '=', deliveryId)
      .execute();
    return;
  }
  if (outcome.ok) {
    await trx
      .updateTable('tenancy.marketplace_webhook_deliveries')
      .set({
        ...base,
        status: 'delivered',
        delivered_at: sql<Date>`now()`,
        last_status: outcome.status,
        last_error: null,
        next_attempt_at: null,
      })
      .where('id', '=', deliveryId)
      .execute();
    return;
  }
  const delay = outcome.retryable ? retryDelay(attempts, outcome.retryAfterMs) : undefined;
  const next = delay === undefined ? null : new Date(Date.now() + delay);
  await trx
    .updateTable('tenancy.marketplace_webhook_deliveries')
    .set({
      ...base,
      status: next === null ? 'failed' : 'pending',
      last_status: outcome.status ?? null,
      last_error: outcome.message.slice(0, 1000),
      next_attempt_at: next,
    })
    .where('id', '=', deliveryId)
    .execute();
  if (next !== null) await enqueueDelivery(trx, deliveryId, next);
}

/**
 * The worker's task for one attempt at a delivery, with the worker's vault, which alone
 * opens the signing secret, and the request function the server passes in.
 */
export function createDeliverTask({
  vault,
  send,
  retryDelay,
}: {
  readonly vault: AppWebhookOpener;
  readonly send: SendAppWebhook;
  readonly retryDelay: AppWebhookRetryDelay;
}): Task<typeof deliverReference.data> {
  return defineTask({
    ...deliverReference,
    async run(data, { invocation, services }) {
      const { context } = invocation;
      const prepared = await withTenant(services.db, context, (trx) =>
        prepare(trx, vault, data.deliveryId),
      );
      if (prepared.send === false) return;
      // No transaction is open while the request is out.
      const outcome: Outcome =
        prepared.send === 'refused'
          ? { refused: prepared.reason }
          : await send(prepared.url, prepared.body, {
              secret: prepared.secret,
              deliveryId: toPublicId('marketplace_delivery', data.deliveryId),
            });
      await withTenant(services.db, context, (trx) =>
        record(trx, data.deliveryId, outcome, retryDelay),
      );
    },
  });
}

/** The marketplace's worker tasks, given the worker's vault and the request function. */
export function createMarketplaceTasks(options: {
  readonly vault: AppWebhookOpener;
  readonly send: SendAppWebhook;
  readonly retryDelay: AppWebhookRetryDelay;
}): readonly [typeof dispatchEventTask, Task<typeof deliverReference.data>] {
  return [dispatchEventTask, createDeliverTask(options)];
}
