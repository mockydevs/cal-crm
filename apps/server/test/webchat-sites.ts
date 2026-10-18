// Two real HTTP sites for the web chat end-to-end test (apps/dashboard/e2e/webchat.spec.ts):
// a "CRM" that serves the built widget and the REAL public transport, and a "shop" that
// serves the test page. A browser between them enforces the same-origin policy for real.
//
// The transport, its gate, its CORS headers and its bounds are the production code. What
// stands in is the messaging module behind it: sessions are kept in memory here, because
// the browser test has no database. The module itself is proven on Postgres by its own
// integration tests.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  loadWidgetScript,
  registerPublicWebchat,
  type PublicWebchatPorts,
} from '../src/webchat-widget/transport.js';
import { buildWidget } from '../webchat-widget/tools/build.js';

interface Admission {
  readonly origin: string;
}
interface StoredMessage {
  readonly seq: number;
  readonly from: 'visitor' | 'team';
  readonly text: string;
  readonly sentAt: string;
  readonly clientMessageId?: string;
}
interface Session {
  readonly origin: string;
  readonly name: string | undefined;
  readonly email: string | undefined;
  readonly marketingConsent: boolean;
  readonly messages: StoredMessage[];
  ended: boolean;
}

export interface WebchatSitesOptions {
  /** The test page; `{{CRM}}` and `{{KEY}}` are filled in. */
  readonly page: string;
  readonly emailRequired?: boolean;
  readonly marketingConsentWording?: string | null;
}

export interface WebchatSites {
  /** The CRM's origin: the widget script and the API. */
  readonly crm: string;
  /** The website the widget allows. */
  readonly shop: string;
  /** The same page on another origin (another host name), which the widget does not allow. */
  readonly elsewhere: string;
  readonly widgetKey: string;
  /** Every request the CRM received: method, path, Origin header and status. */
  readonly requests: readonly {
    readonly method: string;
    readonly path: string;
    readonly origin: string | undefined;
    readonly status: number;
  }[];
  /** What the sessions hold, for assertions. No token is exposed. */
  sessions(): readonly Omit<Session, 'messages'>[];
  messages(): readonly StoredMessage[];
  /** The team replies in the newest session. */
  reply(text: string): void;
  /** Makes the shared limiter refuse every request, with this wait; null lets them through again. */
  limit(retryAfterSeconds: number | null): void;
  close(): Promise<void>;
}

const addressOf = (app: FastifyInstance): number => {
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('No port.');
  return address.port;
};

export async function startWebchatSites(options: WebchatSitesOptions): Promise<WebchatSites> {
  const widgetKey = randomBytes(24).toString('base64url');
  const sessions = new Map<string, Session>();
  let limited: number | null = null;
  const requests: {
    method: string;
    path: string;
    origin: string | undefined;
    status: number;
  }[] = [];

  // The page needs the CRM's address and the CRM needs the shop's, so the shop's route is
  // registered now and filled once both are listening.
  const served: { page?: { readonly html: string; readonly policy: string } } = {};
  const shopApp = Fastify();
  shopApp.get('/', (_request, reply) =>
    served.page === undefined
      ? reply.code(503).send()
      : reply
          .type('text/html; charset=utf-8')
          .header('content-security-policy', served.page.policy)
          .send(served.page.html),
  );
  await shopApp.listen({ host: '127.0.0.1', port: 0 });
  const shopPort = addressOf(shopApp);
  const shop = `http://127.0.0.1:${String(shopPort)}`;
  const elsewhere = `http://localhost:${String(shopPort)}`;

  const live = (admission: Admission, token: string | undefined): Session | undefined => {
    const session = token === undefined ? undefined : sessions.get(token);
    return session !== undefined && !session.ended && session.origin === admission.origin
      ? session
      : undefined;
  };
  const handlers: PublicWebchatPorts<Admission> = {
    // As the module's gate: this widget's key, and exactly the shop's origin.
    admit: (key, origin) =>
      Promise.resolve(key === widgetKey && origin === shop ? { origin: shop } : undefined),
    config: () =>
      Promise.resolve({
        outcome: 'ok',
        config: {
          title: 'Chat with us',
          greeting: 'Hello. How can we help?',
          emailRequired: options.emailRequired ?? true,
          marketingConsentWording: options.marketingConsentWording ?? null,
          messageLength: 2000,
        },
      }),
    start: (admission, input) => {
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, {
        origin: admission.origin,
        name: input.name,
        email: input.email,
        marketingConsent: input.marketingConsent,
        messages: [],
        ended: false,
      });
      return Promise.resolve({
        outcome: 'ok',
        session: { token, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      });
    },
    send: (admission, token, input) => {
      const session = live(admission, token);
      if (session === undefined) return Promise.resolve({ outcome: 'session_invalid' });
      const repeated = session.messages.find(
        (message) => message.clientMessageId === input.clientMessageId,
      );
      const stored = repeated ?? {
        seq: session.messages.length + 1,
        from: 'visitor' as const,
        text: input.text,
        sentAt: new Date().toISOString(),
        clientMessageId: input.clientMessageId,
      };
      if (repeated === undefined) session.messages.push(stored);
      const { clientMessageId: _id, ...message } = stored;
      return Promise.resolve({ outcome: 'ok', message });
    },
    messages: (admission, token, after) => {
      const session = live(admission, token);
      if (session === undefined) return Promise.resolve({ outcome: 'session_invalid' });
      const page = session.messages
        .filter((message) => message.seq > after)
        .slice(0, 50)
        .map(({ clientMessageId: _id, ...message }) => message);
      return Promise.resolve({
        outcome: 'ok',
        page: { messages: page, cursor: page.at(-1)?.seq ?? after, more: false },
      });
    },
    end: (admission, token) => {
      const session = live(admission, token);
      if (session === undefined) return Promise.resolve({ outcome: 'session_invalid' });
      session.ended = true;
      return Promise.resolve({ outcome: 'ok' });
    },
  };

  const folder = mkdtempSync(path.join(tmpdir(), 'crm-webchat-e2e-'));
  const script = loadWidgetScript(
    new URL(`file:///${(await buildWidget(folder)).replaceAll('\\', '/')}`),
  );
  if (script === undefined) throw new Error('The widget was not built.');

  const crmApp = Fastify();
  crmApp.addHook('onResponse', async (request, reply) => {
    requests.push({
      method: request.method,
      path: request.url,
      origin: request.headers.origin,
      status: reply.statusCode,
    });
  });
  await registerPublicWebchat(crmApp, {
    handlers,
    rateLimit: () =>
      Promise.resolve(
        limited === null ? { allowed: true } : { allowed: false, retryAfterSeconds: limited },
      ),
    script,
  });
  await crmApp.listen({ host: '127.0.0.1', port: 0 });
  const crm = `http://127.0.0.1:${String(addressOf(crmApp))}`;

  served.page = {
    html: options.page.replaceAll('{{CRM}}', crm).replaceAll('{{KEY}}', widgetKey),
    // A strict policy a careful website might have: scripts and connections only to the
    // CRM, and no inline script or style at all.
    policy: `default-src 'none'; script-src ${crm}; connect-src ${crm}; base-uri 'none'; form-action 'none'`,
  };

  return {
    crm,
    shop,
    elsewhere,
    widgetKey,
    requests,
    sessions: () => [...sessions.values()].map(({ messages: _messages, ...session }) => session),
    messages: () => [...sessions.values()].flatMap((session) => session.messages),
    reply(text) {
      const session = [...sessions.values()].at(-1);
      if (session === undefined) throw new Error('No session to reply in.');
      session.messages.push({
        seq: session.messages.length + 1,
        from: 'team',
        text,
        sentAt: new Date().toISOString(),
      });
    },
    limit(retryAfterSeconds) {
      limited = retryAfterSeconds;
    },
    async close() {
      await Promise.all([crmApp.close(), shopApp.close()]);
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
