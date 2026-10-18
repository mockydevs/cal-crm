// The one way out to a model provider, over real sockets to servers this file starts on
// loopback. Nothing here reaches a real provider.
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { parseLocalServers } from './addresses.js';
import { AiTransportError, createAiTransport, readBody, type AiHttpAnswer } from './transport.js';

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function listen(handler: Handler): Promise<{ origin: string; hostPort: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      handler(request, response, Buffer.concat(chunks).toString('utf8'));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, hostPort: `127.0.0.1:${String(port)}` };
}

const transportTo = (hostPort: string, maxResponseBytes?: number) =>
  createAiTransport({
    localServers: parseLocalServers(hostPort),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to fail.');
}

describe('a call to a listed model server', () => {
  it('sends nothing when the request was already cancelled', async () => {
    let calls = 0;
    const fake = await listen((_request, response) => {
      calls += 1;
      response.end('{}');
    });
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      transportTo(fake.hostPort)({
        method: 'POST',
        url: `${fake.origin}/v1/messages`,
        headers: {},
        timeoutMs: 5000,
        signal: controller.signal,
      }),
    );
    expect(error).toMatchObject({ code: 'cancelled' });
    expect(calls).toBe(0);
  });

  it('cancels a stalled response stream without waiting for its deadline', async () => {
    const controller = new AbortController();
    const fake = await listen((_request, response) => {
      response.writeHead(200);
      response.write('partial');
    });
    const answer = await transportTo(fake.hostPort)({
      method: 'POST',
      url: `${fake.origin}/v1/messages`,
      headers: {},
      timeoutMs: 5000,
      signal: controller.signal,
    });
    controller.abort();
    expect(await failure(readBody(answer, 1024))).toMatchObject({ code: 'cancelled' });
  });
  it('sends the request as given and hands back the status, headers and body', async () => {
    const seen: {
      method?: string;
      url?: string;
      headers?: IncomingMessage['headers'];
      body?: string;
    } = {};
    const fake = await listen((request, response, body) => {
      Object.assign(seen, {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      response.writeHead(201, { 'content-type': 'application/json', 'Retry-After': '7' });
      response.write('{"ok":');
      response.end('true}');
    });
    const answer = await transportTo(fake.hostPort)({
      method: 'POST',
      url: `${fake.origin}/v1/chat/completions?beta=1`,
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: '{"café":1}',
      timeoutMs: 5000,
    });
    expect(answer.status).toBe(201);
    expect(answer.header('retry-after')).toBe('7');
    expect(answer.header('Content-Type')).toBe('application/json');
    expect(answer.header('x-missing')).toBeUndefined();
    expect(await readBody(answer, 1024)).toBe('{"ok":true}');
    expect(seen).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions?beta=1',
      body: '{"café":1}',
    });
    expect(seen.headers).toMatchObject({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
      'content-length': '11',
    });
  });

  it('sends a GET with no body, and never follows a redirect', async () => {
    let requests = 0;
    const fake = await listen((request, response) => {
      requests += 1;
      expect(request.method).toBe('GET');
      expect(request.headers['content-length']).toBeUndefined();
      response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
      response.end();
    });
    const answer = await transportTo(fake.hostPort)({
      method: 'GET',
      url: `${fake.origin}/v1/models`,
      headers: {},
      timeoutMs: 5000,
    });
    expect(answer.status).toBe(302);
    expect(await readBody(answer, 1024)).toBe('');
    expect(requests).toBe(1);
  });

  it('gives up at the deadline, before an answer and in the middle of one', async () => {
    const silent = await listen(() => undefined);
    const waiting = await failure(
      transportTo(silent.hostPort)({
        method: 'POST',
        url: `${silent.origin}/v1/messages`,
        headers: {},
        body: '{}',
        timeoutMs: 80,
      }),
    );
    expect(waiting).toBeInstanceOf(AiTransportError);
    expect(waiting).toMatchObject({ code: 'timeout' });

    const stalled = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
    });
    const answer = await transportTo(stalled.hostPort)({
      method: 'POST',
      url: `${stalled.origin}/v1/messages`,
      headers: {},
      body: '{}',
      timeoutMs: 150,
    });
    expect(answer.status).toBe(200);
    expect(await failure(readBody(answer, 1024))).toMatchObject({ code: 'timeout' });
  });

  it('reports a server that hangs up mid-answer, or is not there at all', async () => {
    const dropping = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n', () => {
        response.destroy();
      });
    });
    const answer = await transportTo(dropping.hostPort)({
      method: 'POST',
      url: `${dropping.origin}/v1/messages`,
      headers: {},
      body: '{}',
      timeoutMs: 5000,
    });
    expect(await failure(readBody(answer, 1024))).toMatchObject({ code: 'network' });

    const gone = await listen(() => undefined);
    const [server] = servers.splice(-1);
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
    expect(
      await failure(
        transportTo(gone.hostPort)({
          method: 'GET',
          url: `${gone.origin}/v1/models`,
          headers: {},
          timeoutMs: 5000,
        }),
      ),
    ).toMatchObject({ code: 'network' });
  });

  it('stops reading an answer that is larger than it may be', async () => {
    const fake = await listen((_request, response) => {
      response.writeHead(200);
      response.end('x'.repeat(5000));
    });
    const transport = transportTo(fake.hostPort, 1000);
    const call = {
      method: 'GET',
      url: `${fake.origin}/big`,
      headers: {},
      timeoutMs: 5000,
    } as const;
    expect(await failure(readBody(await transport(call), 1_000_000))).toMatchObject({
      code: 'too_large',
    });
    // The reader's own limit holds too.
    expect(await failure(readBody(await transportTo(fake.hostPort)(call), 100))).toMatchObject({
      code: 'too_large',
    });
  });

  it('lets go of the connection when the caller is done with it', async () => {
    let closed: (() => void) | undefined;
    const hungUp = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const fake = await listen((request, response) => {
      request.socket.on('close', () => closed?.());
      response.writeHead(200);
      response.write('data: first\n\n');
    });
    const answer: AiHttpAnswer = await transportTo(fake.hostPort)({
      method: 'POST',
      url: `${fake.origin}/v1/messages`,
      headers: {},
      body: '{}',
      timeoutMs: 60_000,
    });
    answer.close();
    answer.close();
    await hungUp;
  });
});

describe('where a call may go', () => {
  it('refuses, without connecting, an address that is not allowed', async () => {
    let connections = 0;
    const transport = createAiTransport({
      localServers: parseLocalServers('ollama:11434'),
      lookup: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
      requester: () => {
        connections += 1;
        throw new Error('must not connect');
      },
    });
    for (const url of [
      'http://127.0.0.1:11434/v1/models',
      'http://ollama:11435/v1/models',
      'https://api.example.com:8443/v1/models',
      'https://user:pass@api.example.com/v1/models',
      'not a url',
      // A public-looking name that resolves to a private address.
      'https://api.example.com/v1/models',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      const error = await failure(transport({ method: 'GET', url, headers: {}, timeoutMs: 5000 }));
      expect(error).toBeInstanceOf(AiTransportError);
      expect(error).toMatchObject({ code: 'blocked_address' });
      // Neither the address nor anything in it is repeated.
      expect((error as Error).message).toBe(
        'The model provider could not be reached (blocked_address).',
      );
    }
    expect(connections).toBe(0);
  });

  it('connects a public https address to the address it checked, and to no other', async () => {
    const fake = await listen((_request, response) => {
      response.writeHead(200);
      response.end('reached');
    });
    const port = Number(fake.hostPort.split(':')[1]);
    const asked: string[] = [];
    const seen: { options?: RequestOptions; secure?: boolean } = {};
    const transport = createAiTransport({
      lookup: (hostname) => {
        asked.push(hostname);
        return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
      },
      // Stands in for node:https: the call is made to the local server instead.
      requester: (options, secure) => {
        Object.assign(seen, { options, secure });
        const { lookup: _lookup, ...rest } = options;
        return httpRequest({ ...rest, host: '127.0.0.1', port });
      },
    });
    const answer = await transport({
      method: 'GET',
      url: 'https://api.example.com/v1/models?limit=5',
      headers: { 'x-api-key': 'test-key' },
      timeoutMs: 5000,
    });
    expect(await readBody(answer, 100)).toBe('reached');
    expect(asked).toEqual(['api.example.com']);
    expect(seen.secure).toBe(true);
    expect(seen.options).toMatchObject({
      method: 'GET',
      host: 'api.example.com',
      port: 443,
      path: '/v1/models?limit=5',
      // A fresh connection every time: a pooled socket would skip the pinned lookup.
      agent: false,
    });
    // Whatever name the socket asks about, it is given the address that was checked.
    const pinned = seen.options?.lookup;
    const one = await new Promise((resolve) => {
      pinned?.('other.example.com', {}, (_error, address, family) => {
        resolve([address, family]);
      });
    });
    expect(one).toEqual(['93.184.216.34', 4]);
    const all = await new Promise((resolve) => {
      pinned?.('other.example.com', { all: true }, (_error, addresses) => {
        resolve(addresses);
      });
    });
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('reports a name with no address, and a requester that cannot start', async () => {
    const nowhere = createAiTransport({ lookup: () => Promise.reject(new Error('ENOTFOUND')) });
    expect(
      await failure(
        nowhere({
          method: 'GET',
          url: 'https://api.example.com/v1/models',
          headers: {},
          timeoutMs: 500,
        }),
      ),
    ).toMatchObject({ code: 'network' });
    const broken = createAiTransport({
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      requester: () => {
        throw new Error('no sockets left');
      },
    });
    expect(
      await failure(
        broken({
          method: 'GET',
          url: 'https://api.example.com/v1/models',
          headers: {},
          timeoutMs: 500,
        }),
      ),
    ).toMatchObject({ code: 'network' });
  });

  it('counts a slow DNS answer against the deadline, and sends nothing after it', async () => {
    let connections = 0;
    const transport = createAiTransport({
      lookup: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve([{ address: '93.184.216.34', family: 4 }]);
          }, 200);
        }),
      requester: () => {
        connections += 1;
        throw new Error('must not connect');
      },
    });
    expect(
      await failure(
        transport({
          method: 'GET',
          url: 'https://api.example.com/v1/models',
          headers: {},
          timeoutMs: 40,
        }),
      ),
    ).toMatchObject({ code: 'timeout' });
    expect(connections).toBe(0);
  });

  it('refuses a deadline that is not a sensible number', async () => {
    const transport = createAiTransport();
    for (const timeoutMs of [0, -5, 1.5, Number.NaN, 3_600_001]) {
      await expect(
        transport({ method: 'GET', url: 'https://api.example.com/', headers: {}, timeoutMs }),
      ).rejects.toThrow(RangeError);
    }
  });
});
