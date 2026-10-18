// One lock order for everything that writes conversations and messages: the business,
// then the conversation, then messages. Migration 0046 makes a message's new status reach
// its conversation, so the outbound worker (business FOR UPDATE, then the message) now
// also takes the conversation; an inbox command that held the conversation first and then
// needed the business for its event would deadlock with it. Each case here pauses one
// side at a known point and waits until the superuser sees the other blocked. Real Postgres.
import { randomUUID } from 'node:crypto';

import { conversation, threadMessage } from '@repo/contracts';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createDispatchOutboundTask } from './outbound.js';
import { inboxBusiness, startInbox, type InboxWorld } from '../test/inbox.js';

let world: InboxWorld;
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

const key = () => randomUUID().replaceAll('-', '');

/** A conversation with a reply queued for delivery. */
async function queuedReply() {
  const b = await inboxBusiness(world);
  const maya = await b.contact({ firstName: 'Maya' });
  const box = await b.mailbox();
  const stored = await b.receive(maya, box.id, 'Is June 13 still open?');
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const reply = threadMessage.parse(
    await world.call('sendConversationReply', b.as(), {
      params,
      body: {
        channel: 'email',
        accountId: box.publicId,
        to: maya.emailIdentity,
        text: 'Hi Maya',
        idempotencyKey: key(),
      },
    }),
  );
  const job = {
    invocation: {
      context: { ...b.context, actorKind: 'system' as const, correlationId: randomUUID() },
      permissions: 'all' as const,
    },
    services: world.services,
  };
  const statusOf = async (messageId: string) =>
    (
      await b.query<{ status: string }>('select status from messaging.messages where id = $1', [
        messageId,
      ])
    )[0]?.status;
  return {
    b,
    stored,
    params,
    job,
    statusOf,
    messageId: parsePublicId('message', reply.id) ?? '',
  };
}

/** Whether a row can be locked right now, asked by the superuser without waiting. */
const free = (table: string, id: string): Promise<boolean> =>
  world.database
    .as('postgres', (admin) =>
      admin.query(`select id from ${table} where id = $1 for update nowait`, [id]),
    )
    .then(
      () => true,
      (error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '55P03'
        )
          return false;
        throw error;
      },
    );

const commands = [
  [
    'an internal note',
    'addConversationNote',
    (f: Awaited<ReturnType<typeof queuedReply>>) =>
      Promise.resolve({ params: f.params, body: { text: 'Called her.', idempotencyKey: key() } }),
  ],
  [
    'an assignment',
    'assignConversation',
    async (f: Awaited<ReturnType<typeof queuedReply>>) => ({
      params: f.params,
      body: {
        assignee: 'me',
        revision: conversation.parse(
          await world.call('getConversation', f.b.as(), { params: f.params }),
        ).revision,
      },
    }),
  ],
  [
    'marking read',
    'markConversationRead',
    (f: Awaited<ReturnType<typeof queuedReply>>) =>
      Promise.resolve({
        params: f.params,
        body: { through: toPublicId('message', f.stored.messageId) },
      }),
  ],
] as const;

it.each(commands)(
  'runs %s beside the outbound worker without a deadlock',
  async (_name, operationId, request) => {
    const f = await queuedReply();
    const prepared = await request(f);
    let command: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let conversationFree: boolean | undefined;
    const task = createDispatchOutboundTask(
      {
        deliver: () => Promise.resolve({ outcome: 'accepted', providerId: randomUUID() }),
      },
      // The worker's transaction is here after it has locked the business and the
      // message, and before it changes the message's status.
      async (trx) => {
        const {
          rows: [worker],
        } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
        command = Promise.allSettled([world.call(operationId, f.b.as(), prepared)]);
        // The command waits on the worker: for the business, before any conversation.
        await world.blockedBy(worker?.pid ?? 0, 1);
        conversationFree = await free('messaging.conversations', f.stored.conversationId);
        return { action: 'allow' };
      },
    );
    // The worker goes on to change the status, which takes the conversation, and commits.
    const [worked] = await Promise.allSettled([task.run({ messageId: f.messageId }, f.job)]);
    if (command === undefined) throw new Error('The command never started.');
    const [commanded] = await command;
    const outcome = (result: PromiseSettledResult<unknown> | undefined) =>
      result?.status === 'fulfilled' ? 'ok' : String(result?.reason);
    expect([outcome(worked), outcome(commanded)]).toEqual(['ok', 'ok']);
    // While it waited, the command held nothing the worker needed.
    expect(conversationFree).toBe(true);
    expect(await f.statusOf(f.messageId)).toBe('sent');
    expect(await world.call('getConversation', f.b.as(), { params: f.params })).toMatchObject({
      needsReply: false,
    });
  },
);

it('lets the worker wait for a command that already holds the business', async () => {
  const f = await queuedReply();
  let worked: Promise<PromiseSettledResult<unknown>[]> | undefined;
  const task = createDispatchOutboundTask({
    deliver: () => Promise.resolve({ outcome: 'accepted', providerId: randomUUID() }),
  });
  // A command's transaction, paused after its first two locks: the business, then the
  // conversation.
  await world.database.withTenant({ ...f.b.context, correlationId: randomUUID() }, async (held) => {
    await held.query('select id from tenancy.businesses where id = $1 for key share', [
      f.b.business.id,
    ]);
    await held.query('select id from messaging.conversations where id = $1 for update', [
      f.stored.conversationId,
    ]);
    const [owner] = await held.query<{ pid: number }>('select pg_backend_pid() as pid');
    worked = Promise.allSettled([task.run({ messageId: f.messageId }, f.job)]);
    // The worker stops at the business, holding neither the message nor the conversation.
    await world.blockedBy(owner?.pid ?? 0, 1);
    expect(await free('messaging.messages', f.messageId)).toBe(true);
  });
  if (worked === undefined) throw new Error('The worker never started.');
  expect((await worked).map((each) => each.status)).toEqual(['fulfilled']);
  expect(await f.statusOf(f.messageId)).toBe('sent');
});

it('records a delivery outcome while a writer that holds the conversation changes the same message', async () => {
  // The worker records the provider's answer in a second transaction. If it changes the
  // message first and only then reaches the conversation, a writer that holds the
  // conversation and then changes that message (a bounce read by the inbox sync, which
  // holds the business FOR SHARE) meets it in the opposite order: before outbound.ts took
  // the business first in that transaction too, this case ended in a deadlock (40P01).
  const f = await queuedReply();
  let writer: Promise<PromiseSettledResult<unknown>[]> | undefined;
  const holding = Promise.withResolvers<undefined>();
  const task = createDispatchOutboundTask({
    // Between the worker's two transactions.
    async deliver() {
      writer = Promise.allSettled([
        world.database.withTenant(
          { ...f.b.context, actorKind: 'system', correlationId: randomUUID() },
          async (ingest) => {
            await ingest.query('select id from tenancy.businesses where id = $1 for share', [
              f.b.business.id,
            ]);
            await ingest.query('select id from messaging.conversations where id = $1 for update', [
              f.stored.conversationId,
            ]);
            const [owner] = await ingest.query<{ pid: number }>('select pg_backend_pid() as pid');
            holding.resolve(undefined);
            // The worker's second transaction is now waiting on this one.
            await world.blockedBy(owner?.pid ?? 0, 1);
            await ingest.query(
              "update messaging.messages set status = 'bounced', error_code = 'hard_bounce' where id = $1",
              [f.messageId],
            );
          },
        ),
      ]);
      await holding.promise;
      return { outcome: 'accepted', providerId: randomUUID() };
    },
  });
  const [worked] = await Promise.allSettled([task.run({ messageId: f.messageId }, f.job)]);
  if (writer === undefined) throw new Error('The writer never started.');
  const [wrote] = await writer;
  const outcome = (result: PromiseSettledResult<unknown> | undefined) =>
    result?.status === 'fulfilled' ? 'ok' : String(result?.reason);
  expect([outcome(worked), outcome(wrote)]).toEqual(['ok', 'ok']);
});
