import { createServer } from 'node:http';
import { once } from 'node:events';
import { toPublicId } from '@repo/kernel';
import { Server } from 'socket.io';
import { expect, it } from 'vitest';
import { runSocketCohort } from './capacity-sockets.js';

const businessId = toPublicId('business', '01890a5d-ac96-774b-bcce-b302099a8051');

it('uses native cookie, origin and business authentication and observes live Socket.IO connections', async () => {
  const http = createServer();
  const io = new Server(http, { transports: ['websocket'] });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback port.');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const cookies: string[] = [];
  io.on('connection', (socket) => {
    cookies.push(socket.handshake.headers.cookie ?? '');
    expect(socket.handshake.headers.origin).toBe(origin);
    expect(socket.handshake.auth['businessId']).toBe(businessId);
    socket.emit('business.changed', { businessId });
  });
  try {
    const result = await runSocketCohort({
      origin,
      environment: 'local',
      durationMs: 150,
      warmupMs: 50,
      identities: [
        { userId: 'one', businessId, cookie: 'fixture=one' },
        { userId: 'two', businessId, cookie: 'fixture=two' },
      ],
    });
    expect(cookies.toSorted()).toEqual(['fixture=one', 'fixture=two']);
    expect(result).toMatchObject({
      configuredUsers: 2,
      peakConnected: 2,
      minimumConnected: 2,
      connectErrors: 0,
      notifications: 2,
      wrongBusinessHints: 0,
    });
    expect(JSON.stringify(result)).not.toContain('fixture=');
  } finally {
    await io.close();
  }
});

it('refuses remote local targets, duplicate sessions and invalid sample windows before connecting', async () => {
  const valid = {
    origin: 'http://127.0.0.1:3000',
    environment: 'local' as const,
    durationMs: 150,
    warmupMs: 50,
    identities: [{ userId: 'one', businessId, cookie: 'fixture=one' }],
  };
  await expect(runSocketCohort({ ...valid, origin: 'https://crm.example.test' })).rejects.toThrow();
  await expect(
    runSocketCohort({ ...valid, identities: [...valid.identities, ...valid.identities] }),
  ).rejects.toThrow();
  await expect(runSocketCohort({ ...valid, warmupMs: 200 })).rejects.toThrow();
});
