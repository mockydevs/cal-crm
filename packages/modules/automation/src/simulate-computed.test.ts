// A test run of contact.update with copied and computed values: the same writes a real run
// would plan, made to the run's own values only, so later steps read what was written.
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import type { FieldNormalizationContext } from '@repo/module-crm';
import { describe, expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';

const definition = (key: string, valueType: string, options: unknown[] = []) =>
  ({
    id: `fld_${key}`,
    objectKey: 'contact',
    key,
    label: key,
    description: '',
    valueType,
    options,
    currency: null,
    archived: false,
    revision: 'r',
    mergeKey: `contact.${key}`,
  }) as unknown as FieldNormalizationContext['definitions'][number];

const fields: FieldNormalizationContext = {
  definitions: [
    definition('utm_source', 'text'),
    definition('lead_source_raw', 'text'),
    definition('visits', 'number'),
    definition('renewal', 'date'),
  ],
  aliases: [],
  country: undefined,
};

const run = (steps: AutomationDocumentInput['steps'], values: Record<string, unknown>) =>
  simulateAutomation({
    document: automationDocument.parse({
      name: 'Work out values',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'set',
      steps,
    }),
    values: values as Parameters<typeof simulateAutomation>[0]['values'],
    events: [],
    start: new Date('2026-10-12T09:00:00Z'),
    timeZone: 'Africa/Nairobi',
    enrolmentId: 't',
    fields,
  });

const facebook = {
  type: 'condition',
  config: {
    if: { field: 'contact.custom.lead_source_raw', operator: 'includes', value: 'facebook' },
  },
} as const;

describe('a test run of computed and copied values', () => {
  it('writes them to its own values, so a later condition reads the copy', () => {
    const trace = run(
      {
        set: {
          type: 'contact.update',
          config: {
            fields: {
              'contact.custom.lead_source_raw': '{{contact.custom.utm_source}}',
              'contact.custom.visits': {
                op: 'math',
                left: 'contact.custom.visits',
                operator: '+',
                right: 1,
              },
              'contact.custom.renewal': { op: 'date_add', days: 365 },
            },
          },
          next: 'from_facebook',
        },
        from_facebook: { ...facebook, next: { yes: 'often' } },
        often: {
          type: 'condition',
          config: {
            if: { field: 'contact.custom.visits', operator: 'greater_than', value: 4 },
          },
          next: { yes: 'due' },
        },
        due: {
          type: 'condition',
          config: {
            if: { field: 'contact.custom.renewal', operator: 'after', value: '2027-10-11' },
          },
        },
      },
      { 'contact.custom.utm_source': 'facebook_ads', 'contact.custom.visits': 4 },
    );
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((step) => [step.step, step.kind, step.branch])).toEqual([
      ['set', 'would_change', undefined],
      ['from_facebook', 'branched', 'yes'],
      ['often', 'branched', 'yes'],
      ['due', 'branched', 'yes'],
    ]);
    expect(trace.steps[0]?.explanation).toBe(
      'Would update contact; nothing is sent or changed in a test run.',
    );
  });

  it('says what it would leave alone', () => {
    const trace = run(
      {
        set: {
          type: 'contact.update',
          config: {
            fields: {
              'contact.custom.lead_source_raw': {
                set: '{{contact.custom.utm_source}}',
                onlyIfEmpty: true,
              },
            },
          },
          next: 'from_facebook',
        },
        from_facebook: facebook,
      },
      { 'contact.custom.utm_source': 'facebook', 'contact.custom.lead_source_raw': 'referral' },
    );
    expect(trace.steps[0]?.explanation).toBe(
      'Would change no field. contact.custom.lead_source_raw already has a value, so it was left as it was.',
    );
    expect(trace.steps[1]?.branch).toBe('no');
  });

  it('fails where a real run would, with the same code', () => {
    const divided = run(
      {
        set: {
          type: 'contact.update',
          config: {
            fields: {
              'contact.custom.visits': {
                op: 'math',
                left: 10,
                operator: '/',
                right: 'contact.custom.visits',
              },
            },
          },
        },
      },
      { 'contact.custom.visits': 0 },
    );
    expect(divided.outcome).toEqual({ kind: 'failed', step: 'set', error: 'division_by_zero' });
    const misfit = run(
      {
        set: {
          type: 'contact.update',
          config: { fields: { 'contact.custom.visits': 'about {{contact.firstName}}' } },
        },
      },
      { 'contact.firstName': 'Ada' },
    );
    expect(misfit.outcome).toEqual({ kind: 'failed', step: 'set', error: 'invalid_value' });
  });

  it('goes on past a failed step that is set to go on', () => {
    const trace = run(
      {
        set: {
          type: 'contact.update',
          config: { fields: { 'contact.custom.lead_source_raw': 'From {{contact.custom.gone}}' } },
          onFailure: 'continue',
          next: 'from_facebook',
        },
        from_facebook: facebook,
      },
      {},
    );
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps[0]?.explanation).toContain('Would fail here (missing_values).');
  });
});
