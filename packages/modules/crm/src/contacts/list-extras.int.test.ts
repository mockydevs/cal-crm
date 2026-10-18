// What a row of the contact list can also carry (last activity, tags, company) and the
// list's count, against a migrated Postgres as crm_app under row-level security. The budget
// at 100,000 contacts is list.budget.test.ts.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import {
  CONTACT_COUNT_LIMIT,
  contactCount,
  contactList,
  type ContactList,
  type ContactSummary,
} from '@repo/contracts';
import { parsePublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { seedContacts } from '../../test/contacts.js';
import { lists, type World } from '../../test/lists-boards.js';
import { activityChannel, CONTACT_ACTIVITY_EVENTS } from './extras.js';

let world: World;
beforeAll(async () => {
  world = await lists(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

const list = async (invocation: Invocation, query: Record<string, string> = {}) =>
  contactList.parse(await world.call('listContacts', invocation, { query }));
const count = async (invocation: Invocation, query: Record<string, string> = {}) =>
  contactCount.parse(await world.call('countContacts', invocation, { query }));
const row = async (
  invocation: Invocation,
  id: string,
  include: string,
): Promise<ContactSummary> => {
  const found = (await list(invocation, { include })).items.find((item) => item.id === id);
  if (found === undefined) throw new Error(`No row for ${id}`);
  return found;
};
/** Every page of a list, following next. */
async function everyPage(
  invocation: Invocation,
  query: Record<string, string>,
): Promise<ContactList['items']> {
  const items: ContactList['items'] = [];
  let after: string | null = null;
  do {
    const page: ContactList = await list(invocation, {
      ...query,
      ...(after === null ? {} : { after }),
    });
    items.push(...page.items);
    after = page.next;
  } while (after !== null);
  return items;
}
/** When the event was stored as having happened, as the API shows a time. */
async function occurredAt(eventId: string): Promise<string> {
  const stored = await world.database.as('crm_owner', (sql) =>
    sql.one<{ occurred_at: Date }>('select occurred_at from events.events where id = $1', [
      eventId,
    ]),
  );
  return stored.occurred_at.toISOString();
}

describe("a contact's last activity", () => {
  it('is null until the contact gets in touch, whatever is edited inside the CRM', async () => {
    const me = await world.inBusiness();
    const maya = await world.contact(me, 'Maya');
    expect((await row(me, maya, 'lastActivity')).lastActivity).toBeNull();

    // Edits by the team are on the timeline and are not the contact's activity.
    await world.call('updateContact', me, { params: { id: maya }, body: { lastName: 'Thompson' } });
    for (const type of ['note.created', 'tag.assigned', 'task.created', 'deal.contact_linked'])
      await world.happen(me, maya, type);
    // Neither is anything the business sends, or what becomes of it.
    for (const type of [
      'message.submitted',
      'message.sent',
      'message.delivered',
      'message.bounced',
    ])
      await world.happen(me, maya, type, { channel: 'sms' });
    expect((await row(me, maya, 'lastActivity')).lastActivity).toBeNull();
  });

  it('is the newest time the contact got in touch, with the channel it came through', async () => {
    const me = await world.inBusiness();
    const maya = await world.contact(me, 'Maya');
    // Each payload is what its module's emitter writes (messaging's sms-inbound.ts,
    // inbound.ts and webchat-public.ts, forms' public.ts, calendar's booking.ts).
    const steps = [
      ['message.received', { conversationId: randomUUID(), channel: 'sms', keyword: null }, 'sms'],
      ['message.received', { conversationId: randomUUID(), mailboxId: randomUUID() }, 'email'],
      ['message.received', { channel: 'webchat', identity: 'unverified' }, 'webchat'],
      ['form.submitted', { formId: 'form_x', outcome: 'updated' }, 'form'],
      ['appointment.booked', { calendarId: randomUUID() }, 'appointment'],
      ['appointment.rescheduled', {}, 'appointment'],
      ['appointment.cancelled', {}, 'appointment'],
      // A channel a later version adds still counts, under a name of its own.
      ['message.received', { channel: 'whatsapp' }, 'other'],
    ] as const;
    for (const [type, payload, channel] of steps) {
      const eventId = await world.happen(me, maya, type, payload);
      // An edit after it changes nothing.
      await world.happen(me, maya, 'tag.assigned');
      expect((await row(me, maya, 'lastActivity')).lastActivity).toEqual({
        at: await occurredAt(eventId),
        channel,
      });
    }
  });

  it('goes by when it happened, not by when it was stored', async () => {
    const me = await world.inBusiness();
    const maya = await world.contact(me, 'Maya');
    const recent = await world.happen(me, maya, 'form.submitted');
    // History brought in afterwards keeps its own date: an old message, stored now.
    await world.database.as('crm_owner', async (sql) => {
      const event = await sql.one<{ id: string; recorded_at: string; occurred_at: string }>(
        `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                                    subject_kind, subject_id, payload, occurred_at)
         values ($1, $2, 'message.received', 'import', uuidv7(), 'message', uuidv7(),
                 '{"channel": "sms"}', '2025-01-02T03:04:05Z')
         returning id, recorded_at::text, occurred_at::text`,
        [me.context.agencyId, me.context.businessId],
      );
      await sql.query(
        `insert into crm.timeline_entries
           (business_id, record_id, occurred_at, event_id, event_recorded_at, event_type)
         values ($1, $2, $3::timestamptz, $4, $5::timestamptz, 'message.received')`,
        [
          me.context.businessId,
          parsePublicId('contact', maya),
          event.occurred_at,
          event.id,
          event.recorded_at,
        ],
      );
    });
    expect((await row(me, maya, 'lastActivity')).lastActivity).toEqual({
      at: await occurredAt(recent),
      channel: 'form',
    });
  });

  it("gives each row of a page its own, and nothing of another business's", async () => {
    const me = await world.inBusiness();
    const other = await world.inBusiness();
    const theirs = await world.contact(other, 'Elsewhere');
    await world.happen(other, theirs, 'message.received', { channel: 'sms' });

    const expected = new Map<string, unknown>();
    for (const [index, channel] of (['sms', 'webchat', 'none', 'form'] as const).entries()) {
      const id = await world.contact(me, `Contact ${String(index)}`);
      if (channel === 'none') {
        expected.set(id, null);
        continue;
      }
      const eventId = await world.happen(
        me,
        id,
        channel === 'form' ? 'form.submitted' : 'message.received',
        { channel },
      );
      expected.set(id, { at: await occurredAt(eventId), channel });
    }
    const page = await list(me, { include: 'lastActivity' });
    expect(new Map(page.items.map((item) => [item.id, item.lastActivity]))).toEqual(expected);
    // The other business reads its own, and only its own.
    expect((await list(other, { include: 'lastActivity' })).items.map((item) => item.id)).toEqual([
      theirs,
    ]);
  });

  it('names its channel from the event alone', () => {
    expect(activityChannel('form.submitted', { channel: 'sms' })).toBe('form');
    expect(activityChannel('appointment.cancelled', {})).toBe('appointment');
    expect(activityChannel('message.received', { channel: 'email' })).toBe('email');
    expect(activityChannel('message.received', { mailboxId: 'box' })).toBe('email');
    // A channel it has no name for is never taken for an email, mailbox or not.
    expect(activityChannel('message.received', { channel: 'rcs', mailboxId: 'box' })).toBe('other');
    expect(activityChannel('message.received', {})).toBe('other');
    expect(activityChannel('message.received', { channel: 7, mailboxId: 7 })).toBe('other');
  });

  it('reads through the index that holds exactly its events', async () => {
    const [index] = await world.database.as('crm_owner', (sql) =>
      sql.query<{ predicate: string }>(
        `select pg_get_expr(indpred, indrelid) as predicate from pg_index
         where indexrelid = 'crm.timeline_entries_contact_activity_idx'::regclass`,
      ),
    );
    const named = [...(index?.predicate ?? '').matchAll(/'([a-z_.]+)'::text/g)].map(
      (match) => match[1],
    );
    expect(named.sort()).toEqual([...CONTACT_ACTIVITY_EVENTS].sort());
  });
});

describe("a row's tags and company", () => {
  it('are the tags by name and the primary company, and never one in the trash', async () => {
    const me = await world.inBusiness();
    const maya = await world.contact(me, 'Maya');
    const ken = await world.contact(me, 'Ken');
    const tag = async (name: string) => {
      const created = (await world.call('createTag', me, { body: { name } })) as { id: string };
      await world.call('assignRecordTag', me, {
        params: { id: maya, tagId: created.id },
        body: {},
      });
      return { id: created.id, name };
    };
    const wedding = await tag('Wedding');
    const corporate = await tag('corporate');
    const company = async (name: string, primary: boolean) => {
      const created = (await world.call('createCompany', me, { body: { name } })) as { id: string };
      await world.call('linkContactCompany', me, {
        params: { id: maya, companyId: created.id },
        body: { primary },
      });
      return { id: created.id, name };
    };
    await company('Second Venue Ltd', false);
    const venue = await company('Garden Venue Ltd', true);

    expect(await row(me, maya, 'tags,company')).toMatchObject({
      tags: [corporate, wedding],
      company: venue,
    });
    // A contact with neither has an empty list and no company, not a missing answer.
    expect(await row(me, ken, 'tags,company')).toMatchObject({ tags: [], company: null });

    await world.call('trashCompany', me, { params: { id: venue.id } });
    expect((await row(me, maya, 'company')).company).toBeNull();
  });
});

describe('the list without extras, and with a wrong one', () => {
  it('answers exactly the row it always did, and only what was named', async () => {
    const me = await world.inBusiness();
    const maya = await world.contact(me, 'Maya');
    await world.happen(me, maya, 'form.submitted');
    const [plain] = (await list(me)).items;
    expect(Object.keys(plain ?? {}).sort()).toEqual(['createdAt', 'email', 'id', 'name', 'phone']);
    const [named] = (await list(me, { include: 'company,lastActivity' })).items;
    expect(Object.keys(named ?? {}).sort()).toEqual([
      'company',
      'createdAt',
      'email',
      'id',
      'lastActivity',
      'name',
      'phone',
    ]);
  });

  it.each(['owner', 'lastActivity,', 'tags company', ''])('refuses include=%j', async (include) => {
    const me = await world.inBusiness();
    await expect(list(me, { include })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the count of a list', () => {
  it('is every contact not in the trash, of this business alone', async () => {
    const me = await world.inBusiness();
    const other = await world.inBusiness();
    await world.contact(other, 'Elsewhere');
    expect(await count(me)).toEqual({ count: 0, exact: true });
    const ids = [];
    for (const name of ['Maya', 'Ken', 'Amara']) ids.push(await world.contact(me, name));
    expect(await count(me)).toEqual({ count: 3, exact: true });
    await world.call('trashContact', me, { params: { id: ids[0] ?? '' } });
    expect(await count(me)).toEqual({ count: 2, exact: true });
    expect(await count(other)).toEqual({ count: 1, exact: true });
  });

  it('counts what the same search and filters list', async () => {
    const me = await world.inBusiness();
    await seedContacts(world.database, me.context.businessId ?? '', 130);
    const field = (await world.call('createField', me, {
      body: {
        objectKey: 'contact',
        key: 'budget',
        label: 'Budget',
        description: 'What they plan to spend.',
        valueType: 'number',
        currency: null,
        options: [],
        aiFillSources: [],
        aiOverwrite: 'ask',
        archived: false,
      },
    })) as { id: string };
    const all = await everyPage(me, {});
    await world.database.withTenant(me.context, async (sql) => {
      for (const [index, item] of all.slice(0, 7).entries())
        await sql.query(
          `insert into crm.field_values
             (business_id, record_id, field_id, value_type, value_number, source_kind)
           values (app.business_id(), $1, $2, 'number', $3, 'user')`,
          [parsePublicId('contact', item.id), parsePublicId('field', field.id), index * 100],
        );
    });
    const [newest, oldest] = [all[0], all.at(-1)];
    await world.call('trashContact', me, { params: { id: all[1]?.id ?? '' } });

    for (const query of [
      { q: 'first1' },
      { q: 'last77 first77' },
      { q: 'person31@' },
      { q: '0700 000 1' },
      { q: 'nobody-here' },
      { q: '...' },
      { createdFrom: oldest?.createdAt ?? '', createdBefore: newest?.createdAt ?? '' },
      { fieldId: field.id, fieldOperator: 'is_set' },
      { fieldId: field.id, fieldOperator: 'gte', fieldValue: '300' },
      { q: 'first', fieldId: field.id, fieldOperator: 'is_unset' },
    ] as const) {
      const listed = await everyPage(me, query);
      expect(await count(me, query), JSON.stringify(query)).toEqual({
        count: listed.length,
        exact: true,
      });
    }
    // The counts above are of real lists, not of nothing.
    expect(await count(me, { q: 'first1' })).toEqual({ count: 42, exact: true });
    expect(await count(me, { fieldId: field.id, fieldOperator: 'is_set' })).toEqual({
      count: 6,
      exact: true,
    });
  });

  // 10,050 contacts are written in one statement; the counts themselves are index reads.
  it('is exact for the whole list at any size, and says so when a search or filter is not counted to its end', async () => {
    const me = await world.inBusiness();
    const total = CONTACT_COUNT_LIMIT + 50;
    await seedContacts(world.database, me.context.businessId ?? '', total);
    expect(await count(me)).toEqual({ count: total, exact: true });
    const atLeast = { count: CONTACT_COUNT_LIMIT, exact: false };
    // Every contact's name starts with "first"; every one was added before tomorrow.
    expect(await count(me, { q: 'first' })).toEqual(atLeast);
    expect(await count(me, { createdBefore: '2999-01-01T00:00:00Z' })).toEqual(atLeast);
    // A search that stays under the limit is still exact beside them.
    expect(await count(me, { q: 'first99' })).toEqual({ count: 111, exact: true });
  }, 120_000);

  it.each([{ sort: 'name' }, { after: 'con_x' }, { include: 'tags' }, { fieldOperator: 'is_set' }])(
    'takes the filters only: %j is refused',
    async (query) => {
      const me = await world.inBusiness();
      await expect(count(me, query)).rejects.toBeInstanceOf(ValidationError);
    },
  );
});
