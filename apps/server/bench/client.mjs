// The load generator of the benchmark and the load test: plain node:http over kept-alive
// connections, in a thread of its own, so the clock that times a response is not the
// server's own event loop. Plain JavaScript: a worker thread is started from this file as
// it is. Every request names an address of its own in X-Forwarded-For (the server under
// test trusts the loopback proxy), so the limiter sees as many visitors as a real crowd is.
//
// Four kinds of work, given as workerData:
// - { kind: 'get', url, headers, connections, requests, addressBase }: `requests` GETs,
//   `connections` at a time, each sent when the one before it on its connection is back.
//   Measures what the server can answer, and how long each answer takes.
// - { kind: 'submit', origin, forms: [{ key, website }], perSecond, seconds, fillMs,
//   addressBase, pageUrl }: `perSecond` visitors a second for `seconds`, each of whom loads
//   a form, waits as long as a person takes to fill it in, and sends it once. Sent on the
//   clock whatever the server does (an open loop): a slow server does not slow the crowd.
//   With pageUrl, a visitor a second opens that page too, holding the tag it was sent.
// - { kind: 'book', url, perSecond, seconds, addressBase, days, firstDay }: on the same
//   clock, each visitor opens a booking calendar, asks for a day's slots and books one. The
//   visitor numbered n takes day n % days and that day's slot floor(n / days), so the
//   first days * (slots in a day) visitors each ask for a slot of their own.
// - { kind: 'chat', origin, key, website, perSecond, seconds, addressBase }: on the same
//   clock, each visitor reads a chat widget's settings, starts a chat and writes once.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';

const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });

/**
 * An address of the visitor numbered `n` of the crowd numbered `base`, in the range kept
 * for documentation (RFC 3849). The limiter counts an IPv6 /64 as one visitor, so each
 * visitor gets a /64 of their own: 256 crowds of 16 million.
 */
const addressOf = (base, n) =>
  `2001:db8:${((((base & 0xff) << 8) | ((n >>> 16) & 0xff)) >>> 0).toString(16)}:${(n & 0xffff).toString(16)}::1`;

function request(method, url, headers, body) {
  return new Promise((resolve) => {
    const started = performance.now();
    const call = http.request(url, { method, agent, headers }, (response) => {
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (body !== undefined || method === 'GET') chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          ms: performance.now() - started,
          bytes,
          headers: response.headers,
          text: () => Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    call.on('error', () => {
      resolve({
        status: 0,
        ms: performance.now() - started,
        bytes: 0,
        headers: {},
        text: () => '',
      });
    });
    if (body !== undefined) call.write(body);
    call.end();
  });
}

async function get(work) {
  const latencies = [];
  const statuses = {};
  let bytes = 0;
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: work.connections }, async () => {
      for (;;) {
        const mine = next;
        next += 1;
        if (mine >= work.requests) return;
        const answer = await request('GET', work.url, {
          'x-forwarded-for': addressOf(work.addressBase, mine),
          ...work.headers,
        });
        latencies.push(answer.ms);
        statuses[answer.status] = (statuses[answer.status] ?? 0) + 1;
        bytes += answer.bytes;
      }
    }),
  );
  return { latencies, statuses, bytes, seconds: (performance.now() - started) / 1000 };
}

async function submit(work) {
  const visitors = [];
  const pages = [];
  const started = performance.now();
  let pageTag;
  const visitor = async (n) => {
    const form = work.forms[n % work.forms.length];
    const base = `${work.origin}/api/v1/public/forms/${form.key}`;
    const headers = { 'x-forwarded-for': addressOf(work.addressBase, n), origin: form.website };
    const shown = await request('GET', base, headers);
    if (shown.status !== 200) return { form: form.key, shown: shown.status, status: -1, ms: 0 };
    const { renderToken } = JSON.parse(shown.text());
    await new Promise((resolve) => setTimeout(resolve, work.fillMs));
    const clientSubmissionId = randomUUID();
    const body = JSON.stringify({
      clientSubmissionId,
      renderToken,
      values: {
        first_name: `Visitor ${String(n)}`,
        email: `v${String(work.addressBase)}-${String(n)}@load.example.test`,
      },
      consents: {},
      trap: '',
      pageUrl: `${form.website}/landing?utm_source=load`,
    });
    const sent = await request(
      'POST',
      `${base}/submissions`,
      { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      body,
    );
    return {
      form: form.key,
      shown: 200,
      status: sent.status,
      ms: sent.ms,
      retryAfter: sent.headers['retry-after'],
      clientSubmissionId,
    };
  };
  const total = work.perSecond * work.seconds;
  const every = 1000 / work.perSecond;
  for (let n = 0; n < total; n += 1) {
    const due = started + n * every;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    visitors.push(visitor(n));
    if (work.pageUrl !== undefined && n % work.perSecond === 0)
      pages.push(
        request('GET', work.pageUrl, {
          'x-forwarded-for': addressOf(work.addressBase + 1, n),
          'accept-encoding': 'br',
          ...(pageTag === undefined ? {} : { 'if-none-match': pageTag }),
        }).then((answer) => {
          if (typeof answer.headers.etag === 'string') pageTag = answer.headers.etag;
          return { status: answer.status, ms: answer.ms };
        }),
      );
  }
  return { visitors: await Promise.all(visitors), pages: await Promise.all(pages) };
}

/** `visitor(n)` for `perSecond` visitors a second, on the clock, whatever the server does. */
async function crowd(work, visitor) {
  const visitors = [];
  const started = performance.now();
  const total = work.perSecond * work.seconds;
  const every = 1000 / work.perSecond;
  for (let n = 0; n < total; n += 1) {
    const wait = started + n * every - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    visitors.push(visitor(n));
  }
  return { visitors: await Promise.all(visitors) };
}

const json = (headers, body) => ({
  ...headers,
  'content-type': 'application/json',
  'content-length': Buffer.byteLength(body),
});

function book(work) {
  return crowd(work, async (n) => {
    const headers = { 'x-forwarded-for': addressOf(work.addressBase, n) };
    const shown = await request('GET', work.url, headers);
    if (shown.status !== 200) return { shown: shown.status, status: -1, ms: 0 };
    const date = new Date(work.firstDay + (n % work.days) * 86_400_000).toISOString().slice(0, 10);
    const offered = await request('GET', `${work.url}/slots?date=${date}`, headers);
    if (offered.status !== 200) return { shown: offered.status, status: -1, ms: 0 };
    const { slots } = JSON.parse(offered.text());
    const slot = slots[Math.floor(n / work.days) % Math.max(1, slots.length)];
    // A day with nothing left: nothing to ask for, and nothing sent.
    if (slot === undefined) return { shown: 200, status: -2, ms: 0 };
    const body = JSON.stringify({
      bookingRequestId: randomUUID(),
      startsAt: slot.startsAt,
      contact: {
        firstName: `Visitor ${String(n)}`,
        email: `b${String(work.addressBase)}-${String(n)}@load.example.test`,
      },
      notificationConsent: true,
      contactTimezone: 'UTC',
    });
    const sent = await request('POST', `${work.url}/appointments`, json(headers, body), body);
    return {
      shown: 200,
      status: sent.status,
      ms: sent.ms,
      retryAfter: sent.headers['retry-after'],
    };
  });
}

function chat(work) {
  return crowd(work, async (n) => {
    const base = `${work.origin}/api/v1/public/webchat/${work.key}`;
    const headers = { 'x-forwarded-for': addressOf(work.addressBase, n), origin: work.website };
    const shown = await request('GET', base, headers);
    if (shown.status !== 200) return { shown: shown.status, started: -1, status: -1, ms: 0 };
    const visitor = JSON.stringify({
      name: `Visitor ${String(n)}`,
      email: `c${String(work.addressBase)}-${String(n)}@load.example.test`,
      marketingConsent: false,
    });
    const started = await request('POST', `${base}/sessions`, json(headers, visitor), visitor);
    if (started.status !== 201)
      return {
        shown: 200,
        started: started.status,
        status: -1,
        ms: started.ms,
        retryAfter: started.headers['retry-after'],
      };
    const { token } = JSON.parse(started.text());
    const body = JSON.stringify({ clientMessageId: randomUUID(), text: 'Are you open on Sunday?' });
    const sent = await request(
      'POST',
      `${base}/messages`,
      json({ ...headers, authorization: `Bearer ${token}` }, body),
      body,
    );
    return {
      shown: 200,
      started: 201,
      status: sent.status,
      ms: sent.ms,
      retryAfter: sent.headers['retry-after'],
    };
  });
}

const kinds = { get, submit, book, chat };
const result = await kinds[workerData.kind](workerData);
agent.destroy();
parentPort.postMessage(result);
