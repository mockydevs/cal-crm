import { automationDocument } from '@repo/contracts';
import { expect, it } from 'vitest';
import { simulateAutomation } from './simulate.js';

it('refuses the invalid built-in phone before an unknown custom field', () => {
  const trace = simulateAutomation({
    document: automationDocument.parse({
      name: 'First refusal',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'change',
      steps: {
        change: {
          type: 'contact.update',
          config: { fields: { 'contact.custom.missing': 'new', 'contact.phone': '+254' } },
        },
      },
    }),
    values: {},
    events: [],
    start: new Date('2031-03-01T09:00:00Z'),
    timeZone: 'UTC',
    enrolmentId: 'sample',
    fields: { definitions: [], aliases: [], country: 'KE' },
  });
  expect(trace.outcome).toEqual({ kind: 'failed', step: 'change', error: 'phone_invalid' });
  expect(trace.steps).toEqual([]);
});

it.each([
  { phone: '+254 712 345678', country: undefined, error: undefined },
  { phone: '0712345678', country: 'KE', error: undefined },
  { phone: '0712345678', country: undefined, error: 'phone_country_unknown' },
  { phone: '+254', country: 'KE', error: 'phone_invalid' },
  { phone: '+254712345678 ext. 42', country: 'KE', error: 'phone_extension' },
] as const)(
  'normalizes or refuses a primary phone before downstream routing %#',
  ({ phone, country, error }) => {
    const values = Object.freeze({ 'contact.phone': '+254722345678' });
    const trace = simulateAutomation({
      document: automationDocument.parse({
        name: 'Phone route',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'change',
        steps: {
          change: {
            type: 'contact.update',
            config: { fields: { 'contact.phone': phone } },
            next: 'check',
          },
          check: {
            type: 'condition',
            config: { if: { field: 'contact.phone', operator: 'equals', value: '+254712345678' } },
            next: { yes: 'matched', no: 'stale' },
          },
          matched: { type: 'wait', config: { duration: 'PT1S' } },
          stale: { type: 'wait', config: { duration: 'PT1S' } },
        },
      }),
      values,
      events: [],
      start: new Date('2031-03-01T09:00:00Z'),
      timeZone: 'UTC',
      enrolmentId: 'sample',
      fields: { definitions: [], aliases: [], country },
    });
    expect(trace.outcome).toEqual(
      error === undefined ? { kind: 'completed' } : { kind: 'failed', step: 'change', error },
    );
    expect(trace.steps.map((step) => step.step)).toEqual(
      error === undefined ? ['change', 'check', 'matched'] : [],
    );
    expect(values).toEqual({ 'contact.phone': '+254722345678' });
  },
);
