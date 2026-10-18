// A test run of the steps that find, create and change a deal: which deal each would act
// on, and the deal in hand kept in the run's own values for the conditions after.
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';
import type { SimulatedDeals } from './simulate-deals.js';

const roof = {
  id: 'deal_roof',
  values: {
    'deal.name': 'Roof repair',
    'deal.status': 'open',
    'deal.stage': 'New',
    'deal.pipeline': 'Sales',
    'deal.value': 5000,
  },
};
const names = { pip_sales: 'Sales', stg_new: 'New', stg_booked: 'Booked' };

const run = (
  steps: AutomationDocumentInput['steps'],
  start: string,
  deals?: SimulatedDeals,
  values: Record<string, string | number | null> = { 'contact.name': 'Ada Lovelace' },
) =>
  simulateAutomation({
    document: automationDocument.parse({
      name: 'Deals',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start,
      steps,
    }),
    values,
    events: [],
    start: new Date('2026-10-12T09:00:00Z'),
    timeZone: 'UTC',
    enrolmentId: 't',
    ...(deals === undefined ? {} : { deals }),
  });

const isBig = {
  type: 'condition',
  config: { if: { field: 'deal.value', operator: 'greater_than', value: 1000 } },
} as const;

describe('a test run of deal.find', () => {
  it('takes found with the deal in hand, which the steps after read and act on', () => {
    const trace = run(
      {
        find: {
          type: 'deal.find',
          config: { status: 'open', nameContains: 'roof' },
          next: { found: 'big', not_found: 'open' },
        },
        big: { ...isBig, next: { yes: 'move' } },
        move: { type: 'deal.move', config: { stage: 'stg_booked' }, next: 'booked' },
        booked: {
          type: 'condition',
          config: { if: { field: 'deal.stage', operator: 'equals', value: 'Booked' } },
          next: { yes: 'close' },
        },
        close: { type: 'deal.close', config: { outcome: 'won' }, next: 'won' },
        won: {
          type: 'condition',
          config: { if: { field: 'deal.status', operator: 'equals', value: 'won' } },
        },
        open: { type: 'deal.create', config: { pipeline: 'pip_sales', stage: 'stg_new' } },
      },
      'find',
      { found: { find: roof }, names },
    );
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((step) => [step.step, step.kind, step.branch])).toEqual([
      ['find', 'branched', 'found'],
      ['big', 'branched', 'yes'],
      ['move', 'would_change', undefined],
      ['booked', 'branched', 'yes'],
      ['close', 'would_change', undefined],
      ['won', 'branched', 'yes'],
    ]);
    expect(trace.steps[0]).toMatchObject({
      simulated: true,
      output: { dealId: 'deal_roof' },
      explanation:
        'Would find "Roof repair", the newest of the contact\'s deals that pass now (status open, a name containing "roof"), and take it in hand: the deal steps after it act on it.',
    });
    expect(trace.steps[2]?.explanation).toBe(
      'Would move "Roof repair", the deal the run has in hand, to the stage. Nothing is changed in a test run.',
    );
    expect(trace.steps[4]?.explanation).toBe(
      'Would close "Roof repair", the deal the run has in hand, as won. Nothing is changed in a test run.',
    );
  });

  it('takes not_found when none passes now, and when the test has no contact', () => {
    const steps: AutomationDocumentInput['steps'] = {
      find: { type: 'deal.find', config: {}, next: { not_found: 'open' } },
      open: { type: 'deal.create', config: { pipeline: 'pip_sales', stage: 'stg_new' } },
    };
    const none = run(steps, 'find', { found: { find: null }, names });
    expect(none.steps.map((step) => [step.step, step.branch])).toEqual([
      ['find', 'not_found'],
      ['open', undefined],
    ]);
    expect(none.steps[0]?.explanation).toBe(
      "None of the contact's deals passes now (no filter), so it takes the not_found branch.",
    );
    const sample = run(steps, 'find');
    expect(sample.steps[0]).toMatchObject({
      branch: 'not_found',
      explanation:
        "Would look for the newest of the contact's deals that pass (no filter). A test run without a contact has no deals to look through, so it takes the not_found branch.",
    });
    expect(sample.steps[0]?.output).toBeUndefined();
  });

  it('ends the path of a branch that leads nowhere', () => {
    const trace = run({ find: { type: 'deal.find', config: {} } }, 'find', {
      found: { find: roof },
    });
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps).toHaveLength(1);
  });
});

describe('a test run of the steps that make and change a deal', () => {
  it('takes a created deal in hand, with what the step gives it', () => {
    const trace = run(
      {
        open: {
          type: 'deal.create',
          config: {
            pipeline: 'pip_sales',
            stage: 'stg_new',
            name: 'Renewal for {{contact.name}}',
            amount: 2500,
          },
          next: 'big',
        },
        big: { ...isBig, next: { yes: 'update' } },
        update: {
          type: 'deal.update',
          config: {
            name: '{{deal.name}} (2027)',
            amount: 300,
            source: 'Workflow',
            owner: 'mem_amina',
            expectedCloseDate: { in: 'P30D' },
            fields: { 'deal.custom.service': 'video' },
          },
          next: 'small',
        },
        small: { ...isBig, next: { no: 'note' } },
        note: { type: 'note.create', config: { text: '{{deal.name}} in {{deal.stage}}' } },
      },
      'open',
      { found: {}, names },
    );
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((step) => [step.step, step.branch])).toEqual([
      ['open', undefined],
      ['big', 'yes'],
      ['update', undefined],
      ['small', 'no'],
      ['note', undefined],
    ]);
    expect(trace.steps[0]).toMatchObject({
      kind: 'would_change',
      output: { dealId: 'simulated:deal:open:1' },
    });
    expect(trace.steps[2]).toMatchObject({
      output: { dealId: 'simulated:deal:open:1' },
      explanation:
        'Would update "Renewal for Ada Lovelace", the deal the run has in hand: name, value, source, service, owner, expectedCloseDate. Nothing is changed in a test run.',
    });
  });

  it('says it cannot know the deal when none is in hand', () => {
    const trace = run(
      {
        move: { type: 'deal.move', config: { stage: 'stg_booked' }, next: 'close' },
        close: { type: 'deal.close', config: { outcome: 'won' }, next: 'update' },
        update: { type: 'deal.update', config: { status: 'open' } },
      },
      'move',
    );
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((step) => step.explanation)).toEqual([
      "Would move the contact's one open deal: which deal that is, and whether there is exactly one, is read when the step really runs, to the stage. Nothing is changed in a test run.",
      "Would close the contact's one open deal: which deal that is, and whether there is exactly one, is read when the step really runs, as won. Nothing is changed in a test run.",
      "Would update the contact's one open deal: which deal that is, and whether there is exactly one, is read when the step really runs: status. Nothing is changed in a test run.",
    ]);
  });

  it('fails where a real run would: a name with a merge field that has no value', () => {
    const trace = run(
      {
        open: {
          type: 'deal.create',
          config: { pipeline: 'pip_sales', stage: 'stg_new', name: 'For {{contact.lastName}}' },
        },
      },
      'open',
    );
    expect(trace.outcome).toEqual({ kind: 'failed', step: 'open', error: 'missing_values' });
  });

  it('reads an amount from a field, and leaves the value when the field is empty', () => {
    const steps: AutomationDocumentInput['steps'] = {
      find: { type: 'deal.find', config: {}, next: { found: 'update' } },
      update: {
        type: 'deal.update',
        config: { amountFrom: 'contact.custom.budget' },
        next: 'big',
      },
      big: isBig,
    };
    const filled = run(
      steps,
      'find',
      { found: { find: roof }, names },
      {
        'contact.custom.budget': 50,
      },
    );
    expect(filled.steps.at(-1)?.branch).toBe('no');
    const empty = run(steps, 'find', { found: { find: roof }, names }, {});
    expect(empty.steps.at(-1)?.branch).toBe('yes');
  });
});
