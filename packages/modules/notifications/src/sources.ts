// Which events tell whom. One entry per event type. Each reads the thing the event is about
// as it is now, under row-level security, and says who is to be told of it: the job in
// from-event.ts writes the rest.
//
// The list of types here is the list the database queues a job for
// (private.notification_event_types, migration 0056); a test holds the two together.
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, type ActorKind, type TenantContext } from '@repo/kernel';

import type { Notice } from './deliver.js';
import { isOnTeam, membersHolding, peopleOfMemberships } from './recipients.js';
import { formNotifyOf, idIn } from './rules.js';

/** An event as the job reads it from the log. */
export interface StoredEvent {
  readonly id: string;
  readonly type: string;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly subjectId: string;
  readonly payload: unknown;
}

/** A notice before the job adds what every notice of an event shares. */
export type Planned = Pick<
  Notice,
  'kind' | 'recipients' | 'collapseKey' | 'subject' | 'recordId' | 'title'
>;

type Source = (
  trx: DatabaseTransaction,
  context: TenantContext,
  event: StoredEvent,
) => Promise<readonly Planned[]>;

/**
 * A conversation was assigned: the person that event gave it to is told, if they still
 * have it. A job that runs after it changed hands again tells nobody; the later event
 * tells the later person.
 */
const conversationAssigned: Source = async (trx, _context, event) => {
  const assigned = idIn(event.payload, 'assignedUserId');
  if (assigned === undefined) return [];
  const conversation = await trx
    .selectFrom('messaging.conversations')
    .select(['id', 'contact_id', 'assignee_user_id'])
    .where('id', '=', event.subjectId)
    .executeTakeFirst();
  if (conversation?.assignee_user_id !== assigned) return [];
  return [
    {
      kind: 'conversation.assigned',
      recipients: [assigned],
      subject: { kind: 'conversation', id: conversation.id },
      recordId: conversation.contact_id,
      collapseKey: `conversation.assigned:${conversation.id}`,
    },
  ];
};

/**
 * A contact wrote. Whoever has the conversation is told that their conversation has a new
 * message. The contact's followers who work conversations are told under a kind of their
 * own, as GoHighLevel tells followers of new messages, and everyone else who works
 * conversations under another, because the conversation is nobody's yet, or someone
 * else's, and each person chooses whether to hear of those. One unread notification per
 * person and conversation, whatever its kind: each person gets the first kind in that
 * order that they have not turned off.
 */
const messageReceived: Source = async (trx, context, event) => {
  const conversationId = idIn(event.payload, 'conversationId');
  if (conversationId === undefined) return [];
  const conversation = await trx
    .selectFrom('messaging.conversations')
    .select(['business_id', 'id', 'contact_id', 'assignee_user_id'])
    .where('id', '=', conversationId)
    .executeTakeFirst();
  if (conversation === undefined) return [];
  const assignee = conversation.assignee_user_id;
  const team = await membersHolding(trx, context, ['conversations.reply', 'conversations.manage']);
  const shared = {
    subject: { kind: 'conversation', id: conversation.id },
    recordId: conversation.contact_id,
    collapseKey: `message.received:${conversation.id}`,
  } as const;
  const following = await trx
    .selectFrom('crm.contact_followers')
    .select('user_id')
    .where('business_id', '=', conversation.business_id)
    .where('contact_id', '=', conversation.contact_id)
    .orderBy('user_id')
    .execute();
  const others = team.filter((userId) => userId !== assignee);
  return [
    { ...shared, kind: 'message.received', recipients: [assignee] },
    {
      ...shared,
      kind: 'message.received_following',
      recipients: following.map((row) => row.user_id).filter((userId) => others.includes(userId)),
    },
    { ...shared, kind: 'message.received_other', recipients: others },
  ];
};

/**
 * A task was given to someone, when it was made or when it was edited: that person is
 * told, if the task is still theirs and still open.
 */
const taskAssigned: Source = async (trx, _context, event) => {
  const assigned = idIn(event.payload, 'assignedUserId');
  if (assigned === undefined) return [];
  const task = await trx
    .selectFrom('crm.tasks')
    .select(['id', 'title', 'record_id', 'assignee_user_id', 'completed_at'])
    .where('id', '=', event.subjectId)
    .executeTakeFirst();
  if (task?.assignee_user_id !== assigned || task.completed_at !== null) return [];
  return [
    {
      kind: 'task.assigned',
      recipients: [assigned],
      subject: { kind: 'task', id: task.id },
      recordId: task.record_id,
      title: task.title,
      collapseKey: `task.assigned:${task.id}`,
    },
  ];
};

/**
 * An appointment was booked, moved or cancelled: the team member it is with is told. One
 * with nobody assigned goes to the people who manage calendars, who are the ones able to
 * put somebody on it. The title is the calendar's name, as the appointment keeps it.
 */
const appointmentChanged =
  (kind: 'appointment.booked' | 'appointment.rescheduled' | 'appointment.cancelled'): Source =>
  async (trx, context, event) => {
    const appointment = await trx
      .selectFrom('calendar.appointments')
      .select(['id', 'title', 'contact_id', 'assigned_user_id'])
      .where('id', '=', event.subjectId)
      .executeTakeFirst();
    if (appointment === undefined) return [];
    return [
      {
        kind,
        recipients:
          appointment.assigned_user_id === null
            ? await membersHolding(trx, context, ['calendars.manage'])
            : [appointment.assigned_user_id],
        subject: { kind: 'appointment', id: appointment.id },
        recordId: appointment.contact_id,
        title: appointment.title,
        // Each booking is told of. A second move or cancellation of one nobody has looked
        // at yet is not.
        collapseKey: kind === 'appointment.booked' ? undefined : `${kind}:${appointment.id}`,
      },
    ];
  };

/**
 * Who a form's submission is told to, by the form's own setting as it was published
 * (packages/contracts/src/forms.ts, `notify`):
 * - nothing named: the people who manage forms, since a form has no owner and they are
 *   the ones who put it on a website;
 * - nobody;
 * - the owner of the contact it reached, while they are still on the team. A submission
 *   that reached no contact, or a contact nobody owns, goes to the people who manage
 *   forms instead, so it is not lost;
 * - the people the form lists, while each is still on the team.
 */
async function formRecipients(
  trx: DatabaseTransaction,
  context: TenantContext,
  definition: unknown,
  contactId: string | undefined,
): Promise<string[]> {
  const notify = formNotifyOf(definition);
  const managers = () => membersHolding(trx, context, ['forms.manage']);
  switch (notify.mode) {
    case 'managers':
      return managers();
    case 'nobody':
      return [];
    case 'contact_owner': {
      const contact =
        contactId === undefined
          ? undefined
          : await trx
              .selectFrom('crm.contacts')
              .select('owner_user_id')
              .where('id', '=', contactId)
              .executeTakeFirst();
      const owner = contact?.owner_user_id ?? null;
      return owner !== null && (await isOnTeam(trx, context, owner)) ? [owner] : managers();
    }
    case 'members':
      return peopleOfMemberships(
        trx,
        context,
        notify.memberIds.flatMap((id) => {
          const membership = parsePublicId('membership', id);
          return membership === undefined ? [] : [membership];
        }),
      );
  }
}

/**
 * A form was filled in: the people its own setting names are told (formRecipients). One
 * unread notification per person and form, however many submissions arrive meanwhile.
 */
const formSubmitted: Source = async (trx, context, event) => {
  const formId = idIn(event.payload, 'formId');
  if (formId === undefined) return [];
  const form = await trx
    .selectFrom('forms.forms')
    .select(['id', 'name', 'published_definition'])
    .where('id', '=', formId)
    .executeTakeFirst();
  if (form === undefined) return [];
  const contactId = idIn(event.payload, 'contactId');
  return [
    {
      kind: 'form.submitted',
      recipients: await formRecipients(trx, context, form.published_definition, contactId),
      subject: { kind: 'form', id: form.id },
      recordId: contactId,
      title: form.name,
      collapseKey: `form.submitted:${form.id}`,
    },
  ];
};

/**
 * The business's monthly AI spending limit was reached: the people who manage AI are
 * told, since they are the ones who can raise it or let AI stay paused. The gateway
 * writes the event once in a calendar month.
 */
const aiLimitReached: Source = async (trx, context) => [
  {
    kind: 'ai.limit_reached',
    recipients: await membersHolding(trx, context, ['ai.manage']),
    subject: { kind: 'ai_settings' },
    collapseKey: `ai.limit_reached:${context.businessId ?? context.agencyId}`,
  },
];

/** What each event type tells. An event of any other type tells nobody. */
export const SOURCES: Readonly<Record<string, Source>> = {
  'conversation.assigned': conversationAssigned,
  'message.received': messageReceived,
  'task.created': taskAssigned,
  'task.updated': taskAssigned,
  'form.submitted': formSubmitted,
  'appointment.booked': appointmentChanged('appointment.booked'),
  'appointment.rescheduled': appointmentChanged('appointment.rescheduled'),
  'appointment.cancelled': appointmentChanged('appointment.cancelled'),
  'ai_settings.limit_reached': aiLimitReached,
};

/** The event types the notifications job reads, in the order the database lists them. */
export const NOTIFICATION_EVENT_TYPES: readonly string[] = Object.keys(SOURCES);
