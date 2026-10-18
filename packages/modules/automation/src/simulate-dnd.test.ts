import { automationDocument } from '@repo/contracts';
import { expect, it } from 'vitest';
import { simulateAutomation } from './simulate.js';

it.each([
  { values: {}, error: 'missing_values' },
  { values: { 'contact.firstName': 'Ada' }, error: 'too_small' },
  { values: { 'contact.firstName': 'x'.repeat(1001) }, error: 'too_big' },
  { values: { 'contact.firstName': 'Asked by phone to stop messages.' }, error: undefined },
])('validates the rendered DND reason without changing contact state %#', ({ values, error }) => {
  const trace = simulateAutomation({
    document: automationDocument.parse({
      name: 'DND reason',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'restrict',
      steps: {
        restrict: {
          type: 'dnd.set',
          config: { channel: 'sms', action: 'enable', reason: '{{contact.firstName}}' },
        },
      },
    }),
    values,
    events: [],
    start: new Date('2031-03-01T09:00:00Z'),
    timeZone: 'UTC',
    enrolmentId: 'sample',
  });
  expect(trace.outcome).toEqual(
    error === undefined ? { kind: 'completed' } : { kind: 'failed', step: 'restrict', error },
  );
  expect(trace.steps.map((step) => step.step)).toEqual(error === undefined ? ['restrict'] : []);
  if (error === undefined) expect(trace.steps[0]).not.toHaveProperty('output');
});
