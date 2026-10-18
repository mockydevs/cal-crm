import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { botChallenge, FORM_LIMITS, publicForm, publicFormReceipt } from '@repo/contracts';
import { ConflictError } from '@repo/kernel';
import { FORM_SCRIPT_PATH } from '@repo/module-forms';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicBookingRateLimit } from '../public-booking.js';
import { PAGE_POLICY } from './page.js';
import {
  FORM_PAGE_HEADER,
  FORM_SCRIPT_URL,
  loadEmbedScript,
  registerPublicForms,
  type EmbedScript,
  type PublicFormPorts,
} from './transport.js';

interface Admission {
  readonly formId: string;
  readonly origin: string;
  readonly preview?: boolean;
}
type Ports = PublicFormPorts<Admission>;

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://www.example.com';
const BASE = `/api/v1/public/forms/${KEY}`;
const TOKEN = `1790000000000.${'A'.repeat(43)}`;
const shown = {
  title: 'Ask us',
  description: '',
  submitLabel: 'Send',
  successMessage: 'Thank you.',
  fields: [
    { key: 'email', type: 'email', label: 'Email', helpText: '', required: true, options: [] },
  ],
  consents: [],
  renderToken: TOKEN,
  textLength: FORM_LIMITS.textLength,
  longTextLength: FORM_LIMITS.longTextLength,
};
const body = {
  clientSubmissionId: '5ef5926d-d3b7-4b95-a513-198a51a2c5d1',
  renderToken: TOKEN,
  values: { email: 'maya@example.test' },
  consents: {},
};
const challenge = {
  kind: 'altcha',
  challenge: {
    parameters: {
      algorithm: 'PBKDF2/SHA-256',
      nonce: 'ab'.repeat(16),
      salt: 'cd'.repeat(16),
      cost: 1000,
      keyLength: 32,
      keyPrefix: 'ef'.repeat(16),
      keySignature: '01'.repeat(32),
      expiresAt: 1_790_003_600,
      data: { render: 'A'.repeat(43) },
    },
    signature: '02'.repeat(32),
  },
};
const script: EmbedScript = { body: Buffer.from('(function(){})();'), etag: '"abc"' };

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** The CRM's own address, where it serves a form's page and the preview of a draft. */
const OWN = 'https://crm.example.test';
const PREVIEW = `${'P'.repeat(70)}.${'S'.repeat(22)}`;
const PREVIEW_BASE = `/api/v1/public/forms/preview/${PREVIEW}`;

async function start(options: { script?: EmbedScript; ownOrigin?: string } = {}) {
  const handlers = {
    // As the module's gate: the key must be the form's, the Origin exactly its website,
    // or the CRM's own address, which shows every published form.
    admit: vi
      .fn<Ports['admit']>()
      .mockImplementation((key, origin) =>
        Promise.resolve(
          key === KEY && (origin === ORIGIN || origin === OWN)
            ? { formId: 'f', origin }
            : undefined,
        ),
      ),
    // As the module's other gate: a link to a draft, from the CRM's own address only.
    admitPreview: vi
      .fn<Ports['admitPreview']>()
      .mockImplementation((token, origin) =>
        Promise.resolve(
          token === PREVIEW && origin === OWN
            ? { formId: 'f', origin: OWN, preview: true }
            : undefined,
        ),
      ),
    form: vi.fn<Ports['form']>().mockResolvedValue({ outcome: 'ok', form: shown }),
    submit: vi
      .fn<Ports['submit']>()
      .mockResolvedValue({ outcome: 'ok', receipt: { status: 'received' } }),
    challenge: vi.fn<Ports['challenge']>().mockResolvedValue({ outcome: 'ok', challenge }),
  };
  const rateLimit = vi.fn<PublicBookingRateLimit>().mockResolvedValue({ allowed: true });
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          logs.push(chunk.toString());
          done();
        },
      }),
    },
  });
  apps.push(app);
  await registerPublicForms(app, {
    handlers,
    rateLimit,
    script: options.script,
    ownOrigin: options.ownOrigin,
  });
  await app.ready();
  const call = (request: InjectOptions, origin: string | null = ORIGIN) =>
    app.inject({
      ...request,
      headers: { ...(origin === null ? {} : { origin }), ...request.headers },
    });
  return { app, handlers, rateLimit, logs, call };
}

const read: InjectOptions = { method: 'GET', url: BASE };
const send: InjectOptions = { method: 'POST', url: `${BASE}/submissions`, payload: body };
const corsHeaders = (headers: Record<string, unknown>): string[] =>
  Object.keys(headers).filter((name) => name.startsWith('access-control-'));

describe('an allowed website', () => {
  it('is shown the form and has its submission taken, each answer fitting its contract', async () => {
    const { call, handlers } = await start();
    const loaded = await call(read);
    expect(loaded.statusCode).toBe(200);
    expect(publicForm.parse(loaded.json())).toEqual(shown);
    const sent = await call({ ...send, headers: { 'user-agent': 'Browser/1.0' } });
    expect(sent.statusCode).toBe(201);
    expect(publicFormReceipt.parse(sent.json())).toEqual({ status: 'received' });
    expect(handlers.submit).toHaveBeenCalledExactlyOnceWith(
      { formId: 'f', origin: ORIGIN },
      { ...body, trap: '' },
      { requestId: expect.any(String) as string, ipAddress: '127.0.0.1', userAgent: 'Browser/1.0' },
    );
    for (const answer of [loaded, sent]) {
      // Readable by that website only: the stored origin, never `*`, never credentials.
      expect(answer.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(answer.headers['access-control-expose-headers']).toBe('Retry-After');
      expect(answer.headers['access-control-allow-credentials']).toBeUndefined();
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.headers['referrer-policy']).toBe('no-referrer');
      expect(answer.headers['x-content-type-options']).toBe('nosniff');
      expect(answer.headers.vary).toBe('Origin');
    }
  });

  it('gives the handler the address the server saw and a bounded browser name, never ones the body names', async () => {
    const { call, handlers } = await start();
    await call({
      ...send,
      remoteAddress: '203.0.113.77',
      headers: { 'user-agent': 'x'.repeat(2000), 'x-forwarded-for': '198.51.100.1' },
    });
    const [, , request] = handlers.submit.mock.calls[0] ?? [];
    expect(request?.ipAddress).toBe('203.0.113.77');
    expect(request?.userAgent).toHaveLength(500);
    // No browser name at all is no browser name, not an empty one.
    await call({ ...send, headers: { 'user-agent': '' } });
    expect(handlers.submit.mock.calls[1]?.[2]).not.toHaveProperty('userAgent');
    // A body that tries to say who it is from is not a submission.
    for (const extra of [{ ipAddress: '10.0.0.1' }, { userAgent: 'Mine' }, { origin: ORIGIN }]) {
      const refused = await call({ ...send, payload: { ...body, ...extra } });
      expect(refused.statusCode).toBe(422);
    }
    expect(handlers.submit).toHaveBeenCalledTimes(2);
  });

  it('is told each refusal in general words, with a status the embed can act on', async () => {
    const { call, handlers } = await start();
    const cases = [
      [{ outcome: 'unavailable' }, 403, 'This form cannot be used here.'],
      [{ outcome: 'stale' }, 409, 'The form changed. Load it again and send it again.'],
      [{ outcome: 'changed' }, 409, 'The form changed. Load it again and send it again.'],
      [{ outcome: 'limited', retryAfterSeconds: 7 }, 429, 'Wait before trying again.'],
    ] as const;
    for (const [refusal, status, detail] of cases) {
      handlers.submit.mockResolvedValueOnce(refusal);
      const answer = await call(send);
      expect(answer.statusCode).toBe(status);
      expect(answer.headers['content-type']).toContain('application/problem+json');
      expect(answer.json()).toEqual({
        type: 'about:blank',
        title: expect.any(String) as string,
        status,
        detail,
      });
      expect(answer.headers['retry-after']).toBe(status === 429 ? '7' : undefined);
      expect(answer.headers['access-control-allow-origin']).toBe(ORIGIN);
    }
    handlers.form.mockResolvedValueOnce({ outcome: 'unavailable' });
    expect((await call(read)).statusCode).toBe(403);
    // A wait that makes no sense is a minute; one beyond a day is a day.
    for (const [wait, header] of [
      [0, '60'],
      [-5, '60'],
      [1.5, '60'],
      [Number.NaN, '60'],
      [999_999, '86400'],
    ] as const) {
      handlers.submit.mockResolvedValueOnce({ outcome: 'limited', retryAfterSeconds: wait });
      expect((await call(send)).headers['retry-after']).toBe(header);
    }
  });

  it("is told which answers were refused, in the module's words and by the form's own keys only", async () => {
    const { call, handlers } = await start();
    handlers.submit.mockResolvedValueOnce({
      outcome: 'invalid',
      issues: [
        { path: '/values/email', code: 'invalid_email', message: 'Enter an email address.' },
        { path: '/consents/news', code: 'required', message: 'Tick this box to continue.' },
        { path: '', code: 'invalid', message: 'Check your details and try again.' },
        // Nothing but a question, a box or the form as a whole can be pointed at; and a
        // record that already holds a value is never named.
        {
          path: '/emails/0',
          code: 'taken',
          message: 'This address is taken.',
          existing: { id: 'con_01h455vb4pex5vsknk084sn02q', name: 'Maya Thompson', trashed: false },
        },
        { path: '/values/Email', code: 'x', message: 'no' },
        { path: '/values/email/0', code: 'x', message: 'no' },
      ],
    });
    const answer = await call(send);
    expect(answer.statusCode).toBe(422);
    expect(answer.json()).toEqual({
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      detail: 'Check the answers and try again.',
      errors: [
        { path: '/values/email', code: 'invalid_email', message: 'Enter an email address.' },
        { path: '/consents/news', code: 'required', message: 'Tick this box to continue.' },
        { path: '', code: 'invalid', message: 'Check your details and try again.' },
      ],
    });
    expect(answer.body).not.toMatch(/Maya|con_|taken/);
  });

  it('never sends what does not fit the contract, even when a handler returns it', async () => {
    const { call, handlers, logs } = await start();
    handlers.form.mockResolvedValueOnce({
      outcome: 'ok',
      form: { ...shown, fields: [{ ...shown.fields[0], target: { kind: 'contact' } }] },
    });
    const leaked = await call(read);
    expect(leaked.statusCode).toBe(500);
    expect(leaked.body).not.toContain('target');
    handlers.submit.mockResolvedValueOnce({
      outcome: 'ok',
      receipt: { status: 'received', contactId: 'con_01h455vb4pex5vsknk084sn02q' },
    });
    const receipt = await call(send);
    expect(receipt.statusCode).toBe(500);
    expect(receipt.body).not.toContain('con_');
    expect(logs.join('')).toContain('Public form request failed');
    expect(logs.join('')).not.toContain('con_01h455vb4pex5vsknk084sn02q');
  });

  it('gets a general answer when a handler fails, with nothing of the failure in it', async () => {
    const { call, handlers } = await start();
    handlers.submit.mockRejectedValueOnce(new ConflictError('Contact con_secret changed.'));
    const conflict = await call(send);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toContain('con_secret');
    handlers.submit.mockRejectedValueOnce(new Error('connection to 10.0.0.5 refused'));
    const failed = await call(send);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'The form request could not be completed.',
    });
  });
});

describe('the gate', () => {
  it.each([
    ['another website', 'https://attacker.test'],
    ['no Origin at all', null],
    ['the opaque origin', 'null'],
    ['the website with a path', `${ORIGIN}/`],
  ])('refuses %s with one answer and no CORS header', async (_what, origin) => {
    const { call, handlers } = await start();
    for (const request of [read, send]) {
      const answer = await call(request, origin);
      expect(answer.statusCode).toBe(403);
      expect(answer.json()).toEqual({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'This form cannot be used here.',
      });
      expect(corsHeaders(answer.headers)).toEqual([]);
    }
    expect(handlers.form).not.toHaveBeenCalled();
    expect(handlers.submit).not.toHaveBeenCalled();
  });

  it('refuses a key that is not a form key before asking anyone about it', async () => {
    const { call, handlers } = await start();
    for (const key of ['short', 'k'.repeat(65), 'has space in the key']) {
      const answer = await call({ method: 'GET', url: `/api/v1/public/forms/${key}` });
      expect(answer.statusCode).toBe(403);
      expect(corsHeaders(answer.headers)).toEqual([]);
    }
    // A path that climbs out of the forms API is no path of it at all.
    const outside = await call({ method: 'GET', url: '/api/v1/public/forms/%2e%2e' });
    expect(outside.statusCode).toBe(404);
    expect(corsHeaders(outside.headers)).toEqual([]);
    expect(handlers.admit).not.toHaveBeenCalled();
  });

  it('answers an unknown key, a known key from elsewhere, an unknown path and an unknown method alike', async () => {
    const { call, handlers } = await start();
    const unknown = await call({ method: 'GET', url: `/api/v1/public/forms/${'z'.repeat(32)}` });
    const elsewhere = await call(read, 'https://attacker.test');
    expect(unknown.statusCode).toBe(403);
    expect(unknown.body).toBe(elsewhere.body);
    // What the API does not have is refused at the gate too, before any handler: an
    // allowed website learns no more about it than any other.
    const others: { method: 'GET' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD'; url: string }[] = [
      { method: 'GET', url: `${BASE}/contacts` },
      { method: 'GET', url: `${BASE}/submissions` },
      { method: 'PUT', url: BASE },
      { method: 'DELETE', url: BASE },
      { method: 'PATCH', url: `${BASE}/submissions` },
      { method: 'HEAD', url: BASE },
      { method: 'GET', url: '/api/v1/public/forms' },
      { method: 'GET', url: '/api/v1/public/forms/' },
    ];
    for (const request of others) {
      const answer = await call(request);
      expect(answer.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(corsHeaders(answer.headers)).toEqual([]);
      if (request.method !== 'HEAD') expect(answer.body).toBe(elsewhere.body);
    }
    expect(handlers.form).not.toHaveBeenCalled();
    expect(handlers.submit).not.toHaveBeenCalled();
  });
});

describe('the limiter', () => {
  it('counts a form’s requests toward its business once one was admitted, and never a key that names no form', async () => {
    const { call, rateLimit, handlers } = await start();
    const BUSINESS = '01890f3e-7b1c-7cc0-8a51-00000000000a';
    handlers.admit.mockImplementation((key, origin) =>
      Promise.resolve(
        key === KEY && origin === ORIGIN
          ? { formId: 'f', origin: ORIGIN, businessId: BUSINESS }
          : undefined,
      ),
    );
    await call(read);
    await call(send);
    await call(read, 'https://attacker.test');
    const other = `/api/v1/public/forms/${'z'.repeat(32)}`;
    await call({ method: 'GET', url: other });
    await call({ method: 'GET', url: other });
    expect(rateLimit.mock.calls.map(([request]) => request.businessId)).toEqual([
      // The first request for a key: which business it is for is not known yet.
      undefined,
      BUSINESS,
      // Known from then on, whatever website the request comes from: a flood from anywhere
      // counts against the business it is aimed at, before the gate looks anything up.
      BUSINESS,
      undefined,
      undefined,
    ]);
    // A preview names a draft, not a form's key: only its address is counted.
    await call({ method: 'GET', url: PREVIEW_BASE }, null);
    expect(rateLimit.mock.calls.at(-1)?.[0]).not.toHaveProperty('businessId');
  });

  it('is asked first, for a read or a write, by the address the server saw', async () => {
    const { call, rateLimit, handlers } = await start();
    await call({ ...read, remoteAddress: '203.0.113.9' });
    await call({ ...send, remoteAddress: '203.0.113.9' });
    expect(
      rateLimit.mock.calls.map(([request, operation]) => [request.ipAddress, operation]),
    ).toEqual([
      ['203.0.113.9', 'read'],
      ['203.0.113.9', 'write'],
    ]);
    // Before the gate: a request from anywhere is counted, and an over-limit one asks nobody.
    rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    handlers.admit.mockClear();
    const refused = await call(send, 'https://attacker.test');
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('30');
    expect(handlers.admit).not.toHaveBeenCalled();
    // Readable from any website: it says nothing about any form, and the embed must see it.
    expect(refused.headers['access-control-allow-origin']).toBe('*');
    expect(refused.headers['access-control-expose-headers']).toBe('Retry-After');
  });

  it('fails closed: unavailable when the limiter fails or decides nonsense', async () => {
    const { call, rateLimit, handlers, logs } = await start();
    rateLimit.mockRejectedValueOnce(new Error('database down'));
    const down = await call(send);
    expect(down.statusCode).toBe(503);
    expect(down.headers['access-control-allow-origin']).toBe('*');
    for (const retryAfterSeconds of [0, -1, 1.5, Number.NaN]) {
      rateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds });
      expect((await call(send)).statusCode).toBe(503);
    }
    expect(handlers.admit).not.toHaveBeenCalled();
    expect(handlers.submit).not.toHaveBeenCalled();
    expect(logs.join('')).toContain('Public forms limiter unavailable');
    expect(logs.join('')).not.toContain('database down');
  });
});

describe('a request body', () => {
  it('must be JSON of the contract, bounded, and with no query', async () => {
    const { call, handlers } = await start();
    const post = (request: Partial<InjectOptions>) => call({ ...send, ...request });
    expect(
      (
        await post({
          payload: 'email=maya@example.test',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (await post({ payload: JSON.stringify(body), headers: { 'content-type': 'text/plain' } }))
        .statusCode,
    ).toBe(415);
    expect(
      (
        await post({
          payload: '{"clientSubmissionId":',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(400);
    for (const payload of [
      {},
      { ...body, clientSubmissionId: 'not-a-uuid' },
      { ...body, renderToken: 'nope' },
      { ...body, values: { email: 7 } },
      { ...body, values: { 'Not-A-Key': 'x' } },
      { ...body, contactId: 'con_01h455vb4pex5vsknk084sn02q' },
    ]) {
      const refused = await post({ payload });
      expect(refused.statusCode).toBe(422);
      // Refused in general: nothing of the body is said back.
      expect(refused.json()).toEqual({
        type: 'about:blank',
        title: 'Unprocessable Content',
        status: 422,
        detail: 'Check the answers and try again.',
      });
    }
    expect((await post({ url: `${BASE}/submissions?debug=1` })).statusCode).toBe(422);
    expect((await call({ ...read, url: `${BASE}?callback=x` })).statusCode).toBe(422);
    // The largest a form can ask for fits; anything past the bound is not read.
    const most = { ...body, values: { notes: 'x'.repeat(FORM_LIMITS.longTextLength) } };
    expect((await post({ payload: most })).statusCode).toBe(201);
    const tooLarge = await post({
      payload: JSON.stringify({ ...body, padding: 'x'.repeat(131_072) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(handlers.submit).toHaveBeenCalledTimes(1);
  });
});

describe('the preflight', () => {
  it('is answered from memory for any website, and allows only what the embed sends', async () => {
    const { call, rateLimit, handlers } = await start();
    for (const url of [BASE, `${BASE}/submissions`]) {
      const answer = await call(
        {
          method: 'OPTIONS',
          url,
          headers: {
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type',
          },
        },
        'https://anywhere.test',
      );
      expect(answer.statusCode).toBe(204);
      expect(answer.body).toBe('');
      expect(answer.headers['access-control-allow-origin']).toBe('*');
      expect(answer.headers['access-control-allow-methods']).toBe('GET, POST');
      // No authorization header and no credentials: the embed has no token of a person.
      expect(answer.headers['access-control-allow-headers']).toBe('content-type');
      expect(answer.headers['access-control-allow-credentials']).toBeUndefined();
      expect(answer.headers['access-control-max-age']).toBe('600');
    }
    expect(rateLimit).not.toHaveBeenCalled();
    expect(handlers.admit).not.toHaveBeenCalled();
  });
});

describe('the script', () => {
  it('is served from memory to any website, cached briefly, and costs no lookup', async () => {
    const { app, rateLimit, handlers } = await start({ script });
    expect(FORM_SCRIPT_URL).toBe(FORM_SCRIPT_PATH);
    const answer = await app.inject({ method: 'GET', url: FORM_SCRIPT_URL });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toBe('(function(){})();');
    expect(answer.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(answer.headers['cache-control']).toBe('public, max-age=300');
    expect(answer.headers.etag).toBe('"abc"');
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(answer.headers['referrer-policy']).toBe('no-referrer');
    const unchanged = await app.inject({
      method: 'GET',
      url: FORM_SCRIPT_URL,
      headers: { 'if-none-match': '"abc"' },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');
    expect((await app.inject({ method: 'HEAD', url: FORM_SCRIPT_URL })).statusCode).toBe(404);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(handlers.admit).not.toHaveBeenCalled();
  });

  it('is a 404 where it was not built, and the API still answers', async () => {
    const { app, call } = await start();
    expect((await app.inject({ method: 'GET', url: FORM_SCRIPT_URL })).statusCode).toBe(404);
    expect((await call(read)).statusCode).toBe(200);
  });

  it('is read from the file the build wrote, and is nothing when that is not there', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'crm-form-embed-'));
    try {
      const file = path.join(folder, 'embed.bundle.js');
      expect(loadEmbedScript(pathToFileURL(file))).toBeUndefined();
      writeFileSync(file, '(function(){})();');
      const loaded = loadEmbedScript(pathToFileURL(file));
      expect(loaded?.body.toString()).toBe('(function(){})();');
      expect(loaded?.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
      writeFileSync(file, '(function(){1})();');
      expect(loadEmbedScript(pathToFileURL(file))?.etag).not.toBe(loaded?.etag);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    // In this run nothing was built beside the source file: the default finds nothing.
    expect(loadEmbedScript()).toBeUndefined();
  });
});

describe("the CRM's own pages", () => {
  const own = { [FORM_PAGE_HEADER]: '1' };

  it('are taken as the CRM’s own address when a request has no Origin and the header only they can send', async () => {
    // A browser sends no Origin with a GET to the address the page itself came from.
    const { call, handlers } = await start({ ownOrigin: OWN });
    const loaded = await call({ ...read, headers: own }, null);
    expect(loaded.statusCode).toBe(200);
    expect(handlers.admit).toHaveBeenLastCalledWith(KEY, OWN);
    // With the address the server saw: the token in the answer is bound to it.
    expect(handlers.form).toHaveBeenLastCalledWith(
      { formId: 'f', origin: OWN },
      { requestId: 'req-1', ipAddress: '127.0.0.1' },
    );
    expect(loaded.headers['access-control-allow-origin']).toBe(OWN);
    // With its POST a browser does send the Origin, and that is what is used.
    const sent = await call({ ...send, headers: own }, OWN);
    expect(sent.statusCode).toBe(201);
    expect(handlers.admit).toHaveBeenLastCalledWith(KEY, OWN);
  });

  it('never let the header stand in for an Origin that was sent, or for anything else', async () => {
    const { call, handlers } = await start({ ownOrigin: OWN });
    // Another website cannot send the header at all (the preflight allows Content-Type
    // only); if a request carries both, the Origin it came with is what counts.
    const elsewhere = await call({ ...read, headers: own }, 'https://attacker.test');
    expect(elsewhere.statusCode).toBe(403);
    expect(handlers.admit).toHaveBeenLastCalledWith(KEY, 'https://attacker.test');
    expect(corsHeaders(elsewhere.headers)).toEqual([]);
    // No Origin and no header, or a header that says anything else: no website at all.
    for (const headers of [
      {},
      { [FORM_PAGE_HEADER]: '0' },
      { [FORM_PAGE_HEADER]: 'true' },
      { [FORM_PAGE_HEADER]: '' },
    ]) {
      const refused = await call({ ...read, headers }, null);
      expect(refused.statusCode).toBe(403);
      expect(handlers.admit).toHaveBeenLastCalledWith(KEY, undefined);
    }
    expect(handlers.form).not.toHaveBeenCalled();
  });

  it('are not known to an install that has no secure address of its own', async () => {
    const { call, handlers, app } = await start({ script });
    const refused = await call({ ...read, headers: own }, null);
    expect(refused.statusCode).toBe(403);
    expect(handlers.admit).toHaveBeenLastCalledWith(KEY, undefined);
    // And it serves no page for a form or a preview.
    for (const url of [`/f/${KEY}`, `/f/preview/${PREVIEW}`])
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('allow no more in a preflight than a website gets: the header stays theirs alone', async () => {
    const { app } = await start({ ownOrigin: OWN });
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: BASE,
      headers: {
        origin: 'https://attacker.test',
        'access-control-request-method': 'GET',
        'access-control-request-headers': FORM_PAGE_HEADER,
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type');
  });

  it('serve a form as a page of its own: one shell, the embed, and a policy that allows nothing else', async () => {
    const { app, rateLimit, handlers } = await start({ script, ownOrigin: OWN });
    const answer = await app.inject({ method: 'GET', url: `/f/${KEY}` });
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(answer.body).toContain(
      `<script async src="${FORM_SCRIPT_URL}" data-form-key="${KEY}"></script>`,
    );
    expect(answer.headers['content-security-policy']).toBe(PAGE_POLICY);
    expect(answer.headers['x-frame-options']).toBe('DENY');
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['x-robots-tag']).toBe('noindex');
    expect(answer.headers['referrer-policy']).toBe('no-referrer');
    expect(answer.headers['cache-control']).toBe('public, max-age=300');
    expect(answer.headers['set-cookie']).toBeUndefined();
    // The same bytes whatever the key names, with no lookup: the embed says whether
    // there is such a form.
    const unknown = await app.inject({ method: 'GET', url: `/f/${'z'.repeat(32)}` });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toBe(answer.body.replace(KEY, 'z'.repeat(32)));
    expect(rateLimit).not.toHaveBeenCalled();
    expect(handlers.admit).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'HEAD', url: `/f/${KEY}` })).statusCode).toBe(404);
  });

  it('serve the preview of a draft the same way, never cached', async () => {
    const { app, handlers } = await start({ script, ownOrigin: OWN });
    const answer = await app.inject({ method: 'GET', url: `/f/preview/${PREVIEW}` });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain(
      `<script async src="${FORM_SCRIPT_URL}" data-form-preview="${PREVIEW}"></script>`,
    );
    expect(answer.body).not.toContain('data-form-key');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers['content-security-policy']).toBe(PAGE_POLICY);
    expect(answer.headers['referrer-policy']).toBe('no-referrer');
    // The page is a shell: whether the link still opens anything is the API's to say.
    expect(handlers.admitPreview).not.toHaveBeenCalled();
  });

  it('write nothing a caller sends into a page: what is not a key or a link gets no page', async () => {
    const { app } = await start({ script, ownOrigin: OWN });
    for (const url of [
      '/f/short',
      `/f/${'k'.repeat(65)}`,
      '/f/%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      `/f/${'k'.repeat(20)}%22%20onload%3D%22alert(1)`,
      `/f/${'k'.repeat(20)}%3Cb%3E`,
      '/f/preview/short',
      `/f/preview/${PREVIEW}x`,
      `/f/preview/${'P'.repeat(70)}%22${'S'.repeat(22)}`,
    ]) {
      const answer = await app.inject({ method: 'GET', url });
      expect(answer.statusCode, url).toBe(404);
      expect(answer.body).toBe('');
      expect(answer.headers['content-security-policy']).toBe(PAGE_POLICY);
    }
  });

  it('are not served where the embed was not built', async () => {
    const { app } = await start({ ownOrigin: OWN });
    for (const url of [`/f/${KEY}`, `/f/preview/${PREVIEW}`])
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });
});

describe('a preview', () => {
  const own = { [FORM_PAGE_HEADER]: '1' };
  const preview: InjectOptions = { method: 'GET', url: PREVIEW_BASE, headers: own };
  const rehearse: InjectOptions = {
    method: 'POST',
    url: `${PREVIEW_BASE}/submissions`,
    payload: body,
  };

  it('is shown and rehearsed through the same handlers, as what its own gate admitted', async () => {
    const { call, handlers } = await start({ ownOrigin: OWN });
    const loaded = await call(preview, null);
    expect(loaded.statusCode).toBe(200);
    expect(publicForm.parse(loaded.json())).toEqual(shown);
    expect(handlers.admitPreview).toHaveBeenLastCalledWith(PREVIEW, OWN);
    expect(handlers.form).toHaveBeenLastCalledWith(
      { formId: 'f', origin: OWN, preview: true },
      { requestId: 'req-1', ipAddress: '127.0.0.1' },
    );
    const sent = await call(rehearse, OWN);
    expect(sent.statusCode).toBe(201);
    expect(publicFormReceipt.parse(sent.json())).toEqual({ status: 'received' });
    expect(handlers.submit).toHaveBeenCalledExactlyOnceWith(
      { formId: 'f', origin: OWN, preview: true },
      { ...body, trap: '' },
      expect.objectContaining({ ipAddress: '127.0.0.1' }),
    );
    // The gate of a published form was never asked: a preview is not one.
    expect(handlers.admit).not.toHaveBeenCalled();
    for (const answer of [loaded, sent]) {
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.headers['access-control-allow-origin']).toBe(OWN);
    }
  });

  it('is refused like any other request the gate does not know, and counted by the limiter', async () => {
    const { call, handlers, rateLimit } = await start({ ownOrigin: OWN });
    // From a website, however well it is listed; with no sign of where it is from; and
    // with a link that is not the shape of one.
    for (const [request, origin] of [
      [preview, ORIGIN],
      [rehearse, ORIGIN],
      [{ ...preview, headers: {} }, null],
      [{ ...preview, url: `/api/v1/public/forms/preview/${PREVIEW}x` }, null],
      [{ ...preview, url: '/api/v1/public/forms/preview/short' }, null],
      [{ ...preview, url: `${PREVIEW_BASE}/contacts` }, null],
      [{ ...preview, method: 'DELETE' }, null],
    ] as const) {
      const answer = await call(request, origin);
      expect(answer.statusCode, JSON.stringify([request.method, request.url])).toBe(403);
      expect(corsHeaders(answer.headers)).toEqual([]);
    }
    expect(handlers.form).not.toHaveBeenCalled();
    expect(handlers.submit).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledTimes(7);
    // A refusal by the module reads as it does for a published form.
    handlers.submit.mockResolvedValueOnce({
      outcome: 'invalid',
      issues: [
        { path: '/values/email', code: 'invalid_email', message: 'Enter an email address.' },
      ],
    });
    const refused = await call(rehearse, OWN);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      errors: [
        { path: '/values/email', code: 'invalid_email', message: 'Enter an email address.' },
      ],
    });
  });
});

describe('bot protection', () => {
  const ask: InjectOptions = {
    method: 'POST',
    url: `${BASE}/challenge`,
    payload: { renderToken: TOKEN },
  };

  it('gives an allowed website the challenge for the showing it names, behind the gate and the limiter', async () => {
    const { call, handlers, rateLimit } = await start();
    const answer = await call({ ...ask, remoteAddress: '203.0.113.5' });
    expect(answer.statusCode).toBe(200);
    expect(botChallenge.parse(answer.json())).toEqual(challenge);
    expect(answer.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(handlers.challenge).toHaveBeenCalledExactlyOnceWith(
      { formId: 'f', origin: ORIGIN },
      { renderToken: TOKEN },
      { requestId: expect.any(String) as string, ipAddress: '203.0.113.5' },
    );
    // Counted as a write, like a submission.
    expect(rateLimit.mock.calls.at(-1)?.[1]).toBe('write');
    // A website that is not listed learns nothing.
    expect((await call(ask, 'https://elsewhere.example')).statusCode).toBe(403);
    expect(handlers.challenge).toHaveBeenCalledOnce();
  });

  it('refuses a request that is not a render token, and says a form that asks for none is not there', async () => {
    const { call, handlers } = await start();
    for (const payload of [{}, { renderToken: 'nope' }, { renderToken: TOKEN, extra: 1 }])
      expect((await call({ ...ask, payload })).statusCode).toBe(422);
    expect(handlers.challenge).not.toHaveBeenCalled();
    handlers.challenge.mockResolvedValueOnce({ outcome: 'unavailable' });
    expect((await call(ask)).statusCode).toBe(403);
    handlers.challenge.mockResolvedValueOnce({ outcome: 'stale' });
    expect((await call(ask)).statusCode).toBe(409);
  });

  it('answers the preview of a draft from the CRM own page', async () => {
    const { call, handlers } = await start({ ownOrigin: OWN });
    const answer = await call(
      { method: 'POST', url: `${PREVIEW_BASE}/challenge`, payload: { renderToken: TOKEN } },
      OWN,
    );
    expect(answer.statusCode).toBe(200);
    expect(handlers.challenge.mock.calls[0]?.[0]).toEqual({
      formId: 'f',
      origin: OWN,
      preview: true,
    });
  });
});
