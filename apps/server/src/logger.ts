// Logging: pino, as JSON lines on stdout. Fastify's logger is pino too, so the API and the
// worker share these options.
import type { LoggerOptions } from 'pino';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { redactedRequestUrl } from './sensitive-paths.js';

export const REDACTED = '[redacted]';

/**
 * Fields that never reach the logs, wherever they appear at the top level or one level
 * down (pino's wildcard matches a single level).
 */
const secretFields = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'clientSecret',
  'connectionString',
  'databaseAppUrl',
  'databaseWorkerUrl',
  'databaseUrl',
  'smtpUrl',
  'secretAccessKey',
  'linkSecret',
  'authorization',
  'cookie',
];

export function loggerOptions(config: Pick<Config, 'logLevel'>): LoggerOptions {
  return {
    level: config.logLevel,
    serializers: {
      req(request: Partial<FastifyRequest>) {
        // Callers also log already-serialized objects containing headers alone.
        if (request.url === undefined) return request;
        return {
          method: request.method,
          url: redactedRequestUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
    redact: {
      paths: [
        ...secretFields,
        ...secretFields.map((field) => `*.${field}`),
        '*.publicIntake.secret',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      censor: REDACTED,
    },
  };
}
