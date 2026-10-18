// A merge against an inbox reply to one of its contacts, on two connections, as crm_app,
// both ways round: the reply first, holding the business and the conversation while it reads
// back its message; and the merge first, holding its contacts and the conversations it has
// combined. Both always finish: one waits for the other, and neither is a deadlock's victim
// (40P01). A reply to the conversation the merge removed may be refused; that's an answer.
import { randomUUID } from 'node:crypto';

import { contactMerge, contactMergePreview } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { contactMergeRoutes, type ContactMergeParticipant } from '@repo/module-crm';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { inboxBusiness, startInbox, type InboxBusiness, type InboxWorld } from '../test/inbox.js';
import { messagingContactMerge } from './contact-merge.js';
import { createInboxRoutes } from './inbox-routes.js';

let world: InboxWorld;
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

/** A promise and the function that settles it. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    opened: promise,
    open: () => {
      resolve(undefined);
    },
  };
}

/** Whether a command finished without a deadlock: done, or refused for a reason of its own. */
const finished = (run: Promise<unknown>) =>
  run.then(
    () => 'done',
    (error: unknown) => {
      if ((error as { code?: string }).code === '40P01') return 'deadlock';
      return (error as { name?: string }).name ?? 'failed';
    },
  );

async function merge(
  b: InboxBusiness,
  kept: string,
  merged: string,
  participants: readonly ContactMergeParticipant[],
) {
  const routes = contactMergeRoutes({ participants });
  const route = (id: string) => routes.find((each) => each.endpoint.operationId === id);
  const preview = contactMergePreview.parse(
    await route('previewContactMerge')?.run(
      { invocation: b.as(), params: { id: kept }, query: { mergeIds: merged }, body: undefined },
      world.services,
    ),
  );
  const revisions = Object.fromEntries(preview.contacts.map((each) => [each.id, each.revision]));
  return contactMerge.parse(
    await route('mergeContacts')?.run(
      {
        invocation: b.as(),
        params: { id: kept },
        query: {},
        body: { mergeIds: [merged], revisions },
      },
      world.services,
    ),
  );
}

/**
 * Two contacts who wrote in, each with a conversation, and a mailbox to answer from. The
 * merged contact's message was stored without an event and it has no consent rows, so the
 * merge itself writes nothing that holds the business before its own events: what the
 * merge holds is then only what it locks on purpose.
 */
async function scene() {
  const b = await inboxBusiness(world);
  const box = await b.mailbox();
  const kept = await b.contact({ firstName: 'Kept' });
  const merged = await b.contact({ firstName: 'Merged', consent: false });
  const keptChat = await b.receive(kept, box.id, 'Is June 13 still open?');
  const [mergedConversation] = await b.query<{ id: string }>(
    `insert into messaging.conversations (business_id, contact_id)
     values (app.business_id(), $1) returning id`,
    [merged.id],
  );
  if (mergedConversation === undefined) throw new Error('Fixture rows missing.');
  await b.query(
    `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
       direction, status, body_text, author_kind)
     values (app.business_id(), $1, 'email', $2, 'inbound', 'received', 'And June 14?', 'contact')`,
    [mergedConversation.id, box.id],
  );
  const mergedChat = { conversationId: mergedConversation.id };
  return { b, box, kept, merged, keptChat, mergedChat };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** A reply whose read-back of its own message (the author's name) is held until let go. */
function reply(
  s: Scene,
  to: 'kept' | 'merged',
  hold: { readonly held: Promise<void>; readonly paused: () => void },
) {
  const routes = createInboxRoutes({
    ...world.options,
    actorNames: {
      user: async () => {
        hold.paused();
        await hold.held;
        return new Map<string, string>();
      },
    },
  });
  const contact = s[to];
  const conversationId = (to === 'kept' ? s.keptChat : s.mergedChat).conversationId;
  return world.call(
    'sendConversationReply',
    s.b.as(),
    {
      params: { id: toPublicId('conversation', conversationId) },
      body: {
        channel: 'email',
        accountId: s.box.publicId,
        to: contact.emailIdentity,
        text: 'June 13 is open.',
        idempotencyKey: randomUUID().replaceAll('-', ''),
      },
    },
    routes,
  );
}

it.each(['kept', 'merged'] as const)(
  'a reply to the %s contact first: the merge waits for it, and both finish',
  async (to) => {
    const s = await scene();
    const held = gate();
    const paused = gate();
    const replying = finished(
      reply(s, to, {
        held: held.opened,
        paused: () => {
          paused.open();
        },
      }),
    );
    await paused.opened;
    const merging = finished(
      merge(s.b, s.kept.publicId, s.merged.publicId, [messagingContactMerge]),
    );
    await waitForLock();
    held.open();
    expect(await replying).toBe('done');
    expect(await merging).toBe('done');
    // The reply is in the one conversation the kept contact has now.
    expect(
      await s.b.query(
        `select count(*)::int as messages from messaging.messages m
         join messaging.conversations c on c.id = m.conversation_id
         where c.contact_id = $1`,
        [s.kept.id],
      ),
    ).toEqual([{ messages: 3 }]);
  },
);

it.each(['kept', 'merged'] as const)(
  'the merge first: a reply to the %s contact waits for it, and both finish',
  async (to) => {
    const s = await scene();
    const held = gate();
    const paused = gate();
    const merging = finished(
      merge(s.b, s.kept.publicId, s.merged.publicId, [
        messagingContactMerge,
        {
          name: 'pause',
          merge: async () => {
            paused.open();
            await held.opened;
            return {};
          },
        },
      ]),
    );
    await paused.opened;
    const replying = finished(reply(s, to, { held: Promise.resolve(), paused: () => undefined }));
    await waitForLock();
    held.open();
    expect(await merging).toBe('done');
    // The merged contact's conversation is gone, and the contact is in the trash.
    expect(['done', 'NotFoundError', 'ValidationError']).toContain(await replying);
  },
);

/** Waits until some session of this database waits on a lock. */
async function waitForLock(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await world.database.as('postgres', (sql) =>
      sql.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      ),
    );
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Fixture timeout: nobody waited on a lock.');
}
