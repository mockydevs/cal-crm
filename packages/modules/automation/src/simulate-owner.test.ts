// A test run of the steps that give a contact an owner: who would be next in turn is said,
// a contact that has an owner is left alone when the step says so, and no turn is used.
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';

const run = (
  steps: AutomationDocumentInput['steps'],
  start: string,
  ownership?: { hasOwner: boolean; turns: Record<string, number> },
) =>
  simulateAutomation({
    document: automationDocument.parse({
      name: 'Share the leads',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start,
      steps,
    }),
    values: {},
    events: [],
    start: new Date('2026-10-12T09:00:00Z'),
    timeZone: 'UTC',
    enrolmentId: 't',
    ...(ownership === undefined ? {} : { ownership }),
  });

const users = ['mem_a', 'mem_b', 'mem_c'];

describe('a test run of owner.assign', () => {
  it('names the member whose turn it is, from the place kept for the step', () => {
    const trace = run({ assign: { type: 'owner.assign', config: { users } } }, 'assign', {
      hasOwner: false,
      turns: { assign: 4 },
    });
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps).toEqual([
      {
        step: 'assign',
        type: 'owner.assign',
        kind: 'would_change',
        at: new Date('2026-10-12T09:00:00Z'),
        explanation:
          "Would make the next team member in turn the contact's owner: number 2 of 3. Who is still on the team is read when the step really runs. Nothing is changed in a test run, and no turn is used.",
        simulated: true,
        output: { membershipId: 'mem_b' },
      },
    ]);
  });

  it('starts at the first member when no turn has been taken, or none is known', () => {
    const trace = run({ assign: { type: 'owner.assign', config: { users } } }, 'assign');
    expect(trace.steps[0]?.output).toEqual({ membershipId: 'mem_a' });
  });

  it('moves on within the run when a path comes to the step again', () => {
    const trace = run(
      {
        assign: { type: 'owner.assign', config: { users }, next: 'pause' },
        pause: { type: 'wait', config: { duration: 'PT1M' }, next: 'again' },
        again: { type: 'goto', config: { target: 'assign' } },
      },
      'assign',
    );
    const given = trace.steps.filter((step) => step.step === 'assign').slice(0, 4);
    expect(given.map((step) => step.output?.['membershipId'])).toEqual([
      'mem_a',
      'mem_b',
      'mem_c',
      'mem_a',
    ]);
  });

  it('leaves the owner in place when the step keeps one', () => {
    const steps: AutomationDocumentInput['steps'] = {
      assign: { type: 'owner.assign', config: { users, onlyIfUnassigned: true } },
    };
    const kept = run(steps, 'assign', { hasOwner: true, turns: {} });
    expect(kept.steps[0]).toMatchObject({
      kind: 'would_change',
      explanation:
        'Would leave the owner in place: the contact already has one, and this step is set to keep it. Nothing is changed in a test run, and no turn is used.',
    });
    expect(kept.steps[0]?.output).toBeUndefined();
    expect(run(steps, 'assign', { hasOwner: false, turns: {} }).steps[0]?.output).toEqual({
      membershipId: 'mem_a',
    });
  });

  it('knows what its own earlier steps did to the owner', () => {
    const trace = run(
      {
        first: { type: 'owner.assign', config: { user: 'mem_x' }, next: 'second' },
        second: {
          type: 'owner.assign',
          config: { users, onlyIfUnassigned: true },
          next: 'clear',
        },
        clear: { type: 'owner.remove', config: {}, next: 'third' },
        third: { type: 'owner.assign', config: { users, onlyIfUnassigned: true } },
      },
      'first',
    );
    expect(trace.steps.map((step) => step.output)).toEqual([
      { membershipId: 'mem_x' },
      undefined,
      undefined,
      { membershipId: 'mem_a' },
    ]);
    expect(trace.steps[0]?.explanation).toBe(
      "Would make the step's team member the contact's owner. Nothing is changed in a test run, and no turn is used.",
    );
  });
});
