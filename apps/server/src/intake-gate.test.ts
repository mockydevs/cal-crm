import { describe, expect, it } from 'vitest';

import { createIntakeGate, INTAKE_GATE_FULL, INTAKE_GATE_RETRY_SECONDS } from './intake-gate.js';

/** Work that ends when the test says so. */
function held() {
  let finish = (): void => undefined;
  let fail: (error: Error) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { done, finish, fail };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the gate of a business’s public requests', () => {
  it('runs one request of a business at a time, in the order they came', async () => {
    const gate = createIntakeGate();
    const order: string[] = [];
    const first = held();
    const second = held();
    const run = (name: string, wait: Promise<void>) =>
      gate('business-a', async () => {
        order.push(`${name} started`);
        await wait;
        order.push(`${name} ended`);
        return name;
      });
    const a = run('a', first.done);
    const b = run('b', second.done);
    const c = run('c', Promise.resolve());
    await tick();
    // The second and third hold nothing and have not begun.
    expect(order).toEqual(['a started']);
    first.finish();
    await tick();
    expect(order).toEqual(['a started', 'a ended', 'b started']);
    second.finish();
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a started', 'a ended', 'b started', 'b ended', 'c started', 'c ended']);
  });

  it('lets another business through while one is busy', async () => {
    const gate = createIntakeGate();
    const busy = held();
    const slow = gate('business-a', () => busy.done.then(() => 'slow'));
    expect(await gate('business-b', () => Promise.resolve('quick'))).toBe('quick');
    busy.finish();
    expect(await slow).toBe('slow');
  });

  it('tells a request that finds the line full, and starts nothing for it', async () => {
    const gate = createIntakeGate({ maxWaiting: 2 });
    const busy = held();
    let started = 0;
    const work = async () => {
      started += 1;
      await busy.done;
      return 'answered';
    };
    const running = gate('business-a', work);
    const waiting = [gate('business-a', work), gate('business-a', work)];
    await tick();
    expect(await gate('business-a', work)).toBe(INTAKE_GATE_FULL);
    expect(await gate('business-a', work)).toBe(INTAKE_GATE_FULL);
    expect(started).toBe(1);
    // Another business has a line of its own.
    expect(await gate('business-b', () => Promise.resolve('other'))).toBe('other');
    busy.finish();
    expect(await Promise.all([running, ...waiting])).toEqual(['answered', 'answered', 'answered']);
    expect(started).toBe(3);
    // The line is free again, and the business is forgotten until its next request.
    expect(await gate('business-a', () => Promise.resolve('again'))).toBe('again');
    expect(INTAKE_GATE_RETRY_SECONDS).toBeGreaterThanOrEqual(1);
  });

  it('lets the next one go when a request fails, and gives the failure to its own caller', async () => {
    const gate = createIntakeGate();
    const broken = held();
    const failing = gate('business-a', () => broken.done);
    const after = gate('business-a', () => Promise.resolve('answered'));
    broken.fail(new Error('the database is down'));
    await expect(failing).rejects.toThrow('the database is down');
    expect(await after).toBe('answered');
  });

  it('with no line at all, takes one at a time and refuses the rest', async () => {
    const gate = createIntakeGate({ maxWaiting: 0 });
    const busy = held();
    const running = gate('business-a', () => busy.done.then(() => 'one'));
    expect(await gate('business-a', () => Promise.resolve('two'))).toBe(INTAKE_GATE_FULL);
    busy.finish();
    expect(await running).toBe('one');
    for (const maxWaiting of [-1, 1.5, Number.NaN])
      expect(() => createIntakeGate({ maxWaiting })).toThrow(/whole number/);
  });
});
