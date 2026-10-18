import { describe, expect, it } from 'vitest';

import type { WidgetConfig, WidgetMessage } from './api.js';
import {
  checkDetails,
  checkMessage,
  initialState,
  pollDelay,
  reduce,
  unreadCount,
  type WidgetEvent,
  type WidgetState,
} from './state.js';

const config: WidgetConfig = {
  title: 'Chat with us',
  greeting: 'Hello.',
  emailRequired: true,
  marketingConsentWording: null,
  messageLength: 20,
};
const message = (
  seq: number,
  from: 'visitor' | 'team',
  text = `m${String(seq)}`,
): WidgetMessage => ({
  seq,
  from,
  text,
  sentAt: '2026-10-09T09:00:00.000Z',
});
const after = (events: readonly WidgetEvent[], start = initialState(0)): WidgetState =>
  events.reduce(reduce, start);

describe('reduce', () => {
  it('starts closed, loading, with nothing shown', () => {
    expect(initialState(3)).toEqual({
      open: false,
      view: 'loading',
      config: null,
      items: [],
      cursor: 0,
      seen: 3,
      notice: null,
      busy: false,
    });
  });

  it('shows the form without a session and the chat with one', () => {
    expect(after([{ type: 'config', config, session: false }]).view).toBe('form');
    expect(after([{ type: 'config', config, session: true }]).view).toBe('chat');
    expect(after([{ type: 'unavailable' }]).view).toBe('unavailable');
  });

  it('shows a message as sending, then sent in its place', () => {
    const queued = after([{ type: 'queued', id: 'a', text: 'Hello' }]);
    expect(queued.items).toEqual([
      { id: 'a', seq: null, from: 'visitor', text: 'Hello', status: 'sending' },
    ]);
    const delivered = reduce(queued, {
      type: 'delivered',
      id: 'a',
      message: message(1, 'visitor', 'Hello'),
    });
    expect(delivered.items).toEqual([
      { id: 'a', seq: 1, from: 'visitor', text: 'Hello', status: 'sent' },
    ]);
    expect(delivered.busy).toBe(false);
  });

  it('keeps what the visitor typed, not what a response says they typed', () => {
    const state = after([
      { type: 'queued', id: 'a', text: 'Typed' },
      { type: 'delivered', id: 'a', message: message(1, 'visitor', 'Something else') },
    ]);
    expect(state.items[0]?.text).toBe('Typed');
  });

  it('marks a failed message and says why, and sends it again under the same id', () => {
    const failed = after([
      { type: 'queued', id: 'a', text: 'Hello' },
      { type: 'undelivered', id: 'a', notice: 'offline' },
    ]);
    expect(failed.items[0]?.status).toBe('failed');
    expect(failed.notice).toBe('offline');
    const again = reduce(failed, { type: 'queued', id: 'a', text: 'Hello' });
    expect(again.items).toHaveLength(1);
    expect(again.items[0]?.status).toBe('sending');
    expect(again.notice).toBeNull();
  });

  it('adds a page of messages once, in order, and moves the cursor forward only', () => {
    const first = after([
      { type: 'page', messages: [message(2, 'team'), message(1, 'visitor')], cursor: 2 },
    ]);
    expect(first.items.map((item) => item.seq)).toEqual([1, 2]);
    expect(first.cursor).toBe(2);
    const again = after(
      [
        { type: 'page', messages: [message(2, 'team'), message(3, 'team')], cursor: 3 },
        { type: 'page', messages: [], cursor: 1 },
      ],
      first,
    );
    expect(again.items.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(again.cursor).toBe(3);
  });

  it('keeps one copy when a read returns a message before its own send does', () => {
    const state = after([
      { type: 'queued', id: 'a', text: 'Hello' },
      { type: 'page', messages: [message(1, 'visitor', 'Hello')], cursor: 1 },
      { type: 'delivered', id: 'a', message: message(1, 'visitor', 'Hello') },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ seq: 1, status: 'sent' });
  });

  it('keeps messages still on their way after the stored ones', () => {
    const state = after([
      { type: 'queued', id: 'a', text: 'second' },
      { type: 'page', messages: [message(1, 'team')], cursor: 1 },
    ]);
    expect(state.items.map((item) => item.id)).toEqual(['s1', 'a']);
  });

  it('leaves nothing of a chat on screen when it ends', () => {
    const ended = after([
      { type: 'config', config, session: true },
      { type: 'opened' },
      { type: 'queued', id: 'a', text: 'private' },
      { type: 'page', messages: [message(1, 'team', 'also private')], cursor: 1 },
      { type: 'busy', busy: true },
      { type: 'ended', notice: 'sessionEnded' },
    ]);
    expect(ended).toMatchObject({
      view: 'form',
      items: [],
      cursor: 0,
      seen: 0,
      notice: 'sessionEnded',
      busy: false,
    });
  });

  it('goes back to loading when a chat ends before the form is known', () => {
    expect(after([{ type: 'ended', notice: null }]).view).toBe('loading');
  });

  it('sets and clears a notice and the busy mark', () => {
    const state = after([
      { type: 'notice', notice: 'emailNeeded' },
      { type: 'busy', busy: true },
    ]);
    expect(state).toMatchObject({ notice: 'emailNeeded', busy: true });
    expect(reduce(state, { type: 'notice', notice: null }).notice).toBeNull();
    expect(reduce(state, { type: 'started' })).toMatchObject({ view: 'chat', notice: null });
  });
});

describe('unreadCount', () => {
  const closed = after([
    { type: 'page', messages: [message(1, 'visitor'), message(2, 'team')], cursor: 2 },
  ]);

  it('counts the team replies that came while the panel was closed', () => {
    expect(unreadCount(closed)).toBe(1);
    const more = reduce(closed, { type: 'page', messages: [message(3, 'team')], cursor: 3 });
    expect(unreadCount(more)).toBe(2);
  });

  it("never counts the visitor's own messages", () => {
    expect(
      unreadCount(after([{ type: 'page', messages: [message(1, 'visitor')], cursor: 1 }])),
    ).toBe(0);
  });

  it('counts nothing once the panel is opened, or while it is open', () => {
    const opened = reduce(closed, { type: 'opened' });
    expect(opened.seen).toBe(2);
    expect(unreadCount(opened)).toBe(0);
    const live = reduce(opened, { type: 'page', messages: [message(3, 'team')], cursor: 3 });
    expect(unreadCount(live)).toBe(0);
    expect(unreadCount(reduce(live, { type: 'closed' }))).toBe(0);
  });

  it('does not announce again what was seen before the page was reloaded', () => {
    const reloaded = after(
      [{ type: 'page', messages: [message(1, 'team'), message(2, 'team')], cursor: 2 }],
      initialState(2),
    );
    expect(unreadCount(reloaded)).toBe(0);
  });
});

describe('pollDelay', () => {
  const facts = { session: true, open: true, hidden: false, quiet: 0, failures: 0 };

  it('reads nothing without a session or in a background tab', () => {
    expect(pollDelay({ ...facts, session: false })).toBeNull();
    expect(pollDelay({ ...facts, hidden: true })).toBeNull();
    expect(pollDelay({ ...facts, hidden: true, failures: 3 })).toBeNull();
  });

  it('reads an open panel every 4 seconds, slowing to 15 when nothing comes', () => {
    expect(pollDelay(facts)).toBe(4000);
    expect(pollDelay({ ...facts, quiet: 4 })).toBe(4000);
    expect(pollDelay({ ...facts, quiet: 5 })).toBe(6000);
    expect(pollDelay({ ...facts, quiet: 6 })).toBe(9000);
    expect(pollDelay({ ...facts, quiet: 8 })).toBe(15_000);
    expect(pollDelay({ ...facts, quiet: 100_000 })).toBe(15_000);
  });

  it('reads a closed panel every 30 seconds', () => {
    expect(pollDelay({ ...facts, open: false })).toBe(30_000);
    expect(pollDelay({ ...facts, open: false, quiet: 50 })).toBe(30_000);
  });

  it('backs off after failures, to 2 minutes at most, open or closed', () => {
    expect(pollDelay({ ...facts, failures: 1 })).toBe(5000);
    expect(pollDelay({ ...facts, failures: 2 })).toBe(10_000);
    expect(pollDelay({ ...facts, failures: 5 })).toBe(80_000);
    expect(pollDelay({ ...facts, failures: 6 })).toBe(120_000);
    expect(pollDelay({ ...facts, failures: 10_000 })).toBe(120_000);
    expect(pollDelay({ ...facts, open: false, failures: 1 })).toBe(5000);
  });

  it('waits as long as the server asks when that is longer, within the same limit', () => {
    expect(pollDelay({ ...facts, failures: 1, retryAfterSeconds: 42 })).toBe(42_000);
    expect(pollDelay({ ...facts, failures: 1, retryAfterSeconds: 2 })).toBe(5000);
    expect(pollDelay({ ...facts, failures: 1, retryAfterSeconds: 99_999 })).toBe(120_000);
  });

  it('never returns a wait under 4 seconds', () => {
    for (const open of [true, false])
      for (const quiet of [0, 1, 7, 1000])
        for (const failures of [0, 1, 4, 99])
          expect(
            pollDelay({ session: true, hidden: false, open, quiet, failures }),
          ).toBeGreaterThanOrEqual(4000);
  });
});

describe('the checks before a request', () => {
  it('asks for a message that is not blank and not too long', () => {
    expect(checkMessage(config, 'Hello')).toBeNull();
    expect(checkMessage(config, '   \n')).toBe('messageNeeded');
    expect(checkMessage(config, 'a'.repeat(20))).toBeNull();
    expect(checkMessage(config, 'a'.repeat(21))).toBe('messageTooLong');
  });

  it('asks for an email address only when the widget requires one', () => {
    expect(checkDetails(config, { email: ' ', text: 'Hello' })).toBe('emailNeeded');
    expect(
      checkDetails({ ...config, emailRequired: false }, { email: '', text: 'Hello' }),
    ).toBeNull();
    expect(checkDetails(config, { email: 'maya@example.test', text: 'Hello' })).toBeNull();
  });

  it('catches a slip in the address, required or not, before the message', () => {
    for (const email of ['maya', 'maya@', '@example.test', 'maya@example', 'ma ya@example.test'])
      expect(checkDetails({ ...config, emailRequired: false }, { email, text: '' })).toBe(
        'emailInvalid',
      );
    expect(checkDetails(config, { email: 'maya@example.test', text: '' })).toBe('messageNeeded');
  });
});
