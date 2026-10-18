import { expect, it } from 'vitest';
import { selectRoundRobinMember, type RoundRobinCandidate } from './assignment-policy.js';

function candidate(
  userId: string,
  changes: Partial<Omit<RoundRobinCandidate, 'userId'>> = {},
): RoundRobinCandidate {
  return {
    userId,
    available: true,
    order: 0,
    priority: 'medium',
    weight: 1,
    weightedCount: 0n,
    monthlyCount: 0n,
    ...changes,
  };
}

it('prefers an available high-priority member over earlier medium and unavailable high members', () => {
  expect(
    selectRoundRobinMember({
      mode: 'availability',
      candidates: [
        candidate('medium', { order: 0 }),
        candidate('unavailable', { priority: 'high', available: false, order: 1 }),
        candidate('high', { priority: 'high', order: 2 }),
      ],
    }),
  ).toBe('high');
});

it('hides members three ahead of the whole team minimum even when that minimum member is busy', () => {
  expect(
    selectRoundRobinMember({
      mode: 'equal',
      candidates: [
        candidate('minimum', { available: false, monthlyCount: 0n }),
        candidate('ahead-three', { priority: 'high', monthlyCount: 3n }),
        candidate('ahead-two', { priority: 'low', monthlyCount: 2n }),
      ],
    }),
  ).toBe('ahead-two');
});

it('uses exact monthly counts before priority, then configured order for equal counts', () => {
  const candidates = [
    candidate('priority-first', { priority: 'high', order: 0, monthlyCount: 9007199254740993n }),
    candidate('later-low-count', { priority: 'low', order: 2, monthlyCount: 9007199254740992n }),
    candidate('earlier-low-count', { priority: 'low', order: 1, monthlyCount: 9007199254740992n }),
  ];
  expect(selectRoundRobinMember({ mode: 'equal', candidates })).toBe('earlier-low-count');
});

it('preserves the independently weighted whole-history policy instead of monthly equal allocation', () => {
  expect(
    selectRoundRobinMember({
      mode: 'weighted',
      candidates: [
        candidate('earlier', { order: 0, weightedCount: 2n, monthlyCount: 0n }),
        candidate('double-weight', { order: 1, weight: 2, weightedCount: 3n, monthlyCount: 99n }),
        candidate('busy', { available: false, weight: 100, weightedCount: 0n }),
      ],
    }),
  ).toBe('double-weight');
});

it('allows an explicitly selected available member to bypass equal fairness and priority', () => {
  expect(
    selectRoundRobinMember({
      mode: 'equal',
      requestedUserId: 'selected',
      candidates: [
        candidate('minimum'),
        candidate('selected', { priority: 'low', monthlyCount: 100n }),
      ],
    }),
  ).toBe('selected');
});

it('prefers the contact owner only when that owner is a current calendar member', () => {
  expect(
    selectRoundRobinMember({
      mode: 'availability',
      preferredOwnerUserId: 'owner',
      candidates: [
        candidate('automatic', { priority: 'high' }),
        candidate('owner', { priority: 'low', order: 1 }),
      ],
    }),
  ).toBe('owner');
});

it.each(['equal', 'availability', 'weighted'] as const)(
  '%s never falls back after an unavailable or foreign explicit staff selection',
  (mode) => {
    const candidates = [candidate('automatic'), candidate('busy', { available: false })];
    expect(selectRoundRobinMember({ mode, candidates, requestedUserId: 'busy' })).toBeUndefined();
    expect(
      selectRoundRobinMember({ mode, candidates, requestedUserId: 'foreign' }),
    ).toBeUndefined();
    expect(
      selectRoundRobinMember({
        mode,
        candidates,
        requestedUserId: 'automatic',
        preferredOwnerUserId: 'busy',
      }),
    ).toBe('automatic');
  },
);

it('shows only a current owner availability but falls back when the owner is outside the calendar', () => {
  const candidates = [candidate('automatic'), candidate('busy-owner', { available: false })];
  expect(
    selectRoundRobinMember({ mode: 'equal', candidates, preferredOwnerUserId: 'busy-owner' }),
  ).toBeUndefined();
  expect(
    selectRoundRobinMember({ mode: 'equal', candidates, preferredOwnerUserId: 'foreign' }),
  ).toBe('automatic');
});

it.each(['equal', 'availability', 'weighted'] as const)(
  '%s returns no assignment for an empty or entirely busy team',
  (mode) => {
    expect(selectRoundRobinMember({ mode, candidates: [] })).toBeUndefined();
    expect(
      selectRoundRobinMember({ mode, candidates: [candidate('busy', { available: false })] }),
    ).toBeUndefined();
  },
);

it('uses configured order and a stable final ID tie without mutating the candidate list', () => {
  const candidates = Object.freeze([
    candidate('z', { order: 2 }),
    candidate('b', { order: 1 }),
    candidate('a', { order: 1 }),
  ]);
  expect(selectRoundRobinMember({ mode: 'availability', candidates })).toBe('a');
  expect(selectRoundRobinMember({ mode: 'equal', candidates })).toBe('a');
  expect(candidates.map((member) => member.userId)).toEqual(['z', 'b', 'a']);
});

it('uses monthly count order independently of the supplied candidate order', () => {
  const candidates = [
    candidate('least', { monthlyCount: 0n }),
    candidate('more', { monthlyCount: 2n }),
    candidate('middle', { monthlyCount: 1n }),
  ];
  expect(selectRoundRobinMember({ mode: 'equal', candidates })).toBe('least');
  expect(selectRoundRobinMember({ mode: 'equal', candidates: [...candidates].reverse() })).toBe(
    'least',
  );
});
