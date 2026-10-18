// The two test sites of the web chat end-to-end test (test/webchat-sites.ts), over real
// HTTP on loopback: the built widget and the real public transport on one origin, a page
// on another. What a browser would then enforce (the same-origin policy) is the browser
// test's to prove; this proves what the CRM answers to each origin, on the wire.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { startWebchatSites, type WebchatSites } from '../../test/webchat-sites.js';
import { createWidgetApi } from './api.js';

let sites: WebchatSites;
let base: string;
beforeAll(async () => {
  sites = await startWebchatSites({
    page: '<script async src="{{CRM}}/webchat/widget.js" data-widget-key="{{KEY}}"></script>',
  });
  base = `${sites.crm}/api/v1/public/webchat/${sites.widgetKey}`;
}, 60_000);
afterAll(async () => {
  await sites.close();
});

const json = { 'content-type': 'application/json' };

it('serves the page with a policy that allows only the CRM, and the script as one function', async () => {
  const page = await fetch(`${sites.shop}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toBe(
    `<script async src="${sites.crm}/webchat/widget.js" data-widget-key="${sites.widgetKey}"></script>`,
  );
  expect(page.headers.get('content-security-policy')).toBe(
    `default-src 'none'; script-src ${sites.crm}; connect-src ${sites.crm}; base-uri 'none'; form-action 'none'`,
  );
  const script = await fetch(`${sites.crm}/webchat/widget.js`);
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(script.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  expect(script.headers.get('x-content-type-options')).toBe('nosniff');
  expect((await script.text()).startsWith('(function(){')).toBe(true);
});

it('answers the allowed website with its own origin, and every other origin with nothing', async () => {
  const allowed = await fetch(base, { headers: { origin: sites.shop } });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get('access-control-allow-origin')).toBe(sites.shop);
  expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
  expect(allowed.headers.get('vary')).toBe('Origin');
  // The same page on another host name is another origin.
  for (const origin of [sites.elsewhere, 'https://evil.test', `${sites.shop}.evil.test`, 'null']) {
    const refused = await fetch(base, { headers: { origin } });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    expect(await refused.json()).toMatchObject({ status: 403, title: 'Forbidden' });
  }
  const noOrigin = await fetch(base);
  expect(noOrigin.status).toBe(403);
});

it('answers every preflight alike, and then only the allowed website gets through the gate', async () => {
  const preflight = (origin: string): Promise<Response> =>
    fetch(`${base}/messages`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
  for (const origin of [sites.shop, sites.elsewhere]) {
    const answer = await preflight(origin);
    expect(answer.status).toBe(204);
    expect(answer.headers.get('access-control-allow-origin')).toBe('*');
    expect(answer.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(answer.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(answer.headers.get('access-control-allow-credentials')).toBeNull();
  }
  // What the preflight allowed a browser to send is refused for the website not listed.
  const refused = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { origin: sites.elsewhere, ...json },
    body: JSON.stringify({ marketingConsent: false }),
  });
  expect(refused.status).toBe(403);
  expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  expect(sites.sessions()).toEqual([]);
});

it('carries a chat both ways, as text, and gives its token nothing from another origin', async () => {
  const started = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { origin: sites.shop, ...json },
    body: JSON.stringify({ email: 'maya@example.test', marketingConsent: false }),
  });
  expect(started.status).toBe(201);
  const session: unknown = await started.json();
  const token =
    typeof session === 'object' && session !== null && 'token' in session
      ? String(session.token)
      : '';
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const bearer = { authorization: `Bearer ${token}` };

  const sent = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { origin: sites.shop, ...json, ...bearer },
    body: JSON.stringify({ clientMessageId: randomUUID(), text: 'Hello' }),
  });
  expect(sent.status).toBe(200);
  sites.reply('<b>Hi</b>');
  const read = await fetch(`${base}/messages?after=0`, {
    headers: { origin: sites.shop, ...bearer },
  });
  expect(await read.json()).toMatchObject({
    messages: [
      { seq: 1, from: 'visitor', text: 'Hello' },
      { seq: 2, from: 'team', text: '<b>Hi</b>' },
    ],
    cursor: 2,
    more: false,
  });

  // The token is whole and right; only the origin differs.
  const stolen = await fetch(`${base}/messages?after=0`, {
    headers: { origin: sites.elsewhere, ...bearer },
  });
  expect(stolen.status).toBe(403);
  expect(stolen.headers.get('access-control-allow-origin')).toBeNull();
  expect(JSON.stringify(await stolen.json())).not.toContain('Hello');
  // And nothing without the token, from the allowed origin.
  const anonymous = await fetch(`${base}/messages?after=0`, { headers: { origin: sites.shop } });
  expect(anonymous.status).toBe(401);

  const ended = await fetch(`${base}/session/end`, {
    method: 'POST',
    headers: { origin: sites.shop, ...bearer },
  });
  expect(ended.status).toBe(204);
  const after = await fetch(`${base}/messages?after=0`, {
    headers: { origin: sites.shop, ...bearer },
  });
  expect(after.status).toBe(401);
  expect(sites.sessions()).toEqual([
    {
      origin: sites.shop,
      name: undefined,
      email: 'maya@example.test',
      marketingConsent: false,
      ended: true,
    },
  ]);
});

it('reads a refusal by the limiter from any website: the status and how long to wait', async () => {
  sites.limit(7);
  try {
    for (const origin of [sites.shop, sites.elsewhere]) {
      const refused = await fetch(base, { headers: { origin } });
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('7');
      expect(refused.headers.get('access-control-allow-origin')).toBe('*');
      expect(refused.headers.get('access-control-expose-headers')).toBe('Retry-After');
      expect(refused.headers.get('access-control-allow-credentials')).toBeNull();
      expect(await refused.json()).toEqual({
        type: 'about:blank',
        title: 'Too Many Requests',
        status: 429,
        detail: 'Wait before trying again.',
      });
    }
    // The widget's own client, over the same wire: it is told to wait, and for how long.
    const api = createWidgetApi(sites.crm, sites.widgetKey, (url, init) =>
      fetch(url, { ...init, headers: { ...init.headers, origin: sites.shop } }),
    );
    expect(await api.config()).toEqual({ ok: false, failure: 'limited', retryAfterSeconds: 7 });
    expect(await api.messages('t'.repeat(43), 0)).toEqual({
      ok: false,
      failure: 'limited',
      retryAfterSeconds: 7,
    });
    // The preflight still goes through, or a browser would never show the widget the 429.
    const preflight = await fetch(`${base}/messages`, {
      method: 'OPTIONS',
      headers: { origin: sites.shop, 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
  } finally {
    sites.limit(null);
  }
  const again = await fetch(base, { headers: { origin: sites.shop } });
  expect(again.status).toBe(200);
});

it('records every request the CRM received, with the origin each one stated', () => {
  const api = sites.requests.filter(
    (each) => each.path.startsWith('/api/') && each.method !== 'OPTIONS' && each.status !== 429,
  );
  expect(api.length).toBeGreaterThan(10);
  for (const each of api) expect(each.status === 403).toBe(each.origin !== sites.shop);
});
