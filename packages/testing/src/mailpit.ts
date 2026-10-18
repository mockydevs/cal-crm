// A throwaway Mailpit for tests: it catches what the app sends over SMTP, and its API shows
// each message. The endpoints and fields are Mailpit 1.31.4's (server/ui/api/v1/swagger.json).
import { GenericContainer, Wait } from 'testcontainers';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import * as z from 'zod';

// The image compose.dev.yml runs.
const IMAGE =
  'axllent/mailpit:v1.31.4@sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48';
const SMTP_PORT = 1025;
const API_PORT = 8025;

export interface TlsMailpitServer extends MailpitServer {
  readonly address: string;
  readonly smtpPort: number;
  readonly ca: string;
  readonly username: string;
  readonly password: string;
}

/** Strict product TLS/auth with a disposable fixture CA; v1.31.4 config and cmd source. */
export async function startTlsMailpit(): Promise<{
  server: TlsMailpitServer;
  stop: () => Promise<void>;
}> {
  const username = 'fixture';
  const password = 'fixture-only-password';
  const container = await new GenericContainer(IMAGE)
    .withEnvironment({
      MP_SMTP_TLS_CERT: 'sans:localhost',
      MP_SMTP_TLS_KEY: 'sans:localhost',
      MP_SMTP_REQUIRE_TLS: 'true',
      MP_SMTP_AUTH: `${username}:${password}`,
    })
    .withExposedPorts(SMTP_PORT, API_PORT)
    .withWaitStrategy(Wait.forHttp('/api/v1/messages', API_PORT))
    .start();
  try {
    const { address: host } = await lookup(container.getHost(), { family: 4 });
    const port = container.getMappedPort(SMTP_PORT);
    // Bootstrap trust for this newly-created fixture only. The connector still verifies
    // the certificate and hostname on every actual submission.
    const ca = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host, port, rejectUnauthorized: false });
      socket.setTimeout(10_000, () => socket.destroy(new Error('Fixture TLS timed out.')));
      socket.once('error', reject);
      socket.once('secureConnect', () => {
        const raw = socket.getPeerCertificate().raw;
        socket.destroy();
        const lines = raw.toString('base64').match(/.{1,64}/g);
        if (lines === null) reject(new Error('Fixture returned no certificate.'));
        else
          resolve(`-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`);
      });
    });
    return {
      server: {
        address: host,
        smtpPort: port,
        ca,
        username,
        password,
        smtpUrl: `smtps://${host}:${String(port)}`,
        apiUrl: `http://${host}:${String(container.getMappedPort(API_PORT))}`,
      },
      stop: async () => {
        await container.stop();
      },
    };
  } catch (failure) {
    await container.stop();
    throw failure;
  }
}

/** Where Mailpit is. Plain data, for Vitest's provide and inject. */
export interface MailpitServer {
  /** For the app: smtp://host:port, without authentication or TLS. */
  smtpUrl: string;
  /** Mailpit's web API, such as http://host:port. */
  apiUrl: string;
}

/** All the mailbox needs: the API's address, such as a test run passes on to its workers. */
export type MailpitApi = Pick<MailpitServer, 'apiUrl'>;

/** Starts Mailpit, ready to catch mail. */
export async function startMailpit(): Promise<{
  server: MailpitServer;
  stop: () => Promise<void>;
}> {
  const container = await new GenericContainer(IMAGE)
    .withExposedPorts(SMTP_PORT, API_PORT)
    .withWaitStrategy(Wait.forHttp('/api/v1/messages', API_PORT))
    .start();
  const host = container.getHost();
  return {
    server: {
      smtpUrl: `smtp://${host}:${String(container.getMappedPort(SMTP_PORT))}`,
      apiUrl: `http://${host}:${String(container.getMappedPort(API_PORT))}`,
    },
    stop: async () => {
      await container.stop();
    },
  };
}

/** A message as Mailpit caught it. */
export interface CaughtMail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface Mailbox {
  /** The messages sent to this address, oldest first. */
  messagesTo(address: string): Promise<CaughtMail[]>;
  /** Deletes every message. */
  clear(): Promise<void>;
}

const address = z.looseObject({ Address: z.string() });
const summaries = z.looseObject({
  messages: z.array(z.looseObject({ ID: z.string(), To: z.array(address) })),
});
const message = z.looseObject({
  ID: z.string(),
  From: address,
  To: z.array(address),
  Subject: z.string(),
  Text: z.string(),
  HTML: z.string(),
});

async function call(server: MailpitApi, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${server.apiUrl}/api/v1${path}`, init);
  if (!response.ok) {
    throw new Error(`Mailpit answered ${String(response.status)} to ${path}.`);
  }
  return response;
}

const json = async (server: MailpitApi, path: string): Promise<unknown> =>
  (await call(server, path)).json();

export function mailbox(server: MailpitApi): Mailbox {
  return {
    async messagesTo(recipient) {
      // Newest first, as Mailpit lists them; a test sends far fewer than this.
      const { messages } = summaries.parse(await json(server, '/messages?limit=500'));
      const wanted = recipient.toLowerCase();
      const ids = messages
        .filter((each) => each.To.some((to) => to.Address.toLowerCase() === wanted))
        .map((each) => each.ID)
        .reverse();
      return Promise.all(
        ids.map(async (id) => {
          const found = message.parse(await json(server, `/message/${id}`));
          return {
            id: found.ID,
            from: found.From.Address,
            to: found.To.map((to) => to.Address),
            subject: found.Subject,
            text: found.Text,
            html: found.HTML,
          };
        }),
      );
    },
    async clear() {
      // With no IDs, every message is deleted. The answer is plain text: "ok".
      await call(server, '/messages', { method: 'DELETE' });
    },
  };
}
