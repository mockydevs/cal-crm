import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions, REDACTED } from './logger.js';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return {
    stream,
    lines: () => chunks.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('loggerOptions', () => {
  it('redacts public intake settings both alone and inside the server configuration', () => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions({ logLevel: 'info' }), stream);
    const publicIntake = { secret: 'private-shared-public-intake-key' };
    log.info({ publicIntake, config: { publicIntake, port: 3000 } });
    expect(lines()).toMatchObject([
      {
        publicIntake: { secret: REDACTED },
        config: { publicIntake: { secret: REDACTED }, port: 3000 },
      },
    ]);
    expect(JSON.stringify(lines())).not.toContain('private-shared-public-intake-key');
  });

  it('removes public booking and management capabilities even on unknown paths and queries', () => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions({ logLevel: 'info' }), stream);
    for (const url of [
      '/api/v1/public/appointments/private-capability/unknown?token=secret',
      '/book/appointments/private-capability?token=secret',
      '/api/v1/%70ublic/appointments/private-capability?token=secret',
      '/api/v1/public/appointments/%zz/private-capability',
      'http://crm.example.test/api/v1/public/../private-capability?token=secret',
      'http://crm.example.test/%62ook/appointments/private-capability',
      '/api%2fv1/public/appointments/private-capability',
    ]) {
      log.info({ req: { method: 'GET', url } });
    }
    expect(JSON.stringify(lines())).not.toMatch(/private-capability|token=secret/);
    expect(lines()).toHaveLength(7);
  });
  it('never writes secrets, at the top level or one level down', () => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions({ logLevel: 'info' }), stream);

    log.info(
      {
        password: 'hunter2',
        body: { email: 'dana@example.com', password: 'hunter2', apiKey: 'sk-live-1' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'session=xyz', accept: '*/*' } },
        config: {
          databaseAppUrl: 'postgres://crm_app:secret@db/crm',
          databaseWorkerUrl: 'postgres://crm_worker:secret@db/crm',
          port: 3000,
        },
        files: { linkSecret: 'link-hunter2' },
        storage: { kind: 's3', secretAccessKey: 's3-hunter2' },
      },
      'signed in',
    );

    const [line] = lines();
    expect(line).toMatchObject({
      msg: 'signed in',
      password: REDACTED,
      body: { email: 'dana@example.com', password: REDACTED, apiKey: REDACTED },
      req: { headers: { authorization: REDACTED, cookie: REDACTED, accept: '*/*' } },
      config: { databaseAppUrl: REDACTED, databaseWorkerUrl: REDACTED, port: 3000 },
      files: { linkSecret: REDACTED },
      storage: { kind: 's3', secretAccessKey: REDACTED },
    });
    expect(JSON.stringify(line)).not.toMatch(/hunter2|sk-live|Bearer|session=|secret@/);
  });

  it('logs at the configured level', () => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions({ logLevel: 'warn' }), stream);
    log.info('hidden');
    log.warn('shown');
    expect(lines().map((line) => line['msg'])).toEqual(['shown']);
  });

  it('retains request diagnosis while removing unsubscribe capabilities and queries', () => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions({ logLevel: 'info' }), stream);
    log.info({
      reqId: 'request-1',
      req: {
        method: 'POST',
        url: '/unsubscribe/private-capability?again=1',
        host: 'crm.example.test',
        ip: '127.0.0.1',
        socket: { remotePort: 1000 },
      },
    });
    log.info({ reqId: 'request-2', req: { method: 'GET', url: '/health' } });
    expect(lines()).toMatchObject([
      {
        reqId: 'request-1',
        req: {
          method: 'POST',
          url: '/unsubscribe/[redacted]',
          host: 'crm.example.test',
          remoteAddress: '127.0.0.1',
          remotePort: 1000,
        },
      },
      { reqId: 'request-2', req: { method: 'GET', url: '/health' } },
    ]);
    expect(JSON.stringify(lines())).not.toContain('private-capability');
  });

  it.each([
    '/webhooks/twilio/private-capability/inbound',
    '/webhooks/twilio/private-capability/status?m=private-message',
    '/webhooks/%74wilio/private-capability/unknown',
    'https://crm.example.test/webhooks/twilio/private-capability/../unknown',
  ])('removes SMS webhook capability and query from request logs: %s', (url) => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions({ logLevel: 'info' }), stream);
    log.info({ reqId: 'sms-request', req: { method: 'POST', url } });
    expect(lines()).toMatchObject([
      { reqId: 'sms-request', req: { method: 'POST', url: '/webhooks/twilio/[redacted]' } },
    ]);
    expect(JSON.stringify(lines())).not.toMatch(/private-capability|private-message/);
  });
});
