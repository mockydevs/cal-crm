import { describe, expect, it } from 'vitest';

import { createSubmitGate, GATE_FULL, GATE_RETRY_SECONDS } from './submit-gate.js';

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

describe('the gate of a form’s submissions', () => {
  it('runs one submission of a form at a time, in the order they came', async () => {
    const gate = createSubmitGate();
    const order: string[] = [];
    const first = held();
    const second = held();
    const run = (name: string, wait: Promise<void>) =>
      gate('form-a', async () => {
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

  it('lets another form through while one is busy', async () => {
    const gate = createSubmitGate();
    const busy = held();
    const slow = gate('form-a', () => busy.done.then(() => 'slow'));
    expect(await gate('form-b', () => Promise.resolve('quick'))).toBe('quick');
    busy.finish();
    expect(await slow).toBe('slow');
  });

  it('tells a submission that finds the line full, and starts nothing for it', async () => {
    const gate = createSubmitGate({ maxWaiting: 2 });
    const busy = held();
    let started = 0;
    const work = async () => {
      started += 1;
      await busy.done;
      return 'stored';
    };
    const running = gate('form-a', work);
    const waiting = [gate('form-a', work), gate('form-a', work)];
    await tick();
    expect(await gate('form-a', work)).toBe(GATE_FULL);
    expect(await gate('form-a', work)).toBe(GATE_FULL);
    expect(started).toBe(1);
    // Another form has a line of its own.
    expect(await gate('form-b', () => Promise.resolve('other'))).toBe('other');
    busy.finish();
    expect(await Promise.all([running, ...waiting])).toEqual(['stored', 'stored', 'stored']);
    expect(started).toBe(3);
    // The line is free again, and the form is forgotten until its next submission.
    expect(await gate('form-a', () => Promise.resolve('again'))).toBe('again');
    expect(GATE_RETRY_SECONDS).toBeGreaterThanOrEqual(1);
  });

  it('lets the next one go when a submission fails, and gives the failure to its own caller', async () => {
    const gate = createSubmitGate();
    const broken = held();
    const failing = gate('form-a', () => broken.done);
    const after = gate('form-a', () => Promise.resolve('stored'));
    broken.fail(new Error('the database is down'));
    await expect(failing).rejects.toThrow('the database is down');
    expect(await after).toBe('stored');
  });

  it('with no line at all, takes one at a time and refuses the rest', async () => {
    const gate = createSubmitGate({ maxWaiting: 0 });
    const busy = held();
    const running = gate('form-a', () => busy.done.then(() => 'one'));
    expect(await gate('form-a', () => Promise.resolve('two'))).toBe(GATE_FULL);
    busy.finish();
    expect(await running).toBe('one');
    for (const maxWaiting of [-1, 1.5, Number.NaN])
      expect(() => createSubmitGate({ maxWaiting })).toThrow(/whole number/);
  });
});
