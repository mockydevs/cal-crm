import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { pino } from 'pino';
import { expect, it } from 'vitest';
import { startRealtime } from './realtime.js';

it('stops without waiting for a stalled database authentication handshake', async () => {
  const received = Promise.withResolvers<undefined>();
  const peers = new Set<Socket>();
  // A real transport that accepts startup but never answers, including after FIN.
  const database = createTcpServer({ allowHalfOpen: true }, (socket) => {
    peers.add(socket);
    socket.once('data', () => {
      received.resolve(undefined);
    });
  });
  database.listen(0, '127.0.0.1');
  await once(database, 'listening');
  const address = database.address();
  if (address === null || typeof address === 'string') throw new Error('Missing database port.');
  const realtime = startRealtime({
    httpServer: createHttpServer(),
    databaseUrl: `postgres://test:test@127.0.0.1:${String(address.port)}/test`,
    publicUrl: 'http://crm.test',
    authentication: {
      signedIn: () => Promise.resolve(undefined),
      workplace: () => Promise.reject(new Error('No session.')),
    },
    logger: pino({ level: 'silent' }),
  });
  let closed: Promise<void> | undefined;
  try {
    await received.promise;
    let finished = false;
    closed = realtime.close().then(() => {
      finished = true;
    });
    await expect.poll(() => finished, { timeout: 1000 }).toBe(true);
    await expect(realtime.ready()).rejects.toThrow('Realtime listener unavailable.');
  } finally {
    for (const peer of peers) peer.destroy();
    await (closed ?? realtime.close());
    await new Promise<void>((resolve) => {
      database.close(() => {
        resolve();
      });
    });
  }
});
