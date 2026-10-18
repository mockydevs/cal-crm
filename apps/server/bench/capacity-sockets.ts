// Actual Socket.IO protocol, not raw WebSocket approximations. Run only against owned
// loopback/staging fixtures; reports deliberately contain no cookies or actor identifiers.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parsePublicId } from '@repo/kernel';
import { io, type Socket } from 'socket.io-client';
import * as z from 'zod';

const cohortSchema = z.strictObject({
  origin: z.url(),
  environment: z.enum(['local', 'isolated-staging']),
  durationMs: z.int().min(1).max(21_600_000),
  warmupMs: z.int().min(0),
  rampMs: z.int().min(0).default(0),
  identities: z
    .array(
      z.strictObject({
        userId: z.string().min(1),
        businessId: z.string().refine((value) => parsePublicId('business', value) !== undefined),
        cookie: z.string().min(1).max(8192),
      }),
    )
    .min(1)
    .max(50_000),
});

export interface SocketCohortResult {
  readonly configuredUsers: number;
  readonly createdUsers: number;
  readonly peakConnected: number;
  readonly minimumConnected: number;
  readonly samples: number;
  readonly connectErrors: number;
  readonly unexpectedDisconnects: number;
  readonly reconnections: number;
  readonly notifications: number;
  readonly wrongBusinessHints: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steadyStartedAt: string;
}

interface HintEvents {
  'business.changed': (value: unknown) => void;
}
const hint = z.strictObject({ businessId: z.string() });

export async function runSocketCohort(
  input: z.input<typeof cohortSchema>,
): Promise<SocketCohortResult> {
  const config = cohortSchema.parse(input);
  const origin = new URL(config.origin);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname);
  if (
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    (config.environment === 'local'
      ? !local || origin.protocol !== 'http:' || config.identities.length > 100
      : origin.protocol !== 'https:')
  )
    throw new Error('Use small loopback tests or explicitly isolated HTTPS staging.');
  if (config.warmupMs + config.rampMs >= config.durationMs)
    throw new Error('There must be a steady observation window.');
  if (
    new Set(config.identities.map((actor) => actor.userId)).size !== config.identities.length ||
    new Set(config.identities.map((actor) => actor.cookie)).size !== config.identities.length
  )
    throw new Error('Supply distinct test users and sessions.');
  const started = Date.now();
  const steady = started + config.rampMs + config.warmupMs;
  const sockets: Socket<HintEvents, Record<string, never>>[] = [];
  let closing = false;
  let connected = 0;
  let peakConnected = 0;
  let minimumConnected = config.identities.length;
  let samples = 0;
  let connectErrors = 0;
  let unexpectedDisconnects = 0;
  let reconnections = 0;
  let notifications = 0;
  let wrongBusinessHints = 0;
  const launch = (actor: z.output<typeof cohortSchema>['identities'][number]): void => {
    if (closing) return;
    const socket: Socket<HintEvents, Record<string, never>> = io(origin.origin, {
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      auth: { businessId: actor.businessId },
      extraHeaders: { origin: origin.origin, cookie: actor.cookie },
    });
    sockets.push(socket);
    let live = false;
    let seen = false;
    socket.on('connect', () => {
      if (seen) reconnections += 1;
      seen = true;
      if (!live) connected += 1;
      live = true;
      peakConnected = Math.max(peakConnected, connected);
    });
    socket.on('connect_error', () => {
      connectErrors += 1;
    });
    socket.on('disconnect', () => {
      if (live) connected -= 1;
      live = false;
      if (!closing) unexpectedDisconnects += 1;
    });
    socket.on('business.changed', (value) => {
      const checked = hint.safeParse(value);
      if (!checked.success || checked.data.businessId !== actor.businessId) wrongBusinessHints += 1;
      else notifications += 1;
    });
    socket.connect();
  };
  const timers = config.identities.map((actor, index) =>
    setTimeout(
      () => {
        launch(actor);
      },
      (config.rampMs * index) / Math.max(1, config.identities.length - 1),
    ),
  );
  const sample = (): void => {
    if (Date.now() < steady) return;
    samples += 1;
    minimumConnected = Math.min(minimumConnected, connected);
  };
  const sampling = setInterval(sample, 20);
  try {
    await delay(config.durationMs);
    sample();
  } finally {
    closing = true;
    clearInterval(sampling);
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.disconnect();
  }
  return {
    configuredUsers: config.identities.length,
    createdUsers: sockets.length,
    peakConnected,
    minimumConnected: samples === 0 ? 0 : minimumConnected,
    samples,
    connectErrors,
    unexpectedDisconnects,
    reconnections,
    notifications,
    wrongBusinessHints,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    steadyStartedAt: new Date(steady).toISOString(),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configFile = process.argv[2];
  const outputFile = process.argv[3];
  if (configFile === undefined || outputFile === undefined)
    throw new Error('Usage: node bench/capacity-sockets.ts fixture.json report.json');
  const input: unknown = JSON.parse(await readFile(configFile, 'utf8'));
  const result = await runSocketCohort(cohortSchema.parse(input));
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (
    result.minimumConnected !== result.configuredUsers ||
    result.connectErrors > 0 ||
    result.unexpectedDisconnects > 0 ||
    result.wrongBusinessHints > 0
  )
    process.exitCode = 1;
}
