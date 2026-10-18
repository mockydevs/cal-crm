// Unit tests for the webhook.call core. Nothing here reaches a network: DNS and the HTTPS
// request are both injected fakes, so each safeguard is tested on its own.
import type * as Crypto from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';

import { describe, expect, it, vi } from 'vitest';

import {
  callWebhook,
  isPublicAddress,
  parseRetryAfter,
  parseWebhookUrl,
  resolvePublicAddress,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookRetryDelay,
  type WebhookLookup,
  type WebhookRequester,
} from './webhook.js';

// The real comparison still runs; the spy only shows that verification goes through it.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SECRET = 'whsec_test_5f2c9a7e';
const PUBLIC_V4 = '93.184.216.34';
const now = new Date('2026-10-09T12:00:00Z');
const config = { url: 'https://hooks.example.com/crm?source=a', method: 'POST' } as const;

const lookupOf =
  (...addresses: readonly string[]): WebhookLookup =>
  () =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );

class FakeResponse extends EventEmitter {
  destroyed = false;
  constructor(
    readonly statusCode: number,
    readonly headers: Readonly<Record<string, string>>,
  ) {
    super();
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  body: string | undefined;
  constructor(private readonly play: (request: FakeRequest) => void) {
    super();
  }
  end(body: string): void {
    this.body = body;
    setImmediate(() => {
      this.play(this);
    });
  }
  destroy(): void {
    this.destroyed = true;
  }
}

interface Reply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly chunks?: readonly string[];
  /** Leave the body open, as a server that never finishes would. */
  readonly open?: boolean;
  /** Never answer at all. */
  readonly silent?: boolean;
  readonly error?: Error;
}

function network(reply: Reply = {}): {
  readonly requester: WebhookRequester;
  readonly calls: RequestOptions[];
  readonly requests: FakeRequest[];
  readonly responses: FakeResponse[];
} {
  const calls: RequestOptions[] = [];
  const requests: FakeRequest[] = [];
  const responses: FakeResponse[] = [];
  const requester: WebhookRequester = (options) => {
    calls.push(options);
    const request = new FakeRequest((sent) => {
      if (reply.silent === true) return;
      if (reply.error !== undefined) {
        sent.emit('error', reply.error);
        return;
      }
      const response = new FakeResponse(reply.status ?? 200, reply.headers ?? {});
      responses.push(response);
      sent.emit('response', response);
      for (const chunk of reply.chunks ?? []) response.emit('data', Buffer.from(chunk));
      if (reply.open !== true) response.emit('end');
    });
    requests.push(request);
    return request;
  };
  return { requester, calls, requests, responses };
}

const call = (
  reply: Reply = {},
  overrides: Partial<Parameters<typeof callWebhook>[2]> = {},
  target: Parameters<typeof callWebhook>[0] = config,
) => {
  const net = network(reply);
  const result = callWebhook(
    target,
    { event: 'deal.won', id: 'deal_1' },
    {
      secret: SECRET,
      now: () => now,
      lookup: lookupOf(PUBLIC_V4),
      requester: net.requester,
      ...overrides,
    },
  );
  return { ...net, result };
};

describe('signing', () => {
  it('signs the timestamp and body with HMAC-SHA256, hex encoded', () => {
    // Worked out separately with: openssl dgst -sha256 -hmac key over "1760011200.{}".
    expect(signWebhook('key', 1760011200, '{}')).toBe(
      '782cf5b3b6fd81d5b65cedc69ad858f096f6b2a2b02995c6ddd1b17c65be5612',
    );
    expect(signWebhook('key', 1760011200, '{}')).not.toBe(signWebhook('key', 1760011201, '{}'));
    expect(signWebhook('key', 1760011200, '{}')).not.toBe(signWebhook('key', 1760011200, '{ }'));
    expect(signWebhook('key', 1760011200, '{}')).not.toBe(signWebhook('other', 1760011200, '{}'));
  });

  it('verifies a signature it made and refuses any other', () => {
    const header = `v1=${signWebhook(SECRET, 1760011200, '{"a":1}')}`;
    expect(verifyWebhookSignature(SECRET, 1760011200, '{"a":1}', header)).toBe(true);
    expect(verifyWebhookSignature(SECRET, 1760011201, '{"a":1}', header)).toBe(false);
    expect(verifyWebhookSignature(SECRET, 1760011200, '{"a":2}', header)).toBe(false);
    expect(verifyWebhookSignature('wrong', 1760011200, '{"a":1}', header)).toBe(false);
    expect(verifyWebhookSignature(SECRET, 1760011200, '{"a":1}', header.slice(3))).toBe(false);
  });

  it('refuses a signature of the wrong length without throwing', () => {
    expect(verifyWebhookSignature(SECRET, 1760011200, '{}', 'v1=abc')).toBe(false);
    expect(verifyWebhookSignature(SECRET, 1760011200, '{}', '')).toBe(false);
  });

  it('compares in constant time', () => {
    const compare = vi.mocked(timingSafeEqual);
    compare.mockClear();
    const header = `v1=${signWebhook(SECRET, 1760011200, '{}')}`;
    const wrong = `v1=${'0'.repeat(64)}`;
    expect(verifyWebhookSignature(SECRET, 1760011200, '{}', header)).toBe(true);
    expect(verifyWebhookSignature(SECRET, 1760011200, '{}', wrong)).toBe(false);
    expect(compare).toHaveBeenCalledTimes(2);
  });
});

describe('public addresses', () => {
  it.each([
    ['this network', '0.1.2.3'],
    ['private 10/8', '10.0.0.5'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['carrier-grade NAT, top of the range', '100.127.255.254'],
    ['loopback', '127.0.0.1'],
    ['loopback, not the usual one', '127.8.9.10'],
    ['link-local', '169.254.10.10'],
    ['cloud metadata', '169.254.169.254'],
    ['private 172.16/12', '172.16.0.1'],
    ['private 172.16/12, top of the range', '172.31.255.255'],
    ['protocol assignments', '192.0.0.8'],
    ['documentation 192.0.2/24', '192.0.2.1'],
    ['AS112', '192.31.196.1'],
    ['AMT', '192.52.193.1'],
    ['6to4 relay', '192.88.99.1'],
    ['private 192.168/16', '192.168.1.1'],
    ['AS112 delegation', '192.175.48.1'],
    ['benchmarking', '198.18.0.1'],
    ['documentation 198.51.100/24', '198.51.100.7'],
    ['documentation 203.0.113/24', '203.0.113.7'],
    ['multicast', '224.0.0.1'],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 unspecified', '::'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unique-local', 'fc00::1'],
    ['IPv6 unique-local, fd half', 'fd12:3456:789a::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 site-local', 'fec0::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv6 NAT64', '64:ff9b::7f00:1'],
    ['IPv6 discard', '100::1'],
    ['IPv6 Teredo', '2001::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['IPv6 6to4', '2002:7f00:1::1'],
    ['IPv6 documentation 3fff::/20', '3fff::1'],
    ['IPv6 with a zone', 'fe80::1%eth0'],
    ['a public IPv6 address with a zone', '2606:4700:4700::1111%eth0'],
    ['not an address', 'example.com'],
    ['nothing', ''],
  ])('refuses %s (%s)', (_name, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    ['loopback', '::ffff:127.0.0.1'],
    ['loopback, in hex', '::ffff:7f00:1'],
    ['private 10/8', '::ffff:10.0.0.5'],
    ['private 172.16/12', '::ffff:172.16.0.1'],
    ['private 192.168/16', '::ffff:192.168.1.1'],
    ['cloud metadata', '::ffff:169.254.169.254'],
    ['carrier-grade NAT', '::ffff:100.64.0.1'],
    ['this network', '::ffff:0.0.0.0'],
    ['multicast', '::ffff:224.0.0.1'],
    ['reserved', '::ffff:240.0.0.1'],
  ])('refuses the IPv4-mapped form of %s (%s)', (_name, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    PUBLIC_V4,
    '100.63.255.255',
    '100.128.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '169.253.255.255',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4001::200e',
    '::ffff:8.8.8.8',
  ])('allows the public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('resolvePublicAddress', () => {
  it('returns the first address when every answer is public', async () => {
    await expect(
      resolvePublicAddress('hooks.example.com', lookupOf(PUBLIC_V4, '2606:4700:4700::1111')),
    ).resolves.toEqual({ ok: true, address: PUBLIC_V4, family: 4 });
  });

  it('refuses the host when any answer is not public, wherever it comes in the list', async () => {
    for (const answers of [
      ['10.0.0.5', PUBLIC_V4],
      [PUBLIC_V4, '10.0.0.5'],
      [PUBLIC_V4, '8.8.8.8', '::1'],
      [PUBLIC_V4, 'not-an-address'],
    ])
      await expect(
        resolvePublicAddress('rebind.example.com', lookupOf(...answers)),
      ).resolves.toMatchObject({ ok: false, code: 'blocked_address' });
  });

  it('checks an IP literal itself and never looks it up', async () => {
    const lookup = vi.fn(lookupOf(PUBLIC_V4));
    await expect(resolvePublicAddress('127.0.0.1', lookup)).resolves.toMatchObject({
      ok: false,
      code: 'blocked_address',
    });
    await expect(resolvePublicAddress('[::1]', lookup)).resolves.toMatchObject({
      ok: false,
      code: 'blocked_address',
    });
    await expect(resolvePublicAddress('[::ffff:7f00:1]', lookup)).resolves.toMatchObject({
      ok: false,
      code: 'blocked_address',
    });
    await expect(resolvePublicAddress('8.8.8.8', lookup)).resolves.toEqual({
      ok: true,
      address: '8.8.8.8',
      family: 4,
    });
    await expect(resolvePublicAddress('[2606:4700:4700::1111]', lookup)).resolves.toEqual({
      ok: true,
      address: '2606:4700:4700::1111',
      family: 6,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports a failed or empty lookup as a DNS error', async () => {
    await expect(
      resolvePublicAddress('gone.example.com', () => Promise.reject(new Error('ENOTFOUND'))),
    ).resolves.toMatchObject({ ok: false, code: 'dns_error' });
    await expect(resolvePublicAddress('empty.example.com', lookupOf())).resolves.toMatchObject({
      ok: false,
      code: 'dns_error',
    });
  });
});

describe('parseWebhookUrl', () => {
  it('accepts https on the default port', () => {
    expect(parseWebhookUrl('https://hooks.example.com/a?b=1')).toMatchObject({ ok: true });
    expect(parseWebhookUrl('https://hooks.example.com:443/a')).toMatchObject({ ok: true });
  });

  it.each([
    ['plain http', 'http://hooks.example.com/a'],
    ['another scheme', 'ftp://hooks.example.com/a'],
    ['a user name', 'https://user@hooks.example.com/a'],
    ['a password', 'https://user:pass@hooks.example.com/a'],
    ['another port', 'https://hooks.example.com:8443/a'],
    ['a database port', 'https://hooks.example.com:5432/'],
    ['not a URL', 'hooks.example.com/a'],
    ['an empty string', ''],
  ])('refuses %s', (_name, url) => {
    expect(parseWebhookUrl(url)).toMatchObject({ ok: false });
  });

  it('accepts another port only when the install allows it', () => {
    expect(parseWebhookUrl('https://hooks.example.com:8443/a', [8443])).toMatchObject({ ok: true });
    expect(parseWebhookUrl('https://hooks.example.com:8444/a', [8443])).toMatchObject({
      ok: false,
    });
  });

  it('never repeats credentials from the URL in its message', () => {
    const parsed = parseWebhookUrl('https://user:hunter2@hooks.example.com/a');
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
  });
});

describe('callWebhook', () => {
  it('posts the JSON body with a timestamp and a signature that verifies', async () => {
    const { result, calls, requests } = call({ status: 204 });
    await expect(result).resolves.toEqual({ ok: true, status: 204, body: '', truncated: false });
    expect(calls).toHaveLength(1);
    const body = requests[0]?.body ?? '';
    expect(JSON.parse(body)).toEqual({ event: 'deal.won', id: 'deal_1' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      host: 'hooks.example.com',
      port: 443,
      path: '/crm?source=a',
    });
    const headers = new Map(Object.entries(calls[0]?.headers ?? {}));
    // 2026-10-09T12:00:00Z in Unix seconds.
    expect(headers.get(WEBHOOK_TIMESTAMP_HEADER)).toBe('1791547200');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Content-Length')).toBe(String(Buffer.byteLength(body)));
    const signature = String(headers.get(WEBHOOK_SIGNATURE_HEADER));
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(SECRET, 1791547200, body, signature)).toBe(true);
  });

  it('names the delivery, the same on every retry, so a receiver can ignore a repeat', async () => {
    const named = call({}, { deliveryId: 'arun_1:4' });
    await named.result;
    expect(named.calls[0]?.headers).toMatchObject({ [WEBHOOK_DELIVERY_HEADER]: 'arun_1:4' });
    const unnamed = call();
    await unnamed.result;
    expect(Object.keys(unnamed.calls[0]?.headers ?? {})).not.toContain(WEBHOOK_DELIVERY_HEADER);
  });

  it('refuses a delivery id that could not be a header value', async () => {
    for (const deliveryId of ['', 'a\r\nX-Injected: 1', 'x'.repeat(201), 'naïve'])
      await expect(call({}, { deliveryId }).result).rejects.toBeInstanceOf(RangeError);
  });

  it('uses the method the step names', async () => {
    const { result, calls } = call({}, {}, { ...config, method: 'PATCH' });
    await result;
    expect(calls[0]?.method).toBe('PATCH');
  });

  it('never sends, returns or logs the secret', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const ok = call({ status: 200, chunks: ['fine'] });
    const failed = call({ status: 500, chunks: ['broken'] });
    const outputs = [await ok.result, await failed.result, ok.calls, failed.calls];
    expect(JSON.stringify(outputs)).not.toContain(SECRET);
    expect(ok.requests[0]?.body).not.toContain(SECRET);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('connects to the address it checked, not to whatever the name resolves to later', async () => {
    // A rebinding DNS server: public for the check, loopback for anyone who asks again.
    const answers = [[PUBLIC_V4], ['127.0.0.1']];
    const lookup = vi.fn<WebhookLookup>(() =>
      Promise.resolve(
        (answers.shift() ?? ['127.0.0.1']).map((address) => ({ address, family: 4 })),
      ),
    );
    const { result, calls } = call({}, { lookup });
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(lookup).toHaveBeenCalledTimes(1);
    const options = calls[0];
    // The name stays the host, so TLS still checks the certificate against it.
    expect(options?.host).toBe('hooks.example.com');
    // No pooled socket from an earlier call can be reused.
    expect(options?.agent).toBe(false);
    const pinned = options?.lookup;
    if (pinned === undefined) throw new Error('The request was not pinned to an address.');
    const single = vi.fn();
    pinned('hooks.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, PUBLIC_V4, 4);
    const all = vi.fn();
    pinned('hooks.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: PUBLIC_V4, family: 4 }]);
    const other = vi.fn();
    pinned('elsewhere.example.com', { all: true }, other);
    expect(other).toHaveBeenCalledWith(null, [{ address: PUBLIC_V4, family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('refuses a host that resolves to a private address, before any request', async () => {
    const { result, calls } = call({}, { lookup: lookupOf(PUBLIC_V4, '169.254.169.254') });
    await expect(result).resolves.toMatchObject({
      ok: false,
      code: 'blocked_address',
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses an IP literal that is not public', async () => {
    for (const url of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://2130706433/x']) {
      const { result, calls } = call({}, {}, { ...config, url });
      await expect(result).resolves.toMatchObject({ ok: false, code: 'blocked_address' });
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses a URL that is not plain https on an allowed port', async () => {
    for (const url of [
      'http://hooks.example.com/x',
      'https://user:pass@hooks.example.com/x',
      'https://hooks.example.com:8443/x',
    ]) {
      const { result, calls } = call({}, {}, { ...config, url });
      await expect(result).resolves.toMatchObject({
        ok: false,
        code: 'invalid_url',
        retryable: false,
      });
      expect(calls).toHaveLength(0);
    }
    const allowed = call(
      {},
      { allowedPorts: [8443] },
      { ...config, url: 'https://a.example:8443/' },
    );
    await expect(allowed.result).resolves.toMatchObject({ ok: true });
    expect(allowed.calls[0]?.port).toBe(8443);
  });

  it('treats a redirect as a failure and never follows it', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { result, calls } = call({
        status,
        headers: { location: 'https://169.254.169.254/latest/meta-data/' },
      });
      await expect(result).resolves.toMatchObject({
        ok: false,
        code: 'redirect',
        status,
        retryable: false,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it('stops reading the response at the cap', async () => {
    const chunk = 'x'.repeat(40 * 1024);
    const { result, responses, requests } = call({ chunks: [chunk, chunk, chunk], open: true });
    const outcome = await result;
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.body)).toBe(WEBHOOK_MAX_RESPONSE_BYTES);
    expect(responses[0]?.destroyed).toBe(true);
    expect(requests[0]?.destroyed).toBe(true);
  });

  it('returns a short body whole', async () => {
    const { result } = call({ chunks: ['{"received":', 'true}'] });
    await expect(result).resolves.toEqual({
      ok: true,
      status: 200,
      body: '{"received":true}',
      truncated: false,
    });
  });

  it('times out when the server never answers, and drops the connection', async () => {
    const { result, requests } = call({ silent: true }, { timeoutMs: 30 });
    await expect(result).resolves.toMatchObject({ ok: false, code: 'timeout', retryable: true });
    expect(requests[0]?.destroyed).toBe(true);
  });

  it('times out when the body never finishes', async () => {
    const { result, requests } = call({ chunks: ['slow'], open: true }, { timeoutMs: 30 });
    await expect(result).resolves.toMatchObject({ ok: false, code: 'timeout', retryable: true });
    expect(requests[0]?.destroyed).toBe(true);
  });

  it('times out when DNS never answers', async () => {
    const { result, calls } = call(
      {},
      { timeoutMs: 30, lookup: () => new Promise(() => undefined) },
    );
    await expect(result).resolves.toMatchObject({ ok: false, code: 'timeout', retryable: true });
    expect(calls).toHaveLength(0);
  });

  it('sends nothing when DNS answers only after the deadline', async () => {
    const late: WebhookLookup = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve([{ address: PUBLIC_V4, family: 4 }]);
        }, 60);
      });
    const { result, calls } = call({}, { timeoutMs: 20, lookup: late });
    await expect(result).resolves.toMatchObject({ ok: false, code: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toHaveLength(0);
  });

  it('reports a connection failure as a retryable network error', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), {
      code: 'ECONNREFUSED',
    });
    await expect(call({ error: refused }).result).resolves.toEqual({
      ok: false,
      code: 'network_error',
      retryable: true,
      message: 'The webhook could not be reached (ECONNREFUSED).',
    });
    const dns = call({}, { lookup: () => Promise.reject(new Error('ENOTFOUND')) });
    await expect(dns.result).resolves.toMatchObject({
      ok: false,
      code: 'network_error',
      retryable: true,
    });
  });

  it('reports a request that could not even be made as a network error', async () => {
    const requester: WebhookRequester = () => {
      throw new TypeError('Request path contains unescaped characters');
    };
    await expect(call({}, { requester }).result).resolves.toMatchObject({
      ok: false,
      code: 'network_error',
    });
  });

  it.each([
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [599, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [410, false],
    [422, false],
    [199, false],
  ])('reports status %i as an HTTP error, retryable: %s', async (status, retryable) => {
    await expect(call({ status }).result).resolves.toMatchObject({
      ok: false,
      code: 'http_error',
      status,
      retryable,
    });
  });

  it('passes on Retry-After from a 429 or 503 only', async () => {
    const limited = call({ status: 429, headers: { 'retry-after': '120' } });
    await expect(limited.result).resolves.toMatchObject({ status: 429, retryAfterMs: 120_000 });
    const down = call({
      status: 503,
      headers: { 'retry-after': 'Fri, 09 Oct 2026 12:05:00 GMT' },
    });
    await expect(down.result).resolves.toMatchObject({ status: 503, retryAfterMs: 300_000 });
    const broken = await call({ status: 500, headers: { 'retry-after': '120' } }).result;
    expect(broken).not.toHaveProperty('retryAfterMs');
  });

  it('quotes only a short, cleaned excerpt of an error response', async () => {
    const noisy = `oops\r\n\u0000\u001b[31m${'A'.repeat(5000)}`;
    const outcome = await call({ status: 500, chunks: [noisy] }).result;
    if (outcome.ok) throw new Error('Expected a failure.');
    expect(outcome.message.length).toBeLessThan(300);
    expect(outcome.message).toContain('oops');
    // eslint-disable-next-line no-control-regex -- the point is that none are left.
    expect(outcome.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(outcome).not.toHaveProperty('body');
  });

  it('refuses a payload that has no JSON form', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    for (const payload of [circular, undefined, 10n]) {
      const net = network();
      await expect(
        callWebhook(config, payload, {
          secret: SECRET,
          lookup: lookupOf(PUBLIC_V4),
          requester: net.requester,
        }),
      ).resolves.toMatchObject({ ok: false, code: 'invalid_payload', retryable: false });
      expect(net.calls).toHaveLength(0);
    }
  });

  it('throws for a mistake in the calling code: no secret, or a timeout out of range', async () => {
    await expect(call({}, { secret: '' }).result).rejects.toThrow(RangeError);
    await expect(call({}, { timeoutMs: 0 }).result).rejects.toThrow(RangeError);
    await expect(call({}, { timeoutMs: 120_000 }).result).rejects.toThrow(RangeError);
  });
});

describe('parseRetryAfter', () => {
  it('reads a number of seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter(' 5 ', now)).toBe(5000);
  });

  it('reads all three HTTP-date forms of RFC 9110', () => {
    expect(parseRetryAfter('Fri, 09 Oct 2026 12:02:00 GMT', now)).toBe(120_000);
    expect(parseRetryAfter('Friday, 09-Oct-26 12:02:00 GMT', now)).toBe(120_000);
    expect(parseRetryAfter('Fri Oct  9 12:02:00 2026', now)).toBe(120_000);
    expect(parseRetryAfter('Sun Nov 15 12:00:00 2026', now)).toBe(37 * 24 * 3_600_000);
  });

  it('reads a two-digit year more than 50 years ahead as the past century', () => {
    expect(parseRetryAfter('Sunday, 06-Nov-94 08:49:37 GMT', now)).toBe(0);
  });

  it('gives no wait for a date already past', () => {
    expect(parseRetryAfter('Fri, 31 Dec 1999 23:59:59 GMT', now)).toBe(0);
  });

  it.each(['', 'soon', '-5', '1.5', '12s', '2026-10-09T12:02:00Z', 'Fri, 09 Oct 2026 12:02:00'])(
    'ignores %j',
    (value) => {
      expect(parseRetryAfter(value, now)).toBeUndefined();
    },
  );

  it('ignores a date that does not exist, and keeps a huge number finite', () => {
    expect(parseRetryAfter('Fri, 31 Feb 2026 12:02:00 GMT', now)).toBeUndefined();
    expect(parseRetryAfter('Fri, 09 Oct 2026 25:02:00 GMT', now)).toBeUndefined();
    expect(Number.isSafeInteger(parseRetryAfter('9'.repeat(400), now))).toBe(true);
  });
});

describe('webhookRetryDelay', () => {
  it('doubles from one minute and stops after the last attempt', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => webhookRetryDelay(attempt))).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000,
    ]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
    expect(webhookRetryDelay(6)).toBeUndefined();
    expect(webhookRetryDelay(7)).toBeUndefined();
  });

  it('waits at least as long as Retry-After asks, up to the cap', () => {
    expect(webhookRetryDelay(1, 300_000)).toBe(300_000);
    expect(webhookRetryDelay(4, 1000)).toBe(480_000);
    expect(webhookRetryDelay(1, 86_400_000)).toBe(3_600_000);
    expect(webhookRetryDelay(6, 1000)).toBeUndefined();
  });

  it('refuses an attempt number that is not a count', () => {
    expect(() => webhookRetryDelay(0)).toThrow(RangeError);
    expect(() => webhookRetryDelay(1.5)).toThrow(RangeError);
  });
});
