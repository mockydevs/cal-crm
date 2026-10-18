import { createAutomationTestRunInput } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { followUp, harborSetup, leadIntake } from '../e2e/automation-fixtures';
import type { Draft } from './automation-document';
import { eventsAwaited, fieldsRead, sampleValueOf, testRunBody } from './automation-test-inputs';

describe('what a test can be told', () => {
  it('finds the fields a draft reads: its conditions, wherever they are, and its merge fields', () => {
    expect(fieldsRead(followUp)).toEqual(['contact.services', 'contact.firstName']);
    expect(fieldsRead(leadIntake)).toEqual(['contact.services']);
    const more: Draft = {
      triggers: [
        {
          id: 'changed',
          type: 'field.changed',
          // A trigger's own setting named `field` is not a condition.
          config: { field: 'contact.email' },
          if: { any: [{ field: 'contact.city', operator: 'equals', value: 'Nairobi' }] },
        },
      ],
      stopWhen: [
        {
          event: 'tag.added',
          if: { not: { field: 'contact.tags', operator: 'includes', value: 'x' } },
        },
      ],
      steps: {
        text: {
          type: 'sms.send',
          config: { message: 'Hi {{ contact.firstName }}, {{deal.value}} {{values.x}}' },
        },
      },
    };
    expect(fieldsRead(more)).toEqual([
      'contact.city',
      'contact.firstName',
      'deal.value',
      'contact.tags',
    ]);
    expect(fieldsRead({})).toEqual([]);
  });

  it('finds the events a draft waits for or stops on', () => {
    expect(eventsAwaited(followUp)).toEqual([
      'message.received',
      'appointment.booked',
      'deal.closed',
    ]);
    const waits: Draft = {
      stopWhen: [{ event: 'message.received' }, {}],
      steps: {
        hold: { type: 'wait.event', config: { event: 'trigger_link.clicked', timeout: 'P1D' } },
        odd: { type: 'wait.event', config: {} },
        goal: {
          type: 'goal',
          config: { events: [{ type: 'appointment.booked' }, { type: 'message.received' }, 'x'] },
        },
        other: { type: 'wait', config: { event: 'never' } },
      },
    };
    expect(eventsAwaited(waits)).toEqual([
      'message.received',
      'trigger_link.clicked',
      'appointment.booked',
    ]);
    expect(eventsAwaited({})).toEqual([]);
  });

  it('sends what was typed as the kind of value the field holds', () => {
    const setup = {
      ...harborSetup,
      fields: {
        contact: [
          ...harborSetup.fields.contact,
          { key: 'budget', aliases: ['spend'], type: 'number' as const, options: [] },
          { key: 'vip', aliases: [], type: 'boolean' as const, options: [] },
        ],
        deal: [{ key: 'value', aliases: [], type: 'money' as const, options: [] }],
      },
    };
    expect(sampleValueOf('contact.services', ' video , photo,, ', setup)).toEqual([
      'video',
      'photo',
    ]);
    expect(sampleValueOf('contact.tags', 'VIP', setup)).toEqual(['VIP']);
    expect(sampleValueOf('contact.custom.budget', '1200.5', setup)).toBe(1200.5);
    expect(sampleValueOf('contact.spend', '12', setup)).toBe(12);
    expect(sampleValueOf('contact.budget', 'lots', setup)).toBe('lots');
    expect(sampleValueOf('deal.value', '300', setup)).toBe(300);
    expect(sampleValueOf('contact.vip', 'Yes', setup)).toBe(true);
    expect(sampleValueOf('contact.vip', 'false', setup)).toBe(false);
    expect(sampleValueOf('contact.vip', 'maybe', setup)).toBe('maybe');
    // A phone number stays the text it is.
    expect(sampleValueOf('contact.phone', '0712345678', setup)).toBe('0712345678');
    expect(sampleValueOf('contact.firstName', '   ', setup)).toBeUndefined();
  });

  it('builds a request the contract accepts, with only what was filled in', () => {
    expect(testRunBody(undefined, [], [], harborSetup)).toEqual({});
    const body = testRunBody(
      'con_01k8e2wzr0e008000000000031',
      [
        { field: 'contact.firstName', value: 'Sam' },
        { field: 'contact.services', value: '' },
        { field: '', value: 'lost' },
      ],
      [
        { event: 'message.received', amount: 1, unit: 'days' },
        { event: 'appointment.booked', amount: 90, unit: 'minutes' },
        { event: 'deal.closed', amount: undefined, unit: 'hours' },
        { event: 'deal.closed', amount: 0, unit: 'hours' },
        { event: '', amount: 2, unit: 'hours' },
      ],
      harborSetup,
    );
    expect(body).toEqual({
      contactId: 'con_01k8e2wzr0e008000000000031',
      values: { 'contact.firstName': 'Sam' },
      events: [
        { event: 'message.received', after: 'P1D' },
        { event: 'appointment.booked', after: 'PT90M' },
      ],
    });
    expect(createAutomationTestRunInput.safeParse(body).success).toBe(true);
  });
});
