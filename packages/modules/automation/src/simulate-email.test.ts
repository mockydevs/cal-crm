// A test run of a Send email step fills the email in for the contact, as a send does, and
// stops where a send would stop.
import { automationDocument, type FieldDefinition } from '@repo/contracts';
import type { FieldNormalizationContext } from '@repo/module-crm';
import { expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';

const start = new Date('2026-10-14T09:00:00Z');
const HELPER = 'contact.custom.clean_plain_text_service_interest';
const STILL = {
  subject: 'Your {{contact.firstName}} event',
  text: '\n  Are you still in need of a {{contact.clean_plain_text_service_interest}} team?\nThanks',
};

const field = (key: string, valueType: FieldDefinition['valueType']): FieldDefinition => ({
  id: `field_${key}`,
  objectKey: 'contact',
  key,
  label: key,
  description: '',
  valueType,
  currency: null,
  revision: '1',
  archived: false,
  aiFillSources: [],
  aiOverwrite: 'never',
  options: [],
});
const fields: FieldNormalizationContext = {
  definitions: [
    field('service_interest', 'text'),
    field('clean_plain_text_service_interest', 'text'),
  ],
  aliases: [],
  country: 'US',
};

const mapThenEmail = (onFailure?: 'continue') =>
  automationDocument.parse({
    name: 'Map, then email',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'which',
    steps: {
      which: {
        type: 'condition',
        config: {
          branches: [
            {
              name: 'all',
              if: { field: 'contact.custom.service_interest', operator: 'equals', value: 'all' },
            },
          ],
        },
        next: { all: 'set_all', none: 'still' },
      },
      set_all: {
        type: 'contact.update',
        config: { fields: { [HELPER]: 'DJ, photo, and video' } },
        next: 'still',
      },
      still: {
        type: 'email.send',
        config: { template: 'tpl_01m4x6000000000000000000000' },
        ...(onFailure === undefined ? {} : { onFailure, next: 'after' }),
      },
      ...(onFailure === undefined
        ? {}
        : { after: { type: 'tag.add', config: { tag: 'tag_01m4x6000000000000000000000' } } }),
    },
  });

it('fills the email in from values the run wrote earlier, under the field’s merge key', () => {
  const trace = simulateAutomation({
    document: mapThenEmail(),
    values: {
      'contact.firstName': 'Ada',
      'contact.custom.service_interest': 'all',
      [HELPER]: null,
    },
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
    fields,
    emails: { still: STILL },
  });
  expect(trace.outcome).toEqual({ kind: 'completed' });
  expect(trace.steps.at(-1)).toMatchObject({
    step: 'still',
    kind: 'would_send',
    explanation: 'Would send the email "Your Ada event"; nothing is sent in a test run.',
    email: {
      subject: 'Your Ada event',
      firstLine: 'Are you still in need of a DJ, photo, and video team?',
      missingValues: [],
    },
  });
});

it('fails the step as a send would when a merge field has no value, and names it', () => {
  const trace = simulateAutomation({
    document: mapThenEmail(),
    values: { 'contact.firstName': 'Ada', 'contact.custom.service_interest': null, [HELPER]: null },
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
    fields,
    emails: { still: STILL },
  });
  expect(trace.outcome).toEqual({ kind: 'failed', step: 'still', error: 'missing_values' });
  expect(trace.steps.at(-1)).toMatchObject({
    step: 'still',
    kind: 'ended',
    explanation: expect.stringContaining(
      'no value for contact.clean_plain_text_service_interest, so a real send would stop here (missing_values)',
    ) as string,
    email: { missingValues: ['contact.clean_plain_text_service_interest'] },
  });
});

it('goes on where the step says a failure goes on, keeping the email it could not send', () => {
  const trace = simulateAutomation({
    document: mapThenEmail('continue'),
    values: { 'contact.firstName': 'Ada', 'contact.custom.service_interest': null, [HELPER]: null },
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
    fields,
    emails: { still: STILL },
  });
  expect(trace.outcome).toEqual({ kind: 'completed' });
  const still = trace.steps.find((each) => each.step === 'still');
  expect(still?.email?.missingValues).toEqual(['contact.clean_plain_text_service_interest']);
  expect(still?.explanation).toContain('Would fail here (missing_values).');
});

it('fails as a send does when the template is gone, and describes a step it was not given', () => {
  const gone = simulateAutomation({
    document: mapThenEmail(),
    values: {},
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
    emails: { still: 'unavailable' },
  });
  expect(gone.outcome).toEqual({ kind: 'failed', step: 'still', error: 'template_unavailable' });
  const described = simulateAutomation({
    document: mapThenEmail(),
    values: {},
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
  });
  expect(described.steps.at(-1)).toMatchObject({ step: 'still', kind: 'would_send' });
  expect(described.steps.at(-1)?.email).toBeUndefined();
});
