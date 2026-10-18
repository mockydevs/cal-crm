// Which events tell whom: each source, read from a real event about a real conversation,
// task, form or appointment.
import { randomUUID } from 'node:crypto';

import { notificationKinds } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  atAgency,
  event,
  place,
  suite,
  things,
  toldIn,
  whoWasTold,
  type Place,
} from '../test/fixtures.js';
import { NOTIFICATION_EVENT_TYPES, notifyOfEvent } from './index.js';

const s = suite();

/** Runs the job's work for one event, as the worker does, and gives how many were told. */
const run = (at: Place, eventId: string) =>
  withTenant(s.db, at.system, (trx) => notifyOfEvent(trx, at.system, eventId));

const sorted = (pairs: [string, string][]) =>
  [...pairs].sort(([kindA, userA], [kindB, userB]) =>
    `${kindA}:${userA}`.localeCompare(`${kindB}:${userB}`),
  );

describe('the lists the database and the code share', () => {
  it('name the same event types, in the same order', async () => {
    const { types } = await s.database.as('crm_app', (sql) =>
      sql.one<{ types: string[] }>('select private.notification_event_types() as types'),
    );
    expect(NOTIFICATION_EVENT_TYPES).toEqual(types);
  });

  it('name the same kinds as the contract, for a notification and for a preference', async () => {
    const checks = await s.database.as('crm_owner', (sql) =>
      sql.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
         where conname in ('notifications_kind_valid', 'preferences_kind_valid')`,
      ),
    );
    expect(checks).toHaveLength(2);
    for (const { definition } of checks)
      expect([...definition.matchAll(/'([a-z_.]+)'::text/g)].map((match) => match[1])).toEqual([
        ...notificationKinds,
      ]);
  });
});

describe('a conversation assigned', () => {
  it('tells the person it was assigned to, about the conversation and its contact', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const { contactId, conversation } = await things(s, at);
    const conversationId = await conversation(dana.id);
    const eventId = await event(s, at, 'conversation.assigned', {
      subject: { kind: 'conversation', id: conversationId },
      payload: { assignedUserId: dana.id },
      actor: { kind: 'user', id: at.owner.id },
    });

    expect(await run(at, eventId)).toBe(1);
    expect(await toldIn(s, at)).toEqual([
      expect.objectContaining({
        user_id: dana.id,
        kind: 'conversation.assigned',
        source_key: `event:${eventId}`,
        event_id: eventId,
        actor_kind: 'user',
        actor_id: at.owner.id,
        subject_kind: 'conversation',
        subject_id: conversationId,
        record_id: contactId,
        title: null,
        body: null,
      }),
    ]);
  });

  it('tells nobody when someone takes it themselves', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const conversationId = await (await things(s, at)).conversation(dana.id);
    const eventId = await event(s, at, 'conversation.assigned', {
      subject: { kind: 'conversation', id: conversationId },
      payload: { assignedUserId: dana.id },
      actor: { kind: 'user', id: dana.id },
    });
    expect(await run(at, eventId)).toBe(0);
    expect(await toldIn(s, at)).toEqual([]);
  });

  it('tells nobody when it has changed hands again by the time the job runs', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const sam = await at.join('member');
    const conversationId = await (await things(s, at)).conversation(sam.id);
    // The first event gave it to Dana; a later one gave it to Sam, who has it now.
    const first = await event(s, at, 'conversation.assigned', {
      subject: { kind: 'conversation', id: conversationId },
      payload: { assignedUserId: dana.id },
      actor: { kind: 'user', id: at.owner.id },
    });
    const second = await event(s, at, 'conversation.assigned', {
      subject: { kind: 'conversation', id: conversationId },
      payload: { assignedUserId: sam.id },
      actor: { kind: 'user', id: at.owner.id },
    });
    expect(await run(at, first)).toBe(0);
    expect(await run(at, second)).toBe(1);
    expect(await whoWasTold(s, at)).toEqual([['conversation.assigned', sam.id]]);
  });

  it.each([
    ['says nobody was assigned', {}],
    ['names something that is no id of ours', { assignedUserId: 'mem_01h455vb4pex5vsknk084sn02q' }],
  ])('tells nobody when the event %s', async (_name, payload) => {
    const at = await place(s);
    const conversationId = await (await things(s, at)).conversation(at.owner.id);
    const eventId = await event(s, at, 'conversation.assigned', {
      subject: { kind: 'conversation', id: conversationId },
      payload,
    });
    expect(await run(at, eventId)).toBe(0);
  });

  it('tells nobody about a conversation that is no longer there', async () => {
    const at = await place(s);
    const eventId = await event(s, at, 'conversation.assigned', {
      subject: { kind: 'conversation', id: randomUUID() },
      payload: { assignedUserId: at.owner.id },
    });
    expect(await run(at, eventId)).toBe(0);
  });
});

describe('a message received', () => {
  it('tells its conversation’s assignee one way, and everyone else who works conversations another', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const admin = await at.join('admin');
    const viewer = await at.join('viewer');
    const staff = await at.join({ agency: 'member' });
    const support = await at.join({ custom: ['conversations.reply'] });
    const bookkeeper = await at.join({ custom: ['deals.manage'] });
    const { contactId, conversation } = await things(s, at);
    const conversationId = await conversation(dana.id);
    const eventId = await event(s, at, 'message.received', {
      subject: { kind: 'message', id: randomUUID() },
      payload: { conversationId, channel: 'sms' },
      actor: { kind: 'contact', id: contactId },
    });

    expect(await run(at, eventId)).toBe(5);
    expect(await whoWasTold(s, at)).toEqual(
      sorted([
        ['message.received', dana.id],
        ['message.received_other', at.owner.id],
        ['message.received_other', admin.id],
        ['message.received_other', staff.id],
        ['message.received_other', support.id],
      ]),
    );
    // Not the viewer, who can do nothing with a conversation, nor someone whose role is
    // about something else.
    const told = (await toldIn(s, at)).map((row) => row.user_id);
    expect(told).not.toContain(viewer.id);
    expect(told).not.toContain(bookkeeper.id);
    for (const row of await toldIn(s, at))
      expect(row).toMatchObject({
        subject_kind: 'conversation',
        subject_id: conversationId,
        record_id: contactId,
        collapse_key: `message.received:${conversationId}`,
        actor_kind: 'contact',
        title: null,
        body: null,
      });
  });

  it('tells the contact’s followers who work conversations as followers, and each person once', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const eli = await at.join('member');
    const viewer = await at.join('viewer');
    const { contactId, conversation } = await things(s, at);
    const conversationId = await conversation(dana.id);
    // Dana has the conversation and follows too; Eli and the viewer follow.
    await s.database.as('crm_owner', async (sql) => {
      for (const userId of [dana.id, eli.id, viewer.id])
        await sql.query(
          `insert into crm.contact_followers (business_id, contact_id, user_id, added_by_kind)
           values ($1, $2, $3, 'system')`,
          [at.businessId, contactId, userId],
        );
    });
    const message = () =>
      event(s, at, 'message.received', {
        subject: { kind: 'message', id: randomUUID() },
        payload: { conversationId, channel: 'sms' },
        actor: { kind: 'contact', id: contactId },
      });

    expect(await run(at, await message())).toBe(3);
    expect(await whoWasTold(s, at)).toEqual(
      sorted([
        ['message.received', dana.id],
        ['message.received_following', eli.id],
        ['message.received_other', at.owner.id],
      ]),
    );
    // Not the viewer, who follows but can do nothing with a conversation.
    expect((await toldIn(s, at)).map((row) => row.user_id)).not.toContain(viewer.id);

    // A follower who turned the following kind off hears of it as anyone else would.
    await s.database.as('crm_owner', (sql) =>
      sql.query(
        `insert into notifications.preferences (business_id, user_id, kind, in_app)
         values ($1, $2, 'message.received_following', false)`,
        [at.businessId, eli.id],
      ),
    );
    await s.database.as('crm_owner', (sql) =>
      sql.query('update notifications.notifications set read_at = now() where business_id = $1', [
        at.businessId,
      ]),
    );
    expect(await run(at, await message())).toBe(3);
    const latest = (await toldIn(s, at)).filter((row) => row.read_at === null);
    expect(latest.find((row) => row.user_id === eli.id)?.kind).toBe('message.received_other');
  });

  it('tells everyone who works conversations when the conversation is nobody’s yet', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const conversationId = await (await things(s, at)).conversation(null);
    const eventId = await event(s, at, 'message.received', {
      subject: { kind: 'message', id: randomUUID() },
      payload: { conversationId },
    });
    expect(await run(at, eventId)).toBe(2);
    expect(await whoWasTold(s, at)).toEqual(
      sorted([
        ['message.received_other', at.owner.id],
        ['message.received_other', dana.id],
      ]),
    );
  });

  it('tells each person once per conversation while they have not looked, however many arrive', async () => {
    const at = await place(s);
    const { conversation } = await things(s, at);
    const conversationId = await conversation(at.owner.id);
    const other = await conversation(at.owner.id);
    const message = (id: string) =>
      event(s, at, 'message.received', {
        subject: { kind: 'message', id: randomUUID() },
        payload: { conversationId: id },
      });
    expect(await run(at, await message(conversationId))).toBe(1);
    expect(await run(at, await message(conversationId))).toBe(0);
    expect(await run(at, await message(conversationId))).toBe(0);
    // Another conversation is told of.
    expect(await run(at, await message(other))).toBe(1);
    // Once the first is read, the next message there is told of again.
    const [first] = await toldIn(s, at);
    await s.database.withTenant(at.owner.context, (sql) =>
      sql.query('update notifications.notifications set read_at = now() where id = $1', [
        first?.id,
      ]),
    );
    expect(await run(at, await message(conversationId))).toBe(1);
    expect(await toldIn(s, at)).toHaveLength(3);
  });

  it('respects each person’s own choice for each of the two kinds', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const off = (person: { id: string; context: Place['system'] }, kind: string) =>
      s.database.withTenant(person.context, (sql) =>
        sql.query(
          `insert into notifications.preferences (business_id, user_id, kind, in_app)
           values ($1, $2, $3, false)`,
          [at.businessId, person.id, kind],
        ),
      );
    // The owner hears nothing of other people's conversations; Dana nothing of her own.
    await off(at.owner, 'message.received_other');
    await off(dana, 'message.received');
    const conversationId = await (await things(s, at)).conversation(dana.id);
    const eventId = await event(s, at, 'message.received', {
      subject: { kind: 'message', id: randomUUID() },
      payload: { conversationId },
    });
    expect(await run(at, eventId)).toBe(0);
    expect(await toldIn(s, at)).toEqual([]);
  });

  it.each([
    ['names no conversation', {}],
    ['names a conversation that is not there', { conversationId: randomUUID() }],
  ])('tells nobody when the event %s', async (_name, payload) => {
    const at = await place(s);
    const eventId = await event(s, at, 'message.received', {
      subject: { kind: 'message', id: randomUUID() },
      payload,
    });
    expect(await run(at, eventId)).toBe(0);
  });
});

describe('a task assigned', () => {
  it.each(['task.created', 'task.updated'])(
    'by %s tells the person it was given to, with the task’s title and record',
    async (type) => {
      const at = await place(s);
      const dana = await at.join('member');
      const { contactId, task } = await things(s, at);
      const taskId = await task({ assignee: dana.id, title: 'Send the quote' });
      const eventId = await event(s, at, type, {
        subject: { kind: 'task', id: taskId },
        payload: { recordId: null, assignedUserId: dana.id },
        actor: { kind: 'user', id: at.owner.id },
      });
      expect(await run(at, eventId)).toBe(1);
      expect(await toldIn(s, at)).toEqual([
        expect.objectContaining({
          user_id: dana.id,
          kind: 'task.assigned',
          subject_kind: 'task',
          subject_id: taskId,
          record_id: contactId,
          title: 'Send the quote',
          body: null,
          actor_kind: 'user',
          actor_id: at.owner.id,
        }),
      ]);
    },
  );

  it('tells nobody of a task someone gave themselves, or of an edit that assigned nobody', async () => {
    const at = await place(s);
    const { task } = await things(s, at);
    const own = await task({ assignee: at.owner.id });
    const selfAssigned = await event(s, at, 'task.created', {
      subject: { kind: 'task', id: own },
      payload: { assignedUserId: at.owner.id },
      actor: { kind: 'user', id: at.owner.id },
    });
    // An edit of the title: the task still has its assignee, and the event names nobody.
    const edited = await event(s, at, 'task.updated', {
      subject: { kind: 'task', id: own },
      payload: { recordId: null },
      actor: { kind: 'user', id: (await at.join('admin')).id },
    });
    expect(await run(at, selfAssigned)).toBe(0);
    expect(await run(at, edited)).toBe(0);
  });

  it('tells nobody of a task that is done, gone or someone else’s by the time the job runs', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const { task } = await things(s, at);
    const told = async (taskId: string) =>
      run(
        at,
        await event(s, at, 'task.created', {
          subject: { kind: 'task', id: taskId },
          payload: { assignedUserId: dana.id },
        }),
      );
    expect(await told(await task({ assignee: dana.id, completed: true }))).toBe(0);
    expect(await told(randomUUID())).toBe(0);
    expect(await told(await task({ assignee: at.owner.id }))).toBe(0);
    expect(await told(await task({ assignee: dana.id, recordId: null }))).toBe(1);
    expect((await toldIn(s, at)).map((row) => row.record_id)).toEqual([null]);
  });

  it('tells a person whose task an automation or an API key made', async () => {
    const at = await place(s);
    const taskId = await (await things(s, at)).task({ assignee: at.owner.id });
    for (const kind of ['automation', 'api_key'] as const) {
      const eventId = await event(s, at, 'task.updated', {
        subject: { kind: 'task', id: taskId },
        payload: { assignedUserId: at.owner.id },
        // Even carrying the person's own id, only a person causes as a person.
        actor: { kind, id: at.owner.id },
      });
      expect(await run(at, eventId)).toBe(kind === 'automation' ? 1 : 0);
    }
    // The second is the same task, still unread: told once.
    expect(await whoWasTold(s, at)).toEqual([['task.assigned', at.owner.id]]);
  });
});

describe('an appointment', () => {
  it.each(['appointment.booked', 'appointment.rescheduled', 'appointment.cancelled'])(
    '%s tells the team member it is with, under the calendar’s name',
    async (type) => {
      const at = await place(s);
      const dana = await at.join('member');
      const { contactId, appointment } = await things(s, at);
      const appointmentId = await appointment(dana.id);
      const eventId = await event(s, at, type, {
        subject: { kind: 'appointment', id: appointmentId },
        payload: { contactId },
        actor: { kind: 'contact', id: contactId },
      });
      expect(await run(at, eventId)).toBe(1);
      expect(await toldIn(s, at)).toEqual([
        expect.objectContaining({
          user_id: dana.id,
          kind: type,
          subject_kind: 'appointment',
          subject_id: appointmentId,
          record_id: contactId,
          title: 'Consultations',
          collapse_key: type === 'appointment.booked' ? null : `${type}:${appointmentId}`,
        }),
      ]);
    },
  );

  it('with nobody assigned tells the people who manage calendars', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const admin = await at.join('admin');
    const appointmentId = await (await things(s, at)).appointment(null);
    const eventId = await event(s, at, 'appointment.booked', {
      subject: { kind: 'appointment', id: appointmentId },
    });
    expect(await run(at, eventId)).toBe(2);
    expect(await whoWasTold(s, at)).toEqual(
      sorted([
        ['appointment.booked', at.owner.id],
        ['appointment.booked', admin.id],
      ]),
    );
    expect((await toldIn(s, at)).map((row) => row.user_id)).not.toContain(dana.id);
  });

  it('tells of every booking, and once of a move nobody has looked at', async () => {
    const at = await place(s);
    const { appointment } = await things(s, at);
    const first = await appointment(at.owner.id);
    const second = await appointment(at.owner.id);
    const said = async (type: string, id: string) =>
      run(at, await event(s, at, type, { subject: { kind: 'appointment', id } }));
    expect(await said('appointment.booked', first)).toBe(1);
    expect(await said('appointment.booked', second)).toBe(1);
    expect(await said('appointment.rescheduled', first)).toBe(1);
    expect(await said('appointment.rescheduled', first)).toBe(0);
    expect(await said('appointment.cancelled', first)).toBe(1);
  });

  it('that is no longer there tells nobody, and nor does the person who moved their own', async () => {
    const at = await place(s);
    const gone = await event(s, at, 'appointment.cancelled', {
      subject: { kind: 'appointment', id: randomUUID() },
    });
    expect(await run(at, gone)).toBe(0);
    const own = await (await things(s, at)).appointment(at.owner.id);
    const moved = await event(s, at, 'appointment.rescheduled', {
      subject: { kind: 'appointment', id: own },
      actor: { kind: 'user', id: at.owner.id },
    });
    expect(await run(at, moved)).toBe(0);
  });
});

describe('a form submitted', () => {
  it('tells the people who manage forms, under the form’s name, about the contact it reached', async () => {
    const at = await place(s);
    const admin = await at.join('admin');
    const member = await at.join('member');
    const frontDesk = await at.join({ custom: ['forms.manage'] });
    const { contactId, form } = await things(s, at);
    const formId = await form('Wedding enquiry');
    const eventId = await event(s, at, 'form.submitted', {
      subject: { kind: 'form_submission', id: randomUUID() },
      payload: { formId, submissionId: randomUUID(), contactId },
      actor: { kind: 'form', id: formId },
    });
    expect(await run(at, eventId)).toBe(3);
    expect(await whoWasTold(s, at)).toEqual(
      sorted([
        ['form.submitted', at.owner.id],
        ['form.submitted', admin.id],
        ['form.submitted', frontDesk.id],
      ]),
    );
    const rows = await toldIn(s, at);
    expect(rows.map((row) => row.user_id)).not.toContain(member.id);
    for (const row of rows)
      expect(row).toMatchObject({
        subject_kind: 'form',
        subject_id: formId,
        record_id: contactId,
        title: 'Wedding enquiry',
        body: null,
        collapse_key: `form.submitted:${formId}`,
        actor_kind: 'form',
        actor_id: formId,
      });
  });

  it('tells each person once per form while they have not looked, and names no contact when it reached none', async () => {
    const at = await place(s);
    const { form } = await things(s, at);
    const formId = await form();
    const submitted = () =>
      event(s, at, 'form.submitted', {
        subject: { kind: 'form_submission', id: randomUUID() },
        payload: { formId, submissionId: randomUUID() },
      });
    expect(await run(at, await submitted())).toBe(1);
    expect(await run(at, await submitted())).toBe(0);
    expect((await toldIn(s, at)).map((row) => row.record_id)).toEqual([null]);
  });

  it.each([
    ['names no form', {}],
    ['names a form that is not there', { formId: randomUUID() }],
  ])('tells nobody when the event %s', async (_name, payload) => {
    const at = await place(s);
    const eventId = await event(s, at, 'form.submitted', {
      subject: { kind: 'form_submission', id: randomUUID() },
      payload,
    });
    expect(await run(at, eventId)).toBe(0);
  });
});

describe('the AI spending limit reached', () => {
  it('tells the people who manage AI, in the business and on the agency’s staff', async () => {
    const at = await place(s);
    const admin = await at.join('admin');
    const member = await at.join('member');
    const agencyOwner = await at.join({ agency: 'owner' });
    const agencyMember = await at.join({ agency: 'member' });
    const eventId = await event(s, at, 'ai_settings.limit_reached', {
      subject: { kind: 'business', id: at.businessId },
      payload: { atLimit: 'pause' },
    });
    expect(await run(at, eventId)).toBe(3);
    expect(await whoWasTold(s, at)).toEqual(
      sorted([
        ['ai.limit_reached', at.owner.id],
        ['ai.limit_reached', admin.id],
        ['ai.limit_reached', agencyOwner.id],
      ]),
    );
    const rows = await toldIn(s, at);
    expect(rows.map((row) => row.user_id)).not.toContain(member.id);
    expect(rows.map((row) => row.user_id)).not.toContain(agencyMember.id);
    for (const row of rows)
      expect(row).toMatchObject({
        subject_kind: 'ai_settings',
        subject_id: null,
        record_id: null,
        title: null,
        actor_kind: 'system',
      });
  });
});

describe('any other event', () => {
  it('tells nobody: one of a type that is not listed, one that is not there, one of another business', async () => {
    const at = await place(s);
    const elsewhere = await place(s);
    const conversationId = await (await things(s, at)).conversation(at.owner.id);
    const unlisted = await event(s, at, 'conversation.unassigned', {
      subject: { kind: 'conversation', id: conversationId },
      payload: { assignedUserId: at.owner.id },
    });
    expect(await run(at, unlisted)).toBe(0);
    expect(await run(at, randomUUID())).toBe(0);

    const theirs = await event(s, elsewhere, 'ai_settings.limit_reached', {
      subject: { kind: 'business', id: elsewhere.businessId },
    });
    // Run where it does not belong: in another business, and at the agency.
    expect(await run(at, theirs)).toBe(0);
    const agency = atAgency(elsewhere);
    expect(await withTenant(s.db, agency, (trx) => notifyOfEvent(trx, agency, theirs))).toBe(0);
    expect(await toldIn(s, at)).toEqual([]);
    expect(await toldIn(s, elsewhere)).toEqual([]);
  });
});

describe('a form that says who is told of a submission', () => {
  /** A published form whose definition names who is told, as the forms module stores it. */
  async function formTelling(at: Place, notify: unknown, name = 'Wedding enquiry') {
    const { contactId, form } = await things(s, at);
    const formId = await form(name);
    const definition = JSON.stringify({ fields: [], ...(notify === undefined ? {} : { notify }) });
    await s.database.withTenant(at.system, (sql) =>
      sql.query(
        `update forms.forms
         set status = 'published', published_definition = $2::jsonb, published_at = now()
         where id = $1`,
        [formId, definition],
      ),
    );
    return { contactId, formId };
  }
  const submitted = (at: Place, formId: string, contactId?: string) =>
    event(s, at, 'form.submitted', {
      subject: { kind: 'form_submission', id: randomUUID() },
      payload: {
        formId,
        submissionId: randomUUID(),
        ...(contactId === undefined ? {} : { contactId }),
      },
      actor: { kind: 'form', id: formId },
    });
  const membershipOf = async (at: Place, userId: string): Promise<string> => {
    const { id } = await s.database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        'select id from tenancy.memberships where user_id = $1 and agency_id = $2',
        [userId, at.agencyId],
      ),
    );
    return toPublicId('membership', id);
  };
  const told = async (at: Place) => (await whoWasTold(s, at)).map(([, userId]) => userId);

  it('tells the people who manage forms when it names them, or names nothing it can read', async () => {
    for (const notify of [{ mode: 'managers' }, undefined, { mode: 'everyone' }, 'nobody']) {
      const at = await place(s);
      const member = await at.join('member');
      const { contactId, formId } = await formTelling(at, notify);
      expect(await run(at, await submitted(at, formId, contactId))).toBe(1);
      expect(await told(at)).toEqual([at.owner.id]);
      expect(await told(at)).not.toContain(member.id);
    }
  });

  it('tells nobody when it says so', async () => {
    const at = await place(s);
    await at.join('admin');
    const { contactId, formId } = await formTelling(at, { mode: 'nobody' });
    expect(await run(at, await submitted(at, formId, contactId))).toBe(0);
    expect(await told(at)).toEqual([]);
  });

  it('tells the owner of the contact it reached, whatever their role', async () => {
    const at = await place(s);
    const dana = await at.join('viewer');
    const { contactId, formId } = await formTelling(at, { mode: 'contact_owner' });
    await s.database.withTenant(at.system, (sql) =>
      sql.query('update crm.contacts set owner_user_id = $2 where id = $1', [contactId, dana.id]),
    );
    expect(await run(at, await submitted(at, formId, contactId))).toBe(1);
    expect(await told(at)).toEqual([dana.id]);
    const [row] = await toldIn(s, at);
    expect(row).toMatchObject({
      kind: 'form.submitted',
      subject_kind: 'form',
      subject_id: formId,
      record_id: contactId,
      title: 'Wedding enquiry',
      collapse_key: `form.submitted:${formId}`,
    });
  });

  it('tells the people who manage forms instead when the contact has no owner, the owner has left, or no contact was reached', async () => {
    // Nobody owns the contact.
    const unowned = await place(s);
    const first = await formTelling(unowned, { mode: 'contact_owner' });
    expect(await run(unowned, await submitted(unowned, first.formId, first.contactId))).toBe(1);
    expect(await told(unowned)).toEqual([unowned.owner.id]);

    // The owner is no longer on the team: they are not told of a business they left.
    const left = await place(s);
    const gone = await left.join('member');
    const second = await formTelling(left, { mode: 'contact_owner' });
    await s.database.withTenant(left.system, (sql) =>
      sql.query('update crm.contacts set owner_user_id = $2 where id = $1', [
        second.contactId,
        gone.id,
      ]),
    );
    await s.database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.memberships where user_id = $1', [gone.id]),
    );
    expect(await run(left, await submitted(left, second.formId, second.contactId))).toBe(1);
    expect(await told(left)).toEqual([left.owner.id]);

    // The details matched no single contact: the submission is still somebody's to read.
    const unresolved = await place(s);
    const third = await formTelling(unresolved, { mode: 'contact_owner' });
    expect(await run(unresolved, await submitted(unresolved, third.formId))).toBe(1);
    expect(await told(unresolved)).toEqual([unresolved.owner.id]);
  });

  it('tells the people it lists while each is on the team, the agency’s staff included, and nobody else', async () => {
    const at = await place(s);
    const admin = await at.join('admin');
    const sam = await at.join('member');
    const dana = await at.join('viewer');
    const gone = await at.join('member');
    const staff = await at.join({ agency: 'member' });
    // Someone on another team altogether is not on this one, whatever the form lists.
    const elsewhere = await place(s);
    const stranger = await elsewhere.join('owner');
    const memberIds = [
      await membershipOf(at, sam.id),
      await membershipOf(at, dana.id),
      await membershipOf(at, gone.id),
      await membershipOf(at, staff.id),
      await membershipOf(elsewhere, stranger.id),
    ];
    const { contactId, formId } = await formTelling(at, { mode: 'members', memberIds });
    await s.database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.memberships where user_id = $1', [gone.id]),
    );
    expect(await run(at, await submitted(at, formId, contactId))).toBe(3);
    expect((await told(at)).toSorted()).toEqual([sam.id, dana.id, staff.id].toSorted());
    // Not the people who manage forms, unless the form lists them.
    expect(await told(at)).not.toContain(at.owner.id);
    expect(await told(at)).not.toContain(admin.id);
    expect(await told(elsewhere)).toEqual([]);
  });

  it('goes by what was published: a draft that names someone else changes nothing yet', async () => {
    const at = await place(s);
    const sam = await at.join('member');
    const { contactId, formId } = await formTelling(at, { mode: 'nobody' });
    await s.database.withTenant(at.system, async (sql) =>
      sql.query(`update forms.forms set definition = $2::jsonb where id = $1`, [
        formId,
        JSON.stringify({
          fields: [],
          notify: { mode: 'members', memberIds: [await membershipOf(at, sam.id)] },
        }),
      ]),
    );
    expect(await run(at, await submitted(at, formId, contactId))).toBe(0);
  });
});
