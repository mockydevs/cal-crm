import { expect, it } from 'vitest';
import { capacityProfile, shardRange } from './capacity-profile.js';

it('distinguishes concurrent people, HTTP demand, origin cache misses and realtime sockets', () => {
  const result = capacityProfile({
    users: 1_000_000,
    staffPercent: 20,
    staffReadsPerMinute: 6,
    publicReadsPerMinute: 2,
    publicCacheHitPercent: 90,
    zones: 3,
  });
  expect(result.staffUsers).toBe(200_000);
  expect(result.publicUsers).toBe(800_000);
  expect(result.realtimeSockets).toBe(200_000);
  expect(result.nominalHttpReadsPerSecond).toBeCloseTo(46_666.6667, 3);
  expect(result.nominalOriginReadsPerSecond).toBeCloseTo(22_666.6667, 3);
  expect(result.zoneLossCapacityMultiplier).toBe(1.5);
  expect(result.measured).toBe(false);
});

it('allocates every user exactly once even when shards do not divide the population', () => {
  const ranges = Array.from({ length: 7 }, (_, index) => shardRange(1003, 7, index));
  expect(ranges[0]?.start).toBe(0);
  expect(ranges.at(-1)?.end).toBe(1003);
  expect(ranges.reduce((total, range) => total + range.users, 0)).toBe(1003);
  for (let index = 1; index < ranges.length; index += 1)
    expect(ranges[index]?.start).toBe(ranges[index - 1]?.end);
});

it('refuses invalid populations, traffic shares, rates and shard identities', () => {
  const valid = {
    users: 1_000_000,
    staffPercent: 20,
    staffReadsPerMinute: 6,
    publicReadsPerMinute: 2,
    publicCacheHitPercent: 90,
    zones: 3,
  };
  for (const changes of [
    { users: 0 },
    { users: Number.NaN },
    { staffPercent: 101 },
    { staffReadsPerMinute: -1 },
    { publicReadsPerMinute: Infinity },
    { publicCacheHitPercent: -1 },
    { zones: 1 },
  ])
    expect(() => capacityProfile({ ...valid, ...changes })).toThrow();
  for (const input of [
    [100, 0, 0],
    [100, 101, 0],
    [100, 5, 5],
    [100, 5, -1],
    [100.1, 5, 0],
  ])
    expect(() => shardRange(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0)).toThrow();
});
