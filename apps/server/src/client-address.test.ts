// The visitor's address behind Traefik and Cloudflare. Requests are injected with the
// connection's own address, as each hop would deliver them: Coolify's Traefik deletes
// X-Forwarded-For from a peer it does not trust and appends the peer (traefik v3.7
// pkg/middlewares/forwardedheaders and pkg/proxy/httputil), and Cloudflare sets
// CF-Connecting-IP and appends the visitor to X-Forwarded-For
// (https://developers.cloudflare.com/fundamentals/reference/http-headers/).
import { Writable } from 'node:stream';
import { BOOKING_NOTIFICATION_WORDING, type PublicCalendarPage } from '@repo/contracts';
import type { PublicBookingHandlers } from '@repo/module-calendar';
import Fastify from 'fastify';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  clientAddress,
  forwardingOptions,
  proxyEntryProblem,
  proxyTrust,
} from './client-address.js';
import { registerPublicBooking } from './public-booking.js';
import { createPublicIntakeLimit, type AdmitPublicIntake } from './public-intake-limit.js';

/** Coolify's network, as measured on a Coolify install. */
const NETWORK = '172.18.0.0/16';
const TRAEFIK = '172.18.0.2';
const EDGE = '162.158.1.1';
const EDGE6 = '2606:4700:10::ac43:1';
/**
 * Cloudflare's CF-Connecting-IP for a Worker's request to another zone, inside
 * 2a06:98c0::/29. What X-Forwarded-For then holds is not documented: these tests give it a
 * Worker-written entry, the worst case.
 */
const WORKER = '2a06:98c0:3600::103';
const VISITOR = '198.51.100.7';
const ATTACKER = '203.0.113.50';
const CHOSEN = '192.0.2.99';
const BEHIND_CLOUDFLARE = [NETWORK, 'cloudflare'];

async function serve(entries: readonly string[]) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const app = Fastify({ loggerInstance: pino(stream), ...forwardingOptions(entries) });
  app.get('/where', (request) => ({ ip: request.ip, protocol: request.protocol }));
  await app.ready();
  const ask = async (remoteAddress: string, headers: Record<string, string> = {}) =>
    (await app.inject({ url: '/where', remoteAddress, headers })).json<{
      ip: string;
      protocol: string;
    }>();
  return { app, ask, lines };
}

describe('a peer that is not a trusted proxy', () => {
  it('is the visitor, whatever it says it forwards', async () => {
    const { ask } = await serve(BEHIND_CLOUDFLARE);
    const spoof = {
      'x-forwarded-for': CHOSEN,
      'cf-connecting-ip': CHOSEN,
      'x-forwarded-proto': 'https',
    };
    expect(await ask(ATTACKER, spoof)).toEqual({ ip: ATTACKER, protocol: 'http' });
    // A Cloudflare address is not a reason to believe X-Forwarded-For either.
    expect((await ask(ATTACKER, { 'x-forwarded-for': `${CHOSEN}, ${EDGE}` })).ip).toBe(ATTACKER);
  });

  it('is the visitor when it goes around Cloudflare to Traefik with headers of its own', async () => {
    const { ask } = await serve(BEHIND_CLOUDFLARE);
    // Traefik dropped the attacker's X-Forwarded-For and appended the attacker; it keeps
    // CF-Connecting-IP, which is not one of its headers.
    expect(
      (await ask(TRAEFIK, { 'x-forwarded-for': ATTACKER, 'cf-connecting-ip': CHOSEN })).ip,
    ).toBe(ATTACKER);
    // A proxy that kept it instead: the attacker's own entry is to the left of the attacker.
    expect(
      (
        await ask(TRAEFIK, {
          'x-forwarded-for': `${CHOSEN}, ${EDGE}, ${ATTACKER}`,
          'cf-connecting-ip': CHOSEN,
        })
      ).ip,
    ).toBe(ATTACKER);
  });
});

describe('through Traefik and Cloudflare', () => {
  it('is CF-Connecting-IP when Traefik replaced X-Forwarded-For with the edge (Coolify default)', async () => {
    const { ask } = await serve(BEHIND_CLOUDFLARE);
    expect(
      await ask(TRAEFIK, {
        'x-forwarded-for': EDGE,
        'cf-connecting-ip': VISITOR,
        'x-forwarded-proto': 'https',
      }),
    ).toEqual({ ip: VISITOR, protocol: 'https' });
    expect(
      (await ask(TRAEFIK, { 'x-forwarded-for': EDGE6, 'cf-connecting-ip': '2001:db8::7' })).ip,
    ).toBe('2001:db8::7');
  });

  it('is CF-Connecting-IP when Traefik trusts Cloudflare, and never what the visitor wrote', async () => {
    const { ask } = await serve(BEHIND_CLOUDFLARE);
    const headers = {
      'x-forwarded-for': `${CHOSEN}, ${VISITOR}, ${EDGE}`,
      'cf-connecting-ip': VISITOR,
    };
    expect((await ask(TRAEFIK, headers)).ip).toBe(VISITOR);
  });

  it("gives a Worker's requests Cloudflare's one Worker address, not the one the Worker wrote", async () => {
    const { ask } = await serve(BEHIND_CLOUDFLARE);
    const headers = {
      'x-forwarded-for': `${CHOSEN}, ${WORKER}, ${EDGE}`,
      'cf-connecting-ip': WORKER,
    };
    expect((await ask(TRAEFIK, headers)).ip).toBe(WORKER);
  });

  it('is the edge itself when CF-Connecting-IP is missing, repeated or not an address', async () => {
    const { ask } = await serve(BEHIND_CLOUDFLARE);
    for (const value of [undefined, `${VISITOR}, ${CHOSEN}`, 'unknown', ''])
      expect(
        (
          await ask(TRAEFIK, {
            'x-forwarded-for': `${CHOSEN}, ${EDGE}`,
            ...(value === undefined ? {} : { 'cf-connecting-ip': value }),
          })
        ).ip,
      ).toBe(EDGE);
  });

  it('is the edge when TRUST_PROXY does not name cloudflare: one shared address, never a chosen one', async () => {
    const { ask } = await serve([NETWORK]);
    expect(
      (await ask(TRAEFIK, { 'x-forwarded-for': `${CHOSEN}, ${EDGE}`, 'cf-connecting-ip': VISITOR }))
        .ip,
    ).toBe(EDGE);
  });

  it('writes the visitor into Fastify’s own request log line', async () => {
    const { ask, lines } = await serve(BEHIND_CLOUDFLARE);
    await ask(TRAEFIK, { 'x-forwarded-for': EDGE, 'cf-connecting-ip': VISITOR });
    const incoming = lines.find((line) => line.includes('"msg":"incoming request"')) ?? '';
    expect(incoming).toContain(`"remoteAddress":"${VISITOR}"`);
  });
});

describe('the plain walk', () => {
  it('takes the first untrusted address from the right, or the last address when all are trusted', async () => {
    const { ask } = await serve(['loopback', NETWORK]);
    expect(
      (await ask('127.0.0.1', { 'x-forwarded-for': `${CHOSEN}, ${VISITOR}, ${TRAEFIK}` })).ip,
    ).toBe(VISITOR);
    expect((await ask('127.0.0.1', { 'x-forwarded-for': '172.18.0.9' })).ip).toBe('172.18.0.9');
    expect((await ask('127.0.0.1')).ip).toBe('127.0.0.1');
    expect((await ask(`::ffff:${TRAEFIK}`, { 'x-forwarded-for': VISITOR })).ip).toBe(VISITOR);
  });

  // Why the name exists: written out as ranges, Cloudflare is one more proxy, and anything
  // running on Cloudflare's network could put an address of its choosing to its left.
  it("believes X-Forwarded-For through Cloudflare's ranges written out by hand", async () => {
    const { ask } = await serve([NETWORK, '162.158.0.0/15', '2a06:98c0::/29']);
    expect((await ask(TRAEFIK, { 'x-forwarded-for': `${CHOSEN}, ${WORKER}, ${EDGE}` })).ip).toBe(
      CHOSEN,
    );
  });

  it('trusts nothing with no entries', async () => {
    expect(forwardingOptions([])).toEqual({ trustProxy: false });
    const { ask } = await serve([]);
    expect(
      await ask(TRAEFIK, { 'x-forwarded-for': VISITOR, 'x-forwarded-proto': 'https' }),
    ).toEqual({
      ip: TRAEFIK,
      protocol: 'http',
    });
  });
});

describe('proxyTrust and clientAddress', () => {
  it('knows the names, and Cloudflare only when named', () => {
    const named = proxyTrust(['loopback', 'linklocal', 'uniquelocal', 'cloudflare']);
    for (const address of [
      '127.0.0.1',
      '::1',
      '169.254.1.1',
      'fe80::1',
      'fe80::1%eth0',
      '10.1.2.3',
      'fd00::1',
    ])
      expect(named.isProxy(address)).toBe(true);
    expect(named.isProxy(EDGE)).toBe(false);
    expect(named.isCloudflare(EDGE)).toBe(true);
    expect(named.isCloudflare(WORKER)).toBe(true);
    expect(named.isCloudflare('2a06:98c8::1')).toBe(false);
    expect(named.isProxy('not an address')).toBe(false);
    expect(proxyTrust([NETWORK]).isCloudflare(EDGE)).toBe(false);
  });

  it('reads repeated X-Forwarded-For headers in order, and skips empty entries', () => {
    const trust = proxyTrust(BEHIND_CLOUDFLARE);
    expect(
      clientAddress(
        { peer: TRAEFIK, forwardedFor: [`${CHOSEN}, ${VISITOR}`, ` , ${TRAEFIK}`] },
        trust,
      ),
    ).toBe(VISITOR);
    expect(clientAddress({ peer: TRAEFIK, forwardedFor: 'unknown' }, trust)).toBe('unknown');
  });

  it('says what is wrong with an entry', () => {
    expect(proxyEntryProblem('cloudflare')).toBeUndefined();
    expect(proxyEntryProblem('172.18.0.0/16')).toBeUndefined();
    expect(proxyEntryProblem('::ffff:172.18.0.5')).toBeUndefined();
    expect(proxyEntryProblem('0.0.0.0/0')).toMatch(/wider than \/8/);
    expect(proxyEntryProblem('::/0')).toMatch(/wider than \/16/);
    expect(proxyEntryProblem('::ffff:0:0/96')).toMatch(/IPv4 range written as IPv6/);
    expect(proxyEntryProblem('cloudflare.com')).toMatch(/is not an address/);
  });
});

describe('the public limiter behind Cloudflare', () => {
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
    timezone: 'America/Chicago',
    slotMinutes: 30,
    durations: [30],
    renderToken: `1793000000000.${'A'.repeat(43)}`,
  };
  const path = '/api/v1/public/book/agency/business/calendar';
  // An obvious fake: it protects nothing.
  const SECRET = 'test-only-public-intake-secret-0123456789';

  /** The real limiter, over a store that admits two requests for each address it is shown. */
  async function serveBooking(entries: readonly string[]) {
    const seen = new Map<string, number>();
    const admit = vi.fn<AdmitPublicIntake>((_operation, digest) => {
      const count = (seen.get(digest.toString('hex')) ?? 0) + 1;
      seen.set(digest.toString('hex'), count);
      return Promise.resolve(
        count <= 2
          ? { allowed: true, retry_after_seconds: 0, reason: 'admitted' }
          : { allowed: false, retry_after_seconds: 37, reason: 'client_quota' },
      );
    });
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
    const app = Fastify({ logger: false, ...forwardingOptions(entries) });
    await registerPublicBooking(app, {
      handlers,
      rateLimit: createPublicIntakeLimit({ admit, secret: SECRET }),
    });
    const visit = async (visitor: string) =>
      (
        await app.inject({
          url: path,
          remoteAddress: TRAEFIK,
          headers: { 'x-forwarded-for': EDGE, 'cf-connecting-ip': visitor },
        })
      ).statusCode;
    return { app, visit };
  }

  it('gives two visitors behind the same edge an allowance each', async () => {
    const { app, visit } = await serveBooking(BEHIND_CLOUDFLARE);
    expect([await visit(VISITOR), await visit(VISITOR), await visit(VISITOR)]).toEqual([
      200, 200, 429,
    ]);
    expect(await visit('203.0.113.9')).toBe(200);
    await app.close();
  });

  it('counts an IPv6 visitor by its /64, behind Cloudflare as anywhere', async () => {
    const { app, visit } = await serveBooking(BEHIND_CLOUDFLARE);
    expect([await visit('2001:db8:1:2::10'), await visit('2001:db8:1:2::99')]).toEqual([200, 200]);
    expect(await visit('2001:db8:1:2::abc')).toBe(429);
    expect(await visit('2001:db8:1:3::10')).toBe(200);
    await app.close();
  });

  it('shares one allowance among everyone at an edge when cloudflare is not named', async () => {
    const { app, visit } = await serveBooking([NETWORK]);
    expect([await visit(VISITOR), await visit('203.0.113.9'), await visit('192.0.2.20')]).toEqual([
      200, 200, 429,
    ]);
    await app.close();
  });
});
