// Which events start which triggers (AUTOMATIONS.md section 3), and whether an event passes
// a trigger's filter. The catalog names triggers for people; emitters name events for what
// happened, so a trigger can listen to more than one event type.
import {
  evaluateCondition,
  type AutomationTrigger,
  type AutomationTriggerType,
  type ConditionValue,
} from '@repo/contracts';
import { decodeTypeId, isUuidV7 } from '@repo/kernel';

import { scoreMismatch } from './score-trigger.js';
import { trackingMismatch } from './tracking-trigger.js';

interface TriggerEvents {
  /** The event types the trigger starts on. */
  readonly events: readonly string[];
  /** Config key → the payload key the event carries it in. */
  readonly filters: Readonly<Record<string, string>>;
}

/**
 * The events that say a field of a record changed. The CRM tells of a custom field by
 * whether it now holds a value, and of a contact's own fields as the contact's update.
 */
export const FIELD_CHANGE_EVENTS = [
  'field.value_set',
  'field.value_cleared',
  'contact.updated',
] as const;

/**
 * One field an event changed, by a path a document may name it with. An event carries which
 * field changed and never its value (events can't be erased), so the changes are read when
 * the event is matched (field-changes.ts) and given to eventPassesTrigger beside its payload,
 * under FIELD_CHANGES.
 */
export interface FieldChange {
  readonly field: string;
  /** What the field holds after the change, null for nothing. Absent when it can't be known. */
  readonly value?: ConditionValue;
}

/** The key the fields an event changed are put under in the payload a trigger is judged by. */
export const FIELD_CHANGES = 'fieldChanges';

/**
 * How the lead of an event arrived: the lead source and the session source of the touch a
 * form submission or a booking recorded. An event carries ids only, so the touch is read
 * when the event is matched (attribution-values.ts) and given to eventPassesTrigger beside
 * its payload, under ARRIVAL.
 */
export interface Arrival {
  /** The lead source, as people read it; null for an event that recorded no touch. */
  readonly source: string | null;
  readonly sessionSource: string | null;
}

/** The key the touch of an event is put under in the payload a trigger is judged by. */
export const ARRIVAL = 'arrival';

const NO_ARRIVAL: Arrival = { source: null, sessionSource: null };

const arrivalIn = (payload: Readonly<Record<string, unknown>>): Arrival => {
  const given: unknown = payload[ARRIVAL];
  if (typeof given !== 'object' || given === null) return NO_ARRIVAL;
  const { source, sessionSource } = given as Readonly<Record<string, unknown>>;
  return {
    source: typeof source === 'string' ? source : null,
    sessionSource: typeof sessionSource === 'string' ? sessionSource : null,
  };
};

const alike = (text: string): string => text.trim().toLowerCase();

/**
 * Which of a trigger's filters by arrival the event's touch does not pass: "lead source is
 * any of", whatever its capitals, then "session source is any of". An event with no touch
 * passes neither. Nothing for a trigger that has no such filter, or when both pass.
 */
function arrivalMismatch(
  config: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
): TriggerMismatch | undefined {
  const { sources, sessionSources } = config;
  if (!Array.isArray(sources) && !Array.isArray(sessionSources)) return undefined;
  const arrival = arrivalIn(payload);
  if (Array.isArray(sources)) {
    const { source } = arrival;
    const wanted = sources.filter((each): each is string => typeof each === 'string');
    if (source === null || !wanted.some((each) => alike(each) === alike(source)))
      return { filter: 'sources', expected: wanted, actual: source };
  }
  if (Array.isArray(sessionSources) && !sessionSources.includes(arrival.sessionSource))
    return {
      filter: 'sessionSources',
      expected: sessionSources as readonly unknown[],
      actual: arrival.sessionSource,
    };
  return undefined;
}

// What contact.updated calls each of the contact's own fields it lists as changed
// (crm/contacts), and the paths documents name them by. A name is the first and last name
// together; emails and phones are every address the contact has, the primary one among them.
const CONTACT_CHANGES: Readonly<Record<string, readonly string[]>> = {
  firstName: ['contact.firstName', 'contact.name'],
  lastName: ['contact.lastName', 'contact.name'],
  emails: ['contact.email'],
  phones: ['contact.phone'],
  source: ['contact.source'],
  type: ['contact.type'],
};

/**
 * The paths of the contact's own fields a contact.updated event changed, each once. What it
 * lists that no document can name, such as the time zone, gives none.
 */
export function contactFieldsChanged(changed: unknown): string[] {
  if (!Array.isArray(changed)) return [];
  return [
    ...new Set(
      changed.flatMap((name: unknown) =>
        typeof name === 'string' && Object.hasOwn(CONTACT_CHANGES, name)
          ? (CONTACT_CHANGES[name] ?? [])
          : [],
      ),
    ),
  ];
}

/** The events that say a contact's do not disturb changed, outbound then inbound. */
const OUTBOUND_DND_EVENTS = [
  'contact.do_not_contact_set',
  'contact.do_not_contact_cleared',
  'contact.dnd_changed',
] as const;
const INBOUND_DND_EVENTS = ['contact.inbound_dnd_set', 'contact.inbound_dnd_cleared'] as const;
const DND_EVENTS: readonly string[] = [...OUTBOUND_DND_EVENTS, ...INBOUND_DND_EVENTS];

export const TRIGGER_EVENTS: Readonly<Record<AutomationTriggerType, TriggerEvents>> = {
  'form.submitted': { events: ['form.submitted'], filters: { form: 'formId' } },
  'message.received': { events: ['message.received'], filters: { channel: 'channel' } },
  'appointment.booked': { events: ['appointment.booked'], filters: { calendar: 'calendarId' } },
  'appointment.status_changed': {
    events: ['appointment.status_changed'],
    filters: { calendar: 'calendarId', status: 'status' },
  },
  'deal.stage_changed': {
    events: ['deal.stage_changed'],
    filters: { pipeline: 'pipelineId', stage: 'stageId' },
  },
  // The CRM emits the outcome as the event type (deals.ts).
  'deal.closed': { events: ['deal.won', 'deal.lost'], filters: { pipeline: 'pipelineId' } },
  'contact.created': { events: ['contact.created'], filters: {} },
  // Every change of do not disturb, however it was made (crm/contacts/dnd.ts and the contact
  // command); direction, on or off, and channel are judged in eventPassesTrigger.
  'contact.dnd_changed': { events: DND_EVENTS, filters: {} },
  'contact.score_changed': { events: ['contact.score_changed'], filters: {} },
  // Which field, and what it changed to, are judged in eventPassesTrigger.
  'field.changed': { events: FIELD_CHANGE_EVENTS, filters: {} },
  // The CRM calls adding a tag to a record "assigned" (assignments.ts).
  'tag.added': { events: ['tag.assigned'], filters: { tag: 'tagId' } },
  'tag.removed': { events: ['tag.removed'], filters: { tag: 'tagId' } },
  'task.created': { events: ['task.created'], filters: {} },
  'task.completed': { events: ['task.completed'], filters: {} },
  'note.created': { events: ['note.created'], filters: {} },
  'note.updated': { events: ['note.updated'], filters: {} },
  // Messaging emits it when a contact opens the address a message carried for the link.
  'trigger_link.clicked': { events: ['trigger_link.clicked'], filters: { link: 'linkId' } },
  // A known contact's page view or external form (forms/src/tracking); which, and where, are
  // judged in eventPassesTrigger.
  'external_tracking.event': {
    events: ['external_tracking.page_viewed', 'external_tracking.form_submitted'],
    filters: {},
  },
  // Commerce emits each under the trigger's own name, with the document's contact among the
  // records it happened to.
  'quote.sent': { events: ['quote.sent'], filters: {} },
  'quote.accepted': { events: ['quote.accepted'], filters: {} },
  'quote.declined': { events: ['quote.declined'], filters: {} },
  'invoice.issued': { events: ['invoice.issued'], filters: {} },
  'invoice.sent': { events: ['invoice.sent'], filters: {} },
  'invoice.paid': { events: ['invoice.paid'], filters: {} },
  'payment.recorded': { events: ['payment.recorded'], filters: {} },
  // No event of this type is ever stored: the subscription it gives a published automation is
  // how the worker's date sweep finds the automation (date-triggers.ts).
  'date.reached': { events: ['date.reached'], filters: {} },
  // Nor of this one: the worker's task reminder sweep finds the automation by it
  // (task-reminders.ts).
  'task.reminder': { events: ['task.reminder'], filters: {} },
  // A run that ended says so itself (runner.ts, stops.ts, actions-automations.ts); which
  // automation, and how it ended, are judged in eventPassesTrigger.
  'automation.run_ended': {
    events: ['automation.run.stopped', 'automation.run.completed', 'automation.run.failed'],
    filters: {},
  },
  // Timers and webhooks aren't events in events.events; nothing starts these two yet.
  'webhook.received': { events: [], filters: {} },
  schedule: { events: [], filters: {} },
};

/** The same id whether written as a public id (tag_…) or as the stored uuid. */
function sameId(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return left === right;
  const canonical = (value: string) => {
    const decoded = decodeTypeId(value);
    return decoded !== undefined && isUuidV7(decoded.uuid) ? decoded.uuid : value;
  };
  return canonical(left) === canonical(right);
}

/** Whether an event of this type and payload passes the trigger's own filters. */
export function eventPassesTrigger(
  trigger: AutomationTrigger,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const mapping = TRIGGER_EVENTS[trigger.type];
  if (!mapping.events.includes(eventType)) return false;
  if (trigger.type === 'automation.run_ended')
    return runEndingPasses(trigger.config, eventType, payload);
  if (trigger.type === 'field.changed') return fieldChangePasses(trigger.config, payload);
  if (trigger.type === 'contact.dnd_changed')
    return dndMismatch(trigger.config, eventType, payload) === undefined;
  if (trigger.type === 'contact.score_changed')
    return scoreMismatch(trigger.config, payload) === undefined;
  if (trigger.type === 'external_tracking.event')
    return trackingMismatch(trigger.config, eventType, payload) === undefined;
  if (trigger.type === 'deal.closed' && trigger.config.outcome !== undefined)
    return eventType === `deal.${trigger.config.outcome}` && filtersPass(trigger, mapping, payload);
  return (
    filtersPass(trigger, mapping, payload) && arrivalMismatch(trigger.config, payload) === undefined
  );
}

// How a run ended, from the event that says it did: a stop condition and a removal both
// say "stopped", and the reason tells them apart.
function endingOf(
  eventType: string,
  reason: unknown,
): 'stopped' | 'removed' | 'completed' | 'failed' | undefined {
  if (eventType === 'automation.run.completed') return 'completed';
  if (eventType === 'automation.run.failed') return 'failed';
  if (typeof reason !== 'string') return undefined;
  return reason.startsWith('removed:')
    ? 'removed'
    : reason.startsWith('stop:')
      ? 'stopped'
      : undefined;
}

function runEndingPasses(
  config: Extract<AutomationTrigger, { type: 'automation.run_ended' }>['config'],
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  if (!config.automations.some((each) => sameId(each, payload['automationId']))) return false;
  const ending = endingOf(eventType, payload['reason']);
  if (ending === undefined) return false;
  // stoppedBy alone means "stopped by one of these"; beside `how`, it narrows the stopped.
  const how = config.how ?? (config.stoppedBy === undefined ? undefined : ['stopped']);
  if (how !== undefined && !how.includes(ending)) return false;
  return (
    ending !== 'stopped' ||
    config.stoppedBy === undefined ||
    config.stoppedBy.some((event) => payload['reason'] === `stop:${event}`)
  );
}

const channelsIn = (payload: Readonly<Record<string, unknown>>, key: string): string[] => {
  const listed: unknown = payload[key];
  return Array.isArray(listed)
    ? listed.filter((each): each is string => typeof each === 'string')
    : [];
};

/**
 * Why a change of do not disturb is not the one the Contact DND trigger asks for, by the
 * filter it fails: direction, flag or channel. Nothing when it is. Outbound (the default)
 * is every channel at once, which is do not contact, or one channel turned on or off;
 * inbound is the one switch for what the contact sends in. A change of several channels at
 * once passes for each of them.
 *
 * One save can turn do not contact on and change channels too, and writes an event for
 * each (crm/contacts/dnd.ts). Its contact.dnd_changed then names the do not contact change
 * (`doNotContact`), and stands aside, as an event the trigger does not take, whenever the
 * save's do not contact event passes the same trigger: one save starts one run.
 */
function dndMismatch(
  config: Extract<AutomationTrigger, { type: 'contact.dnd_changed' }>['config'],
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): TriggerMismatch | undefined {
  const inbound = (INBOUND_DND_EVENTS as readonly string[]).includes(eventType);
  const direction = config.direction ?? 'outbound';
  if (inbound !== (direction === 'inbound'))
    return { filter: 'direction', expected: direction, actual: inbound ? 'inbound' : 'outbound' };
  if (eventType !== 'contact.dnd_changed') {
    const turned =
      eventType === 'contact.inbound_dnd_set' || eventType === 'contact.do_not_contact_set'
        ? 'enabled'
        : 'disabled';
    if (config.flag !== undefined && config.flag !== turned)
      return { filter: 'flag', expected: config.flag, actual: turned };
    if (!inbound && config.channel !== undefined && config.channel !== 'all')
      return { filter: 'channel', expected: config.channel, actual: 'all' };
    return undefined;
  }
  const enabled = channelsIn(payload, 'enabled');
  const disabled = channelsIn(payload, 'disabled');
  if (config.channel === 'all')
    return { filter: 'channel', expected: 'all', actual: [...enabled, ...disabled] };
  const companion = payload['doNotContact'];
  if (
    config.channel === undefined &&
    (companion === 'set' || companion === 'cleared') &&
    (config.flag === undefined || config.flag === (companion === 'set' ? 'enabled' : 'disabled'))
  )
    return {
      filter: 'event',
      expected: [`contact.do_not_contact_${companion}`],
      actual: eventType,
    };
  const changed =
    config.flag === 'enabled'
      ? enabled
      : config.flag === 'disabled'
        ? disabled
        : [...enabled, ...disabled];
  if (config.channel === undefined)
    return changed.length > 0
      ? undefined
      : { filter: 'flag', expected: config.flag ?? 'enabled or disabled', actual: [] };
  if (changed.includes(config.channel)) return undefined;
  return [...enabled, ...disabled].includes(config.channel)
    ? {
        filter: 'flag',
        expected: config.flag,
        actual: enabled.includes(config.channel) ? 'enabled' : 'disabled',
      }
    : { filter: 'channel', expected: config.channel, actual: [...enabled, ...disabled] };
}

const isFieldChange = (value: unknown): value is FieldChange =>
  typeof value === 'object' && value !== null && 'field' in value;

function fieldChangePasses(
  config: Extract<AutomationTrigger, { type: 'field.changed' }>['config'],
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const changes: unknown = payload[FIELD_CHANGES];
  const change = Array.isArray(changes)
    ? changes.filter(isFieldChange).find((each) => each.field === config.field)
    : undefined;
  if (change === undefined) return false;
  if (config.to === undefined) return true;
  // A value that was replaced before the event was matched is not known, and passes no `to`.
  if (change.value === undefined) return false;
  // "Changed to" compares as a condition's equals does; empty text asks for nothing in it.
  const values = { [config.field]: change.value };
  return evaluateCondition(
    config.to === ''
      ? { field: config.field, operator: 'is_empty' }
      : { field: config.field, operator: 'equals', value: config.to },
    values,
    new Date(0),
  );
}

function filtersPass(
  trigger: AutomationTrigger,
  mapping: TriggerEvents,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const config: Readonly<Record<string, unknown>> = trigger.config;
  return Object.entries(mapping.filters).every(([key, payloadKey]) => {
    const wanted = config[key];
    // An unset filter matches everything; a set one needs the event to carry the value.
    return wanted === undefined || (payloadKey in payload && sameId(payload[payloadKey], wanted));
  });
}

/** Which of a trigger's own filters an event did not pass, with what each side held. */
export interface TriggerMismatch {
  /** The filter, by its key in the trigger's config; `event` when the event is not one of the trigger's. */
  readonly filter: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Why an event does not pass a trigger's own filters: the first filter it fails, with what
 * the trigger wanted and what the event had. Nothing when it passes. It judges as
 * eventPassesTrigger does (the unit tests hold the two together); only that one decides
 * whether a record is enrolled.
 */
export function triggerMismatch(
  trigger: AutomationTrigger,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): TriggerMismatch | undefined {
  const mapping = TRIGGER_EVENTS[trigger.type];
  if (!mapping.events.includes(eventType))
    return { filter: 'event', expected: mapping.events, actual: eventType };
  if (trigger.type === 'automation.run_ended') {
    const { config } = trigger;
    if (!config.automations.some((each) => sameId(each, payload['automationId'])))
      return {
        filter: 'automations',
        expected: config.automations,
        actual: payload['automationId'] ?? null,
      };
    const ending = endingOf(eventType, payload['reason']);
    const how = config.how ?? (config.stoppedBy === undefined ? undefined : ['stopped']);
    if (ending === undefined || (how !== undefined && !how.includes(ending)))
      return { filter: 'how', expected: how ?? automationRunEndingsOf(), actual: ending ?? null };
    if (
      ending === 'stopped' &&
      config.stoppedBy !== undefined &&
      !config.stoppedBy.some((event) => payload['reason'] === `stop:${event}`)
    )
      return { filter: 'stoppedBy', expected: config.stoppedBy, actual: payload['reason'] ?? null };
    return undefined;
  }
  if (trigger.type === 'field.changed') {
    const { config } = trigger;
    const changes: unknown = payload[FIELD_CHANGES];
    const changed = Array.isArray(changes) ? changes.filter(isFieldChange) : [];
    const change = changed.find((each) => each.field === config.field);
    if (change === undefined)
      return { filter: 'field', expected: config.field, actual: changed.map((each) => each.field) };
    if (config.to === undefined) return undefined;
    return fieldChangePasses(config, payload)
      ? undefined
      : {
          filter: 'to',
          expected: config.to,
          // A value replaced before the event was matched is not known.
          actual: change.value === undefined ? 'unknown' : change.value,
        };
  }
  if (trigger.type === 'contact.dnd_changed')
    return dndMismatch(trigger.config, eventType, payload);
  if (trigger.type === 'contact.score_changed') return scoreMismatch(trigger.config, payload);
  if (trigger.type === 'external_tracking.event')
    return trackingMismatch(trigger.config, eventType, payload);
  if (
    trigger.type === 'deal.closed' &&
    trigger.config.outcome !== undefined &&
    eventType !== `deal.${trigger.config.outcome}`
  )
    return { filter: 'outcome', expected: trigger.config.outcome, actual: eventType.slice(5) };
  const config: Readonly<Record<string, unknown>> = trigger.config;
  for (const [key, payloadKey] of Object.entries(mapping.filters)) {
    const wanted = config[key];
    if (wanted !== undefined && !(payloadKey in payload && sameId(payload[payloadKey], wanted)))
      return { filter: key, expected: wanted, actual: payload[payloadKey] ?? null };
  }
  return arrivalMismatch(config, payload);
}

// How a run can have ended, for a mismatch that has no list of its own to show.
const automationRunEndingsOf = (): readonly string[] => [
  'stopped',
  'removed',
  'completed',
  'failed',
];
