import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { BOOKING_NOTIFICATION_WORDING, type PublicCalendarPage } from '@repo/contracts';
import type { DB } from '@repo/db';
import type { PublicBookingHandlers } from '@repo/module-calendar';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTAKE_GATE_RETRY_SECONDS } from './intake-gate.js';
import { registerPublicBooking } from './public-booking.js';
import {
  clientKey,
  createIntakeScopes,
  createPublicIntakeLimit,
  databaseAdmission,
  PublicIntakeLimitError,
  type AdmitPublicIntake,
} from './public-intake-limit.js';

// Obvious fakes: these protect nothing.
const SECRET = 'test-only-public-intake-secret-0123456789';
const OTHER_SECRET = 'another-test-only-intake-secret-9876543210';
const admitted = { allowed: true, retry_after_seconds: 0, reason: 'admitted' };
const refused = { allowed: false, retry_after_seconds: 37, reason: 'client_quota' };
const context = (ipAddress: unknown) => ({ requestId: 'request-1', ipAddress }) as never;
/** Past the in-flight limit: "wait", as a full line says it, and never allowed. */
const busy = { allowed: false, retryAfterSeconds: INTAKE_GATE_RETRY_SECONDS };

function limiter(row: unknown = admitted, secret = SECRET) {
  const admit = vi.fn<AdmitPublicIntake>().mockResolvedValue(row);
  return { admit, limit: createPublicIntakeLimit({ admit, secret }) };
}

/** The digest the database receives for an address. */
async function digestOf(ipAddress: string, secret = SECRET): Promise<string> {
  const { admit, limit } = limiter(admitted, secret);
  await limit(context(ipAddress), 'read');
  return admit.mock.calls[0]?.[1].toString('hex') ?? '';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the secret', () => {
  it.each([undefined, null, '', 'too-short-secret', 'x'.repeat(31), 42, Buffer.alloc(64)])(
    'is required and at least 32 bytes: %s',
    (secret) => {
      const admit = vi.fn<AdmitPublicIntake>();
      expect(() => createPublicIntakeLimit({ admit, secret: secret as never })).toThrow(
        'The public intake limiter needs a secret of at least 32 bytes.',
      );
    },
  );

  it('is not echoed when it is refused', () => {
    const secret = 'short-and-private';
    let message = '';
    try {
      createPublicIntakeLimit({ admit: vi.fn<AdmitPublicIntake>(), secret });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('at least 32 bytes');
    expect(message).not.toContain(secret);
  });

  it('counts bytes, so 32 is enough', () => {
    expect(() =>
      createPublicIntakeLimit({ admit: vi.fn<AdmitPublicIntake>(), secret: 'x'.repeat(32) }),
    ).not.toThrow();
  });

  it('comes from the caller only: the source never reads the environment', async () => {
    const source = await readFile(new URL('public-intake-limit.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/process\s*\.\s*env|node:process|dotenv/);
  });

  it('keys the digest: another secret gives another digest for the same address', async () => {
    expect(await digestOf('192.0.2.7')).toBe(await digestOf('192.0.2.7'));
    expect(await digestOf('192.0.2.7')).not.toBe(await digestOf('192.0.2.7', OTHER_SECRET));
  });
});

describe('what reaches the store', () => {
  it('is the operation and an HMAC-SHA256 of the address, never the address', async () => {
    const { admit, limit } = limiter();
    const ipAddress = '203.0.113.77';
    await limit(context(ipAddress), 'write');
    expect(admit).toHaveBeenCalledOnce();
    const [operation, digest, signal, ...rest] = admit.mock.calls[0] ?? [];
    // No business was named, so none is counted.
    expect(rest).toEqual([null]);
    expect(operation).toBe('write');
    expect(signal).toBeInstanceOf(AbortSignal);
    // The format, written out independently: label, a zero byte, the family, the bytes.
    const expected = createHmac('sha256', SECRET)
      .update('crm.public-intake.client.v1')
      .update(Buffer.from([0, 4, 203, 0, 113, 77]))
      .digest();
    expect(Buffer.isBuffer(digest)).toBe(true);
    expect(digest).toHaveLength(32);
    expect(digest?.equals(expected)).toBe(true);
    expect(digest?.includes(Buffer.from([203, 0, 113, 77]))).toBe(false);
    expect(`${String(operation)} ${digest?.toString('latin1') ?? ''}`).not.toContain(ipAddress);
  });

  it('adds a digest of the business a transport names, and never the business', async () => {
    const { admit, limit } = limiter();
    const businessId = '01890f3e-7b1c-7cc0-8a51-0123456789ab';
    const request = (over: object) =>
      ({ requestId: 'request-1', ipAddress: '203.0.113.77', ...over }) as never;
    await limit(request({ businessId }), 'write');
    await limit(request({ businessId }), 'read');
    await limit(request({ businessId: '01890f3e-7b1c-7cc0-8a51-0123456789ac' }), 'write');
    const [first, again, other] = admit.mock.calls.map((call) => call[3]);
    const expected = createHmac('sha256', SECRET)
      .update('crm.public-intake.business.v1')
      .update(Buffer.from([0]))
      .update(businessId)
      .digest();
    expect(first?.equals(expected)).toBe(true);
    expect(again?.equals(expected)).toBe(true);
    expect(other).toHaveLength(32);
    expect(other?.equals(expected)).toBe(false);
    // A client's digest and a business's are never the same row, whatever the two are.
    expect(first?.equals(admit.mock.calls[0]?.[1] ?? Buffer.alloc(0))).toBe(false);
    expect(first?.toString('latin1')).not.toContain(businessId);
    // What is not a business's id is not counted as one.
    for (const odd of [
      undefined,
      '',
      'not-an-id',
      42,
      null,
      `${businessId} `,
      businessId.toUpperCase(),
    ]) {
      admit.mockClear();
      await limit(request({ businessId: odd }), 'read');
      expect(admit.mock.calls[0]?.[3]).toBeNull();
    }
    // Another secret makes another digest.
    const elsewhere = limiter(admitted, OTHER_SECRET);
    await elsewhere.limit(request({ businessId }), 'write');
    expect(elsewhere.admit.mock.calls[0]?.[3]?.equals(expected)).toBe(false);
  });

  it('passes read as read', async () => {
    const { admit, limit } = limiter();
    await limit(context('203.0.113.77'), 'read');
    expect(admit.mock.calls[0]?.[0]).toBe('read');
  });

  it('counts an IPv6 /64 as one client, and another /64 as another', async () => {
    const first = await digestOf('2001:db8:aa:bb::1');
    expect(await digestOf('2001:db8:aa:bb:ffff:ffff:ffff:ffff')).toBe(first);
    expect(await digestOf('2001:0db8:00aa:00bb:1:2:3:4')).toBe(first);
    expect(await digestOf('2001:db8:aa:bc::1')).not.toBe(first);
  });

  it('counts an IPv4 address written as IPv6 as that IPv4 address', async () => {
    const plain = await digestOf('192.0.2.9');
    expect(await digestOf('::ffff:192.0.2.9')).toBe(plain);
    expect(await digestOf('::ffff:c000:209')).toBe(plain);
    expect(await digestOf('192.0.2.10')).not.toBe(plain);
  });
});

describe('clientKey', () => {
  it.each([
    ['192.0.2.1', '04c0000201'],
    ['0.0.0.0', '0400000000'],
    ['255.255.255.255', '04ffffffff'],
    ['2001:db8:1:2:3:4:5:6', '0620010db800010002'],
    ['2001:DB8:1:2::', '0620010db800010002'],
    ['::1', '060000000000000000'],
    ['::', '060000000000000000'],
    ['1:2:3:4:5:6:7::', '060001000200030004'],
    ['fe80::1%eth0', '06fe80000000000000'],
    ['64:ff9b::192.0.2.33', '060064ff9b00000000'],
    ['1:2:3:4:5:6:192.0.2.33', '060001000200030004'],
    ['::ffff:192.0.2.1', '04c0000201'],
    ['0:0:0:0:0:ffff:c000:201', '04c0000201'],
  ])('reads %s', (address, key) => {
    expect(clientKey(address)?.toString('hex')).toBe(key);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'unknown',
    ' 192.0.2.1',
    '192.0.2.1 ',
    '192.0.2',
    '192.0.2.256',
    '192.0.2.1:443',
    '192.0.2.1, 198.51.100.1',
    '[::1]',
    '2001:db8::1::2',
    '2001:db8:1:2:3:4:5:6:7',
    'example.test',
  ])('refuses %s', (address) => {
    expect(clientKey(address)).toBeUndefined();
  });
});

describe('an address that cannot be read', () => {
  it.each([undefined, '', 'unknown', '192.0.2.1, 198.51.100.1', '192.0.2.256'])(
    'is refused without asking the store, not put in a shared bucket: %s',
    async (ipAddress) => {
      const { admit, limit } = limiter();
      const failure = await limit(context(ipAddress), 'read').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PublicIntakeLimitError);
      expect(failure).toMatchObject({ code: 'address_unusable' });
      expect(admit).not.toHaveBeenCalled();
      if (typeof ipAddress === 'string' && ipAddress !== '')
        expect(String(failure)).not.toContain(ipAddress);
    },
  );
});

describe('decisions', () => {
  it('allows what the store admitted', async () => {
    const { limit } = limiter(admitted);
    await expect(limit(context('192.0.2.1'), 'read')).resolves.toEqual({ allowed: true });
  });

  it.each(['client_quota', 'scope_quota', 'global_ceiling', 'storage_full'] as const)(
    'refuses with the retry time and reports the reason: %s',
    async (reason) => {
      const admit = vi.fn<AdmitPublicIntake>().mockResolvedValue({ ...refused, reason });
      const onRefusal = vi.fn<(reason: string) => void>();
      const limit = createPublicIntakeLimit({ admit, secret: SECRET, onRefusal });
      await expect(limit(context('192.0.2.1'), 'write')).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 37,
      });
      expect(onRefusal).toHaveBeenCalledExactlyOnceWith(reason);
    },
  );

  it('does not report an admission, and a failing reporter does not change a refusal', async () => {
    const onRefusal = vi.fn<(reason: string) => void>().mockImplementation(() => {
      throw new Error('metrics are down');
    });
    const admit = vi.fn<AdmitPublicIntake>().mockResolvedValueOnce(admitted);
    const limit = createPublicIntakeLimit({ admit, secret: SECRET, onRefusal });
    await expect(limit(context('192.0.2.1'), 'read')).resolves.toEqual({ allowed: true });
    expect(onRefusal).not.toHaveBeenCalled();
    admit.mockResolvedValueOnce(refused);
    await expect(limit(context('192.0.2.1'), 'read')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 37,
    });
    expect(onRefusal).toHaveBeenCalledOnce();
  });

  it.each([1, 60])('accepts a retry time of %s seconds', async (seconds) => {
    const { limit } = limiter({ ...refused, retry_after_seconds: seconds });
    await expect(limit(context('192.0.2.1'), 'read')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: seconds,
    });
  });

  it.each([
    ['no row', undefined],
    ['null', null],
    ['a string', 'allowed'],
    ['an empty row', {}],
    ['a truthy allowed', { ...admitted, allowed: 't' }],
    ['allowed without its reason', { allowed: true }],
    ['allowed with a refusal reason', { ...admitted, reason: 'client_quota' }],
    ['a refusal without a retry time', { allowed: false, reason: 'client_quota' }],
    ['a retry time of zero', { ...refused, retry_after_seconds: 0 }],
    ['a negative retry time', { ...refused, retry_after_seconds: -5 }],
    ['a retry time past the window', { ...refused, retry_after_seconds: 61 }],
    ['a fractional retry time', { ...refused, retry_after_seconds: 1.5 }],
    ['a retry time as text', { ...refused, retry_after_seconds: '30' }],
    ['a retry time that is not a number', { ...refused, retry_after_seconds: Number.NaN }],
    ['an unknown reason', { ...refused, reason: 'because' }],
    ['a refusal called admitted', { ...refused, reason: 'admitted' }],
    ['a refusal without a reason', { allowed: false, retry_after_seconds: 30 }],
  ])('treats %s as a failure, never as an allow', async (_name, row) => {
    const onRefusal = vi.fn<(reason: string) => void>();
    const admit = vi.fn<AdmitPublicIntake>().mockResolvedValue(row);
    const limit = createPublicIntakeLimit({ admit, secret: SECRET, onRefusal });
    await expect(limit(context('192.0.2.1'), 'read')).rejects.toMatchObject({
      name: 'PublicIntakeLimitError',
      code: 'invalid_decision',
    });
    expect(onRefusal).not.toHaveBeenCalled();
  });
});

describe('failing closed', () => {
  it('throws when the store fails, without the address or the secret in the error', async () => {
    const ipAddress = '198.51.100.23';
    const cause = new Error('connection terminated unexpectedly');
    const admit = vi.fn<AdmitPublicIntake>().mockRejectedValue(cause);
    const limit = createPublicIntakeLimit({ admit, secret: SECRET });
    const failure = await limit(context(ipAddress), 'write').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PublicIntakeLimitError);
    expect(failure).toMatchObject({ code: 'unavailable', cause });
    const text = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(text).not.toContain(ipAddress);
    expect(text).not.toContain(SECRET);
  });

  it('throws when the store throws before it returns a promise', async () => {
    const admit = vi.fn<AdmitPublicIntake>().mockImplementation(() => {
      throw new Error('pool is closed');
    });
    const limit = createPublicIntakeLimit({ admit, secret: SECRET });
    await expect(limit(context('192.0.2.1'), 'read')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('gives up after 1.5 seconds, tells the store, and never allows', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let fail: (reason: Error) => void = () => undefined;
    const admit = vi.fn<AdmitPublicIntake>().mockImplementation(
      (_operation, _digest, given) =>
        new Promise((_resolve, reject) => {
          signal = given;
          fail = reject;
        }),
    );
    const limit = createPublicIntakeLimit({ admit, secret: SECRET });
    const settled = vi.fn<(value: unknown) => void>();
    const decision = limit(context('192.0.2.1'), 'read');
    decision.then(settled, settled);
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(decision).rejects.toMatchObject({
      name: 'PublicIntakeLimitError',
      code: 'timeout',
    });
    expect(signal?.aborted).toBe(true);
    // The store's own late failure is nobody's unhandled rejection, and changes nothing.
    fail(new Error('aborted'));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('refuses even when a late answer would have allowed', async () => {
    vi.useFakeTimers();
    const admit = vi
      .fn<AdmitPublicIntake>()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 200, admitted)));
    const limit = createPublicIntakeLimit({ admit, secret: SECRET, timeoutMs: 100 });
    const decision = limit(context('192.0.2.1'), 'read');
    const outcome = decision.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(await outcome).toMatchObject({ code: 'timeout' });
  });

  it('leaves no timer behind once the store has answered', async () => {
    vi.useFakeTimers();
    const { limit } = limiter();
    await limit(context('192.0.2.1'), 'read');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses at once past the in-flight limit with "wait", and admits again when a call settles', async () => {
    const answers: ((row: unknown) => void)[] = [];
    const admit = vi.fn<AdmitPublicIntake>().mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    const onRefusal = vi.fn();
    const limit = createPublicIntakeLimit({ admit, secret: SECRET, maxInFlight: 2, onRefusal });
    const first = limit(context('192.0.2.1'), 'read');
    const second = limit(context('192.0.2.2'), 'read');
    // A burst, not a failure: told to wait as a full line is (429), never allowed, and the
    // store is not asked.
    await expect(limit(context('192.0.2.3'), 'read')).resolves.toEqual(busy);
    expect(onRefusal).toHaveBeenCalledExactlyOnceWith('busy');
    expect(admit).toHaveBeenCalledTimes(2);
    answers[0]?.(admitted);
    await expect(first).resolves.toEqual({ allowed: true });
    const fourth = limit(context('192.0.2.4'), 'read');
    await vi.waitFor(() => {
      expect(admit).toHaveBeenCalledTimes(3);
    });
    answers[1]?.(admitted);
    answers[2]?.(admitted);
    await expect(Promise.all([second, fourth])).resolves.toEqual([
      { allowed: true },
      { allowed: true },
    ]);
  });

  it('keeps one known business from taking every limiter connection its neighbour needs', async () => {
    const parked = Promise.withResolvers<unknown>();
    let heldScope: string | undefined;
    const admit = vi
      .fn<AdmitPublicIntake>()
      .mockImplementation((_operation, _digest, _signal, scope) => {
        const key = scope?.toString('hex');
        heldScope ??= key;
        return key === heldScope ? parked.promise : Promise.resolve(admitted);
      });
    const limit = createPublicIntakeLimit({ admit, secret: SECRET, maxInFlight: 2 });
    const first = limit(
      {
        requestId: 'a1',
        ipAddress: '192.0.2.1',
        businessId: '01890a5d-ac96-774b-bcce-b302099a8057',
      },
      'read',
    );
    const second = limit(
      {
        requestId: 'a2',
        ipAddress: '192.0.2.2',
        businessId: '01890a5d-ac96-774b-bcce-b302099a8057',
      },
      'read',
    );
    try {
      const occupiedByNoisyBusiness = admit.mock.calls.length;
      await expect(
        limit(
          {
            requestId: 'b1',
            ipAddress: '192.0.2.3',
            businessId: '01890a5d-ac96-774b-bcce-b302099a8058',
          },
          'read',
        ),
      ).resolves.toEqual({ allowed: true });
      expect(occupiedByNoisyBusiness).toBe(1);
    } finally {
      parked.resolve(admitted);
      await Promise.allSettled([first, second]);
    }
    expect(admit).toHaveBeenCalledTimes(3);
  });

  it('bounds a known business’s waiting limiter calls and drains its accepted line', async () => {
    const parked = Promise.withResolvers<unknown>();
    const admit = vi.fn<AdmitPublicIntake>().mockImplementation(() => parked.promise);
    const limit = createPublicIntakeLimit({ admit, secret: SECRET, maxInFlight: 1 });
    const request = (n: number) => ({
      requestId: String(n),
      ipAddress: `192.0.2.${String(n)}`,
      businessId: '01890a5d-ac96-774b-bcce-b302099a8057',
    });
    const accepted = Array.from({ length: 33 }, (_, n) => limit(request(n + 1), 'read'));
    try {
      expect(admit).toHaveBeenCalledOnce();
      await expect(limit(request(34), 'read')).resolves.toEqual(busy);
    } finally {
      parked.resolve(admitted);
      await Promise.allSettled(accepted);
    }
    await expect(Promise.all(accepted)).resolves.toEqual(
      Array.from({ length: 33 }, () => ({ allowed: true })),
    );
    expect(admit).toHaveBeenCalledTimes(33);
  });

  it('never starts a scoped limiter request whose deadline elapsed in the line', async () => {
    vi.useFakeTimers();
    const parked = Promise.withResolvers<unknown>();
    const admit = vi
      .fn<AdmitPublicIntake>()
      .mockImplementationOnce(() => parked.promise)
      .mockResolvedValue(admitted);
    const limit = createPublicIntakeLimit({ admit, secret: SECRET, maxInFlight: 1, timeoutMs: 20 });
    const request = {
      requestId: 'scoped',
      ipAddress: '192.0.2.1',
      businessId: '01890a5d-ac96-774b-bcce-b302099a8057',
    };
    const answer = (work: Promise<unknown>) => work.catch((error: unknown) => error);
    const first = answer(limit(request, 'read'));
    const queued = answer(limit(request, 'read'));
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(await Promise.all([first, queued])).toMatchObject([
        { code: 'timeout' },
        { code: 'timeout' },
      ]);
      expect(admit).toHaveBeenCalledOnce();
    } finally {
      parked.resolve(admitted);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(admit).toHaveBeenCalledOnce();
    await expect(limit(request, 'read')).resolves.toEqual({ allowed: true });
  });

  it('keeps a timed-out call counted until the store settles, so stuck calls cannot pile up', async () => {
    vi.useFakeTimers();
    let settle: (row: unknown) => void = () => undefined;
    const admit = vi
      .fn<AdmitPublicIntake>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      )
      .mockResolvedValue(admitted);
    const limit = createPublicIntakeLimit({ admit, secret: SECRET, maxInFlight: 1 });
    const stuck = limit(context('192.0.2.1'), 'read').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await stuck).toMatchObject({ code: 'timeout' });
    await expect(limit(context('192.0.2.2'), 'read')).resolves.toEqual(busy);
    expect(admit).toHaveBeenCalledOnce();
    settle(admitted);
    await vi.advanceTimersByTimeAsync(0);
    await expect(limit(context('192.0.2.2'), 'read')).resolves.toEqual({ allowed: true });
  });

  it('frees the place of a call whose store failed', async () => {
    const admit = vi
      .fn<AdmitPublicIntake>()
      .mockRejectedValueOnce(new Error('down'))
      .mockImplementationOnce(() => {
        throw new Error('down');
      })
      .mockResolvedValue(admitted);
    const limit = createPublicIntakeLimit({ admit, secret: SECRET, maxInFlight: 1 });
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(limit(context('192.0.2.1'), 'read')).rejects.toMatchObject({
        code: 'unavailable',
      });
    await expect(limit(context('192.0.2.1'), 'read')).resolves.toEqual({ allowed: true });
  });

  it.each([0, -1, 1.5, 65, Number.NaN])('refuses an in-flight limit of %s', (maxInFlight) => {
    expect(() =>
      createPublicIntakeLimit({ admit: vi.fn<AdmitPublicIntake>(), secret: SECRET, maxInFlight }),
    ).toThrow("The public intake limiter's in-flight limit must be 1 to 64.");
  });

  it.each([0, -1, 1.5, 10_001, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a timeout of %s milliseconds, so a wait is always bounded',
    (timeoutMs) => {
      expect(() =>
        createPublicIntakeLimit({ admit: vi.fn<AdmitPublicIntake>(), secret: SECRET, timeoutMs }),
      ).toThrow("The public intake limiter's timeout must be 1 to 10000 milliseconds.");
    },
  );
});

describe('databaseAdmission', () => {
  /**
   * A Kysely that records what would be sent to Postgres and answers with the rows, or
   * when the test lets a hanging statement end.
   */
  function recordingDatabase(rows: unknown[], hangs: 'no' | 'statement' | 'pool' = 'no') {
    const sent: { query: CompiledQuery; options: unknown }[] = [];
    const events: string[] = [];
    let finish: () => void = () => undefined;
    class RecordingDriver extends DummyDriver {
      override async acquireConnection() {
        events.push('acquire');
        if (hangs === 'pool')
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return this.connection();
      }
      connection() {
        return {
          executeQuery: (query: CompiledQuery, options?: unknown) => {
            sent.push({ query, options });
            if (hangs !== 'statement') return Promise.resolve({ rows: rows as never[] });
            return new Promise<{ rows: never[] }>((resolve) => {
              finish = () => {
                resolve({ rows: rows as never[] });
              };
            });
          },
          cancelQuery: () => {
            events.push('cancel');
            return Promise.resolve();
          },
          killSession: () => {
            events.push('kill');
            return Promise.resolve();
          },
          // eslint-disable-next-line require-yield, @typescript-eslint/require-await
          async *streamQuery(): AsyncIterableIterator<never> {
            throw new Error('not used');
          },
        };
      }
      override releaseConnection() {
        events.push('release');
        return Promise.resolve();
      }
    }
    const db = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new RecordingDriver(),
        createIntrospector: (kysely) => new PostgresIntrospector(kysely),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const end = (): void => {
      finish();
    };
    return { db, sent, events, finish: end };
  }

  it('keeps a timed-out statement counted until it ends, and takes no second connection for it', async () => {
    const { db, sent, events, finish } = recordingDatabase([admitted], 'statement');
    const limit = createPublicIntakeLimit({
      admit: databaseAdmission(db),
      secret: SECRET,
      timeoutMs: 20,
      maxInFlight: 1,
    });
    await expect(limit(context('192.0.2.1'), 'read')).rejects.toMatchObject({ code: 'timeout' });
    // Still running: its connection is held, nothing was sent to cancel it over another
    // connection, and the limiter takes no further connection meanwhile.
    expect(events).toEqual(['acquire']);
    await expect(limit(context('192.0.2.1'), 'read')).resolves.toEqual(busy);
    expect(sent).toHaveLength(1);
    finish();
    await vi.waitFor(() => {
      expect(events).toEqual(['acquire', 'release']);
    });
    await expect(limit(context('192.0.2.1'), 'read')).rejects.toMatchObject({ code: 'timeout' });
    expect(sent).toHaveLength(2);
    finish();
    await db.destroy();
  });

  it('never sends the statement of a call that was still waiting for a connection at the deadline', async () => {
    const { db, sent, events, finish } = recordingDatabase([admitted], 'pool');
    const limit = createPublicIntakeLimit({
      admit: databaseAdmission(db),
      secret: SECRET,
      timeoutMs: 20,
      maxInFlight: 1,
    });
    await expect(limit(context('192.0.2.1'), 'read')).rejects.toMatchObject({ code: 'timeout' });
    // Its place stays taken while it waits for the pool.
    await expect(limit(context('192.0.2.1'), 'read')).resolves.toEqual(busy);
    finish();
    await vi.waitFor(() => {
      expect(events).toEqual(['acquire', 'release']);
    });
    expect(sent).toEqual([]);
    await db.destroy();
  });

  it('sends one statement whose only parameters are the operation and the digests', async () => {
    const { db, sent } = recordingDatabase([refused]);
    const ipAddress = '203.0.113.200';
    const limit = createPublicIntakeLimit({ admit: databaseAdmission(db), secret: SECRET });
    await expect(limit(context(ipAddress), 'write')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 37,
    });
    expect(sent).toHaveLength(1);
    const [{ query, options } = { query: undefined, options: 'none sent' }] = sent;
    expect(query?.sql.replaceAll(/\s+/g, ' ').trim()).toBe(
      'select allowed, retry_after_seconds, reason from private.admit_public_intake($1, $2, $3::bytea)',
    );
    expect(query?.parameters).toHaveLength(3);
    const [operation, digest, scope] = query?.parameters ?? [];
    // No business was named: the third is null, and the database counts none.
    expect(scope).toBeNull();
    expect(operation).toBe('write');
    expect(Buffer.isBuffer(digest) && digest.length === 32).toBe(true);
    expect(JSON.stringify(query)).not.toContain(ipAddress);
    expect(JSON.stringify(query)).not.toContain(SECRET);
    // No abort options: see databaseAdmission for why Kysely is not given the signal.
    expect(options).toBeUndefined();
    await db.destroy();
  });

  it.each([[[]], [[admitted, admitted]]])(
    'fails closed unless exactly one row comes back',
    async (rows) => {
      const { db } = recordingDatabase(rows);
      const limit = createPublicIntakeLimit({ admit: databaseAdmission(db), secret: SECRET });
      await expect(limit(context('192.0.2.1'), 'read')).rejects.toMatchObject({
        code: 'invalid_decision',
      });
      await db.destroy();
    },
  );
});

describe('behind the public booking transport', () => {
  const calendar: PublicCalendarPage = {
    notificationWording: BOOKING_NOTIFICATION_WORDING,
    appearance: {
      style: 'neo',
      primaryColor: '#178af6',
      backgroundColor: '#ffffff',
      buttonText: '',
      logoUrl: null,
      coverUrl: null,
    },
    name: 'Consultation',
    description: 'Meet the team.',
    timezone: 'Africa/Nairobi',
    slotMinutes: 30,
    durations: [30],
    renderToken: `1793000000000.${'A'.repeat(43)}`,
  };
  const path = '/api/v1/public/book/agency/business/calendar';

  async function serve(admit: AdmitPublicIntake, maxInFlight?: number) {
    const handlers = {
      calendar: vi.fn<PublicBookingHandlers['calendar']>().mockResolvedValue(calendar),
      slots: vi.fn<PublicBookingHandlers['slots']>(),
      book: vi.fn<PublicBookingHandlers['book']>(),
      appointment: vi.fn<PublicBookingHandlers['appointment']>(),
      cancel: vi.fn<PublicBookingHandlers['cancel']>(),
      reschedule: vi.fn<PublicBookingHandlers['reschedule']>(),
      appointmentSlots: vi.fn<PublicBookingHandlers['appointmentSlots']>(),
      challenge: vi.fn<PublicBookingHandlers['challenge']>(),
    };
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    const logger: FastifyBaseLogger = pino(stream);
    const app = Fastify({ loggerInstance: logger });
    await registerPublicBooking(app, {
      handlers,
      rateLimit: createPublicIntakeLimit({
        admit,
        secret: SECRET,
        ...(maxInFlight === undefined ? {} : { maxInFlight }),
      }),
    });
    // Fastify's own "incoming request" line carries the address; this looks at the rest.
    const added = (): string =>
      logs.filter((line) => !line.includes('"msg":"incoming request"')).join('');
    return { app, handlers, added };
  }

  it('answers 429 with the retry time and runs no handler when the store refuses', async () => {
    const admit = vi.fn<AdmitPublicIntake>().mockResolvedValue(refused);
    const { app, handlers } = await serve(admit);
    const response = await app.inject({ url: path, remoteAddress: '192.0.2.44' });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('37');
    expect(admit.mock.calls[0]?.[0]).toBe('read');
    expect(handlers.calendar).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 503 and runs no handler when the store fails, and logs no address', async () => {
    const admit = vi.fn<AdmitPublicIntake>().mockRejectedValue(new Error('database is down'));
    const { app, handlers, added } = await serve(admit);
    const response = await app.inject({ url: path, remoteAddress: '192.0.2.44' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBeUndefined();
    expect(handlers.calendar).not.toHaveBeenCalled();
    expect(added()).toContain('Public booking limiter unavailable');
    expect(added() + response.body).not.toMatch(/192\.0\.2\.44|database is down/);
    expect(added() + response.body).not.toContain(SECRET);
    await app.close();
  });

  // A visitor in a burst is told to wait, which the booking page does by itself; a 503 says
  // the booking is unavailable, which it is not.
  it('answers a request past the in-flight limit 429 with Retry-After, never 503, and runs no handler', async () => {
    let answer: (row: unknown) => void = () => undefined;
    const admit = vi.fn<AdmitPublicIntake>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { app, handlers } = await serve(admit, 1);
    const first = app.inject({ url: path, remoteAddress: '192.0.2.44' });
    await vi.waitFor(() => {
      expect(admit).toHaveBeenCalledOnce();
    });
    const second = await app.inject({ url: path, remoteAddress: '192.0.2.45' });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe(String(INTAKE_GATE_RETRY_SECONDS));
    expect(second.json()).toMatchObject({ status: 429, title: 'Too Many Requests' });
    expect(admit).toHaveBeenCalledOnce();
    answer(admitted);
    expect((await first).statusCode).toBe(200);
    expect(handlers.calendar).toHaveBeenCalledOnce();
    await app.close();
  });

  it('runs the handler once the store admits', async () => {
    const admit = vi.fn<AdmitPublicIntake>().mockResolvedValue(admitted);
    const { app, handlers } = await serve(admit);
    const response = await app.inject({ url: path, remoteAddress: '192.0.2.44' });
    expect(response.statusCode).toBe(200);
    expect(handlers.calendar).toHaveBeenCalledOnce();
    await app.close();
  });
});

describe('the memory of which business a key belongs to', () => {
  it('knows what it was told, and nothing else', () => {
    const scopes = createIntakeScopes();
    expect(scopes.get('key-a')).toBeUndefined();
    scopes.learn('key-a', 'business-1');
    scopes.learn('key-b', 'business-2');
    scopes.learn('key-a', 'business-1');
    expect(scopes.get('key-a')).toBe('business-1');
    expect(scopes.get('key-b')).toBe('business-2');
    expect(scopes.get('key-c')).toBeUndefined();
  });

  it('forgets the key learned longest ago when it is full, and learns it again', () => {
    const scopes = createIntakeScopes(2);
    scopes.learn('a', '1');
    scopes.learn('b', '2');
    scopes.learn('c', '3');
    expect(scopes.get('a')).toBeUndefined();
    expect(scopes.get('b')).toBe('2');
    expect(scopes.get('c')).toBe('3');
    // Told again what it knows: nothing moves, and nothing is forgotten for it.
    scopes.learn('b', '2');
    scopes.learn('a', '1');
    expect(scopes.get('b')).toBeUndefined();
    expect(scopes.get('c')).toBe('3');
    expect(scopes.get('a')).toBe('1');
    // A key that changed hands is the newest again.
    scopes.learn('c', '9');
    scopes.learn('d', '4');
    expect(scopes.get('a')).toBeUndefined();
    expect(scopes.get('c')).toBe('9');
  });

  it('needs room for at least one key', () => {
    for (const max of [0, -1, 1.5, Number.NaN])
      expect(() => createIntakeScopes(max)).toThrow(/needs room/);
  });
});
