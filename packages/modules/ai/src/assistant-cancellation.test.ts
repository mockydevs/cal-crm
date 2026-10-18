import { expect, it, vi } from 'vitest';
import { waitForRetry, withAssistantCancellation } from './assistant-cancellation.js';

it('cancels a retry delay and releases its timer without starting another request', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const wait = waitForRetry(60000, controller.signal);
    controller.abort();
    await wait;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('aborts an active call when Stop is observed, and releases its observer', async () => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const result = withAssistantCancellation(
      () => Promise.resolve(cancelled),
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve('stopped');
            },
            { once: true },
          );
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('does not start work when already cancelled and propagates observation failures', async () => {
  let calls = 0;
  await expect(
    withAssistantCancellation(
      () => Promise.resolve(true),
      () => {
        calls += 1;
        return Promise.resolve('bad');
      },
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(0);
  await expect(
    withAssistantCancellation(
      () => Promise.reject(new Error('database unavailable')),
      () => Promise.resolve('bad'),
    ),
  ).rejects.toThrow('database unavailable');
});

it('propagates an observation failure during an active exchange and aborts the exchange', async () => {
  vi.useFakeTimers();
  try {
    let checks = 0;
    let aborted = false;
    const result = withAssistantCancellation(
      () => {
        checks += 1;
        return checks === 1 ? Promise.resolve(false) : Promise.reject(new Error('lost database'));
      },
      (signal) =>
        new Promise<string>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    );
    const assertion = expect(result).rejects.toThrow('lost database');
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('releases observers on normal completion and failure, including repeated checks', async () => {
  vi.useFakeTimers();
  try {
    let checks = 0;
    const work = Promise.withResolvers<string>();
    const result = withAssistantCancellation(
      () => {
        checks += 1;
        return Promise.resolve(false);
      },
      () => work.promise,
    );
    await vi.advanceTimersByTimeAsync(750);
    expect(checks).toBe(4);
    work.resolve('done');
    expect(await result).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      withAssistantCancellation(
        () => Promise.resolve(false),
        () => Promise.reject(new Error('provider failed')),
      ),
    ).rejects.toThrow('provider failed');
    expect(vi.getTimerCount()).toBe(0);
    await waitForRetry(1, AbortSignal.abort());
    await waitForRetry(1, undefined, () => Promise.resolve());
    await expect(
      waitForRetry(1, undefined, () => Promise.reject(new Error('delay failed'))),
    ).rejects.toThrow('delay failed');
    const wait = waitForRetry(10);
    await vi.advanceTimersByTimeAsync(10);
    await wait;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
