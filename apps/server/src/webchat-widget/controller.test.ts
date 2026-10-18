import { describe, expect, it, vi } from 'vitest';

import type { Outcome, WidgetApi, WidgetConfig, WidgetMessage, WidgetPage } from './api.js';
import { createController, type Details } from './controller.js';
import type { WidgetState } from './state.js';
import type { SessionStore, StoredSession } from './storage.js';

const TOKEN = 't'.repeat(43);
const config: WidgetConfig = {
  title: 'Chat with us',
  greeting: 'Hello.',
  emailRequired: true,
  marketingConsentWording: 'Email me news.',
  messageLength: 2000,
};
const details: Details = {
  name: ' Maya ',
  email: ' maya@example.test ',
  marketingConsent: false,
  text: 'Hello',
};
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const message = (seq: number, from: 'visitor' | 'team', text: string): WidgetMessage => ({
  seq,
  from,
  text,
  sentAt: '2026-10-09T09:00:00.000Z',
});
const page = (messages: WidgetMessage[], more = false): Outcome<WidgetPage> =>
  ok({ messages, cursor: messages.at(-1)?.seq ?? 0, more });

function setup(stored?: StoredSession) {
  const api = {
    config: vi.fn<WidgetApi['config']>().mockResolvedValue(ok(config)),
    start: vi
      .fn<WidgetApi['start']>()
      .mockResolvedValue(ok({ token: TOKEN, expiresAt: '2026-11-08T09:00:00.000Z' })),
    send: vi
      .fn<WidgetApi['send']>()
      .mockImplementation((_token, _id, text) => Promise.resolve(ok(message(1, 'visitor', text)))),
    messages: vi.fn<WidgetApi['messages']>().mockResolvedValue(page([])),
    end: vi.fn<WidgetApi['end']>().mockResolvedValue(ok(null)),
  };
  let saved = stored;
  const store: SessionStore = {
    read: () => saved,
    write: (session) => {
      saved = session;
    },
    clear: () => {
      saved = undefined;
    },
  };
  const timers: { run: () => void; ms: number }[] = [];
  let hidden = false;
  let ids = 0;
  const renders: WidgetState[] = [];
  const unread: number[] = [];
  const controller = createController({
    api,
    store,
    render: (state, count) => {
      renders.push(state);
      unread.push(count);
    },
    newId: () => `id-${String((ids += 1))}`,
    setTimer: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.findIndex((each) => each === timer);
      if (index >= 0) timers.splice(index, 1);
    },
    isHidden: () => hidden,
  });
  return {
    api,
    controller,
    timers,
    renders,
    unread,
    saved: () => saved,
    hide: (value: boolean) => {
      hidden = value;
    },
    /** Runs the one waiting timer, and lets what it started finish. */
    tick: async (): Promise<void> => {
      const [timer] = timers.splice(0, 1);
      timer?.run();
      // Until a whole turn passes with no further read: a long chat is read page after page.
      let calls = -1;
      while (calls !== api.messages.mock.calls.length) {
        calls = api.messages.mock.calls.length;
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      }
    },
  };
}
const session: StoredSession = { token: TOKEN, expiresAt: '2026-11-08T09:00:00.000Z', seen: 0 };
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

describe('a visitor who has not chatted', () => {
  it('asks the CRM for nothing until the panel is opened', async () => {
    const { api, timers } = setup();
    await settle();
    expect(api.config).not.toHaveBeenCalled();
    expect(api.messages).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it('loads the form on opening, and reads no messages without a session', async () => {
    const { api, controller, timers } = setup();
    controller.open();
    await settle();
    expect(api.config).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({ open: true, view: 'form', config });
    expect(api.messages).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it('says the chat is unavailable when it cannot load, and tries again on the next opening', async () => {
    const { api, controller } = setup();
    api.config.mockResolvedValueOnce({ ok: false, failure: 'unavailable' });
    controller.open();
    await settle();
    expect(controller.state().view).toBe('unavailable');
    controller.close();
    controller.open();
    await settle();
    expect(api.config).toHaveBeenCalledTimes(2);
    expect(controller.state().view).toBe('form');
  });

  it('starts a session with trimmed details, keeps the token, then sends the first message', async () => {
    const { api, controller, saved } = setup();
    controller.open();
    await settle();
    await controller.begin(details);
    expect(api.start).toHaveBeenCalledExactlyOnceWith({
      name: 'Maya',
      email: 'maya@example.test',
      marketingConsent: false,
    });
    expect(saved()).toMatchObject({ token: TOKEN });
    expect(api.send).toHaveBeenCalledExactlyOnceWith(TOKEN, 'id-1', 'Hello');
    expect(controller.state()).toMatchObject({
      view: 'chat',
      busy: false,
      items: [{ id: 'id-1', seq: 1, from: 'visitor', text: 'Hello', status: 'sent' }],
    });
  });

  it('sends consent only when the box was shown, ticked, and there is an address', async () => {
    const consenting = async (change: Partial<Details>, shown: WidgetConfig = config) => {
      const { api, controller } = setup();
      api.config.mockResolvedValue(ok(shown));
      controller.open();
      await settle();
      await controller.begin({ ...details, ...change });
      return api.start.mock.calls[0]?.[0].marketingConsent;
    };
    expect(await consenting({ marketingConsent: true })).toBe(true);
    expect(await consenting({ marketingConsent: false })).toBe(false);
    const optional = { ...config, emailRequired: false };
    expect(await consenting({ marketingConsent: true, email: '' }, optional)).toBe(false);
    expect(
      await consenting({ marketingConsent: true }, { ...config, marketingConsentWording: null }),
    ).toBe(false);
  });

  it('leaves out a name and an address that were not given', async () => {
    const { api, controller } = setup();
    api.config.mockResolvedValue(ok({ ...config, emailRequired: false }));
    controller.open();
    await settle();
    await controller.begin({ name: '  ', email: '', marketingConsent: false, text: 'Hello' });
    expect(api.start).toHaveBeenCalledExactlyOnceWith({ marketingConsent: false });
  });

  it('asks nothing of the CRM while the details are wrong', async () => {
    const { api, controller } = setup();
    controller.open();
    await settle();
    await controller.begin({ ...details, email: '' });
    expect(controller.state().notice).toBe('emailNeeded');
    await controller.begin({ ...details, text: ' ' });
    expect(controller.state().notice).toBe('messageNeeded');
    expect(api.start).not.toHaveBeenCalled();
  });

  it.each([
    ['limited', 'slowDown'],
    ['invalid', 'detailsRefused'],
    ['network', 'offline'],
    ['unavailable', 'unavailable'],
  ] as const)('says why a session did not start: %s', async (failure, notice) => {
    const { api, controller, saved } = setup();
    api.start.mockResolvedValue({ ok: false, failure });
    controller.open();
    await settle();
    await controller.begin(details);
    expect(controller.state()).toMatchObject({ view: 'form', notice, busy: false });
    expect(saved()).toBeUndefined();
    expect(api.send).not.toHaveBeenCalled();
  });
});

describe('a visitor in a chat', () => {
  async function chatting() {
    const made = setup(session);
    made.controller.open();
    await settle();
    made.timers.splice(0);
    made.api.messages.mockClear();
    return made;
  }

  it('reads the chat at once on a page load, without waiting to be opened', async () => {
    const { api, timers, tick } = setup(session);
    expect(timers.map((timer) => timer.ms)).toEqual([0]);
    await tick();
    expect(api.messages).toHaveBeenCalledExactlyOnceWith(TOKEN, 0);
    expect(api.config).not.toHaveBeenCalled();
  });

  it('counts replies that arrive while the panel is closed, and none once it is opened', async () => {
    const { api, controller, unread, tick, saved } = setup(session);
    api.messages.mockResolvedValueOnce(
      page([message(1, 'visitor', 'Hi'), message(2, 'team', 'Hello')]),
    );
    await tick();
    expect(unread.at(-1)).toBe(1);
    controller.open();
    expect(unread.at(-1)).toBe(0);
    // Remembered, so the next page load does not announce it again.
    expect(saved()).toMatchObject({ seen: 2 });
  });

  it('reads on from where it stopped, every page of a long chat, up to a limit', async () => {
    const { api, timers, tick, controller } = setup(session);
    api.messages
      .mockResolvedValueOnce(page([message(1, 'team', 'a')], true))
      .mockResolvedValueOnce(page([message(2, 'team', 'b')], true))
      .mockResolvedValueOnce(page([message(3, 'team', 'c')]));
    await tick();
    expect(api.messages.mock.calls.map(([, after]) => after)).toEqual([0, 1, 2]);
    expect(controller.state().items.map((item) => item.text)).toEqual(['a', 'b', 'c']);
    expect(timers).toHaveLength(1);

    api.messages.mockClear();
    api.messages.mockImplementation((_token, after) =>
      Promise.resolve(page([message(after + 1, 'team', 'more')], true)),
    );
    await tick();
    expect(api.messages).toHaveBeenCalledTimes(10);
  });

  it('waits 4 seconds between reads while open and 30 while closed', async () => {
    const { controller, timers, tick } = await chatting();
    controller.open();
    await tick();
    expect(timers.map((timer) => timer.ms)).toEqual([4000]);
    controller.close();
    expect(timers.map((timer) => timer.ms)).toEqual([30_000]);
  });

  it('stops reading in a background tab and reads at once on coming back', async () => {
    const { controller, timers, hide } = await chatting();
    hide(true);
    controller.visibilityChanged();
    expect(timers).toHaveLength(0);
    hide(false);
    controller.visibilityChanged();
    expect(timers.map((timer) => timer.ms)).toEqual([0]);
  });

  it('backs off when reads fail, honours the retry time, and recovers', async () => {
    const { api, controller, timers, tick } = await chatting();
    controller.open();
    api.messages.mockResolvedValueOnce({ ok: false, failure: 'network' });
    await tick();
    expect(timers.map((timer) => timer.ms)).toEqual([5000]);
    api.messages.mockResolvedValueOnce({ ok: false, failure: 'limited', retryAfterSeconds: 40 });
    await tick();
    expect(timers.map((timer) => timer.ms)).toEqual([40_000]);
    // Still failing: coming back to the tab does not skip the wait.
    controller.visibilityChanged();
    expect(timers.map((timer) => timer.ms)).toEqual([40_000]);
    await tick();
    expect(timers.map((timer) => timer.ms)).toEqual([4000]);
    expect(controller.state().view).toBe('chat');
  });

  it('forgets a session the CRM no longer answers, and shows the form again', async () => {
    for (const failure of ['session', 'full'] as const) {
      const { api, controller, timers, tick, saved } = await chatting();
      controller.open();
      api.messages.mockResolvedValueOnce(page([message(1, 'team', 'private')]));
      await tick();
      api.messages.mockResolvedValueOnce({ ok: false, failure });
      await tick();
      expect(saved()).toBeUndefined();
      expect(controller.state()).toMatchObject({ view: 'form', items: [], notice: 'sessionEnded' });
      expect(timers).toHaveLength(0);
    }
  });

  it('says nothing to a returning visitor whose old session has gone', async () => {
    const { api, controller, tick, saved } = setup(session);
    api.messages.mockResolvedValueOnce({ ok: false, failure: 'session' });
    await tick();
    expect(saved()).toBeUndefined();
    expect(controller.state().notice).toBeNull();
  });

  it('sends a message and shows it at once', async () => {
    const { api, controller, renders } = await chatting();
    api.send.mockResolvedValue(ok(message(3, 'visitor', 'Next')));
    await controller.send('Next');
    expect(api.send).toHaveBeenCalledExactlyOnceWith(TOKEN, 'id-1', 'Next');
    expect(renders.some((state) => state.items.some((item) => item.status === 'sending'))).toBe(
      true,
    );
    expect(controller.state().items).toEqual([
      { id: 'id-1', seq: 3, from: 'visitor', text: 'Next', status: 'sent' },
    ]);
  });

  it('does not send a blank message or one that is too long', async () => {
    const { api, controller } = await chatting();
    await controller.send('  ');
    expect(controller.state().notice).toBe('messageNeeded');
    await controller.send('a'.repeat(2001));
    expect(controller.state().notice).toBe('messageTooLong');
    expect(api.send).not.toHaveBeenCalled();
  });

  it('keeps a message that failed and sends it again under the same id', async () => {
    const { api, controller } = await chatting();
    api.send.mockResolvedValueOnce({ ok: false, failure: 'network' });
    await controller.send('Hello');
    expect(controller.state()).toMatchObject({
      notice: 'offline',
      busy: false,
      items: [{ id: 'id-1', status: 'failed', text: 'Hello' }],
    });
    await controller.retry('id-1');
    expect(api.send.mock.calls).toEqual([
      [TOKEN, 'id-1', 'Hello'],
      [TOKEN, 'id-1', 'Hello'],
    ]);
    expect(controller.state().items).toEqual([
      { id: 'id-1', seq: 1, from: 'visitor', text: 'Hello', status: 'sent' },
    ]);
    // Only a failed message can be sent again.
    await controller.retry('id-1');
    await controller.retry('unknown');
    expect(api.send).toHaveBeenCalledTimes(2);
  });

  it('tells a visitor who sends too fast to wait, and keeps the message', async () => {
    const { api, controller } = await chatting();
    api.send.mockResolvedValueOnce({ ok: false, failure: 'limited', retryAfterSeconds: 20 });
    await controller.send('Hello');
    expect(controller.state()).toMatchObject({
      view: 'chat',
      notice: 'slowDown',
      items: [{ status: 'failed' }],
    });
  });

  it('ends the session when a send finds it gone', async () => {
    const { api, controller, saved } = await chatting();
    api.send.mockResolvedValueOnce({ ok: false, failure: 'session' });
    await controller.send('Hello');
    expect(saved()).toBeUndefined();
    expect(controller.state()).toMatchObject({ view: 'form', items: [], notice: 'sessionEnded' });
  });

  it('ends a chat: forgets the token first, tells the CRM, and clears the screen', async () => {
    const { api, controller, saved, timers } = await chatting();
    api.send.mockResolvedValue(ok(message(1, 'visitor', 'private')));
    await controller.send('private');
    controller.end();
    expect(saved()).toBeUndefined();
    expect(api.end).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(controller.state()).toMatchObject({ view: 'form', items: [], notice: null });
    expect(timers).toHaveLength(0);
    // Nothing more is sent or read with the old token.
    await controller.send('after');
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('drops an answer that arrives for a session already ended', async () => {
    const { api, controller } = await chatting();
    let answer: (value: Outcome<WidgetMessage>) => void = () => undefined;
    api.send.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const sending = controller.send('late');
    controller.end();
    answer(ok(message(1, 'visitor', 'late')));
    await sending;
    expect(controller.state().items).toEqual([]);
  });

  it('keeps working when the page breaks the view', async () => {
    const api = setup(session).api;
    const controller = createController({
      api,
      store: { read: () => session, write: () => undefined, clear: () => undefined },
      render: () => {
        throw new Error('the host page removed the element');
      },
      newId: () => 'id',
      setTimer: () => undefined,
      clearTimer: () => undefined,
      isHidden: () => false,
    });
    expect(() => {
      controller.open();
    }).not.toThrow();
    await settle();
    expect(controller.state().view).toBe('chat');
  });
});
