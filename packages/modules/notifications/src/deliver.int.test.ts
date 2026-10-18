// Writing a notification: who it is written for and who is left out, once per source, once
// while unread per key, and never past the ceiling.
import { randomUUID } from 'node:crypto';

import { withTenant } from '@repo/db';
import { describe, expect, it } from 'vitest';

import { atAgency, place, suite, things, toldIn, type Place } from '../test/fixtures.js';
import { BODY_LENGTH, deliver, TITLE_LENGTH, UNREAD_CEILING, type Notice } from './index.js';

const s = suite();

const notice = (recipients: readonly (string | null)[], more: Partial<Notice> = {}): Notice => ({
  kind: 'ai.limit_reached',
  recipients,
  sourceKey: `test:${randomUUID()}`,
  cause: { kind: 'system', id: null },
  subject: { kind: 'ai_settings' },
  ...more,
});
const tell = (at: Place, told: Notice) =>
  withTenant(s.db, at.system, (trx) => deliver(trx, at.system, told));

describe('a notice', () => {
  it('is written for each person it names, with what it is about and who caused it', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const { contactId, conversation } = await things(s, at);
    const conversationId = await conversation();
    const eventId = randomUUID();

    const told = await tell(
      at,
      notice([at.owner.id, dana.id], {
        kind: 'conversation.assigned',
        sourceKey: `event:${eventId}`,
        collapseKey: `conversation.assigned:${conversationId}`,
        eventId,
        cause: { kind: 'api_key', id: eventId },
        subject: { kind: 'conversation', id: conversationId },
        recordId: contactId,
      }),
    );

    expect(told.sort()).toEqual([at.owner.id, dana.id].sort());
    const rows = await toldIn(s, at);
    expect(rows.map((row) => row.user_id).sort()).toEqual([at.owner.id, dana.id].sort());
    for (const row of rows)
      expect(row).toMatchObject({
        kind: 'conversation.assigned',
        source_key: `event:${eventId}`,
        collapse_key: `conversation.assigned:${conversationId}`,
        event_id: eventId,
        actor_kind: 'api_key',
        actor_id: eventId,
        subject_kind: 'conversation',
        subject_id: conversationId,
        record_id: contactId,
        title: null,
        body: null,
        read_at: null,
      });
  });

  it('is never written for the person who caused it', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const told = await tell(
      at,
      notice([at.owner.id, dana.id], { cause: { kind: 'user', id: dana.id } }),
    );
    expect(told).toEqual([at.owner.id]);
    // Alone, they are told nothing and nothing is written.
    expect(await tell(at, notice([dana.id], { cause: { kind: 'user', id: dana.id } }))).toEqual([]);
    expect((await toldIn(s, at)).map((row) => row.user_id)).toEqual([at.owner.id]);
  });

  it('is written only for people who belong to the business, or to the agency’s staff', async () => {
    const at = await place(s);
    const elsewhere = await place(s);
    const staff = await at.join({ agency: 'member' });
    const stranger = await s.database.fixtures.user();
    const told = await tell(
      at,
      notice([at.owner.id, staff.id, elsewhere.owner.id, stranger.id, randomUUID()]),
    );
    expect(told.sort()).toEqual([at.owner.id, staff.id].sort());
    expect(await toldIn(s, elsewhere)).toEqual([]);
  });

  it('is not written for someone who was removed, or who can no longer sign in', async () => {
    const at = await place(s);
    const removed = await at.join('member');
    const disabled = await at.join('member');
    await s.database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.memberships where user_id = $1', [removed.id]),
    );
    await s.database.as('crm_auth', (sql) =>
      sql.query('update auth.users set disabled_at = now() where id = $1', [disabled.id]),
    );
    expect(await tell(at, notice([removed.id, disabled.id, at.owner.id]))).toEqual([at.owner.id]);
  });

  it('is not written for someone who turned its kind off, and is for the kinds they left on', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    await s.database.withTenant(dana.context, (sql) =>
      sql.query(
        `insert into notifications.preferences (business_id, user_id, kind, in_app)
         values ($1, $2, 'task.due', false), ($1, $2, 'task.assigned', true)`,
        [at.businessId, dana.id],
      ),
    );
    const task = { subject: { kind: 'task', id: randomUUID() } } as const;
    expect(await tell(at, notice([dana.id, at.owner.id], { ...task, kind: 'task.due' }))).toEqual([
      at.owner.id,
    ]);
    expect(await tell(at, notice([dana.id], { ...task, kind: 'task.assigned' }))).toEqual([
      dana.id,
    ]);
    // A kind they never chose about is on.
    expect(await tell(at, notice([dana.id]))).toEqual([dana.id]);
  });

  it('follows the preference of the business it happens in, not of another', async () => {
    const at = await place(s);
    const other = await s.database.fixtures.business(at.agencyId);
    const staff = await at.join({ agency: 'admin' });
    await s.database.withTenant({ ...staff.context, businessId: other.id }, (sql) =>
      sql.query(
        `insert into notifications.preferences (business_id, user_id, kind, in_app)
         values ($1, $2, 'ai.limit_reached', false)`,
        [other.id, staff.id],
      ),
    );
    expect(await tell(at, notice([staff.id]))).toEqual([staff.id]);
    const there = { ...at.system, businessId: other.id };
    expect(await withTenant(s.db, there, (trx) => deliver(trx, there, notice([staff.id])))).toEqual(
      [],
    );
  });

  it('is written once per person and source, however often its job runs', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const once = notice([at.owner.id], { sourceKey: 'event:same' });
    expect(await tell(at, once)).toEqual([at.owner.id]);
    expect(await tell(at, once)).toEqual([]);
    // The same source reaches someone it had not reached, and nobody twice.
    expect(await tell(at, { ...once, recipients: [at.owner.id, dana.id] })).toEqual([dana.id]);
    expect(await toldIn(s, at)).toHaveLength(2);
  });

  it('is written once while unread per person and key, and again once that one is read', async () => {
    const at = await place(s);
    const key = { collapseKey: 'message.received:thread' };
    expect(await tell(at, notice([at.owner.id], key))).toEqual([at.owner.id]);
    expect(await tell(at, notice([at.owner.id], key))).toEqual([]);
    // Another key, and no key at all, are told of.
    expect(await tell(at, notice([at.owner.id], { collapseKey: 'other' }))).toEqual([at.owner.id]);
    expect(await tell(at, notice([at.owner.id]))).toEqual([at.owner.id]);
    const [first] = await toldIn(s, at);
    await s.database.withTenant(at.owner.context, (sql) =>
      sql.query('update notifications.notifications set read_at = now() where id = $1', [
        first?.id,
      ]),
    );
    expect(await tell(at, notice([at.owner.id], key))).toEqual([at.owner.id]);
  });

  it('keeps its title and words to their lengths, and leaves empty ones out', async () => {
    const at = await place(s);
    const automation = {
      kind: 'automation.notice',
      subject: { kind: 'automation', id: randomUUID() },
    } as const;
    await tell(
      at,
      notice([at.owner.id], {
        ...automation,
        title: `  ${'t'.repeat(400)} `,
        body: 'b'.repeat(1200),
      }),
    );
    await tell(at, notice([at.owner.id], { ...automation, title: '  ', body: '' }));
    const [long, empty] = await toldIn(s, at);
    expect(Array.from(long?.title ?? '')).toHaveLength(TITLE_LENGTH);
    expect(long?.title?.endsWith('…')).toBe(true);
    expect(Array.from(long?.body ?? '')).toHaveLength(BODY_LENGTH);
    expect(empty).toMatchObject({ title: null, body: null });
  });

  it('leaves out a record that is gone by now, and is still written', async () => {
    const at = await place(s);
    expect(await tell(at, notice([at.owner.id], { recordId: randomUUID() }))).toEqual([
      at.owner.id,
    ]);
    // A record of another business is no record of this one.
    const elsewhere = await place(s);
    const theirs = await things(s, elsewhere);
    expect(await tell(at, notice([at.owner.id], { recordId: theirs.contactId }))).toEqual([
      at.owner.id,
    ]);
    expect((await toldIn(s, at)).map((row) => row.record_id)).toEqual([null, null]);
  });

  it('stops at the ceiling of unread notifications, and goes on once some are read', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    // The owner already holds the ceiling, written directly as the worker would.
    await s.database.withTenant(at.system, (sql) =>
      sql.query(
        `insert into notifications.notifications
           (agency_id, business_id, user_id, kind, source_key, actor_kind, subject_kind)
         select $1, $2, $3, 'ai.limit_reached', 'bulk:' || n, 'system', 'ai_settings'
         from generate_series(1, $4::int) n`,
        [at.agencyId, at.businessId, at.owner.id, UNREAD_CEILING],
      ),
    );
    expect(await tell(at, notice([at.owner.id, dana.id]))).toEqual([dana.id]);
    await s.database.withTenant(at.owner.context, (sql) =>
      sql.query(
        `update notifications.notifications set read_at = now()
         where user_id = $1 and source_key = 'bulk:1'`,
        [at.owner.id],
      ),
    );
    expect(await tell(at, notice([at.owner.id]))).toEqual([at.owner.id]);
    expect(await tell(at, notice([at.owner.id]))).toEqual([]);
  });

  it('about the agency as a whole is written for its staff only, with no business', async () => {
    const at = await place(s);
    const staff = await at.join({ agency: 'owner' });
    const agency = atAgency(at);
    const told = await withTenant(s.db, agency, (trx) =>
      deliver(trx, agency, notice([staff.id, at.owner.id])),
    );
    expect(told).toEqual([staff.id]);
    const rows = await s.database.as('crm_owner', (sql) =>
      sql.query<{ user_id: string; business_id: string | null }>(
        'select user_id, business_id from notifications.notifications where agency_id = $1',
        [at.agencyId],
      ),
    );
    expect(rows).toEqual([{ user_id: staff.id, business_id: null }]);
  });
});
