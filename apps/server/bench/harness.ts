// What the page benchmark and the load tests share: the production start on a real,
// migrated Postgres (Testcontainers), a business with a published 20-section page,
// published forms, a booking calendar and a chat widget, the load generator in a thread of
// its own, and the arithmetic.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { Worker } from 'node:worker_threads';

import { allowEveryone, type ApiRoute, type Invocation } from '@repo/commands';
import {
  calendarConfiguration,
  form as formContract,
  site as siteContract,
  sitePage,
  siteStep,
  webchatWidget,
  type Form,
  type FormDefinitionInput,
  type PageDocument,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { createFormRoutes } from '@repo/module-forms';
import { createWebchatRoutes } from '@repo/module-messaging';
import { createSealingVault, newSecretsKey, parseSecretsPublicKey } from '@repo/module-vault';
import type { DatabaseServer, TestDatabase } from '@repo/testing';
import { testDatabase } from '@repo/testing';

import { apiRoutes } from '../src/api-routes.js';
import type { Config } from '../src/config.js';
import { start, type Running } from '../src/start.js';

export const PUBLIC_URL = 'https://crm.example.test';
export const WEBSITE = 'https://www.harborlights.example';
const SECRET = 'bench-fixture-key-with-at-least-32-bytes!';

export interface Bench {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly app: Running;
  /** A new business with one person on its team. */
  business(): Promise<BenchBusiness>;
  /**
   * A booking calendar of the business, open every day from nine to five in UTC, half an
   * hour a slot, bookable from now for sixty days: the address of its public API.
   */
  calendar(business: BenchBusiness): Promise<{ readonly url: string }>;
  /** A chat widget of the business, on for the website: its key. */
  widget(business: BenchBusiness): Promise<{ readonly key: string }>;
  /** A form of the business, published for the website. */
  form(invocation: Invocation, name: string): Promise<Form>;
  /** A funnel of the signed-in business with this page published at `landing`: its key. */
  publish(document: PageDocument): Promise<{ readonly key: string; readonly url: string }>;
  /** Empties the shared limiter's counters, as the turn of a minute does. */
  resetLimiter(): Promise<void>;
  close(): Promise<void>;
}

export interface BenchBusiness {
  readonly id: string;
  readonly slug: string;
  readonly context: TenantContext;
  readonly invocation: Invocation;
}

const enquiry = {
  title: 'Plan your event',
  fields: [
    {
      key: 'first_name',
      type: 'text',
      label: 'First name',
      target: { kind: 'contact', attribute: 'firstName' },
    },
    {
      key: 'email',
      type: 'email',
      label: 'Email',
      required: true,
      target: { kind: 'contact', attribute: 'email' },
    },
  ],
  consents: [],
  // What a new form does: the Source from how they arrived, and the tag of it.
  contactActions: { source: { kind: 'arrived' }, tagBySource: true },
} satisfies FormDefinitionInput;

/**
 * The server as an install runs it (role app: the HTTP server and no worker, as a separate
 * worker process would be beside it), with a pool the size an install has by default.
 */
export async function openBench(
  server: DatabaseServer,
  over: Partial<Config> = {},
): Promise<Bench> {
  const database = await testDatabase(server);
  const db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const agencySlug = `bench-${randomUUID().slice(0, 8)}`;
  const agency = await database.fixtures.agency({ slug: agencySlug });
  const first = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  const config: Config = {
    nodeEnv: 'test',
    role: 'app',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: undefined,
    databasePoolSize: 10,
    shutdownTimeoutMs: 5000,
    dashboardDir: undefined,
    // The signed-in API below is this one person in the first business.
    devTenantContext: { agencyId: agency.id, businessId: first.id, userId: user.id },
    publicUrl: PUBLIC_URL,
    publicIntake: { secret: SECRET },
    authentication: undefined,
    mail: undefined,
    // The load generator names each visitor's address, as a proxy in front would.
    trustProxy: ['loopback'],
    files: undefined,
    vault: undefined,
    ...over,
  };
  const app = await start(config, apiRoutes, []);
  const routes: readonly ApiRoute[] = [
    ...apiRoutes(),
    ...createFormRoutes(PUBLIC_URL, { previewSecret: SECRET }),
    ...createWebchatRoutes(PUBLIC_URL),
  ];
  const asTeam = async (
    invocation: Invocation,
    operationId: string,
    request: { params?: unknown; body?: unknown } = {},
  ): Promise<unknown> => {
    const route = routes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`No route for ${operationId}.`);
    return route.run(
      {
        invocation: {
          ...invocation,
          context: { ...invocation.context, correlationId: randomUUID() },
        },
        params: request.params ?? {},
        query: {},
        body: request.body,
      },
      { db, authorize: allowEveryone },
    );
  };
  const api = async <T>(
    parse: { parse: (value: unknown) => T },
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await fetch(`${app.address}/api/v1${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${String(response.status)} ${text}`);
    return parse.parse(JSON.parse(text));
  };

  return {
    database,
    db,
    app,
    async business() {
      const slug = `business-${randomUUID().slice(0, 8)}`;
      const owner = await database.fixtures.business(agency.id, { slug });
      const member = await database.fixtures.user({ name: 'Sam Rivers' });
      return {
        id: owner.id,
        slug,
        context: owner.context,
        invocation: {
          context: {
            ...owner.context,
            actorKind: 'user',
            actorId: member.id,
            userId: member.id,
            correlationId: randomUUID(),
          },
          permissions: 'all',
        },
      };
    },
    async calendar(business) {
      // What a calendar needs before it can be booked: a host on the team, and a mailbox
      // its confirmations are queued for (never sent: this server runs no worker).
      const host = await database.fixtures.user({ name: 'Riley Host' });
      const membership = await database.withTenant(business.context, (sql) =>
        sql.one<{ id: string }>(
          `with role as (
             insert into tenancy.roles(agency_id, scope, key, name)
             values (app.agency_id(), 'business', $2, 'Host') returning id)
           insert into tenancy.memberships(agency_id, business_id, user_id, role_id)
           select app.agency_id(), app.business_id(), $1, id from role returning id`,
          [host.id, `host_${randomUUID().slice(0, 8)}`],
        ),
      );
      const vault = await createSealingVault(
        parseSecretsPublicKey((await newSecretsKey(1)).publicKey),
      );
      const secretId = await withTenant(db, business.context, (trx) =>
        vault.store(
          trx,
          { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.credentials' },
          'sealed fixture; never dispatched',
        ),
      );
      const account = await database.withTenant(business.context, async (sql) => {
        await sql.query(
          'insert into messaging.settings(business_id, quiet_hours_enabled) values (app.business_id(), false)',
        );
        const made = await sql.one<{ id: string }>(
          "insert into messaging.channel_accounts(business_id, channel, name) values (app.business_id(), 'email', 'Bookings') returning id",
        );
        await sql.query(
          `insert into messaging.mailboxes(business_id, id, email_address, auth_method, smtp_host,
             smtp_port, smtp_security, smtp_username, secret_id, use_for_conversations)
           values (app.business_id(), $1, 'bookings@example.test', 'password', 'localhost', 1025,
             'none', 'fixture', $2, true)`,
          [made.id, secretId],
        );
        return made;
      });
      calendarConfiguration.parse(
        await asTeam(business.invocation, 'createCalendar', {
          body: {
            name: 'Venue tour',
            kind: 'personal',
            timezone: 'UTC',
            bookingSlug: 'venue-tour',
            confirmationSenderId: toPublicId('mailbox', account.id),
            isActive: true,
            minNoticeMinutes: 0,
            members: [{ membershipId: toPublicId('membership', membership.id), weight: 1 }],
            weeklyHours: Array.from({ length: 7 }, (_, weekday) => ({
              weekday,
              startTime: '09:00',
              endTime: '17:00',
            })),
            dateOverrides: [],
          },
        }),
      );
      return {
        url: `${app.address}/api/v1/public/book/${agencySlug}/${business.slug}/venue-tour`,
      };
    },
    async widget(business) {
      const made = webchatWidget.parse(
        await asTeam(business.invocation, 'createWebchatWidget', {
          body: {
            name: 'Main site',
            allowedOrigins: [WEBSITE],
            enabled: true,
            settings: {
              title: 'Chat with us',
              greeting: 'Hello.',
              emailRequired: true,
              marketingConsentWording: null,
            },
          },
        }),
      );
      return { key: made.publicKey };
    },
    async form(invocation, name) {
      const draft = formContract.parse(await asTeam(invocation, 'createForm', { body: { name } }));
      const saved = formContract.parse(
        await asTeam(invocation, 'updateForm', {
          params: { id: draft.id },
          body: {
            name,
            definition: enquiry,
            allowedOrigins: [WEBSITE],
            revision: draft.revision,
          },
        }),
      );
      return formContract.parse(
        await asTeam(invocation, 'publishForm', {
          params: { id: saved.id },
          body: { revision: saved.revision },
        }),
      );
    },
    async publish(document) {
      const made = await api(siteContract, 'POST', '/sites', {
        kind: 'funnel',
        name: `Bench ${randomUUID().slice(0, 8)}`,
      });
      const step = await api(siteStep, 'POST', `/sites/${made.id}/steps`, {
        name: 'Landing',
        path: 'landing',
      });
      const pageId = step.pages[0]?.id ?? '';
      const empty = await api(sitePage, 'GET', `/site-pages/${pageId}`);
      const saved = await api(sitePage, 'PUT', `/site-pages/${pageId}/draft`, {
        baseVersion: empty.currentVersion,
        document,
      });
      await api(sitePage, 'POST', `/site-pages/${pageId}/publish`, { revision: saved.revision });
      const key = (await api(siteContract, 'GET', `/sites/${made.id}`)).publicKey ?? '';
      return { key, url: `${app.address}/s/${key}/landing` };
    },
    async resetLimiter() {
      await database.as('crm_owner', async (sql) => {
        // The totals row first, as the limiter itself takes its locks: never a deadlock.
        await sql.query('select singleton from intake.public_rate_limit_totals for update');
        await sql.query('delete from intake.public_rate_limit_clients');
        await sql.query(
          `update intake.public_rate_limit_totals
           set window_start = 'epoch', reads = 0, writes = 0, full_window = null`,
        );
      });
    },
    async close() {
      await app.stop();
      await db.destroy();
      await database.close();
    },
  };
}

/**
 * Runs `work` again and again, this long after it last ended, until the function given
 * back is called; that call settles when the last run has ended. A failure stops it and is
 * thrown by that call: a measurement taken while the limiter was not being emptied would
 * be a refusal's.
 */
export function repeatedly(everyMs: number, work: () => Promise<void>): () => Promise<void> {
  let stopped = false;
  let failure: unknown;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const turn = (): void => {
    running = work().then(
      () => {
        if (!stopped) timer = setTimeout(turn, everyMs);
      },
      (error: unknown) => {
        failure = error;
      },
    );
  };
  turn();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error('It failed.');
  };
}

/** Runs the load generator (client.mjs) in a thread of its own and gives what it measured. */
export async function load<Result>(work: Readonly<Record<string, unknown>>): Promise<Result> {
  const worker = new Worker(new URL('./client.mjs', import.meta.url), { workerData: work });
  const failed = once(worker, 'error').then(([error]) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
  try {
    const [result] = (await Promise.race([once(worker, 'message'), failed])) as [Result];
    return result;
  } finally {
    await worker.terminate();
  }
}

export interface GetResult {
  readonly latencies: number[];
  readonly statuses: Record<string, number>;
  readonly bytes: number;
  readonly seconds: number;
}

/** The value below which this share of the measurements fall, in the unit they are in. */
export function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? Number.NaN;
}

export interface Summary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export const summary = (values: readonly number[]): Summary => ({
  p50: Number(percentile(values, 0.5).toFixed(2)),
  p95: Number(percentile(values, 0.95).toFixed(2)),
  p99: Number(percentile(values, 0.99).toFixed(2)),
  max: Number(Math.max(...values).toFixed(2)),
});

/** The machine a measurement was taken on: a number means nothing without it. */
export const machine = (): Readonly<Record<string, string | number>> => ({
  cpu: cpus()[0]?.model.trim() ?? 'unknown',
  logicalCpus: cpus().length,
  memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
});

/** Keeps a run's numbers beside the code (apps/server/reports is not committed). */
export function report(name: string, value: unknown): void {
  const directory = new URL('../reports/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL(`${name}.json`, directory), `${JSON.stringify(value, null, 2)}\n`);
  process.stdout.write(`\n${name}\n${JSON.stringify(value, null, 2)}\n`);
}
