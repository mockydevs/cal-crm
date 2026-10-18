// A local HTTP server that stands in for a model provider. It never talks to a provider: a
// test tells it what to answer, and it keeps what it was sent. The Claude and OpenAI
// stand-ins (fake-anthropic.ts, fake-openai.ts) are built on it.
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/** What a request is answered with. */
export interface FakeAnswer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Written one piece at a time, each flushed before the next. */
  readonly pieces?: readonly string[];
  /**
   * After the pieces: `end` finishes the answer, `hang` keeps the connection open and
   * silent, `drop` cuts the connection as a crashed server or a lost network would.
   */
  readonly then?: 'end' | 'hang' | 'drop';
}

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** The body as JSON, or undefined when it is not JSON. */
  readonly json: unknown;
}

export interface FakeProvider {
  /** Where it listens, such as http://127.0.0.1:49152. */
  readonly origin: string;
  /** The same as AI_LOCAL_SERVERS would list it: 127.0.0.1:49152. */
  readonly hostPort: string;
  /** Every request so far, oldest first. */
  readonly requests: FakeRequest[];
  /** Answers the next request this way instead of the usual one. Answers queue up. */
  next(answer: FakeAnswer): void;
  stop(): Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error('A request body was not bytes.');
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('A request body was too large for the stand-in.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parse(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

async function send(response: ServerResponse, answer: FakeAnswer): Promise<void> {
  response.writeHead(answer.status, answer.headers);
  // Headers go out even when no piece follows, as a provider that then stalls would send.
  response.flushHeaders();
  for (const piece of answer.pieces ?? []) {
    await new Promise<void>((resolve) =>
      response.write(piece, () => {
        resolve();
      }),
    );
  }
  if (answer.then === 'hang') return;
  if (answer.then === 'drop') response.destroy();
  else response.end();
}

/** Starts a stand-in on a free loopback port. `usual` answers what no test scripted. */
export async function startFakeProvider(
  usual: (request: FakeRequest) => FakeAnswer,
): Promise<FakeProvider> {
  const requests: FakeRequest[] = [];
  const scripted: FakeAnswer[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      const body = await bodyOf(incoming);
      const request: FakeRequest = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        headers: incoming.headers,
        body,
        json: parse(body),
      };
      requests.push(request);
      await send(response, scripted.shift() ?? usual(request));
    })().catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The stand-in has no port.');
  const { port }: AddressInfo = address;
  const hostPort = `127.0.0.1:${String(port)}`;
  return {
    origin: `http://${hostPort}`,
    hostPort,
    requests,
    next: (answer) => {
      scripted.push(answer);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A fixture file's text. */
export function fixture(directory: 'anthropic' | 'openai', name: string): string {
  return readFileSync(new URL(`../src/fixtures/${directory}/${name}`, import.meta.url), 'utf8');
}

/** A JSON answer. */
export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FakeAnswer {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    pieces: [JSON.stringify(body)],
  };
}

/**
 * A fixture stream, one event a piece. `events` cuts it to its first so many events, to be
 * followed by `then`.
 */
export function stream(
  text: string,
  options: { readonly events?: number; readonly then?: FakeAnswer['then'] } = {},
): FakeAnswer {
  const events = text
    .split(/\n\n/)
    .filter((event) => event.trim() !== '')
    .map((event) => `${event}\n\n`);
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    pieces: events.slice(0, options.events ?? events.length),
    ...(options.then === undefined ? {} : { then: options.then }),
  };
}
