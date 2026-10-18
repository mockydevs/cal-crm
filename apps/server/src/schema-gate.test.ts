import { describe, expect, it } from 'vitest';

import { SchemaNotReadyError, waitForSchema } from './schema-gate.js';

/** A clock the gate's waits move forward, so a test takes no real time. */
function fakeTime(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let time = 0;
  return {
    now: () => time,
    sleep: (ms) => {
      time += ms;
      return Promise.resolve();
    },
  };
}

describe('waitForSchema', () => {
  it('returns at once when the database has every migration of this release', async () => {
    const said: string[] = [];
    await waitForSchema({
      missing: () => Promise.resolve([]),
      log: (message) => said.push(message),
      ...fakeTime(),
    });
    expect(said).toEqual([]);
  });

  it('waits while the worker migrates, saying what is missing once per change', async () => {
    const answers = [
      ['0111_a.sql', '0112_b.sql'],
      ['0111_a.sql', '0112_b.sql'],
      ['0112_b.sql'],
      [],
    ];
    const said: string[] = [];
    const time = fakeTime();
    await waitForSchema({
      missing: () => Promise.resolve(answers.shift() ?? []),
      log: (message) => said.push(message),
      intervalMs: 2_000,
      ...time,
    });
    expect(said).toEqual([
      'Waiting for the database to have 0111_a.sql, 0112_b.sql before serving.',
      'Waiting for the database to have 0112_b.sql before serving.',
    ]);
    expect(time.now()).toBe(6_000);
  });

  it("starts as before when the database can't be reached: /ready reports that", async () => {
    let calls = 0;
    const said: string[] = [];
    await waitForSchema({
      missing: () => {
        calls += 1;
        return Promise.reject(new Error('connect ECONNREFUSED'));
      },
      log: (message) => said.push(message),
      ...fakeTime(),
    });
    expect(calls).toBe(1);
    expect(said).toEqual([
      "Couldn't check the database's migrations (connect ECONNREFUSED); starting, and /ready says whether the database answers.",
    ]);
  });

  it('gives up after its limit, naming what never arrived', async () => {
    const time = fakeTime();
    const waiting = waitForSchema({
      missing: () => Promise.resolve(['0112_b.sql']),
      log: () => undefined,
      intervalMs: 1_000,
      timeoutMs: 5_000,
      ...time,
    });
    await expect(waiting).rejects.toThrow(SchemaNotReadyError);
    await expect(waiting).rejects.toThrow(/0112_b\.sql/);
    expect(time.now()).toBe(5_000);
  });
});
