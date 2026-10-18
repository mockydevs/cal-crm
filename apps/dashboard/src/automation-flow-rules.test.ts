import { i18n } from '@lingui/core';
import {
  automationGoalEvents,
  automationStepTypes,
  MAX_CONDITION_BRANCHES,
  MAX_GOAL_EVENTS,
} from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  branchesOf,
  canAddBranch,
  canAddGoalEvent,
  goalEventFields,
  goalEventsOf,
  movedBranch,
  namedFrom,
  newBranchName,
  nextGoalEvent,
  withBranch,
  withGoalFilter,
  writtenBranches,
} from './automation-flow-rules';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const hasEmail = { field: 'contact.email', operator: 'is_set' };
const accepts = (type: 'condition' | 'goal', config: unknown): boolean =>
  automationStepTypes[type].config.safeParse(config).success;

describe("an If / else's own branches", () => {
  const three = [
    { name: 'hot', label: 'Hot lead', if: hasEmail },
    { name: 'warm', label: undefined, if: hasEmail },
    { name: 'cold', label: undefined, if: hasEmail },
  ];

  it('reads them in the order written, and writes them as the contract takes them', () => {
    const config = { branches: [{ name: 'hot', label: 'Hot lead', if: hasEmail }, 7, {}] };
    expect(branchesOf(config)).toEqual([three[0]]);
    expect(branchesOf({})).toEqual([]);
    expect(writtenBranches(three)).toEqual([
      { name: 'hot', label: 'Hot lead', if: hasEmail },
      { name: 'warm', if: hasEmail },
      { name: 'cold', if: hasEmail },
    ]);
    expect(writtenBranches([{ name: 'hot', label: '  ', if: hasEmail }])).toEqual([
      { name: 'hot', if: hasEmail },
    ]);
    expect(accepts('condition', { branches: writtenBranches(three) })).toBe(true);
  });

  it('moves one a place up or down, and leaves the ends where they are', () => {
    const names = (branches: readonly { name: string }[]): string[] =>
      branches.map((each) => each.name);
    expect(names(movedBranch(three, 2, -1))).toEqual(['hot', 'cold', 'warm']);
    expect(names(movedBranch(three, 0, 1))).toEqual(['warm', 'hot', 'cold']);
    expect(names(movedBranch(three, 0, -1))).toEqual(['hot', 'warm', 'cold']);
    expect(names(movedBranch(three, 2, 1))).toEqual(['hot', 'warm', 'cold']);
  });

  it('adds one with a key no other has, never the None branch, up to ten', () => {
    expect(newBranchName([])).toBe('branch_1');
    expect(newBranchName(['branch_2', 'yes'])).toBe('branch_3');
    expect(newBranchName(['branch_2'])).toBe('branch_3');
    const added = withBranch(three);
    expect(added).toHaveLength(4);
    expect(added[3]).toEqual({
      name: 'branch_4',
      label: undefined,
      if: { field: '', operator: 'equals' },
    });
    const full = Array.from({ length: MAX_CONDITION_BRANCHES }, (_, index) => ({
      name: `b${String(index)}`,
      label: undefined,
      if: hasEmail,
    }));
    expect(canAddBranch(full)).toBe(false);
    expect(withBranch(full)).toHaveLength(MAX_CONDITION_BRANCHES);
    expect(canAddBranch(three)).toBe(true);
  });

  it('turns a yes and no condition into a first branch that keeps the name yes', () => {
    expect(writtenBranches(namedFrom(hasEmail))).toEqual([{ name: 'yes', if: hasEmail }]);
    expect(accepts('condition', { branches: writtenBranches(namedFrom(hasEmail)) })).toBe(true);
  });
});

describe('the events that meet a goal', () => {
  it('reads what is written, and builds what the contract takes', () => {
    expect(goalEventsOf([{ type: 'tag.added', config: { tag: 'tag_vip' } }, 7, {}])).toEqual([
      { type: 'tag.added', config: { tag: 'tag_vip' } },
    ]);
    expect(goalEventsOf(undefined)).toEqual([]);
    const booked = nextGoalEvent([]);
    expect(booked).toEqual({ type: automationGoalEvents[0], config: {} });
    const tag = withGoalFilter({ type: 'tag.added', config: {} }, 'tag', 'tag_vip');
    expect(accepts('goal', { events: [tag], otherwise: 'wait' })).toBe(true);
    expect(withGoalFilter(tag, 'tag', '')).toEqual({ type: 'tag.added', config: {} });
    expect(withGoalFilter(tag, 'tag', undefined)).toEqual({ type: 'tag.added', config: {} });
  });

  it('offers a new row the first event not listed yet, and stops at ten', () => {
    expect(nextGoalEvent([{ type: automationGoalEvents[0], config: {} }]).type).toBe(
      automationGoalEvents[1],
    );
    const all = automationGoalEvents.map((type) => ({ type, config: {} }));
    expect(nextGoalEvent(all).type).toBe(automationGoalEvents[0]);
    expect(canAddGoalEvent(all.slice(0, MAX_GOAL_EVENTS - 1))).toBe(true);
    expect(canAddGoalEvent(Array.from({ length: MAX_GOAL_EVENTS }))).toBe(false);
  });

  it("gives each event its trigger's filters, and a message only its channel", () => {
    const keys = (type: string): string[] => goalEventFields(type).map((field) => field.key);
    expect(keys('form.submitted')).toEqual(['form']);
    expect(keys('message.received')).toEqual(['channel']);
    expect(keys('deal.stage_changed')).toEqual(['pipeline', 'stage']);
    expect(keys('appointment.status_changed')).toEqual(['calendar', 'status']);
    // What the value changes to is written in the JSON view.
    expect(keys('field.changed')).toEqual(['field']);
    expect(keys('unknown')).toEqual([]);
    for (const type of automationGoalEvents) expect(Array.isArray(keys(type))).toBe(true);
  });
});
