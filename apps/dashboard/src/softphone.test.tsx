// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SoftphoneProvider, useSoftphone } from './softphone';
import type {
  BrowserVoice,
  BrowserVoiceOptions,
  BrowserVoiceState,
  VoiceCallView,
} from './voice-browser';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}

const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));

beforeAll(async () => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  // The active softphone carries the calling SDK, which takes a while to load the first time:
  // loaded here, so no test's wait is spent on it.
  await import('./softphone-active');
}, 30_000);

beforeEach(() => {
  server.calls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const callView = (patch: Partial<VoiceCallView> = {}): VoiceCallView => ({
  sid: 'CA11111111111111111111111111111111',
  from: '+14155550111',
  phase: 'open',
  muted: false,
  ...patch,
});

/** As the server answers someone who may place calls while calling is available. */
function mayCall(more: (operation: string) => unknown = () => undefined): void {
  server.answer = (operation) => {
    if (operation === 'getMyPermissions') return { permissions: ['calls.place'] };
    if (operation === 'getCallingAvailability') return { available: true, unavailable: null };
    const answer = more(operation);
    if (answer === undefined) throw new Error(`Unexpected ${operation}`);
    return answer;
  };
}

interface StandInVoice {
  controller: BrowserVoice;
  getState: () => BrowserVoiceState;
  setState: (patch: Partial<BrowserVoiceState>) => void;
  recorded: {
    start: number;
    dispose: number;
    refresh: number;
    accept: number;
    reject: number;
    hangUp: number;
    muted: boolean[];
    digits: string[];
  };
}

function makeStandInVoice(initial: Partial<BrowserVoiceState> = {}): StandInVoice {
  let state: BrowserVoiceState = {
    device: 'ready',
    problem: null,
    call: null,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const recorded = {
    start: 0,
    dispose: 0,
    refresh: 0,
    accept: 0,
    reject: 0,
    hangUp: 0,
    muted: [] as boolean[],
    digits: [] as string[],
  };

  const controller: BrowserVoice = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: vi.fn(() => {
      recorded.start += 1;
      return Promise.resolve();
    }),
    refresh: vi.fn(() => {
      recorded.refresh += 1;
      return Promise.resolve();
    }),
    accept: vi.fn(() => {
      recorded.accept += 1;
      return true;
    }),
    reject: vi.fn(() => {
      recorded.reject += 1;
      return true;
    }),
    hangUp: vi.fn(() => {
      recorded.hangUp += 1;
      return true;
    }),
    setMuted: vi.fn((muted: boolean) => {
      recorded.muted.push(muted);
      return true;
    }),
    sendDigits: vi.fn((digits: string) => {
      recorded.digits.push(digits);
      return true;
    }),
    dispose: vi.fn(() => {
      recorded.dispose += 1;
    }),
  };

  const setState = (patch: Partial<BrowserVoiceState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  return { controller, getState: () => state, setState, recorded };
}

function renderSoftphone(
  children: ReactNode,
  createVoice?: (opts: BrowserVoiceOptions) => BrowserVoice,
  businessId = 'biz_test',
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SoftphoneProvider businessId={businessId} createVoice={createVoice}>
          {children}
        </SoftphoneProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('Softphone', () => {
  it('nothing is created without calls.place or while unavailable', async () => {
    const creator = vi.fn(() => makeStandInVoice().controller);

    // Case 1: missing calls.place permission
    server.answer = (operation) => {
      if (operation === 'getMyPermissions') return { permissions: ['calls.read'] };
      if (operation === 'getCallingAvailability') return { available: true, unavailable: null };
      throw new Error(`Unexpected ${operation}`);
    };

    const { unmount } = renderSoftphone(<p>content</p>, creator);
    await waitFor(() => {
      expect(screen.getByText('content')).toBeDefined();
    });
    expect(creator).not.toHaveBeenCalled();
    unmount();

    // Case 2: calling is not available
    creator.mockClear();
    server.answer = (operation) => {
      if (operation === 'getMyPermissions') return { permissions: ['calls.place', 'calls.read'] };
      if (operation === 'getCallingAvailability')
        return {
          available: false,
          unavailable: { code: 'calling_not_set_up', message: 'Not set up.' },
        };
      throw new Error(`Unexpected ${operation}`);
    };

    const second = renderSoftphone(<p>content2</p>, creator);
    await waitFor(() => {
      expect(screen.getByText('content2')).toBeDefined();
    });
    expect(creator).not.toHaveBeenCalled();
    second.unmount();
  });

  it('starts once and disposes on unmount', async () => {
    const standIn = makeStandInVoice();
    const creator = vi.fn(() => standIn.controller);

    server.answer = (operation) => {
      if (operation === 'getMyPermissions') return { permissions: ['calls.place'] };
      if (operation === 'getCallingAvailability') return { available: true, unavailable: null };
      throw new Error(`Unexpected ${operation}`);
    };

    const { unmount } = renderSoftphone(<p>ready</p>, creator);
    await waitFor(() => {
      expect(standIn.recorded.start).toBe(1);
    });
    expect(creator).toHaveBeenCalledTimes(1);
    expect(standIn.recorded.dispose).toBe(0);

    unmount();
    expect(standIn.recorded.dispose).toBe(1);
  });

  it('keeps one controller while its state changes, as the real one does once started', async () => {
    // The real controller tells its subscribers as soon as it starts loading: a render that
    // made a new controller would dispose this one and start the next, without end.
    const made: StandInVoice[] = [];
    const creator = vi.fn(() => {
      const standIn = makeStandInVoice({ device: 'idle' });
      standIn.controller.start = vi.fn(() => {
        standIn.recorded.start += 1;
        standIn.setState({ device: 'loading' });
        return Promise.resolve().then(() => {
          standIn.setState({ device: 'ready' });
        });
      });
      made.push(standIn);
      return standIn.controller;
    });
    server.answer = (operation) => {
      if (operation === 'getMyPermissions') return { permissions: ['calls.place'] };
      if (operation === 'getCallingAvailability') return { available: true, unavailable: null };
      throw new Error(`Unexpected ${operation}`);
    };

    function Device() {
      return <p>{useSoftphone()?.state.device ?? 'none'}</p>;
    }
    renderSoftphone(<Device />, creator);
    expect(await screen.findByText('ready')).toBeDefined();
    expect(creator).toHaveBeenCalledTimes(1);
    expect(made[0]?.recorded).toMatchObject({ start: 1, dispose: 0 });
  });

  it('placeCall sends requestCall with the identity and a key', async () => {
    const standIn = makeStandInVoice();
    server.answer = (operation) => {
      if (operation === 'getMyPermissions') return { permissions: ['calls.place'] };
      if (operation === 'getCallingAvailability') return { available: true, unavailable: null };
      if (operation === 'requestCall') {
        return {
          id: 'call_test_1',
          state: 'requested',
          direction: 'outbound',
        };
      }
      if (operation === 'getCall') {
        return {
          id: 'call_test_1',
          state: 'requested',
          legs: [],
        };
      }
      throw new Error(`Unexpected ${operation}`);
    };

    function TestConsumer() {
      const softphone = useSoftphone();
      return (
        <button
          type="button"
          disabled={softphone === null}
          onClick={() => {
            void softphone?.placeCall('cid_contact_identity_123');
          }}
        >
          Dial
        </button>
      );
    }

    const user = userEvent.setup();
    renderSoftphone(<TestConsumer />, () => standIn.controller);

    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Dial' }).disabled).toBe(false);
    });
    const dialButton = screen.getByRole('button', { name: 'Dial' });
    await user.click(dialButton);

    await waitFor(() => {
      const requestCalls = server.calls.filter((c) => c.operation === 'requestCall');
      expect(requestCalls).toHaveLength(1);
      const input = requestCalls[0]?.input as {
        body: { contactIdentityId: string; idempotencyKey: string };
      };
      expect(input.body.contactIdentityId).toBe('cid_contact_identity_123');
      expect(input.body.idempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it('the expected call (matching sid) is accepted once and another sid is not', async () => {
    const standIn = makeStandInVoice();
    const providerCallId = 'CA0123456789abcdef0123456789abcdef';

    server.answer = (operation) => {
      if (operation === 'getMyPermissions') return { permissions: ['calls.place'] };
      if (operation === 'getCallingAvailability') return { available: true, unavailable: null };
      if (operation === 'requestCall') {
        return { id: 'call_expected_1', state: 'requested' };
      }
      if (operation === 'getCall') {
        return {
          id: 'call_expected_1',
          state: 'dialing',
          legs: [{ parentId: null, providerCallId }],
        };
      }
      throw new Error(`Unexpected ${operation}`);
    };

    function TestConsumer() {
      const softphone = useSoftphone();
      return (
        <button
          type="button"
          disabled={softphone === null}
          onClick={() => {
            void softphone?.placeCall('cid_123');
          }}
        >
          Call
        </button>
      );
    }

    const user = userEvent.setup();
    renderSoftphone(<TestConsumer />, () => standIn.controller);

    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Call' }).disabled).toBe(false);
    });
    const callBtn = screen.getByRole('button', { name: 'Call' });
    await user.click(callBtn);

    // Wait until getCall has been polled
    await waitFor(() => {
      expect(server.calls.some((c) => c.operation === 'getCall')).toBe(true);
    });

    // An unexpected call arrives once the placed call's SID is known. act() runs the
    // effects that would answer it, so a missing SID check fails here.
    await act(async () => {
      await Promise.resolve();
      standIn.setState({
        call: {
          sid: 'CA99999999999999999999999999999999',
          from: '+14155550199',
          phase: 'incoming',
          muted: false,
        },
      });
    });

    expect(standIn.recorded.accept).toBe(0);

    // The expected call arrives
    standIn.setState({
      call: {
        sid: providerCallId,
        from: '+14155550199',
        phase: 'incoming',
        muted: false,
      },
    });

    await waitFor(() => {
      expect(standIn.recorded.accept).toBe(1);
    });

    // Subsequent state changes do not accept again
    standIn.setState({
      call: {
        sid: providerCallId,
        from: '+14155550199',
        phase: 'open',
        muted: false,
      },
    });
    expect(standIn.recorded.accept).toBe(1);
  });

  it("the bar's buttons call accept, reject, setMuted, sendDigits and hangUp", async () => {
    const standIn = makeStandInVoice({
      call: {
        sid: 'CA11111111111111111111111111111111',
        from: '+14155550111',
        phase: 'incoming',
        muted: false,
      },
    });

    server.answer = (operation) => {
      if (operation === 'getMyPermissions') return { permissions: ['calls.place'] };
      if (operation === 'getCallingAvailability') return { available: true, unavailable: null };
      throw new Error(`Unexpected ${operation}`);
    };

    const user = userEvent.setup();
    renderSoftphone(<p>page</p>, () => standIn.controller);

    // Incoming call shows Answer and Decline
    const answerBtn = await screen.findByRole('button', { name: 'Answer' });
    const declineBtn = screen.getByRole('button', { name: 'Decline' });

    await user.click(answerBtn);
    expect(standIn.recorded.accept).toBe(1);

    await user.click(declineBtn);
    expect(standIn.recorded.reject).toBe(1);

    // Transition to open call
    standIn.setState({
      call: {
        sid: 'CA11111111111111111111111111111111',
        from: '+14155550111',
        phase: 'open',
        muted: false,
      },
    });

    // Mute is one button that says whether it is on.
    const muteBtn = await screen.findByRole('button', { name: 'Mute' });
    expect(muteBtn.getAttribute('aria-pressed')).toBe('false');
    await user.click(muteBtn);
    expect(standIn.recorded.muted).toEqual([true]);

    act(() => {
      standIn.setState({ call: callView({ muted: true }) });
    });
    expect(screen.getByRole('button', { name: 'Mute' })).toBe(muteBtn);
    expect(muteBtn.getAttribute('aria-pressed')).toBe('true');
    await user.click(muteBtn);
    expect(standIn.recorded.muted).toEqual([true, false]);

    // Keypad opens digits
    const keypadBtn = screen.getByRole('button', { name: 'Keypad' });
    await user.click(keypadBtn);

    const digit5 = await screen.findByRole('button', { name: '5' });
    await user.click(digit5);
    expect(standIn.recorded.digits).toEqual(['5']);

    const digitHash = screen.getByRole('button', { name: '#' });
    await user.click(digitHash);
    expect(standIn.recorded.digits).toEqual(['5', '#']);

    // Hang up
    const hangUpBtn = screen.getByRole('button', { name: 'Hang up' });
    await user.click(hangUpBtn);
    expect(standIn.recorded.hangUp).toBe(1);
  });

  it('the bar is hidden when idle', async () => {
    const standIn = makeStandInVoice({ call: null, problem: null });

    server.answer = (operation) => {
      if (operation === 'getMyPermissions') return { permissions: ['calls.place'] };
      if (operation === 'getCallingAvailability') return { available: true, unavailable: null };
      throw new Error(`Unexpected ${operation}`);
    };

    renderSoftphone(<p>page</p>, () => standIn.controller);

    await waitFor(() => {
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(screen.queryByLabelText(/Phone/i)).toBeNull();
    });
  });

  it('a device problem shows Try again calling refresh', async () => {
    const standIn = makeStandInVoice({
      call: null,
      problem: { kind: 'microphone_denied', code: 31401 },
    });

    server.answer = (operation) => {
      if (operation === 'getMyPermissions') return { permissions: ['calls.place'] };
      if (operation === 'getCallingAvailability') return { available: true, unavailable: null };
      throw new Error(`Unexpected ${operation}`);
    };

    const user = userEvent.setup();
    renderSoftphone(<p>page</p>, () => standIn.controller);

    expect(await screen.findByText('Microphone permission was denied.')).toBeDefined();

    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    await user.click(tryAgainBtn);
    expect(standIn.recorded.refresh).toBe(1);
  });
  it('mounts a page once while the softphone switches on', async () => {
    let mounts = 0;
    function Page() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <p>{useSoftphone()?.state.device ?? 'off'}</p>;
    }
    mayCall();
    const standIn = makeStandInVoice();
    renderSoftphone(<Page />, () => standIn.controller);
    expect(await screen.findByText('ready')).toBeDefined();
    expect(standIn.recorded.start).toBe(1);
    expect(mounts).toBe(1);
  });

  it('answers the placed call when its id arrives after this browser has started ringing', async () => {
    const providerCallId = `CA${'7'.repeat(32)}`;
    let known = false;
    mayCall((operation) => {
      if (operation === 'requestCall') return { id: 'call_poll_1', state: 'requested' };
      if (operation === 'getCall')
        return {
          id: 'call_poll_1',
          state: 'dialing',
          legs: [{ parentId: null, providerCallId: known ? providerCallId : null }],
        };
      return undefined;
    });
    const standIn = makeStandInVoice();
    function Dial() {
      const softphone = useSoftphone();
      return (
        <button
          type="button"
          disabled={softphone === null}
          onClick={() => void softphone?.placeCall('cid_poll')}
        >
          Dial
        </button>
      );
    }
    const user = userEvent.setup();
    renderSoftphone(<Dial />, () => standIn.controller);
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Dial' }).disabled).toBe(false);
    });
    await user.click(screen.getByRole('button', { name: 'Dial' }));
    await waitFor(() => {
      expect(server.calls.some((each) => each.operation === 'getCall')).toBe(true);
    });
    // The browser rings before the server knows the provider's id: nothing is answered yet.
    act(() => {
      standIn.setState({ call: callView({ sid: providerCallId, phase: 'incoming' }) });
    });
    expect(standIn.recorded.accept).toBe(0);
    known = true;
    await waitFor(
      () => {
        expect(standIn.recorded.accept).toBe(1);
      },
      { timeout: 2000 },
    );
    // Reads that are still on their way, and later ones, answer nothing more.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(standIn.recorded.accept).toBe(1);
    expect(screen.getByRole('button', { name: 'Answer' })).toBeDefined();
  });

  it('tells a screen reader what the call is doing, politely', async () => {
    mayCall();
    const standIn = makeStandInVoice();
    renderSoftphone(<p>page</p>, () => standIn.controller);
    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    act(() => {
      standIn.setState({ call: callView({ phase: 'incoming', from: '+14155550122' }) });
    });
    expect(status.textContent).toBe('Incoming call from +14155550122');
    act(() => {
      standIn.setState({ call: callView({ from: '+14155550122' }) });
    });
    expect(status.textContent).toBe('In call');
  });

  it('shows the keypad only once the call is open', async () => {
    mayCall();
    const standIn = makeStandInVoice({ call: callView({ phase: 'connecting' }) });
    renderSoftphone(<p>page</p>, () => standIn.controller);
    const bar = await screen.findByRole('complementary', { name: 'Phone call' });
    expect(within(bar).getByRole('button', { name: 'Hang up' })).toBeDefined();
    expect(within(bar).queryByRole('button', { name: 'Keypad' })).toBeNull();
    act(() => {
      standIn.setState({ call: callView() });
    });
    expect(within(bar).getByRole('button', { name: 'Keypad' })).toBeDefined();
  });

  it('keeps counting the call’s time while it reconnects', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mayCall();
    const standIn = makeStandInVoice({ call: callView() });
    renderSoftphone(<p>page</p>, () => standIn.controller);
    const bar = await screen.findByRole('complementary', { name: 'Phone call' });
    expect(await within(bar).findByText('0:00')).toBeDefined();
    now += 40_000;
    act(() => {
      standIn.setState({ call: callView({ phase: 'reconnecting' }) });
    });
    // The bar's clock moves on its next second.
    expect(await within(bar).findByText('0:40', {}, { timeout: 2000 })).toBeDefined();
    now += 25_000;
    act(() => {
      standIn.setState({ call: callView() });
    });
    expect(await within(bar).findByText('1:05', {}, { timeout: 2000 })).toBeDefined();
  });

  it('gives focus back to where it was when the call ends', async () => {
    mayCall();
    const standIn = makeStandInVoice();
    const user = userEvent.setup();
    renderSoftphone(<button type="button">Before</button>, () => standIn.controller);
    await screen.findByRole('status');
    const before = screen.getByRole('button', { name: 'Before' });
    before.focus();
    act(() => {
      standIn.setState({ call: callView() });
    });
    const hangUp = screen.getByRole('button', { name: 'Hang up' });
    await user.click(hangUp);
    expect(document.activeElement).toBe(hangUp);
    act(() => {
      standIn.setState({ call: null });
    });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it('keeps the bar inside the screen at 360 pixels', async () => {
    mayCall();
    const standIn = makeStandInVoice({ call: callView() });
    renderSoftphone(<p>page</p>, () => standIn.controller);
    const bar = await screen.findByRole('complementary', { name: 'Phone call' });
    expect(bar.className.split(' ')).toEqual(
      expect.arrayContaining(['left-4', 'right-4', 'sm:left-auto']),
    );
  });
  it('keeps a live controller when React runs its effects twice, as it does in development', async () => {
    // As the real controller: once disposed it is finished, and starting it does nothing.
    const made: StandInVoice[] = [];
    const creator = vi.fn(() => {
      const standIn = makeStandInVoice({ device: 'idle' });
      let disposed = false;
      standIn.controller.start = vi.fn(() => {
        standIn.recorded.start += 1;
        if (!disposed) standIn.setState({ device: 'ready' });
        return Promise.resolve();
      });
      standIn.controller.dispose = vi.fn(() => {
        standIn.recorded.dispose += 1;
        standIn.setState({ device: 'disposed' });
        disposed = true;
      });
      made.push(standIn);
      return standIn.controller;
    });
    mayCall();
    function Device() {
      return <p>{useSoftphone()?.state.device ?? 'off'}</p>;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <StrictMode>
        <I18nProvider i18n={i18n}>
          <QueryClientProvider client={client}>
            <SoftphoneProvider businessId="biz_test" createVoice={creator}>
              <Device />
            </SoftphoneProvider>
          </QueryClientProvider>
        </I18nProvider>
      </StrictMode>,
    );
    expect(await screen.findByText('ready')).toBeDefined();
    // Every controller that was started is disposed, except the one in use.
    const started = made.filter((each) => each.recorded.start > 0);
    expect(started.filter((each) => each.recorded.dispose === 0)).toHaveLength(1);
    unmount();
    expect(made.every((each) => each.recorded.start === 0 || each.recorded.dispose === 1)).toBe(
      true,
    );
  });
});
