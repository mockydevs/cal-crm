// Messaging's part in a contact merge, against a migrated Postgres as crm_app: one
// conversation with every message of both and the same unread messages, consent histories
// combined with no opt-out lost, the web chat, campaign recipients and the rest, and nothing
// changed when the merge fails later.
import { createHash, randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { contactMerge, contactMergePreview } from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { contactMergeRoutes, type ContactMergeParticipant } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { messagingContactMerge } from './contact-merge.js';

let database: TestDatabase;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  services = {
    db: connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    }),
    authorize: allowEveryone,
  };
});
afterAll(async () => {
  await services.db.destroy();
  await database.close();
});

interface Space {
  readonly context: TenantContext;
  readonly owner: Invocation;
  readonly kept: string;
  readonly merged: string;
}

async function space(): Promise<Space> {
  const agency = await database.fixtures.agency();
  const { context } = await database.fixtures.business(agency.id);
  const kept = await database.fixtures.contact(context, { firstName: 'Kept' });
  const merged = await database.fixtures.contact(context, { firstName: 'Merged' });
  return {
    context,
    owner: {
      context: { ...context, actorKind: 'user', correlationId: randomUUID() },
      permissions: 'all',
    },
    kept: kept.id,
    merged: merged.id,
  };
}

/** Merges with the revisions the preview gives, as the merge dialog does. */
async function merge(where: Space, participants: readonly ContactMergeParticipant[]) {
  const routes = contactMergeRoutes({ participants });
  const route = (id: string) => routes.find((each) => each.endpoint.operationId === id);
  const id = toPublicId('contact', where.kept);
  const mergeIds = [toPublicId('contact', where.merged)];
  const preview = contactMergePreview.parse(
    await route('previewContactMerge')?.run(
      {
        invocation: where.owner,
        params: { id },
        query: { mergeIds: mergeIds.join(',') },
        body: undefined,
      },
      services,
    ),
  );
  const revisions = Object.fromEntries(preview.contacts.map((each) => [each.id, each.revision]));
  const merged = contactMerge.parse(
    await route('mergeContacts')?.run(
      { invocation: where.owner, params: { id }, query: {}, body: { mergeIds, revisions } },
      services,
    ),
  );
  return { preview, merged };
}

/** A token's digest, as the links and the chat store them. */
const digest = () => createHash('sha256').update(randomUUID()).digest('hex');

const sql = <Row extends object>(where: Space, text: string, values: unknown[] = []) =>
  database.withTenant(where.context, (each) => each.query<Row>(text, values));
const one = <Row extends object>(where: Space, text: string, values: unknown[] = []) =>
  database.withTenant(where.context, (each) => each.one<Row>(text, values));

async function account(where: Space, channel: 'sms' | 'webchat'): Promise<string> {
  return (
    await one<{ id: string }>(
      where,
      `insert into messaging.channel_accounts (business_id, channel, name)
       values (app.business_id(), $1, 'Line') returning id`,
      [channel],
    )
  ).id;
}

async function conversation(where: Space, contactId: string): Promise<string> {
  return (
    await one<{ id: string }>(
      where,
      `insert into messaging.conversations (business_id, contact_id)
       values (app.business_id(), $1) returning id`,
      [contactId],
    )
  ).id;
}

/** A message, `minutes` after a fixed start, from the contact or to them. */
async function message(
  where: Space,
  conversationId: string,
  accountId: string,
  direction: 'inbound' | 'outbound',
  minutes: number,
): Promise<void> {
  await sql(
    where,
    `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
       direction, status, body_text, author_kind, idempotency_key, created_at)
     values (app.business_id(), $1, 'sms', $2, $3, $4, $5, $6, $7,
       '2026-10-01T09:00:00Z'::timestamptz + $8 * interval '1 minute')`,
    [
      conversationId,
      accountId,
      direction,
      direction === 'inbound' ? 'received' : 'sent',
      `At ${String(minutes)}`,
      direction === 'inbound' ? 'contact' : 'user',
      direction === 'outbound' ? randomUUID() : null,
      minutes,
    ],
  );
}

const readAll = (where: Space, conversationId: string) =>
  sql(where, 'update messaging.conversations set read_through_seq = message_seq where id = $1', [
    conversationId,
  ]);

describe('conversations', () => {
  it('combines both into the kept contact’s, with the same unread messages', async () => {
    const where = await space();
    const sms = await account(where, 'sms');
    const user = await database.fixtures.user();
    const kept = await conversation(where, where.kept);
    await message(where, kept, sms, 'inbound', 1);
    await message(where, kept, sms, 'outbound', 2);
    await readAll(where, kept);
    await message(where, kept, sms, 'inbound', 5);
    await sql(where, `update messaging.conversations set status = 'closed' where id = $1`, [kept]);
    const merged = await conversation(where, where.merged);
    await message(where, merged, sms, 'inbound', 3);
    await readAll(where, merged);
    await message(where, merged, sms, 'inbound', 4);
    await sql(where, 'update messaging.conversations set assignee_user_id = $2 where id = $1', [
      merged,
      user.id,
    ]);

    const { preview, merged: result } = await merge(where, [messagingContactMerge]);

    expect(preview.moved['messaging']).toMatchObject({ conversations: 1, messages: 2 });
    expect(result.moved['messaging']).toMatchObject({ conversations: 1, messages: 2 });
    const [after, ...others] = await sql<{
      id: string;
      unread_count: number;
      needs_reply: boolean;
      status: string;
      assignee_user_id: string | null;
      last_message_at: Date;
      message_seq: string;
      read_through_seq: string;
    }>(where, 'select * from messaging.conversations where contact_id = any($1::uuid[])', [
      [where.kept, where.merged],
    ]);
    expect(others).toEqual([]);
    expect(after).toMatchObject({
      id: kept,
      unread_count: 2,
      needs_reply: true,
      // The merged contact was waiting for a reply there.
      status: 'open',
      assignee_user_id: user.id,
      last_message_at: new Date('2026-10-01T09:05:00Z'),
      message_seq: '5',
      read_through_seq: '3',
    });
    const messages = await sql<{ body_text: string; seq: string }>(
      where,
      'select body_text, seq from messaging.messages where conversation_id = $1 order by seq',
      [kept],
    );
    expect(messages).toEqual([
      { body_text: 'At 1', seq: '1' },
      { body_text: 'At 2', seq: '2' },
      { body_text: 'At 3', seq: '3' },
      { body_text: 'At 4', seq: '4' },
      { body_text: 'At 5', seq: '5' },
    ]);
  });

  it('numbers the read messages of both by time, so the last one says whether a reply is due', async () => {
    const where = await space();
    const sms = await account(where, 'sms');
    const kept = await conversation(where, where.kept);
    await message(where, kept, sms, 'inbound', 1);
    // The team answered last, after everything the merged contact wrote.
    await message(where, kept, sms, 'outbound', 5);
    await readAll(where, kept);
    const merged = await conversation(where, where.merged);
    await message(where, merged, sms, 'inbound', 3);
    await readAll(where, merged);

    await merge(where, [messagingContactMerge]);

    expect(
      await one(
        where,
        'select unread_count, needs_reply, read_through_seq from messaging.conversations where id = $1',
        [kept],
      ),
    ).toEqual({ unread_count: 0, needs_reply: false, read_through_seq: '3' });
    expect(
      await sql(
        where,
        'select body_text, seq from messaging.messages where conversation_id = $1 order by seq',
        [kept],
      ),
    ).toEqual([
      { body_text: 'At 1', seq: '1' },
      { body_text: 'At 3', seq: '2' },
      { body_text: 'At 5', seq: '3' },
    ]);
  });

  it("keeps the kept contact's status and assignee, and moves a lone conversation whole", async () => {
    const where = await space();
    const sms = await account(where, 'sms');
    const kept = await conversation(where, where.kept);
    await message(where, kept, sms, 'inbound', 1);
    await sql(where, `update messaging.conversations set status = 'closed' where id = $1`, [kept]);
    const merged = await conversation(where, where.merged);
    await message(where, merged, sms, 'outbound', 2);
    await sql(where, `update messaging.conversations set status = 'closed' where id = $1`, [
      merged,
    ]);
    await merge(where, [messagingContactMerge]);
    expect(
      await one(where, 'select status, unread_count from messaging.conversations where id = $1', [
        kept,
      ]),
    ).toEqual({ status: 'closed', unread_count: 1 });

    const alone = await space();
    const lone = await conversation(alone, alone.merged);
    await message(alone, lone, await account(alone, 'sms'), 'inbound', 1);
    const { merged: result } = await merge(alone, [messagingContactMerge]);
    expect(result.moved['messaging']).toMatchObject({ conversations: 1, messages: 0 });
    expect(
      await one(
        alone,
        'select contact_id, unread_count from messaging.conversations where id = $1',
        [lone],
      ),
    ).toEqual({ contact_id: alone.kept, unread_count: 1 });
  });
});

describe('consent', () => {
  const record = (
    where: Space,
    contactId: string,
    channel: string,
    status: string,
    daysAgo: number,
  ) =>
    sql(
      where,
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source,
         proof, recorded_at, recorded_by_kind)
       values (app.business_id(), $1, $2, 'marketing', $3, 'user', '{"note": "asked"}',
         now() - $4 * interval '1 day', 'user')`,
      [contactId, channel, status, daysAgo],
    );

  it('copies the history onto the kept contact, and keeps any withdrawal', async () => {
    const where = await space();
    await record(where, where.kept, 'email', 'withdrawn', 2);
    await record(where, where.merged, 'email', 'granted', 1);
    await record(where, where.merged, 'sms', 'granted', 1);

    const { merged: result } = await merge(where, [messagingContactMerge]);

    expect(result.moved['messaging']).toMatchObject({ consents: 2 });
    const rows = await sql<{ channel: string; status: string; proof: Record<string, string> }>(
      where,
      `select channel, status, proof from messaging.consents where contact_id = $1
       order by recorded_at, id`,
      [where.kept],
    );
    const mergedFrom = toPublicId('contact', where.merged);
    expect(rows).toEqual([
      { channel: 'email', status: 'withdrawn', proof: { note: 'asked' } },
      { channel: 'email', status: 'granted', proof: { note: 'asked', mergedFrom } },
      { channel: 'sms', status: 'granted', proof: { note: 'asked', mergedFrom } },
      // The newer grant would have won; the withdrawal is said again so it doesn't.
      { channel: 'email', status: 'withdrawn', proof: { mergedFrom } },
    ]);
    // The merged contact's own rows stay, as the ledger is never changed.
    expect(
      await one(
        where,
        'select count(*)::int as count from messaging.consents where contact_id = $1',
        [where.merged],
      ),
    ).toEqual({ count: 2 });
  });

  it('adds nothing when the merged history already ends withdrawn', async () => {
    const where = await space();
    await record(where, where.kept, 'email', 'granted', 2);
    await record(where, where.merged, 'email', 'withdrawn', 1);
    await merge(where, [messagingContactMerge]);
    expect(
      await sql(
        where,
        'select status from messaging.consents where contact_id = $1 order by recorded_at',
        [where.kept],
      ),
    ).toEqual([{ status: 'granted' }, { status: 'withdrawn' }]);
  });
});

describe('web chat', () => {
  async function chat(where: Space, widget: string, contactId: string, conversationId: string) {
    return (
      await one<{ id: string }>(
        where,
        `insert into messaging.webchat_sessions
           (business_id, widget_id, token_digest, origin, expires_at, contact_id, conversation_id)
         values (app.business_id(), $1, $2, 'https://www.example.com', now() + interval '1 day',
           $3, $4) returning id`,
        [widget, digest(), contactId, conversationId],
      )
    ).id;
  }
  async function widget(where: Space): Promise<string> {
    const id = await account(where, 'webchat');
    await sql(
      where,
      `insert into messaging.webchat_widgets (business_id, id, public_key, allowed_origins)
       values (app.business_id(), $1, $2, '{https://www.example.com}')`,
      [id, `pk-${randomUUID()}`],
    );
    return id;
  }

  it("moves the merged contact's chat into the kept conversation when it has none", async () => {
    const where = await space();
    const chats = await widget(where);
    const kept = await conversation(where, where.kept);
    const merged = await conversation(where, where.merged);
    const session = await chat(where, chats, where.merged, merged);
    const { merged: result } = await merge(where, [messagingContactMerge]);
    expect(result.moved['messaging']).toMatchObject({ webchatSessions: 1 });
    expect(
      await one(
        where,
        'select contact_id, conversation_id from messaging.webchat_sessions where id = $1',
        [session],
      ),
    ).toEqual({ contact_id: where.kept, conversation_id: kept });
  });

  it("ends the merged contact's chat when the kept one has its own, and moves claims", async () => {
    const where = await space();
    const chats = await widget(where);
    const kept = await chat(where, chats, where.kept, await conversation(where, where.kept));
    const merged = await chat(where, chats, where.merged, await conversation(where, where.merged));
    const stranger = await database.fixtures.contact(where.context, { firstName: 'Stranger' });
    const claiming = await chat(where, chats, stranger.id, await conversation(where, stranger.id));
    await sql(
      where,
      'update messaging.webchat_sessions set claimed_contact_id = $2 where id = $1',
      [claiming, where.merged],
    );
    await sql(
      where,
      'update messaging.webchat_sessions set claimed_contact_id = $2 where id = $1',
      [kept, where.merged],
    );
    const { merged: result } = await merge(where, [messagingContactMerge]);
    expect(result.moved['messaging']).toMatchObject({ webchatSessions: 0 });
    expect(
      await sql(
        where,
        'select id, claimed_contact_id from messaging.webchat_sessions where id = any($1::uuid[]) order by id',
        [[kept, merged, claiming]],
      ),
    ).toEqual(
      [
        { id: kept, claimed_contact_id: null },
        { id: claiming, claimed_contact_id: where.kept },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

describe('campaign recipients and the rest', () => {
  async function campaign(where: Space): Promise<string> {
    return (
      await one<{ id: string }>(
        where,
        `insert into messaging.email_campaigns (business_id, name, created_by_kind)
         values (app.business_id(), 'Fall sale', 'user') returning id`,
      )
    ).id;
  }
  const recipient = (where: Space, campaignId: string, contactId: string, status: string) =>
    sql(
      where,
      `insert into messaging.email_campaign_recipients
         (business_id, campaign_id, contact_id, status, released_at)
       values (app.business_id(), $1, $2, $3, case when $3 = 'pending' then null else now() end)`,
      [campaignId, contactId, status],
    );
  const recipients = (where: Space, campaignId: string) =>
    sql(
      where,
      `select contact_id, status, reason from messaging.email_campaign_recipients
       where campaign_id = $1 order by contact_id = $2 desc`,
      [campaignId, where.kept],
    );

  it('keeps the recipient further along, so nobody is mailed twice', async () => {
    const where = await space();
    const ahead = await campaign(where);
    await recipient(where, ahead, where.kept, 'pending');
    await recipient(where, ahead, where.merged, 'sent');
    const behind = await campaign(where);
    await recipient(where, behind, where.kept, 'sent');
    await recipient(where, behind, where.merged, 'pending');
    const alone = await campaign(where);
    await recipient(where, alone, where.merged, 'queued');

    const { merged: result } = await merge(where, [messagingContactMerge]);

    expect(result.moved['messaging']).toMatchObject({ campaignRecipients: 1 });
    expect(await recipients(where, ahead)).toEqual([
      { contact_id: where.kept, status: 'sent', reason: null },
      { contact_id: where.merged, status: 'skipped', reason: 'contact_removed' },
    ]);
    expect(await recipients(where, behind)).toEqual([
      { contact_id: where.kept, status: 'sent', reason: null },
      { contact_id: where.merged, status: 'skipped', reason: 'contact_removed' },
    ]);
    expect(await recipients(where, alone)).toEqual([
      { contact_id: where.kept, status: 'queued', reason: null },
    ]);
  });

  it('moves trigger links, their clicks and unsubscribe links', async () => {
    const where = await space();
    const link = await one<{ id: string }>(
      where,
      `insert into messaging.trigger_links (business_id, name, key, url, created_by_kind)
       values (app.business_id(), 'Offer', 'offer', 'https://harbor.example/', 'user') returning id`,
    );
    const token = await one<{ id: string }>(
      where,
      `insert into messaging.trigger_link_tokens (business_id, link_id, contact_id, digest)
       values (app.business_id(), $1, $2, $3) returning id`,
      [link.id, where.merged, digest()],
    );
    await sql(
      where,
      `insert into messaging.trigger_link_clicks (business_id, link_id, token_id, contact_id)
       values (app.business_id(), $1, $2, $3)`,
      [link.id, token.id, where.merged],
    );
    await sql(
      where,
      `insert into messaging.unsubscribe_links (business_id, address_normalized, digest, contact_id)
       values (app.business_id(), 'merged@example.com', $1, $2)`,
      [digest(), where.merged],
    );

    const { preview, merged: result } = await merge(where, [messagingContactMerge]);

    const plain = { triggerLinkTokens: 1, triggerLinkClicks: 1, unsubscribeLinks: 1, calls: 0 };
    expect(preview.moved['messaging']).toMatchObject(plain);
    expect(result.moved['messaging']).toMatchObject(plain);
    expect(
      await one(
        where,
        `select (select count(*)::int from messaging.trigger_link_tokens where contact_id = $1) as tokens,
           (select count(*)::int from messaging.trigger_link_clicks where contact_id = $1) as clicks,
           (select count(*)::int from messaging.unsubscribe_links where contact_id = $1) as links`,
        [where.kept],
      ),
    ).toEqual({ tokens: 1, clicks: 1, links: 1 });
  });
});

it('leaves everything where it was when the merge fails after it', async () => {
  const where = await space();
  const sms = await account(where, 'sms');
  const kept = await conversation(where, where.kept);
  await message(where, kept, sms, 'inbound', 1);
  const merged = await conversation(where, where.merged);
  await message(where, merged, sms, 'inbound', 2);
  const failing: ContactMergeParticipant = {
    name: 'failing',
    merge: () => Promise.reject(new Error('A later module failed.')),
  };
  await expect(merge(where, [messagingContactMerge, failing])).rejects.toThrow(
    'A later module failed.',
  );
  expect(
    await sql(
      where,
      `select c.contact_id, count(m.id)::int as messages from messaging.conversations c
       join messaging.messages m on m.conversation_id = c.id
       where c.id = any($1::uuid[]) group by c.contact_id order by c.contact_id = $2 desc`,
      [[kept, merged], where.kept],
    ),
  ).toEqual([
    { contact_id: where.kept, messages: 1 },
    { contact_id: where.merged, messages: 1 },
  ]);
});
