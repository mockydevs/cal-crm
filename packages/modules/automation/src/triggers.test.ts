import { automationTrigger, type ConditionValue } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  contactFieldsChanged,
  eventPassesTrigger,
  FIELD_CHANGE_EVENTS,
  FIELD_CHANGES,
  TRIGGER_EVENTS,
  triggerMismatch,
  type FieldChange,
} from './triggers.js';

const trigger = (input: unknown) => automationTrigger.parse(input);
const tagId = '0192f3a0-1111-7222-8333-444455556666';

describe('the trigger table', () => {
  // Commerce emits each of these under the trigger's own name.
  it.each([
    'quote.sent',
    'quote.accepted',
    'quote.declined',
    'invoice.issued',
    'invoice.sent',
    'invoice.paid',
    'payment.recorded',
  ])('starts on the commerce event %s, and on no other', (type) => {
    const commerce = trigger({ id: 'commerce', type, config: {} });
    expect(TRIGGER_EVENTS[commerce.type]).toEqual({ events: [type], filters: {} });
    expect(eventPassesTrigger(commerce, type, { number: 'INV-0007' })).toBe(true);
    for (const other of ['quote.issued', 'invoice.voided', 'payment.reversed', 'contact.created'])
      expect(eventPassesTrigger(commerce, other, { number: 'INV-0007' })).toBe(other === type);
  });

  it.each(['task.created', 'task.completed', 'note.created', 'note.updated'])(
    'starts on the real CRM event %s, without accepting unrelated events',
    (type) => {
      const native = trigger({ id: 'native', type, config: {} });
      expect(eventPassesTrigger(native, type, { recordId: 'contact_123' })).toBe(true);
      expect(eventPassesTrigger(native, 'contact.created', { recordId: 'contact_123' })).toBe(
        false,
      );
    },
  );

  it('starts on removal of the selected tag, never on addition or a different tag', () => {
    const removed = trigger({ id: 'removed', type: 'tag.removed', config: { tag: tagId } });
    expect(eventPassesTrigger(removed, 'tag.removed', { tagId })).toBe(true);
    expect(eventPassesTrigger(removed, 'tag.removed', { tagId: toPublicId('tag', tagId) })).toBe(
      true,
    );
    expect(eventPassesTrigger(removed, 'tag.assigned', { tagId })).toBe(false);
    expect(eventPassesTrigger(removed, 'tag.removed', { tagId: 'another' })).toBe(false);
    expect(eventPassesTrigger(removed, 'tag.removed', {})).toBe(false);
  });

  it('listens for what the CRM actually emits', () => {
    expect(TRIGGER_EVENTS['deal.closed'].events).toEqual(['deal.won', 'deal.lost']);
    expect(TRIGGER_EVENTS['tag.added'].events).toEqual(['tag.assigned']);
    expect(TRIGGER_EVENTS.schedule.events).toEqual([]);
  });

  it('gives a date trigger a subscription of its own, for the sweep to find it by', () => {
    expect(TRIGGER_EVENTS['date.reached'].events).toEqual(['date.reached']);
  });
});

describe('an event passes a trigger', () => {
  const tagged = trigger({ id: 't', type: 'tag.added', config: { tag: tagId } });

  it('when its type is one the trigger listens for and its filters match', () => {
    expect(eventPassesTrigger(tagged, 'tag.assigned', { tagId })).toBe(true);
    expect(eventPassesTrigger(tagged, 'tag.removed', { tagId })).toBe(false);
  });

  it('whether ids are written as public ids or as uuids', () => {
    expect(eventPassesTrigger(tagged, 'tag.assigned', { tagId: toPublicId('tag', tagId) })).toBe(
      true,
    );
    const byPublic = trigger({
      id: 't',
      type: 'tag.added',
      config: { tag: toPublicId('tag', tagId) },
    });
    expect(eventPassesTrigger(byPublic, 'tag.assigned', { tagId })).toBe(true);
  });

  it("not when the event doesn't carry a value the filter needs", () => {
    expect(eventPassesTrigger(tagged, 'tag.assigned', {})).toBe(false);
    expect(eventPassesTrigger(tagged, 'tag.assigned', { tagId: 'another' })).toBe(false);
  });

  it('with an unset filter matching everything', () => {
    const anyStage = trigger({ id: 't', type: 'deal.stage_changed', config: {} });
    expect(eventPassesTrigger(anyStage, 'deal.stage_changed', {})).toBe(true);
  });

  it('for deal.closed, by outcome', () => {
    const won = trigger({ id: 't', type: 'deal.closed', config: { outcome: 'won' } });
    const any = trigger({ id: 't', type: 'deal.closed', config: {} });
    expect(eventPassesTrigger(won, 'deal.won', {})).toBe(true);
    expect(eventPassesTrigger(won, 'deal.lost', {})).toBe(false);
    expect(eventPassesTrigger(any, 'deal.lost', {})).toBe(true);
  });
});

describe('Contact DND', () => {
  const dnd = (config: Record<string, unknown>) =>
    trigger({ id: 'dnd', type: 'contact.dnd_changed', config });
  const turned = (enabled: string[], disabled: string[] = []) => ({
    channels: enabled,
    enabled,
    disabled,
  });

  it('listens for every change of do not disturb, outbound and inbound', () => {
    expect(TRIGGER_EVENTS['contact.dnd_changed'].events).toEqual([
      'contact.do_not_contact_set',
      'contact.do_not_contact_cleared',
      'contact.dnd_changed',
      'contact.inbound_dnd_set',
      'contact.inbound_dnd_cleared',
    ]);
  });

  it('with no filter, starts on any outbound change and on no inbound one', () => {
    const any = dnd({});
    expect(eventPassesTrigger(any, 'contact.do_not_contact_set', {})).toBe(true);
    expect(eventPassesTrigger(any, 'contact.do_not_contact_cleared', {})).toBe(true);
    expect(eventPassesTrigger(any, 'contact.dnd_changed', turned(['sms']))).toBe(true);
    expect(eventPassesTrigger(any, 'contact.inbound_dnd_set', {})).toBe(false);
    // A change event that names no channel turned on or off is no change.
    expect(eventPassesTrigger(any, 'contact.dnd_changed', turned([]))).toBe(false);
    expect(eventPassesTrigger(any, 'contact.created', {})).toBe(false);
  });

  it('for every channel, starts on do not contact turned on or off as the flag says', () => {
    const allOn = dnd({ flag: 'enabled', channel: 'all' });
    expect(eventPassesTrigger(allOn, 'contact.do_not_contact_set', {})).toBe(true);
    expect(eventPassesTrigger(allOn, 'contact.do_not_contact_cleared', {})).toBe(false);
    expect(eventPassesTrigger(allOn, 'contact.dnd_changed', turned(['sms']))).toBe(false);
    const allOff = dnd({ flag: 'disabled', channel: 'all' });
    expect(eventPassesTrigger(allOff, 'contact.do_not_contact_cleared', {})).toBe(true);
    expect(eventPassesTrigger(allOff, 'contact.do_not_contact_set', {})).toBe(false);
  });

  it('for one channel, starts when that channel is turned on or off as the flag says', () => {
    const smsOn = dnd({ direction: 'outbound', flag: 'enabled', channel: 'sms' });
    expect(eventPassesTrigger(smsOn, 'contact.dnd_changed', turned(['email', 'sms']))).toBe(true);
    expect(eventPassesTrigger(smsOn, 'contact.dnd_changed', turned(['email']))).toBe(false);
    expect(eventPassesTrigger(smsOn, 'contact.dnd_changed', turned([], ['sms']))).toBe(false);
    expect(eventPassesTrigger(smsOn, 'contact.do_not_contact_set', {})).toBe(false);
    const callOff = dnd({ flag: 'disabled', channel: 'call' });
    expect(eventPassesTrigger(callOff, 'contact.dnd_changed', turned([], ['call']))).toBe(true);
    expect(eventPassesTrigger(callOff, 'contact.dnd_changed', turned(['call']))).toBe(false);
    const chatEither = dnd({ channel: 'webchat' });
    expect(eventPassesTrigger(chatEither, 'contact.dnd_changed', turned(['webchat']))).toBe(true);
    expect(eventPassesTrigger(chatEither, 'contact.dnd_changed', turned([], ['webchat']))).toBe(
      true,
    );
    // Any channel turned on, as "enabled for specific channels" with none chosen.
    const anyOn = dnd({ flag: 'enabled' });
    expect(eventPassesTrigger(anyOn, 'contact.dnd_changed', turned(['call']))).toBe(true);
    expect(eventPassesTrigger(anyOn, 'contact.dnd_changed', turned([], ['call']))).toBe(false);
  });

  it('inbound, starts on the one inbound switch as the flag says, and on no outbound change', () => {
    const inbound = dnd({ direction: 'inbound' });
    expect(eventPassesTrigger(inbound, 'contact.inbound_dnd_set', {})).toBe(true);
    expect(eventPassesTrigger(inbound, 'contact.inbound_dnd_cleared', {})).toBe(true);
    expect(eventPassesTrigger(inbound, 'contact.do_not_contact_set', {})).toBe(false);
    expect(eventPassesTrigger(inbound, 'contact.dnd_changed', turned(['sms']))).toBe(false);
    const inboundOn = dnd({ direction: 'inbound', flag: 'enabled' });
    expect(eventPassesTrigger(inboundOn, 'contact.inbound_dnd_set', {})).toBe(true);
    expect(eventPassesTrigger(inboundOn, 'contact.inbound_dnd_cleared', {})).toBe(false);
  });

  it('starts once for a save that turns do not contact on and changes channels too', () => {
    // The save's two events, as crm/contacts/dnd.ts writes them.
    const save = [
      ['contact.do_not_contact_set', {}],
      ['contact.dnd_changed', { ...turned(['sms']), doNotContact: 'set' }],
    ] as const;
    const passing = (config: Record<string, unknown>) =>
      save.filter(([type, payload]) => eventPassesTrigger(dnd(config), type, payload)).length;
    expect(passing({})).toBe(1);
    expect(passing({ flag: 'enabled' })).toBe(1);
    expect(passing({ channel: 'all' })).toBe(1);
    expect(passing({ channel: 'sms' })).toBe(1);
    expect(passing({ flag: 'enabled', channel: 'sms' })).toBe(1);
    // Turning do not contact on and a channel off: "turned off" is the channel's alone.
    const mixed = [
      ['contact.do_not_contact_set', {}],
      ['contact.dnd_changed', { ...turned([], ['email']), doNotContact: 'set' }],
    ] as const;
    expect(
      mixed.filter(([type, payload]) =>
        eventPassesTrigger(dnd({ flag: 'disabled' }), type, payload),
      ),
    ).toEqual([mixed[1]]);
    // The one that stands aside is not a filter that refused it.
    expect(
      triggerMismatch(dnd({}), 'contact.dnd_changed', { ...turned(['sms']), doNotContact: 'set' }),
    ).toEqual({
      filter: 'event',
      expected: ['contact.do_not_contact_set'],
      actual: 'contact.dnd_changed',
    });
  });

  it('says which of direction, flag or channel a change does not fit', () => {
    expect(triggerMismatch(dnd({}), 'contact.inbound_dnd_set', {})).toEqual({
      filter: 'direction',
      expected: 'outbound',
      actual: 'inbound',
    });
    expect(
      triggerMismatch(
        dnd({ direction: 'inbound', flag: 'enabled' }),
        'contact.inbound_dnd_cleared',
        {},
      ),
    ).toEqual({ filter: 'flag', expected: 'enabled', actual: 'disabled' });
    expect(triggerMismatch(dnd({ channel: 'sms' }), 'contact.do_not_contact_set', {})).toEqual({
      filter: 'channel',
      expected: 'sms',
      actual: 'all',
    });
    expect(
      triggerMismatch(dnd({ channel: 'all' }), 'contact.dnd_changed', turned(['email'])),
    ).toEqual({ filter: 'channel', expected: 'all', actual: ['email'] });
    expect(
      triggerMismatch(dnd({ channel: 'sms' }), 'contact.dnd_changed', turned(['email'])),
    ).toEqual({ filter: 'channel', expected: 'sms', actual: ['email'] });
    expect(
      triggerMismatch(
        dnd({ flag: 'enabled', channel: 'sms' }),
        'contact.dnd_changed',
        turned([], ['sms']),
      ),
    ).toEqual({ filter: 'flag', expected: 'enabled', actual: 'disabled' });
    expect(
      triggerMismatch(dnd({ flag: 'enabled' }), 'contact.dnd_changed', turned([], ['sms'])),
    ).toEqual({ filter: 'flag', expected: 'enabled', actual: [] });
    expect(triggerMismatch(dnd({ channel: 'sms' }), 'contact.dnd_changed', turned(['sms']))).toBe(
      undefined,
    );
  });

  it('takes no channel for inbound, which is one setting', () => {
    expect(() => dnd({ direction: 'inbound', channel: 'sms' })).toThrow(
      'Inbound do not disturb has no channels to choose.',
    );
    expect(() => dnd({ channel: 'whatsapp' })).toThrow();
  });
});

describe('a field change', () => {
  const changes = (...fieldChanges: FieldChange[]) => ({ [FIELD_CHANGES]: fieldChanges });
  const guests = trigger({
    id: 't',
    type: 'field.changed',
    config: { field: 'contact.custom.guests' },
  });
  const to = (field: string, value: string | number | boolean) =>
    trigger({ id: 't', type: 'field.changed', config: { field, to: value } });
  const guestsNow = (value: ConditionValue) => changes({ field: 'contact.custom.guests', value });

  it('is heard as what the CRM emits: a value set or cleared, and a contact updated', () => {
    expect(TRIGGER_EVENTS['field.changed'].events).toEqual([
      'field.value_set',
      'field.value_cleared',
      'contact.updated',
    ]);
    expect(TRIGGER_EVENTS['field.changed'].events).toEqual(FIELD_CHANGE_EVENTS);
    // The type nothing emits is no longer listened for.
    expect(eventPassesTrigger(guests, 'field.changed', guestsNow(120))).toBe(false);
  });

  it('passes for the field the trigger names, set or cleared, and for no other', () => {
    expect(eventPassesTrigger(guests, 'field.value_set', guestsNow(120))).toBe(true);
    expect(eventPassesTrigger(guests, 'field.value_cleared', guestsNow(null))).toBe(true);
    expect(
      eventPassesTrigger(guests, 'field.value_set', changes({ field: 'contact.custom.budget' })),
    ).toBe(false);
  });

  it('needs the changes read beside the payload: the stored payload names no path', () => {
    const stored = { recordId: 'contact_123', fieldId: 'field_123' };
    expect(eventPassesTrigger(guests, 'field.value_set', stored)).toBe(false);
    expect(eventPassesTrigger(guests, 'field.value_set', { [FIELD_CHANGES]: 'guests' })).toBe(
      false,
    );
    expect(eventPassesTrigger(guests, 'field.value_set', { [FIELD_CHANGES]: [null, 'x'] })).toBe(
      false,
    );
  });

  it('finds the field among several, as by the key a merged field left behind', () => {
    expect(
      eventPassesTrigger(
        guests,
        'field.value_set',
        changes(
          { field: 'contact.custom.headcount', value: 4 },
          { field: 'contact.custom.guests', value: 4 },
        ),
      ),
    ).toBe(true);
  });

  it('compares what it changed to as a condition does: numbers as numbers, text without case', () => {
    const many = to('contact.custom.guests', 120);
    expect(eventPassesTrigger(many, 'field.value_set', guestsNow(120))).toBe(true);
    expect(eventPassesTrigger(many, 'field.value_set', guestsNow(121))).toBe(false);
    expect(eventPassesTrigger(many, 'field.value_set', guestsNow('120'))).toBe(false);
    const gold = to('contact.custom.tier', 'Gold');
    const tier = (value: ConditionValue) => changes({ field: 'contact.custom.tier', value });
    expect(eventPassesTrigger(gold, 'field.value_set', tier('gold'))).toBe(true);
    expect(eventPassesTrigger(gold, 'field.value_set', tier('silver'))).toBe(false);
    // A field of several choices changed to the one named when it is among them.
    expect(eventPassesTrigger(gold, 'field.value_set', tier(['silver', 'gold']))).toBe(true);
    const vip = to('contact.custom.vip', true);
    const flag = (value: boolean) => changes({ field: 'contact.custom.vip', value });
    expect(eventPassesTrigger(vip, 'field.value_set', flag(true))).toBe(true);
    expect(eventPassesTrigger(vip, 'field.value_set', flag(false))).toBe(false);
  });

  it('passes no "changed to" when the value is not known, or was cleared', () => {
    const many = to('contact.custom.guests', 120);
    expect(
      eventPassesTrigger(many, 'field.value_set', changes({ field: 'contact.custom.guests' })),
    ).toBe(false);
    expect(eventPassesTrigger(many, 'field.value_cleared', guestsNow(null))).toBe(false);
  });

  it('takes empty text as "changed to nothing": a cleared value', () => {
    const emptied = to('contact.custom.guests', '');
    expect(eventPassesTrigger(emptied, 'field.value_cleared', guestsNow(null))).toBe(true);
    expect(eventPassesTrigger(emptied, 'field.value_set', guestsNow(3))).toBe(false);
  });

  it('hears a field of the contact itself through the update of the contact', () => {
    const source = to('contact.source', 'Website');
    expect(
      eventPassesTrigger(
        source,
        'contact.updated',
        changes({ field: 'contact.source', value: 'website' }),
      ),
    ).toBe(true);
    expect(
      eventPassesTrigger(
        source,
        'contact.updated',
        changes({ field: 'contact.firstName', value: 'Website' }),
      ),
    ).toBe(false);
  });
});

describe('the fields of the contact itself that an update lists', () => {
  it('become the paths documents name them by, each once', () => {
    expect(contactFieldsChanged(['firstName', 'lastName'])).toEqual([
      'contact.firstName',
      'contact.name',
      'contact.lastName',
    ]);
    expect(contactFieldsChanged(['emails', 'phones', 'source', 'type'])).toEqual([
      'contact.email',
      'contact.phone',
      'contact.source',
      'contact.type',
    ]);
  });

  it('are none for what no document can name, or for a payload without a list', () => {
    expect(contactFieldsChanged(['timeZone', 'dateOfBirth', 'toString', 7])).toEqual([]);
    expect(contactFieldsChanged(undefined)).toEqual([]);
    expect(contactFieldsChanged('firstName')).toEqual([]);
  });
});
