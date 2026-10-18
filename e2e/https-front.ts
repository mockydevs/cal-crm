// A small HTTPS front for one test server: what Coolify's proxy is to an install. The
// "Inbox day" stack needs it because text messages need a public https address (Twilio
// reports to it, and signs for it), and the browser has to reach the server at that same
// address for its session and its origin to be the install's own.
//
// It ends TLS with a certificate made for this test run and passes every request, and
// every WebSocket, on to the server unchanged. The browser is told to accept the
// certificate (ignoreHTTPSErrors); nothing else ever trusts it.
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import type { SecureContext } from 'node:tls';

export interface HttpsFront {
  /** Such as https://localhost:49200. */
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * Listens on `port` of 127.0.0.1 and forwards to `target`, a port of 127.0.0.1. The
 * identity is one made for "localhost", so that is the name the front is reached by.
 */
export async function startHttpsFront(
  port: number,
  target: number,
  identity: SecureContext,
): Promise<HttpsFront> {
  const server = createServer((request, response) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: target,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  // A WebSocket (the dashboard's live updates): the same request, then bytes both ways.
  const tunnels = new Set<() => void>();
  server.on('upgrade', (request, socket, head) => {
    const upstream = connect(target, '127.0.0.1', () => {
      const headers: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2)
        headers.push(`${request.rawHeaders[index] ?? ''}: ${request.rawHeaders[index + 1] ?? ''}`);
      upstream.write(
        `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`,
      );
      upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const close = (): void => {
      tunnels.delete(close);
      socket.destroy();
      upstream.destroy();
    };
    tunnels.add(close);
    for (const end of [upstream, socket]) {
      end.once('error', close);
      end.once('close', close);
    }
  });
  // The browser names the host it wants (SNI), and gets the test run's certificate for it.
  server.addContext('localhost', identity);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `https://localhost:${String(port)}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        for (const close of tunnels) close();
        server.closeAllConnections();
        server.close((failure) => {
          if (failure === undefined) resolve();
          else reject(failure);
        });
      }),
  };
}
