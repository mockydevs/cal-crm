// A test run of the steps that start and end other automations: what a real run would do is
// described, with the outcome that can be known beforehand, and nothing is started or
// ended.
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { simulateAutomation, type SimulatedAutomation } from './simulate.js';
import { planStep } from './steps.js';

const automations: readonly SimulatedAutomation[] = [
  { id: 'aut_booked', name: 'Consultation booked', active: true },
  { id: 'aut_pre', name: 'Pre-consultation', active: true },
  { id: 'aut_paused', name: 'Old follow-up', active: false },
  { id: 'aut_education', name: 'Education', active: true },
];

const run = (
  steps: AutomationDocumentInput['steps'],
  start: string,
  known: { automations?: readonly SimulatedAutomation[]; automationId?: string } = {
    automations,
    automationId: 'aut_booked',
  },
) =>
  simulateAutomation({
    document: automationDocument.parse({
      name: 'Consultation booked',
      triggers: [{ id: 'booked', type: 'appointment.booked', config: {} }],
      start,
      steps,
    }),
    values: {},
    events: [],
    start: new Date('2026-10-09T09:00:00Z'),
    timeZone: 'UTC',
    enrolmentId: 't',
    ...known,
  });

const after = { type: 'wait', config: { duration: 'PT1M' } } as const;

describe('a test run of a step that starts another automation', () => {
  it('says which automation it would start, and goes on', () => {
    const trace = run(
      { go: { type: 'automation.run', config: { automation: 'aut_pre' }, next: 'after' }, after },
      'go',
    );
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps[0]).toEqual({
      step: 'go',
      type: 'automation.run',
      kind: 'would_change',
      at: new Date('2026-10-09T09:00:00Z'),
      explanation: 'Would start "Pre-consultation"; nothing is started in a test run.',
      simulated: true,
      output: { outcome: 'started' },
    });
    expect(trace.steps.map((step) => step.step)).toEqual(['go', 'after']);
  });

  it('says so when what it would start is not active, or is the automation itself', () => {
    const trace = run(
      {
        old: { type: 'automation.run', config: { automation: 'aut_paused' }, next: 'again' },
        again: { type: 'automation.run', config: { automation: 'aut_booked' } },
      },
      'old',
    );
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((step) => [step.step, step.output, step.explanation])).toEqual([
      ['old', { outcome: 'not_active' }, 'Would start nothing: "Old follow-up" is not active.'],
      [
        'again',
        { outcome: 'refused_loop' },
        'Would start nothing: "Consultation booked" is this automation, and one never starts itself.',
      ],
    ]);
  });

  it('fails where a real run would, at an automation the business does not have', () => {
    const trace = run(
      { go: { type: 'automation.run', config: { automation: 'aut_gone' }, next: 'after' }, after },
      'go',
    );
    expect(trace.steps).toEqual([]);
    expect(trace.outcome).toEqual({ kind: 'failed', step: 'go', error: 'unknown_reference' });
  });

  it('describes the step without naming anything when it is told of no automations', () => {
    const trace = run(
      { go: { type: 'automation.run', config: { automation: 'aut_pre' } } },
      'go',
      {},
    );
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps).toMatchObject([
      {
        step: 'go',
        kind: 'would_change',
        explanation: 'Would start another automation; nothing is sent or changed in a test run.',
      },
    ]);
    expect(trace.steps[0]).not.toHaveProperty('output');
  });
});

describe('a test run of a step that removes the contact from automations', () => {
  const removal = (config: Record<string, unknown>, known?: Parameters<typeof run>[2]) =>
    run(
      {
        clear: { type: 'automation.remove', config, next: 'after' } as never,
        after,
      },
      'clear',
      known,
    );

  it('ends nothing and goes on when its own run is not among them', () => {
    const others = removal({ from: 'all_others', except: ['aut_education'] });
    expect(others.outcome).toEqual({ kind: 'completed' });
    expect(others.steps.map((step) => [step.step, step.kind])).toEqual([
      ['clear', 'would_change'],
      ['after', 'waited'],
    ]);
    expect(others.steps[0]?.explanation).toBe(
      'Would remove the contact from every other automation, except "Education"; no run is ended in a test run.',
    );
    expect(removal({ from: 'all_others' }).steps[0]?.explanation).toBe(
      'Would remove the contact from every other automation; no run is ended in a test run.',
    );
    const listed = removal({ from: 'automations', automations: ['aut_pre', 'aut_unlisted'] });
    expect(listed.steps.map((step) => step.step)).toEqual(['clear', 'after']);
    expect(listed.steps[0]?.explanation).toBe(
      'Would remove the contact from "Pre-consultation", "aut_unlisted"; no run is ended in a test run.',
    );
    // All but itself: its own automation is excepted, so it goes on.
    const spared = removal({ from: 'all', except: ['aut_booked'] });
    expect(spared.steps.map((step) => step.step)).toEqual(['clear', 'after']);
    expect(spared.steps[0]?.explanation).toBe(
      'Would remove the contact from every automation, except "Consultation booked"; no run is ended in a test run.',
    );
  });

  it('ends the test run at the step when a real run would end there', () => {
    for (const config of [
      { from: 'current' },
      { from: 'all' },
      { from: 'all', except: ['aut_education'] },
      { from: 'automations', automations: ['aut_booked'] },
    ]) {
      const trace = removal(config);
      expect(trace.outcome, JSON.stringify(config)).toEqual({ kind: 'completed' });
      expect(trace.steps.map((step) => [step.step, step.kind])).toEqual([['clear', 'ended']]);
      expect(trace.steps[0]?.explanation).toMatch(/A real run would end here\.$/);
    }
    expect(removal({ from: 'current' }).steps[0]?.explanation).toBe(
      'Would remove the contact from this automation; no run is ended in a test run. A real run would end here.',
    );
  });

  it('reads a removal from all as ending the run when it is not told which automation it is', () => {
    const all = removal({ from: 'all', except: ['aut_booked'] }, {});
    expect(all.steps.map((step) => [step.step, step.kind])).toEqual([['clear', 'ended']]);
    expect(all.steps[0]?.explanation).toBe(
      'Would remove the contact from every automation, except "aut_booked"; no run is ended in a test run. A real run would end here.',
    );
    // Listed automations can't be told to include its own, so it goes on.
    const listed = removal({ from: 'automations', automations: ['aut_booked'] }, {});
    expect(listed.steps.map((step) => step.step)).toEqual(['clear', 'after']);
  });
});

describe('the planner', () => {
  it('never performs either step: the engine runs them', () => {
    for (const step of [
      { type: 'automation.run', config: { automation: 'aut_pre' } },
      { type: 'automation.remove', config: { from: 'current' } },
    ] as const)
      expect(
        planStep({
          key: 'x',
          step,
          values: {},
          now: new Date('2026-10-09T09:00:00Z'),
          timeZone: 'UTC',
          enrolmentId: 't',
        }),
      ).toEqual({
        kind: 'fail',
        error: 'not_implemented',
        explanation: `${step.type} steps are run by the engine, not planned.`,
      });
  });
});
