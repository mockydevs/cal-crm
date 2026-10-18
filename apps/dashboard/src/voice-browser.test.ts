// The browser softphone controller, against injected stand-ins for @twilio/voice-sdk's
// Device and Call (2.18.5's event names and methods). Nothing here loads the real SDK,
// opens a socket, asks for a microphone or places a call.
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserVoice,
  type BrowserVoiceOptions,
  type RequestVoiceGrant,
  type VoiceGrant,
  type VoiceSdkModule,
} from './voice-browser';

const jwt = (n: number) =>
  `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ${String(n)}In0.c2lnbmF0dXJl${String(n)}`;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const grant = (n = 1): VoiceGrant => ({ token: jwt(n), expiresAt: '2026-10-15T12:05:00Z' });

class FakeCall extends EventEmitter {
  readonly accept = vi.fn();
  readonly reject = vi.fn();
  readonly ignore = vi.fn();
  readonly disconnect = vi.fn();
  readonly mute = vi.fn();
  readonly sendDigits = vi.fn();
  constructor(readonly parameters: Record<string, string>) {
    super();
  }
}

function sdk(options: { supported?: boolean; register?: () => Promise<void> } = {}) {
  const devices: FakeDevice[] = [];
  class FakeDevice extends EventEmitter {
    static readonly isSupported = options.supported ?? true;
    readonly register = vi.fn(options.register ?? (() => Promise.resolve()));
    readonly updateToken = vi.fn();
    readonly destroy = vi.fn();
    constructor(
      readonly token: string,
      readonly options?: unknown,
    ) {
      super();
      devices.push(this);
    }
  }
  const module: VoiceSdkModule = { Device: FakeDevice };
  return { module, devices };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(overrides: Partial<BrowserVoiceOptions> = {}, fake = sdk()) {
  const requestGrant = vi.fn<RequestVoiceGrant>(() => Promise.resolve(grant()));
  const loadSdk = vi.fn(() => Promise.resolve(fake.module));
  const voice = createBrowserVoice({ requestGrant, loadSdk, now: () => NOW, ...overrides });
  return { voice, requestGrant, loadSdk, devices: fake.devices };
}

async function registered(fake = sdk()) {
  const made = setup({}, fake);
  await made.voice.start();
  const device = made.devices[0];
  if (device === undefined) throw new Error('no device');
  device.emit('registering');
  device.emit('registered');
  return { ...made, device };
}

const twilioError = (code: number) => Object.assign(new Error('synthetic'), { code });

describe('starting', () => {
  it('loads the SDK only on start and is ready only after the SDK says registered', async () => {
    const { voice, loadSdk, requestGrant, devices } = setup();
    expect(voice.getState()).toEqual({ device: 'idle', problem: null, call: null });
    expect(loadSdk).not.toHaveBeenCalled();

    await voice.start();
    expect(loadSdk).toHaveBeenCalledOnce();
    expect(requestGrant).toHaveBeenCalledOnce();
    const device = devices[0];
    expect(device?.token).toBe(jwt(1));
    expect(device?.options).toEqual({ closeProtection: true });
    expect(device?.register).toHaveBeenCalledOnce();
    // register() resolving is not the SDK's registered event.
    expect(voice.getState().device).toBe('loading');

    device?.emit('registering');
    expect(voice.getState().device).toBe('registering');
    device?.emit('registered');
    expect(voice.getState()).toEqual({ device: 'ready', problem: null, call: null });
  });

  it('never keeps a token in its state', async () => {
    const { voice } = await registered();
    expect(JSON.stringify(voice.getState())).not.toContain(jwt(1));
  });

  it('starts once however often it is asked', async () => {
    const { voice, requestGrant, devices } = setup();
    await Promise.all([voice.start(), voice.start()]);
    await voice.start();
    expect(requestGrant).toHaveBeenCalledOnce();
    expect(devices).toHaveLength(1);
  });

  it.each([
    ['the grant request fails', () => Promise.reject(new Error('403'))],
    ['the token is not a JWT', () => Promise.resolve({ ...grant(), token: 'not a jwt' })],
    [
      'the grant has expired',
      () => Promise.resolve({ ...grant(), expiresAt: '2026-10-15T11:59:59Z' }),
    ],
    ['the expiry is not a date', () => Promise.resolve({ ...grant(), expiresAt: 'soon' })],
  ])('is offline with grant_failed and no device when %s', async (_name, requestGrant) => {
    const { voice, devices } = setup({ requestGrant });
    await voice.start();
    expect(voice.getState()).toEqual({
      device: 'offline',
      problem: { kind: 'grant_failed', code: null },
      call: null,
    });
    expect(devices).toHaveLength(0);
  });

  it('reports a browser without WebRTC instead of constructing a device', async () => {
    const fake = sdk({ supported: false });
    const { voice } = setup({}, fake);
    await voice.start();
    expect(voice.getState().problem).toEqual({ kind: 'unsupported', code: null });
    expect(fake.devices).toHaveLength(0);
  });

  it('reports an SDK that could not load', async () => {
    const { voice } = setup({ loadSdk: () => Promise.reject(new Error('chunk failed')) });
    await voice.start();
    expect(voice.getState()).toEqual({
      device: 'offline',
      problem: { kind: 'load_failed', code: null },
      call: null,
    });
  });

  it('reports a device the SDK refuses to construct', async () => {
    class Refusing extends EventEmitter {
      static readonly isSupported = true;
      readonly register = vi.fn(() => Promise.resolve());
      readonly updateToken = vi.fn();
      readonly destroy = vi.fn();
      constructor() {
        super();
        throw twilioError(31_000);
      }
    }
    const { voice } = setup({ loadSdk: () => Promise.resolve({ Device: Refusing }) });
    await voice.start();
    expect(voice.getState()).toEqual({
      device: 'offline',
      problem: { kind: 'provider', code: 31_000 },
      call: null,
    });
  });

  it('reports a register refusal with the SDK error it gave', async () => {
    const fake = sdk({ register: () => Promise.reject(twilioError(20_104)) });
    const { voice } = setup({}, fake);
    await voice.start();
    expect(voice.getState()).toEqual({
      device: 'offline',
      problem: { kind: 'token_rejected', code: 20_104 },
      call: null,
    });
  });
});

describe('disposal', () => {
  it('drops a grant that arrives after disposal and aborts its request', async () => {
    const pending = deferred<VoiceGrant>();
    let signal: AbortSignal | undefined;
    const { voice, devices } = setup({
      requestGrant: (given) => {
        signal = given;
        return pending.promise;
      },
    });
    const started = voice.start();
    voice.dispose();
    expect(signal?.aborted).toBe(true);
    pending.resolve(grant());
    await started;
    expect(devices).toHaveLength(0);
    expect(voice.getState().device).toBe('disposed');
  });

  it('drops an SDK that loads after disposal', async () => {
    const fake = sdk();
    const loading = deferred<VoiceSdkModule>();
    const { voice } = setup({ loadSdk: () => loading.promise }, fake);
    const started = voice.start();
    voice.dispose();
    loading.resolve(fake.module);
    await started;
    expect(fake.devices).toHaveLength(0);
  });

  it('removes every listener it added and destroys the device once', async () => {
    const { voice, device } = await registered();
    const call = new FakeCall({ CallSid: `CA${'1'.repeat(32)}`, From: '+12025550101' });
    device.emit('incoming', call);
    voice.dispose();
    voice.dispose();
    expect(device.eventNames()).toEqual([]);
    expect(call.eventNames()).toEqual([]);
    expect(device.destroy).toHaveBeenCalledOnce();
    expect(voice.getState()).toEqual({ device: 'disposed', problem: null, call: null });
    expect(voice.accept()).toBe(false);
    await voice.start();
    expect(voice.getState().device).toBe('disposed');
  });

  it('is disposed even when the SDK throws while destroying', async () => {
    const { voice, device } = await registered();
    device.destroy.mockImplementation(() => {
      throw new Error('already destroyed');
    });
    voice.dispose();
    expect(voice.getState().device).toBe('disposed');
  });
});

describe('token refresh', () => {
  it('asks for a new grant when the token will expire and hands it to the device', async () => {
    const { voice, device, requestGrant } = await registered();
    requestGrant.mockResolvedValueOnce(grant(2));
    device.emit('tokenWillExpire', device);
    await flush();
    expect(requestGrant).toHaveBeenCalledTimes(2);
    expect(device.updateToken).toHaveBeenCalledExactlyOnceWith(jwt(2));
    expect(voice.getState().device).toBe('ready');
  });

  it('runs one refresh at a time', async () => {
    const { device, requestGrant } = await registered();
    const pending = deferred<VoiceGrant>();
    requestGrant.mockReturnValueOnce(pending.promise);
    device.emit('tokenWillExpire', device);
    device.emit('tokenWillExpire', device);
    pending.resolve(grant(2));
    await flush();
    expect(requestGrant).toHaveBeenCalledTimes(2);
    expect(device.updateToken).toHaveBeenCalledOnce();
  });

  it('keeps the device and reports grant_failed when the refresh fails', async () => {
    const { voice, device, requestGrant } = await registered();
    requestGrant.mockRejectedValueOnce(new Error('session ended'));
    await voice.refresh();
    expect(device.updateToken).not.toHaveBeenCalled();
    expect(voice.getState()).toEqual({
      device: 'ready',
      problem: { kind: 'grant_failed', code: null },
      call: null,
    });
    // A later refresh that works clears the problem.
    requestGrant.mockResolvedValueOnce(grant(3));
    await voice.refresh();
    expect(device.updateToken).toHaveBeenCalledExactlyOnceWith(jwt(3));
    expect(voice.getState().problem).toBeNull();
  });

  it('never hands the device a refreshed token after disposal', async () => {
    const { voice, device, requestGrant } = await registered();
    const pending = deferred<VoiceGrant>();
    requestGrant.mockReturnValueOnce(pending.promise);
    const refreshing = voice.refresh();
    voice.dispose();
    pending.resolve(grant(2));
    await refreshing;
    expect(device.updateToken).not.toHaveBeenCalled();
  });

  it('refuses a refreshed grant that is malformed, and an SDK that refuses the token', async () => {
    const { voice, device, requestGrant } = await registered();
    requestGrant.mockResolvedValueOnce({ token: 'x', expiresAt: '2026-10-15T12:05:00Z' });
    await voice.refresh();
    expect(device.updateToken).not.toHaveBeenCalled();
    expect(voice.getState().problem).toEqual({ kind: 'grant_failed', code: null });
    device.updateToken.mockImplementationOnce(() => {
      throw new Error('destroyed');
    });
    await voice.refresh();
    expect(voice.getState().problem).toEqual({ kind: 'grant_failed', code: null });
  });

  it('does nothing before a device exists', async () => {
    const { voice, requestGrant } = setup();
    await voice.refresh();
    expect(requestGrant).not.toHaveBeenCalled();
  });
});

describe('device errors', () => {
  it.each([
    [31_401, 'microphone_denied'],
    [31_402, 'microphone_unavailable'],
    [20_101, 'token_rejected'],
    [31_205, 'token_rejected'],
    [53_000, 'network'],
    [31_005, 'network'],
    [31_000, 'provider'],
  ])('shows SDK error %i as %s', async (code, kind) => {
    const { voice, device } = await registered();
    device.emit('error', twilioError(code));
    expect(voice.getState().problem).toEqual({ kind, code });
  });

  it('shows an error without a numeric code as a provider problem', async () => {
    const { voice, device } = await registered();
    device.emit('error', { code: 'x' });
    expect(voice.getState().problem).toEqual({ kind: 'provider', code: null });
  });

  it('goes offline when the SDK unregisters, and clears the problem on registering again', async () => {
    const { voice, device } = await registered();
    device.emit('error', twilioError(53_000));
    device.emit('unregistered');
    expect(voice.getState().device).toBe('offline');
    device.emit('registered');
    expect(voice.getState()).toEqual({ device: 'ready', problem: null, call: null });
  });
});

describe('an incoming call', () => {
  const sid = `CA${'1'.repeat(32)}`;
  async function ringing() {
    const made = await registered();
    const call = new FakeCall({ CallSid: sid, From: '+12025550101' });
    made.device.emit('incoming', call);
    return { ...made, call };
  }

  it('is shown ringing with its caller and accepted on request', async () => {
    const { voice, call } = await ringing();
    expect(voice.getState().call).toEqual({
      sid,
      from: '+12025550101',
      phase: 'incoming',
      muted: false,
    });
    expect(voice.sendDigits('1')).toBe(false);
    expect(voice.accept()).toBe(true);
    expect(call.accept).toHaveBeenCalledOnce();
    expect(voice.getState().call?.phase).toBe('connecting');
    expect(voice.accept()).toBe(false);
    call.emit('accept', call);
    expect(voice.getState().call?.phase).toBe('open');
  });

  it('controls an open call: mute, digits, reconnecting and hang up', async () => {
    const { voice, call } = await ringing();
    voice.accept();
    call.emit('accept', call);
    expect(voice.setMuted(true)).toBe(true);
    expect(call.mute).toHaveBeenCalledWith(true);
    call.emit('mute', true, call);
    expect(voice.getState().call?.muted).toBe(true);
    expect(voice.sendDigits('12#*w9')).toBe(true);
    expect(call.sendDigits).toHaveBeenCalledWith('12#*w9');
    expect(voice.sendDigits('12a')).toBe(false);
    expect(voice.sendDigits('')).toBe(false);
    call.emit('reconnecting', twilioError(53_405));
    expect(voice.getState().call?.phase).toBe('reconnecting');
    call.emit('reconnected');
    expect(voice.getState().call?.phase).toBe('open');
    expect(voice.hangUp()).toBe(true);
    expect(call.disconnect).toHaveBeenCalledOnce();
    call.emit('disconnect', call);
    expect(voice.getState().call).toBeNull();
    expect(call.eventNames()).toEqual([]);
  });

  it('is rejected on request and cleared when the SDK confirms', async () => {
    const { voice, call } = await ringing();
    expect(voice.reject()).toBe(true);
    expect(call.reject).toHaveBeenCalledOnce();
    call.emit('reject');
    expect(voice.getState().call).toBeNull();
    expect(call.eventNames()).toEqual([]);
  });

  it('hanging up a ringing call rejects it', async () => {
    const { voice, call } = await ringing();
    expect(voice.hangUp()).toBe(true);
    expect(call.reject).toHaveBeenCalledOnce();
    expect(call.disconnect).not.toHaveBeenCalled();
  });

  it('is cleared when the caller gives up', async () => {
    const { voice, call } = await ringing();
    call.emit('cancel');
    expect(voice.getState().call).toBeNull();
  });

  it('shows a microphone refusal on accept and ends when the SDK ends it', async () => {
    const { voice, call } = await ringing();
    voice.accept();
    call.emit('error', twilioError(31_401));
    expect(voice.getState().problem).toEqual({ kind: 'microphone_denied', code: 31_401 });
    call.emit('disconnect', call);
    expect(voice.getState().call).toBeNull();
    expect(voice.getState().problem).toEqual({ kind: 'microphone_denied', code: 31_401 });
  });

  it('leaves a second call alone on this device while one is in hand', async () => {
    const { voice, device, call } = await ringing();
    const second = new FakeCall({ CallSid: `CA${'2'.repeat(32)}`, From: '+12025550102' });
    device.emit('incoming', second);
    expect(second.ignore).toHaveBeenCalledOnce();
    expect(second.reject).not.toHaveBeenCalled();
    expect(voice.getState().call?.sid).toBe(sid);
    expect(call.ignore).not.toHaveBeenCalled();
  });

  it('reads missing or malformed parameters as unknown', async () => {
    const { voice, device } = await registered();
    device.emit('incoming', new FakeCall({ CallSid: 'nope', From: 'x'.repeat(300) }));
    expect(voice.getState().call).toEqual({
      sid: null,
      from: null,
      phase: 'incoming',
      muted: false,
    });
  });

  it('has no controls without a call', async () => {
    const { voice } = await registered();
    expect(voice.accept()).toBe(false);
    expect(voice.reject()).toBe(false);
    expect(voice.hangUp()).toBe(false);
    expect(voice.setMuted(true)).toBe(false);
    expect(voice.sendDigits('1')).toBe(false);
  });
});

describe('subscribers', () => {
  it('hears each change, keeps one snapshot between changes and can leave', async () => {
    const { voice, devices } = setup();
    const heard = vi.fn();
    const leave = voice.subscribe(heard);
    await voice.start();
    const before = voice.getState();
    expect(voice.getState()).toBe(before);
    devices[0]?.emit('registered');
    expect(heard).toHaveBeenLastCalledWith();
    expect(voice.getState()).not.toBe(before);
    const count = heard.mock.calls.length;
    leave();
    devices[0]?.emit('unregistered');
    expect(heard).toHaveBeenCalledTimes(count);
  });
});
