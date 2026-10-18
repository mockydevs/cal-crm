import { BOOKING_NOTIFICATION_WORDING, getPublicCalendar } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  againWhenBusy,
  BUSY_TRIES,
  BusyError,
  requestOrBusy,
  retryAfterMs,
  waitBeforeTry,
} from './public-booking-busy';

const now = Date.parse('2026-10-13T12:00:00.000Z');

describe('retryAfterMs', () => {
  it('reads a number of seconds, and a date', () => {
    expect(retryAfterMs('2', now)).toBe(2000);
    expect(retryAfterMs(' 5 ', now)).toBe(5000);
    expect(retryAfterMs('Tue, 13 Oct 2026 12:00:04 GMT', now)).toBe(4000);
  });

  it('keeps a wait between one second and thirty, whatever the header says', () => {
    expect(retryAfterMs('0', now)).toBe(1000);
    expect(retryAfterMs('3600', now)).toBe(30_000);
    // A date already past is still not "at once".
    expect(retryAfterMs('Tue, 13 Oct 2026 11:00:00 GMT', now)).toBe(1000);
  });

  it('has no answer for a header that is missing or says neither', () => {
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs('', now)).toBeNull();
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs('-3', now)).toBeNull();
    expect(retryAfterMs('1.5', now)).toBeNull();
  });
});

describe('waitBeforeTry', () => {
  it('waits what the server named, else two seconds and then longer', () => {
    expect(waitBeforeTry(1, 3000)).toBe(3000);
    expect(waitBeforeTry(3, 1000)).toBe(1000);
    expect(waitBeforeTry(1, null)).toBe(2000);
    expect(waitBeforeTry(2, null)).toBe(4000);
    expect(waitBeforeTry(3, null)).toBe(8000);
    // Never asked for, and still an answer.
    expect(waitBeforeTry(9, null)).toBe(8000);
    expect(waitBeforeTry(0, null)).toBe(2000);
  });
});

const calendar = {
  name: 'Venue tour',
  description: '',
  timezone: 'UTC',
  slotMinutes: 30,
  durations: [30],
  notificationWording: BOOKING_NOTIFICATION_WORDING,
  renderToken: `1790000000000.${'a'.repeat(43)}`,
  appearance: {
    style: 'neo',
    primaryColor: '#178af6',
    backgroundColor: '#ffffff',
    buttonText: '',
    logoUrl: null,
    coverUrl: null,
  },
};
const params = { agencySlug: 'agency', businessSlug: 'events', calendarSlug: 'venue-tour' };
const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const refusal = (status: number) => ({ type: 'about:blank', title: 'Refused', status });

describe('requestOrBusy', () => {
  it('answers as the page’s own client does', async () => {
    const send = vi.fn<typeof fetch>(() => Promise.resolve(answer(200, calendar)));
    await expect(requestOrBusy(getPublicCalendar, { params }, send)).resolves.toMatchObject({
      name: 'Venue tour',
    });
    expect(send.mock.calls[0]?.[0]).toBe('/api/v1/public/book/agency/events/venue-tour');
    // Outside any business: the address names it.
    expect(send.mock.calls[0]?.[1]?.headers).not.toHaveProperty('business-id');
  });

  it('says the server is busy, with the wait it named, on a 429', async () => {
    const busy = await requestOrBusy(getPublicCalendar, { params }, () =>
      Promise.resolve(answer(429, refusal(429), { 'retry-after': '2' })),
    ).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(BusyError);
    expect((busy as BusyError).retryAfterMs).toBe(2000);
    const unnamed = await requestOrBusy(getPublicCalendar, { params }, () =>
      Promise.resolve(answer(429, refusal(429))),
    ).catch((error: unknown) => error);
    expect((unnamed as BusyError).retryAfterMs).toBeNull();
  });

  it('leaves every other refusal as it is', async () => {
    const gone = await requestOrBusy(getPublicCalendar, { params }, () =>
      // A Retry-After on anything but a 429 is not this page's to act on.
      Promise.resolve(answer(503, refusal(503), { 'retry-after': '2' })),
    ).catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(ApiError);
    expect(gone).not.toBeInstanceOf(BusyError);
    await expect(
      requestOrBusy(getPublicCalendar, { params }, () => Promise.reject(new TypeError('offline'))),
    ).rejects.toThrow('offline');
  });
});

describe('againWhenBusy', () => {
  const pause = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

  it('asks again by itself after the wait the server named, and answers when it does', async () => {
    pause.mockClear();
    const waiting: boolean[] = [];
    let asked = 0;
    const result = await againWhenBusy(
      () => {
        asked += 1;
        return asked < 3 ? Promise.reject(new BusyError(asked * 1000)) : Promise.resolve('booked');
      },
      {
        pause,
        onWaiting: (now_) => {
          waiting.push(now_);
        },
      },
    );
    expect(result).toBe('booked');
    expect(asked).toBe(3);
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    // Said while it waits, and taken back when it ends.
    expect(waiting).toEqual([true, true, false]);
  });

  it('backs off when no time is named, and gives up after a few tries', async () => {
    pause.mockClear();
    const waiting: boolean[] = [];
    let asked = 0;
    const ended = await againWhenBusy(
      () => {
        asked += 1;
        return Promise.reject(new BusyError(null));
      },
      {
        pause,
        onWaiting: (now_) => {
          waiting.push(now_);
        },
      },
    ).catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(BusyError);
    expect(asked).toBe(1 + BUSY_TRIES);
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([2000, 4000, 8000]);
    expect(waiting.at(-1)).toBe(false);
  });

  it('does not ask again for anything but a busy answer', async () => {
    pause.mockClear();
    let asked = 0;
    await expect(
      againWhenBusy(
        () => {
          asked += 1;
          return Promise.reject(new Error('Someone else took that time.'));
        },
        { pause },
      ),
    ).rejects.toThrow('Someone else took that time.');
    expect(asked).toBe(1);
    expect(pause).not.toHaveBeenCalled();
    // With nobody listening it still runs.
    await expect(againWhenBusy(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('stops waiting when the page no longer wants the answer', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    let asked = 0;
    const ended = againWhenBusy(
      () => {
        asked += 1;
        return Promise.reject(new BusyError(null));
      },
      { signal: stop.signal },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    stop.abort();
    expect(await ended).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(asked).toBe(1);
    // Left alone, the wait runs its course on the clock.
    asked = 0;
    const waited = againWhenBusy(() => {
      asked += 1;
      return asked === 1 ? Promise.reject(new BusyError(1000)) : Promise.resolve('there');
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(waited).resolves.toBe('there');
    vi.useRealTimers();
  });
});
