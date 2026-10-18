// The browser softphone: one @twilio/voice-sdk Device that registers this person for incoming
// calls, and the one call they have in hand. Checked against the installed SDK 2.18.5
// (es5/twilio/device.d.ts, call.d.ts, device.js, call.js, errors/generated.js) and Twilio's
// Voice JavaScript SDK docs (https://www.twilio.com/docs/voice/sdk/javascript).
//
// The SDK loads only on start. Access tokens come from the caller's authorized grant
// request, go straight to the Device and never into state, storage or logs. Outbound
// calls are placed by the server and bridged here as incoming calls, so there is no
// connect(): nothing here can dial a number or repeat a paid action.
import type { Call, Device } from '@twilio/voice-sdk';

/** A short-lived access token the server issued for this person and business. */
export interface VoiceGrant {
  readonly token: string;
  /** ISO 8601. */
  readonly expiresAt: string;
}
/** Asks the server for a grant; the signal aborts it when the controller is disposed. */
export type RequestVoiceGrant = (signal: AbortSignal) => Promise<VoiceGrant>;

/** An SDK event listener, as the SDK's EventEmitter types it. */
type Listener = Parameters<Device['on']>[1];
// on/removeListener as the SDK's EventEmitter has them; their chaining result is unused.
interface Listening {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}
/** The parts of the SDK's Call and Device this controller uses. */
export type SdkCall = Pick<
  Call,
  'accept' | 'reject' | 'ignore' | 'disconnect' | 'mute' | 'sendDigits' | 'parameters'
> &
  Listening;
export type SdkDevice = Pick<Device, 'register' | 'updateToken' | 'destroy'> & Listening;
export interface VoiceSdkModule {
  readonly Device: {
    new (token: string, options?: Device.Options): SdkDevice;
    readonly isSupported: boolean;
  };
}

export type VoiceProblemKind =
  | 'unsupported'
  | 'load_failed'
  | 'grant_failed'
  | 'token_rejected'
  | 'microphone_denied'
  | 'microphone_unavailable'
  | 'network'
  | 'provider';
export interface VoiceProblem {
  readonly kind: VoiceProblemKind;
  /** The SDK's numeric error code, when it gave one. */
  readonly code: number | null;
}
export interface VoiceCallView {
  /** The provider's Call SID, when it is well formed. */
  readonly sid: string | null;
  /** Who is calling, as the SDK reports it (a number or client:name). */
  readonly from: string | null;
  readonly phase: 'incoming' | 'connecting' | 'open' | 'reconnecting';
  readonly muted: boolean;
}
export interface BrowserVoiceState {
  /** 'ready' only after the SDK's own registered event. */
  readonly device: 'idle' | 'loading' | 'registering' | 'ready' | 'offline' | 'disposed';
  readonly problem: VoiceProblem | null;
  readonly call: VoiceCallView | null;
}

export interface BrowserVoiceOptions {
  readonly requestGrant: RequestVoiceGrant;
  /**
   * The calling SDK. The caller supplies it, so the SDK is bundled with the code that starts
   * the softphone rather than as a chunk of its own (see softphone-active.tsx).
   */
  readonly loadSdk: () => Promise<VoiceSdkModule>;
  readonly now?: () => number;
}

export interface BrowserVoice {
  /** The same object until something changes, for useSyncExternalStore. */
  getState(): BrowserVoiceState;
  subscribe(listener: () => void): () => void;
  /** Loads the SDK, gets a grant and registers. Runs once. */
  start(): Promise<void>;
  /** Fetches a new grant for the device; one at a time. */
  refresh(): Promise<void>;
  accept(): boolean;
  reject(): boolean;
  hangUp(): boolean;
  setMuted(muted: boolean): boolean;
  sendDigits(digits: string): boolean;
  /** Removes every listener and destroys the device. Make a new controller per business. */
  dispose(): void;
}

// Codes from the SDK's errors/generated.js.
const PROBLEM_CODES: ReadonlyMap<number, VoiceProblemKind> = new Map([
  [31_401, 'microphone_denied'],
  [31_402, 'microphone_unavailable'],
  [20_101, 'token_rejected'],
  [20_104, 'token_rejected'],
  [31_201, 'token_rejected'],
  [31_202, 'token_rejected'],
  [31_204, 'token_rejected'],
  [31_205, 'token_rejected'],
  [31_207, 'token_rejected'],
  [31_005, 'network'],
  [31_009, 'network'],
  [53_000, 'network'],
  [53_001, 'network'],
]);

function problemOf(error: unknown): VoiceProblem {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
      ? error.code
      : null;
  return { kind: (code === null ? undefined : PROBLEM_CODES.get(code)) ?? 'provider', code };
}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
// The SDK's own sendDigits accepts these; w is a half-second pause.
const DIGITS = /^[0-9*#w]{1,32}$/;
const fromOf = (value: string | undefined): string | null =>
  value !== undefined && value.length > 0 && value.length <= 256 && /^[^\p{Cc}]+$/u.test(value)
    ? value
    : null;

export function createBrowserVoice(options: BrowserVoiceOptions): BrowserVoice {
  const loadSdk = options.loadSdk;
  const now = options.now ?? Date.now;
  let state: BrowserVoiceState = { device: 'idle', problem: null, call: null };
  const subscribers = new Set<() => void>();
  const requests = new Set<AbortController>();
  let disposed = false;
  const isDisposed = () => disposed;
  let starting: Promise<void> | null = null;
  let refreshing: Promise<void> | null = null;
  let device: SdkDevice | null = null;
  let deviceListeners: (readonly [string, Listener])[] = [];
  let call: SdkCall | null = null;
  let callListeners: (readonly [string, Listener])[] = [];

  const set = (next: Partial<BrowserVoiceState>) => {
    if (disposed) return;
    state = { ...state, ...next };
    for (const subscriber of subscribers) subscriber();
  };
  const setCall = (next: Partial<VoiceCallView>) => {
    if (state.call !== null) set({ call: { ...state.call, ...next } });
  };

  /** A valid grant's token, or null; the request is aborted on disposal. */
  async function tokenFromServer(): Promise<string | null> {
    const controller = new AbortController();
    requests.add(controller);
    try {
      const grant = await options.requestGrant(controller.signal);
      const expires = Date.parse(grant.expiresAt);
      return JWT.test(grant.token) && grant.token.length <= 8192 && expires > now()
        ? grant.token
        : null;
    } catch {
      return null;
    } finally {
      requests.delete(controller);
    }
  }

  function releaseCall() {
    for (const [event, listener] of callListeners) call?.removeListener(event, listener);
    callListeners = [];
    call = null;
    set({ call: null });
  }

  function onIncoming(incoming: SdkCall) {
    // The SDK ignores invites while a call is active; this covers a second ringing one.
    // ignore() stops it ringing here only, so the person's other devices still ring.
    if (call !== null) {
      incoming.ignore();
      return;
    }
    call = incoming;
    const sid = incoming.parameters['CallSid'];
    const listeners: (readonly [string, Listener])[] = [
      [
        'accept',
        () => {
          setCall({ phase: 'open' });
        },
      ],
      [
        'reconnecting',
        () => {
          setCall({ phase: 'reconnecting' });
        },
      ],
      [
        'reconnected',
        () => {
          setCall({ phase: 'open' });
        },
      ],
      [
        'mute',
        (muted: boolean) => {
          setCall({ muted });
        },
      ],
      [
        'error',
        (error: unknown) => {
          set({ problem: problemOf(error) });
        },
      ],
      ['disconnect', releaseCall],
      ['cancel', releaseCall],
      ['reject', releaseCall],
    ];
    for (const [event, listener] of listeners) incoming.on(event, listener);
    callListeners = listeners;
    set({
      call: {
        sid: sid !== undefined && CALL_SID.test(sid) ? sid : null,
        from: fromOf(incoming.parameters['From']),
        phase: 'incoming',
        muted: false,
      },
    });
  }

  async function begin(): Promise<void> {
    set({ device: 'loading' });
    // Both at once; a grant that is not used is aborted, never handed on.
    const granted = tokenFromServer();
    const stop = (problem: VoiceProblem) => {
      for (const controller of requests) controller.abort();
      set({ device: 'offline', problem });
    };
    let sdk: VoiceSdkModule;
    try {
      sdk = await loadSdk();
    } catch {
      stop({ kind: 'load_failed', code: null });
      return;
    }
    if (isDisposed()) return;
    if (!sdk.Device.isSupported) {
      stop({ kind: 'unsupported', code: null });
      return;
    }
    const token = await granted;
    // Disposal can happen during either await.
    if (isDisposed()) return;
    if (token === null) {
      set({ device: 'offline', problem: { kind: 'grant_failed', code: null } });
      return;
    }
    let created: SdkDevice;
    try {
      created = new sdk.Device(token, { closeProtection: true });
    } catch (error) {
      set({ device: 'offline', problem: problemOf(error) });
      return;
    }
    device = created;
    deviceListeners = [
      [
        'registering',
        () => {
          set({ device: 'registering' });
        },
      ],
      [
        'registered',
        () => {
          set({ device: 'ready', problem: null });
        },
      ],
      [
        'unregistered',
        () => {
          set({ device: 'offline' });
        },
      ],
      [
        'error',
        (error: unknown) => {
          set({ problem: problemOf(error) });
        },
      ],
      ['incoming', onIncoming],
      ['tokenWillExpire', () => void refresh()],
    ];
    for (const [event, listener] of deviceListeners) created.on(event, listener);
    try {
      await created.register();
    } catch (error) {
      if (device === created) set({ device: 'offline', problem: problemOf(error) });
    }
  }

  async function renew(current: SdkDevice): Promise<void> {
    const token = await tokenFromServer();
    if (disposed || device !== current) return;
    if (token === null) {
      set({ problem: { kind: 'grant_failed', code: null } });
      return;
    }
    try {
      current.updateToken(token);
    } catch {
      set({ problem: { kind: 'grant_failed', code: null } });
      return;
    }
    if (state.problem?.kind === 'grant_failed' || state.problem?.kind === 'token_rejected')
      set({ problem: null });
  }

  function refresh(): Promise<void> {
    if (disposed || device === null) return Promise.resolve();
    refreshing ??= renew(device).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  const phase = () => state.call?.phase;

  return {
    getState: () => state,
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    start() {
      if (disposed) return Promise.resolve();
      starting ??= begin();
      return starting;
    },
    refresh,
    accept() {
      if (call === null || phase() !== 'incoming') return false;
      call.accept();
      setCall({ phase: 'connecting' });
      return true;
    },
    reject() {
      if (call === null || phase() !== 'incoming') return false;
      call.reject();
      return true;
    },
    hangUp() {
      if (call === null) return false;
      if (phase() === 'incoming') call.reject();
      else call.disconnect();
      return true;
    },
    setMuted(muted) {
      if (call === null || phase() === 'incoming') return false;
      call.mute(muted);
      return true;
    },
    sendDigits(digits) {
      if (call === null || phase() !== 'open' || !DIGITS.test(digits)) return false;
      call.sendDigits(digits);
      return true;
    },
    dispose() {
      if (disposed) return;
      for (const controller of requests) controller.abort();
      requests.clear();
      for (const [event, listener] of callListeners) call?.removeListener(event, listener);
      for (const [event, listener] of deviceListeners) device?.removeListener(event, listener);
      callListeners = [];
      deviceListeners = [];
      try {
        device?.destroy();
      } catch {
        // Destroying is best effort; the controller is finished either way.
      }
      device = null;
      call = null;
      state = { device: 'disposed', problem: null, call: null };
      for (const subscriber of subscribers) subscriber();
      disposed = true;
    },
  };
}
