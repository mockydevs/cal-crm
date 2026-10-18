// A local HTTP stand-in for Emailable's API, for the whole-product suite. It never talks to
// Emailable, and its key is made up by the test that starts it.
//
// It answers the two requests the email-checks adapter makes, in the shapes of Emailable's
// API reference (https://emailable.com/docs/api/emails/ and account/), as the adapter's own
// tests record them (packages/adapters/email-checks/src/emailable.test.ts):
//
//   GET /v1/verify?email=…   one address: deliverable, or undeliverable when its local part
//                            starts with "nobody" (reason rejected_email)
//   GET /v1/account          the credits left
//
// A request without a key is answered 401 and one with another key 403, as Emailable's
// status codes page has it (https://emailable.com/docs/api/status-codes/); any other path 404.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the stand-in answers for the credits left. */
export const FAKE_EMAILABLE_CREDITS = 250;

export interface FakeEmailable {
  /** Where the adapter's requests go instead of https://api.emailable.com. */
  readonly origin: string;
  /** The addresses checked, in order. */
  readonly checked: readonly string[];
  stop(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startFakeEmailable(key: string): Promise<FakeEmailable> {
  const checked: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    // Emailable's status codes: 401 when no key is sent, 403 when it is not a valid one.
    const authorization = request.headers.authorization;
    if (authorization === undefined || !sameText(authorization, `Bearer ${key}`)) {
      json(response, authorization === undefined ? 401 : 403, { message: 'Invalid API key.' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/account') {
      json(response, 200, {
        owner_email: 'owner@fixture.example',
        available_credits: FAKE_EMAILABLE_CREDITS,
      });
      return;
    }
    const email = url.searchParams.get('email');
    if (request.method === 'GET' && url.pathname === '/v1/verify' && email !== null) {
      checked.push(email);
      const [user = '', domain = ''] = email.split('@');
      const undeliverable = user.startsWith('nobody');
      json(response, 200, {
        accept_all: false,
        did_you_mean: null,
        disposable: false,
        domain,
        duration: 0.1,
        email,
        free: false,
        mailbox_full: false,
        mx_record: `mail.${domain}`,
        no_reply: false,
        reason: undeliverable ? 'rejected_email' : 'accepted_email',
        role: false,
        score: undeliverable ? 0 : 100,
        smtp_provider: null,
        state: undeliverable ? 'undeliverable' : 'deliverable',
        tag: null,
        user,
      });
      return;
    }
    json(response, 404, { message: 'Not found.' });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    checked,
    stop: () =>
      new Promise<void>((done, fail) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) done();
          else fail(error);
        });
      }),
  };
}
