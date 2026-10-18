// Settings → External Tracking: the business's tracking id, what the script records and
// where it answers, and Troubleshoot's view of what it reported lately.
//
// - A business gets its tracking id the first time the page is read: one row, made once,
//   whoever reads first. The id is public; a new one can be asked for, and the old one then
//   stops answering at once.
// - Every change names the revision it was made to, under the row's lock, so two people
//   changing the settings at once never overwrite each other.
// - Anyone in the business may read it. Changing it takes sites.manage: external tracking is
//   the analytics of the business's websites.
import { randomBytes } from 'node:crypto';

import {
  defineCommand,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Route,
  type Services,
} from '@repo/commands';
import {
  getExternalTracking,
  getExternalTrackingActivity,
  regenerateTrackingId,
  regenerateTrackingIdInput,
  TRACKING_LIMITS,
  updateExternalTracking,
  updateExternalTrackingInput,
  visitorIdentifications,
  type ExternalTracking,
  type TrackingActivity,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { withTenant } from '@repo/db';
import { ConflictError, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

/** The alphabet of a tracking id: 32 symbols, five bits each. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** A new tracking id: `tk_` and 32 symbols, 160 random bits. */
export function newTrackingId(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let id = 'tk_';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      id += ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  return id;
}

interface SettingsRow {
  readonly tracking_id: string;
  readonly page_views: boolean;
  readonly form_capture: boolean;
  readonly allowed_domains: string[];
  readonly visitor_ids: string;
  readonly revision: number;
}

const visitorIds = z.enum(visitorIdentifications);

const present = (row: SettingsRow): ExternalTracking => ({
  trackingId: row.tracking_id,
  pageViews: row.page_views,
  formCapture: row.form_capture,
  allowedDomains: [...row.allowed_domains],
  // The table's own constraint allows nothing else.
  visitorIds: visitorIds.parse(row.visitor_ids),
  revision: row.revision,
});

const COLUMNS = [
  'tracking_id',
  'page_views',
  'form_capture',
  'allowed_domains',
  'visitor_ids',
  'revision',
] as const;

/**
 * The business's settings, made the first time they are asked for. With `lock`, the row is
 * held until the transaction ends.
 */
export async function trackingSettingsOf(
  trx: DatabaseTransaction,
  businessId: string,
  lock = false,
): Promise<SettingsRow> {
  await trx
    .insertInto('forms.tracking_settings')
    .values({ business_id: businessId, tracking_id: newTrackingId() })
    .onConflict((conflict) => conflict.column('business_id').doNothing())
    .execute();
  const query = trx
    .selectFrom('forms.tracking_settings')
    .select(COLUMNS)
    .where('business_id', '=', businessId);
  return (lock ? query.forUpdate() : query).executeTakeFirstOrThrow();
}

const stale = () =>
  new ConflictError('The tracking settings changed since you opened them. Open them again.');

export const updateExternalTrackingCommand = defineCommand({
  name: 'external_tracking.update',
  permission: 'sites.manage',
  input: updateExternalTrackingInput,
  async handle(trx, input, command): Promise<ExternalTracking> {
    const businessId = requireBusiness(command.context);
    const current = await trackingSettingsOf(trx, businessId, true);
    if (current.revision !== input.revision) throw stale();
    return present(
      await trx
        .updateTable('forms.tracking_settings')
        .set({
          page_views: input.pageViews,
          form_capture: input.formCapture,
          allowed_domains: input.allowedDomains,
          visitor_ids: input.visitorIds,
          revision: current.revision + 1,
        })
        .where('business_id', '=', businessId)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow(),
    );
  },
});

export const regenerateTrackingIdCommand = defineCommand({
  name: 'external_tracking.regenerate',
  permission: 'sites.manage',
  input: regenerateTrackingIdInput,
  async handle(trx, input, command): Promise<ExternalTracking> {
    const businessId = requireBusiness(command.context);
    const current = await trackingSettingsOf(trx, businessId, true);
    if (current.revision !== input.revision) throw stale();
    return present(
      await trx
        .updateTable('forms.tracking_settings')
        .set({ tracking_id: newTrackingId(), revision: current.revision + 1 })
        .where('business_id', '=', businessId)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow(),
    );
  },
});

/** What Troubleshoot shows: the latest events and each page heard from lately. */
export async function readTrackingActivity(trx: DatabaseTransaction): Promise<TrackingActivity> {
  const since = sql<Date>`now() - make_interval(days => ${TRACKING_LIMITS.days}::integer)`;
  const events = await trx
    .selectFrom('forms.tracking_events')
    .select([
      'received_at',
      'kind',
      'page_host',
      'page_path',
      'page_title',
      'form_name',
      'contact_id',
    ])
    .where('received_at', '>', since)
    .orderBy('received_at', 'desc')
    .orderBy('id', 'desc')
    .limit(TRACKING_LIMITS.recentEvents)
    .execute();
  const pages = await trx
    .selectFrom('forms.tracking_page_days')
    .select([
      'page_host',
      'page_path',
      sql<number>`sum(page_views)::integer`.as('page_views'),
      sql<number>`sum(form_submissions)::integer`.as('form_submissions'),
      sql<Date>`max(last_seen_at)`.as('last_seen_at'),
    ])
    .where('day', '>', sql<Date>`(current_date - ${TRACKING_LIMITS.days}::integer)`)
    .groupBy(['page_host', 'page_path'])
    .orderBy(sql`max(last_seen_at)`, 'desc')
    .orderBy('page_path')
    .limit(TRACKING_LIMITS.pages)
    .execute();
  const last = events[0]?.received_at ?? pages[0]?.last_seen_at;
  return {
    lastEventAt: last === undefined ? null : last.toISOString(),
    events: events.map((row) => ({
      receivedAt: row.received_at.toISOString(),
      // The table's own constraint allows nothing else.
      kind: row.kind === 'form_submission' ? 'form_submission' : 'page_view',
      pageHost: row.page_host,
      pagePath: row.page_path,
      pageTitle: row.page_title,
      formName: row.form_name,
      contactId: row.contact_id === null ? null : toPublicId('contact', row.contact_id),
    })),
    pages: pages.map((row) => ({
      pageHost: row.page_host,
      pagePath: row.page_path,
      pageViews: row.page_views,
      formSubmissions: row.form_submissions,
      lastSeenAt: row.last_seen_at.toISOString(),
    })),
  };
}

export const externalTrackingRoutes: readonly ApiRoute[] = [
  {
    endpoint: getExternalTracking,
    run: ({ invocation }, { db }) => {
      const businessId = requireBusiness(invocation.context);
      return withTenant(db, invocation.context, async (trx) =>
        present(await trackingSettingsOf(trx, businessId)),
      );
    },
  } satisfies Route<typeof getExternalTracking>,
  {
    endpoint: updateExternalTracking,
    command: updateExternalTrackingCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, updateExternalTrackingCommand, body, invocation),
  } satisfies Route<typeof updateExternalTracking>,
  {
    endpoint: regenerateTrackingId,
    command: regenerateTrackingIdCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, regenerateTrackingIdCommand, body, invocation),
  } satisfies Route<typeof regenerateTrackingId>,
  {
    endpoint: getExternalTrackingActivity,
    run: ({ invocation }, { db }) => {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, readTrackingActivity);
    },
  } satisfies Route<typeof getExternalTrackingActivity>,
];

/**
 * The daily purge's part: raw events past thirty days, a page's days past thirteen months
 * and visitors unseen for thirteen months, in every business, a batch at a time.
 */
export async function expireExternalTracking(services: Services, batch = 5000): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < 200; pass++) {
    const { rows } = await sql<{ removed: number }>`
      select private.expire_tracking_data(${batch}) as removed
    `.execute(services.db);
    const removed = rows[0]?.removed ?? 0;
    total += removed;
    if (removed < batch) break;
  }
  return total;
}
