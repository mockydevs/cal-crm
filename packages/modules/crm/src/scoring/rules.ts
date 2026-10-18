// Which stored events a scoring rule scores, decided without the database. A rule names what
// a contact does; the modules that record it name their events for what happened, so one
// rule can listen to more than one event type, and a payload says which of it happened.
import type { ScoreCalculation, ScoreRuleAction } from '@repo/contracts';
import { decodeTypeId, isUuidV7 } from '@repo/kernel';

/** A rule as the live profile keeps it: ids are stored uuids. */
export interface LiveRule {
  readonly id: string;
  readonly action: ScoreRuleAction;
  /** Which of the action: event, channel, formId, status, change and tagId. */
  readonly qualifier: Readonly<Record<string, string | null>>;
  readonly hasTagId: string | null;
  readonly calculation: ScoreCalculation;
  readonly points: number;
}

/**
 * The event types each action listens to. Email events come from the mail server's reports
 * (messaging/bounces.ts) and from the unsubscribe link (consent.withdrawn); a reply is an
 * inbound message by email, text or web chat; adding a tag is "assigned" in the CRM.
 */
export const SCORE_ACTION_EVENTS: Readonly<Record<ScoreRuleAction, readonly string[]>> = {
  email_event: ['message.bounced', 'message.complained', 'consent.withdrawn'],
  contact_replied: ['message.received'],
  form_submitted: ['form.submitted'],
  appointment_booked: ['appointment.booked'],
  appointment_status: ['appointment.status_changed'],
  contact_tag: ['tag.assigned', 'tag.removed'],
  payment_received: ['payment.recorded'],
  trigger_link_clicked: ['trigger_link.clicked'],
  contact_changed: ['contact.updated', 'field.value_set', 'field.value_cleared'],
};

/** Every event type the rules listen to, each once, in a stable order. */
export function eventTypesOf(rules: readonly Pick<LiveRule, 'action'>[]): string[] {
  return [...new Set(rules.flatMap((rule) => SCORE_ACTION_EVENTS[rule.action]))].sort();
}

/** The stored uuid of an id written either way: as a public id (tag_…) or as the uuid. */
export function canonicalId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const decoded = decodeTypeId(value);
  return decoded !== undefined && isUuidV7(decoded.uuid) ? decoded.uuid : value;
}

const EMAIL_EVENT_TYPES: Readonly<Record<string, string>> = {
  bounced: 'message.bounced',
  complained: 'message.complained',
  unsubscribed: 'consent.withdrawn',
};

/** Whether the event is what the rule scores. Whether the contact has its tag is apart. */
export function rulePasses(
  rule: LiveRule,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  if (!SCORE_ACTION_EVENTS[rule.action].includes(eventType)) return false;
  const { qualifier } = rule;
  switch (rule.action) {
    case 'email_event': {
      const wanted = qualifier['event'];
      if (wanted === undefined || wanted === null) return false;
      if (EMAIL_EVENT_TYPES[wanted] !== eventType) return false;
      // Withdrawn consent is an email unsubscribe only for the email channel.
      return eventType !== 'consent.withdrawn' || payload['channel'] === 'email';
    }
    case 'contact_replied': {
      const channel = qualifier['channel'] ?? null;
      return channel === null || payload['channel'] === channel;
    }
    case 'form_submitted': {
      const formId = qualifier['formId'] ?? null;
      return formId === null || canonicalId(payload['formId']) === formId;
    }
    case 'appointment_status':
      // A reschedule tells of the status it kept: no change of status.
      return (
        payload['rescheduled'] !== true &&
        payload['status'] === qualifier['status'] &&
        payload['previousStatus'] !== payload['status']
      );
    case 'contact_tag':
      return (
        eventType === (qualifier['change'] === 'removed' ? 'tag.removed' : 'tag.assigned') &&
        canonicalId(payload['tagId']) === qualifier['tagId']
      );
    case 'appointment_booked':
    case 'payment_received':
    case 'trigger_link_clicked':
    case 'contact_changed':
      return true;
  }
}

/** What the rule adds to a score: its points, or less them. */
export const changeOf = (rule: Pick<LiveRule, 'calculation' | 'points'>): number =>
  rule.calculation === 'add' ? rule.points : -rule.points;

/**
 * What a rule's change to a contact's score is keyed by, so it is made once. Most rules score
 * each event once. "Contact changed" scores each change once: one save that changes a name
 * and three fields writes four events, all naming the command that wrote them.
 */
export function scoreKeyOf(
  rule: Pick<LiveRule, 'id' | 'action'>,
  event: { readonly id: string; readonly commandId: string | null },
  contactId: string,
): string {
  return rule.action === 'contact_changed' && event.commandId !== null
    ? `cmd:${event.commandId}:rule:${rule.id}:contact:${contactId}`
    : `event:${event.id}:rule:${rule.id}`;
}
