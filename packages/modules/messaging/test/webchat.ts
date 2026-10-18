// The web chat tests' world: a database of the test file's own, the public handlers as the
// server composes them, and what the tests need to overlap two transactions for real.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  publicWebchatMessages,
  type PublicWebchatMessage,
  type PublicWebchatMessages,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { testDatabase, type DatabaseServer, type Sql, type TestDatabase } from '@repo/testing';
import * as z from 'zod';

import { newWidgetKey } from '../src/webchat-token.js';
import {
  createPublicWebchatHandlers,
  type PublicWebchatHandlers,
  type WebchatAdmission,
} from '../src/webchat-public.js';
import { sendWebchatReply, type WebchatReplyResult } from '../src/webchat-reply.js';

export const ORIGIN = 'https://example.com';
export const OTHER_ORIGIN = 'https://www.example.com';

export interface WidgetSettings {
  readonly emailRequired?: boolean;
  readonly marketingConsentWording?: string | null;
}

/** A business with one widget that is on, and the admission of its first website. */
export interface WidgetFixture {
  readonly business: { readonly id: string; readonly context: TenantContext };
  readonly context: TenantContext;
  readonly key: string;
  readonly widgetId: string;
  readonly admission: WebchatAdmission;
  /** Runs one statement as crm_app in this business. */
  rows<Row extends object>(text: string, values?: readonly unknown[]): Promise<Row[]>;
}

/** A transaction kept open by the test, to hold a lock while something else runs. */
export interface OpenTransaction {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row[]>;
  /** Commits. Whatever the transaction held is free from here. */
  release(): Promise<void>;
}

export interface WebchatWorld {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly services: Services;
  readonly handlers: PublicWebchatHandlers;
  fixture(settings?: WidgetSettings, business?: WidgetFixture['business']): Promise<WidgetFixture>;
  /** A started session: its token, as only the visitor has it. */
  started(
    f: WidgetFixture,
    visitor?: { name?: string; email?: string; marketingConsent?: boolean },
    admission?: WebchatAdmission,
  ): Promise<string>;
  sent(
    f: WidgetFixture,
    token: string,
    text?: string,
    admission?: WebchatAdmission,
  ): Promise<PublicWebchatMessage>;
  read(
    f: WidgetFixture,
    token: string,
    after?: number,
    admission?: WebchatAdmission,
  ): Promise<PublicWebchatMessages>;
  /** The team's reply, through a command as the inbox composer will run it. */
  replied(
    f: WidgetFixture,
    conversationId: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<WebchatReplyResult>;
  conversationOf(f: WidgetFixture): Promise<string>;
  /** Opens a transaction as crm_app in a business and keeps it open until released. */
  open(context: TenantContext): Promise<OpenTransaction>;
  /**
   * Resolves once exactly `count` sessions of this database are waiting for a lock, as the
   * superuser sees them (another role's wait events are hidden from crm_app). Rejects after
   * ten seconds: something that should have waited did not.
   */
  lockWaits(count: number): Promise<void>;
  close(): Promise<void>;
}

export const request = (): { requestId: string } => ({ requestId: randomUUID() });
export const message = (text = 'Hello'): { clientMessageId: string; text: string } => ({
  clientMessageId: randomUUID(),
  text,
});

const reply = defineCommand({
  name: 'test.webchat.reply',
  permission: 'contacts.manage',
  input: z.strictObject({ conversationId: z.uuid(), text: z.string(), idempotencyKey: z.string() }),
  audit: () => ({}),
  handle: sendWebchatReply,
});

type Job = (sql: Sql) => Promise<void>;

export async function startWebchat(connection: DatabaseServer): Promise<WebchatWorld> {
  const database = await testDatabase(connection);
  const db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const services: Services = { db, authorize: allowEveryone };
  const handlers = createPublicWebchatHandlers(db);

  const openTransactions = new Set<() => Promise<void>>();
  const world: WebchatWorld = {
    database,
    db,
    services,
    handlers,
    async fixture(settings = {}, business) {
      const owner =
        business ?? (await database.fixtures.business((await database.fixtures.agency()).id));
      const context: TenantContext = { ...owner.context, correlationId: randomUUID() };
      const key = newWidgetKey();
      const widgetId = await database.withTenant(context, async (sql) => {
        const channel = await sql.one<{ id: string }>(
          `insert into messaging.channel_accounts (business_id, channel, name)
           values (app.business_id(), 'webchat', 'Main site') returning id`,
        );
        await sql.query(
          `insert into messaging.webchat_widgets (business_id, id, public_key, allowed_origins, settings)
           values (app.business_id(), $1, $2, $3, $4::jsonb)`,
          [
            channel.id,
            key,
            [ORIGIN, OTHER_ORIGIN],
            JSON.stringify({
              title: 'Chat with us',
              greeting: 'Hello.',
              emailRequired: settings.emailRequired ?? true,
              marketingConsentWording: settings.marketingConsentWording ?? null,
            }),
          ],
        );
        return channel.id;
      });
      const admission = await handlers.admit(key, ORIGIN);
      if (admission === undefined)
        throw new Error('The fixture widget did not admit its own website.');
      return {
        business: owner,
        context,
        key,
        widgetId,
        admission,
        rows: <Row extends object>(text: string, values: readonly unknown[] = []) =>
          database.withTenant(context, (sql) => sql.query<Row>(text, values)),
      };
    },
    async started(f, visitor = {}, admission = f.admission) {
      const result = await handlers.start(
        admission,
        { email: `${randomUUID()}@example.test`, marketingConsent: false, ...visitor },
        request(),
      );
      if (result.outcome !== 'ok') throw new Error(`The session did not start: ${result.outcome}`);
      return result.session.token;
    },
    async sent(f, token, text = 'Hello', admission = f.admission) {
      const result = await handlers.send(admission, token, message(text), request());
      if (result.outcome !== 'ok') throw new Error(`The message was not stored: ${result.outcome}`);
      return result.message;
    },
    async read(f, token, after = 0, admission = f.admission) {
      const result = await handlers.messages(admission, token, after);
      if (result.outcome !== 'ok') throw new Error(`The session was not read: ${result.outcome}`);
      return publicWebchatMessages.parse(result.page);
    },
    async replied(f, conversationId, text, idempotencyKey = randomUUID()) {
      const user = await database.fixtures.user();
      const invocation: Invocation = {
        context: {
          ...f.context,
          actorKind: 'user',
          actorId: user.id,
          userId: user.id,
          correlationId: randomUUID(),
        },
        permissions: 'all',
      };
      return runCommand(services, reply, { conversationId, text, idempotencyKey }, invocation);
    },
    async conversationOf(f) {
      const [row] = await f.rows<{ id: string }>(
        'select id from messaging.conversations order by created_at desc limit 1',
      );
      if (row === undefined) throw new Error('No conversation.');
      return row.id;
    },
    async open(context) {
      const jobs: (Job | null)[] = [];
      let wake = (): void => undefined;
      const next = async (): Promise<Job | null> => {
        while (jobs.length === 0)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        return jobs.shift() ?? null;
      };
      const push = (job: Job | null): void => {
        jobs.push(job);
        wake();
      };
      let opened = (): void => undefined;
      const ready = new Promise<void>((resolve) => {
        opened = resolve;
      });
      const finished = database.withTenant(
        { ...context, correlationId: randomUUID() },
        async (sql) => {
          opened();
          for (;;) {
            const job = await next();
            if (job === null) return;
            await job(sql);
          }
        },
      );
      await Promise.race([ready, finished]);
      const release = async (): Promise<void> => {
        openTransactions.delete(release);
        push(null);
        await finished;
      };
      openTransactions.add(release);
      return {
        query: <Row extends object>(text: string, values: readonly unknown[] = []) =>
          new Promise<Row[]>((resolve, reject) => {
            push(async (sql) => {
              try {
                resolve(await sql.query<Row>(text, values));
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              }
            });
          }),
        release,
      };
    },
    async lockWaits(count) {
      let seen = -1;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const row = await database.as('postgres', (sql) =>
          sql.one<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'`,
          ),
        );
        seen = row.waiting;
        if (seen === count) return;
        await sleep(50);
      }
      throw new Error(
        `Expected ${String(count)} session(s) waiting for a lock, saw ${String(seen)}.`,
      );
    },
    async close() {
      // A test that failed with a transaction in its hands must not leave it holding locks:
      // dropping the database would wait for it until the server gave up.
      await Promise.allSettled([...openTransactions].map((release) => release()));
      await db.destroy();
      await database.close();
    },
  };
  return world;
}
