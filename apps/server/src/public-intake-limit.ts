// The rate limiter for the public booking endpoints. The counting, the limits and the
// windows live in Postgres (migrations 0042 and 0089), so every app instance shares them.
// This file turns a request into the three things the database may know (read or write, a
// keyed digest of the client's address and, when the transport knows which business the
// request is for, a keyed digest of that business) and turns any failure into a refusal.
//
// Three ceilings, each a minute long: one address, one business, the whole install. A
// business at its own ceiling is refused there and adds nothing to the install's count, so
// a flood on one business's form or funnel never uses up what the others share.
import { createHmac, createSecretKey, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import type { Database } from '@repo/db';
import { sql } from 'kysely';
import { createIntakeGate, INTAKE_GATE_FULL, INTAKE_GATE_RETRY_SECONDS } from './intake-gate.js';
import type { PublicBookingRateLimit } from './public-booking.js';

export type PublicIntakeOperation = 'read' | 'write';

/**
 * Why a request was refused. Safe to log or count: it says nothing about the client.
 * `busy`: too many of this instance's limiter calls were unsettled, so the store was not
 * asked; the visitor is told to wait as a full line tells them (intake-gate.ts).
 */
export type PublicIntakeRefusal =
  'client_quota' | 'scope_quota' | 'global_ceiling' | 'storage_full' | 'busy';

/**
 * Asks the shared store to admit one request and returns its one row, unchecked. It gets
 * the digests, never the address and never the business: `scopeDigest` is null for a
 * request that names no business the transport knows. The signal aborts at the deadline: a call that has not
 * reached the store by then must not start. Its promise must settle only when the call
 * has really ended and holds no connection any more: the limiter counts unsettled calls.
 */
export type AdmitPublicIntake = (
  operation: PublicIntakeOperation,
  clientDigest: Buffer,
  signal: AbortSignal,
  scopeDigest: Buffer | null,
) => Promise<unknown>;

export interface PublicIntakeLimitOptions {
  readonly admit: AdmitPublicIntake;
  /**
   * Keys the address digests. At least 32 bytes, the same on every app instance, and
   * supplied by the composition: this file never reads the environment.
   */
  readonly secret: string;
  /** How long one decision may take before the request is refused. Default 1500. */
  readonly timeoutMs?: number;
  /**
   * The most calls to the store that may be unsettled at once, timed-out ones included; a
   * request past that is refused at once. So the limiter never holds more pooled
   * connections than this, however slow the database is. Keep it below the pool's size.
   * Default 8.
   */
  readonly maxInFlight?: number;
  /** Told the reason for each refusal, for a metric or a log line. */
  readonly onRefusal?: (reason: PublicIntakeRefusal) => void;
}

export type PublicIntakeLimitFailure =
  'address_unusable' | 'invalid_decision' | 'timeout' | 'unavailable';

/** Thrown instead of a decision. The transport answers 503 and runs no handler. */
export class PublicIntakeLimitError extends Error {
  readonly code: PublicIntakeLimitFailure;

  constructor(code: PublicIntakeLimitFailure, options?: ErrorOptions) {
    // The message is the code alone: no address, digest, secret or database text.
    super(`The public intake limiter failed: ${code}.`, options);
    this.name = 'PublicIntakeLimitError';
    this.code = code;
  }
}

const MIN_SECRET_BYTES = 32;
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_IN_FLIGHT = 8;
const MAX_IN_FLIGHT = 64;
/** The function's windows are one minute, so no honest retry time is longer. */
const MAX_RETRY_SECONDS = 60;
/** Separates these digests from any other use of the same secret, and from each other. */
const DIGEST_LABEL = 'crm.public-intake.client.v1';
const SCOPE_LABEL = 'crm.public-intake.business.v1';
const REFUSALS: readonly string[] = [
  'client_quota',
  'scope_quota',
  'global_ceiling',
  'storage_full',
];
const BUSINESS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function secretKey(secret: unknown): KeyObject {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES)
    throw new Error(
      `The public intake limiter needs a secret of at least ${String(MIN_SECRET_BYTES)} bytes.`,
    );
  return createSecretKey(Buffer.from(secret, 'utf8'));
}

function ipv6Bytes(address: string): Buffer {
  // A zone (fe80::1%eth0) names the server's interface, not the client.
  let text = address.split('%', 1)[0] ?? '';
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad !== null) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number];
    const tail = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    text = text.slice(0, quad.index) + tail;
  }
  const [head = '', tail] = text.split('::');
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros = new Array<string>(8 - left.length - right.length).fill('0');
  const bytes = Buffer.alloc(16);
  for (const [index, group] of [...left, ...zeros, ...right].entries())
    bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2);
  return bytes;
}

const MAPPED_IPV4_PREFIX = Buffer.from('00000000000000000000ffff', 'hex');

/**
 * What identifies a client: the family and the bytes that are counted together. IPv4 is
 * the whole address. IPv6 is the first 64 bits, because one host or one line controls a
 * whole /64 and could otherwise take a new quota with every address. An IPv4 address
 * written as IPv6 (::ffff:192.0.2.1) is its IPv4 address. Undefined when it is no address.
 */
export function clientKey(address: unknown): Buffer | undefined {
  if (typeof address !== 'string') return undefined;
  const family = isIP(address);
  if (family === 4) return Buffer.from([4, ...address.split('.').map(Number)]);
  if (family !== 6) return undefined;
  const bytes = ipv6Bytes(address);
  if (bytes.subarray(0, 12).equals(MAPPED_IPV4_PREFIX))
    return Buffer.concat([Buffer.from([4]), bytes.subarray(12)]);
  return Buffer.concat([Buffer.from([6]), bytes.subarray(0, 8)]);
}

/** Refuses when the work takes too long, whether or not the work honours the signal. */
async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new PublicIntakeLimitError('timeout'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Started inside a promise, so work that throws at once is a rejection like any other.
    const pending = new Promise<T>((resolve) => {
      resolve(work(controller.signal));
    });
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type Decision = Awaited<ReturnType<PublicBookingRateLimit>>;

/** Trusts nothing about the row: anything but a well-formed decision is a failure. */
function decisionOf(row: unknown): { decision: Decision; refusal?: PublicIntakeRefusal } {
  if (typeof row !== 'object' || row === null) throw new PublicIntakeLimitError('invalid_decision');
  const { allowed, retry_after_seconds: retry, reason } = row as Record<string, unknown>;
  if (allowed === true && reason === 'admitted') return { decision: { allowed: true } };
  if (
    allowed !== false ||
    typeof retry !== 'number' ||
    !Number.isSafeInteger(retry) ||
    retry < 1 ||
    retry > MAX_RETRY_SECONDS ||
    typeof reason !== 'string' ||
    !REFUSALS.includes(reason)
  )
    throw new PublicIntakeLimitError('invalid_decision');
  return {
    decision: { allowed: false, retryAfterSeconds: retry },
    refusal: reason as PublicIntakeRefusal,
  };
}

/**
 * The limiter the public booking transport requires. It never allows by default: a
 * missing or unreadable address, a database error, a slow answer and a malformed answer
 * are all thrown, and the transport refuses the request before any handler runs.
 */
export function createPublicIntakeLimit(options: PublicIntakeLimitOptions): PublicBookingRateLimit {
  const key = secretKey(options.secret);
  const {
    admit,
    onRefusal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
    throw new Error(
      `The public intake limiter's timeout must be 1 to ${String(MAX_TIMEOUT_MS)} milliseconds.`,
    );
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > MAX_IN_FLIGHT)
    throw new Error(
      `The public intake limiter's in-flight limit must be 1 to ${String(MAX_IN_FLIGHT)}.`,
    );
  let inFlight = 0;
  const scoped = createIntakeGate();
  // A call holds its place until the store settles, not until the deadline: a statement
  // that outlives its deadline still holds a connection.
  const counted: AdmitPublicIntake = async (operation, digest, signal, scope) => {
    inFlight += 1;
    try {
      return await admit(operation, digest, signal, scope);
    } finally {
      inFlight -= 1;
    }
  };

  return async (request, operation) => {
    const client = clientKey(request.ipAddress);
    // Not one shared bucket for every such request: that would block or admit them all.
    if (client === undefined) throw new PublicIntakeLimitError('address_unusable');
    const digest = createHmac('sha256', key)
      .update(DIGEST_LABEL)
      .update(Buffer.from([0]))
      .update(client)
      .digest();
    // A business the transport named, by a digest of its own; anything that is not a
    // business's id is not counted as one.
    const scope =
      typeof request.businessId === 'string' && BUSINESS_ID.test(request.businessId)
        ? createHmac('sha256', key)
            .update(SCOPE_LABEL)
            .update(Buffer.from([0]))
            .update(request.businessId)
            .digest()
        : null;

    // A burst, not a failure: the store is not asked, and the visitor's page waits and asks
    // again, as it does for a full line. Never allowed, so it still fails closed.
    let row: unknown;
    try {
      const result = await withDeadline(async (signal) => {
        const ask = async () => {
          // Queued work that outlived its request must never reach the database.
          if (signal.aborted) throw new PublicIntakeLimitError('timeout');
          if (inFlight >= maxInFlight) return { busy: true } as const;
          return { busy: false, row: await counted(operation, digest, signal, scope) } as const;
        };
        // The downstream business gate cannot protect these earlier limiter reads.
        // Hold one store slot per known business, including a timed-out unsettled call.
        // Its bounded FIFO holds no connection; other businesses retain capacity.
        return scope === null ? ask() : scoped(scope.toString('hex'), ask);
      }, timeoutMs);
      if (result === INTAKE_GATE_FULL || result.busy) {
        report(onRefusal, 'busy');
        return { allowed: false, retryAfterSeconds: INTAKE_GATE_RETRY_SECONDS };
      }
      row = result.row;
    } catch (error) {
      if (error instanceof PublicIntakeLimitError) throw error;
      throw new PublicIntakeLimitError('unavailable', { cause: error });
    }
    const { decision, refusal } = decisionOf(row);
    if (refusal !== undefined) report(onRefusal, refusal);
    return decision;
  };
}

function report(
  onRefusal: PublicIntakeLimitOptions['onRefusal'],
  refusal: PublicIntakeRefusal,
): void {
  try {
    onRefusal?.(refusal);
  } catch {
    // Reporting is best effort; the decision stands.
  }
}

/**
 * Asks Postgres, in one statement that commits by itself, as the pool's role (crm_app).
 *
 * A call still waiting for a pooled connection at the deadline never sends its statement.
 * A statement already sent is left to end, and Postgres ends it: the function waits one
 * second at most for a lock, which is less than the limiter's deadline, and does bounded
 * work besides; crm_app's statement_timeout is the last resort. The promise settles when
 * the statement has ended and its connection is back in the pool, which is what the
 * limiter's in-flight count relies on.
 *
 * Kysely 0.29.6 is deliberately not given the signal. Its default, 'ignore query', throws
 * at the abort while the connection stays out until the statement ends, so the count
 * would free a place too early. 'cancel query' opens one more connection for each
 * timed-out statement to send pg_cancel_backend (dialect/postgres/postgres-driver.js,
 * #executeControlQuery), keeps the pooled one until that is done, and reports a failure
 * with console.error; it would gain nothing for lock waits, which end before the deadline.
 */
export function databaseAdmission(db: Database): AdmitPublicIntake {
  return (operation, clientDigest, signal, scopeDigest) =>
    db.connection().execute(async (connection) => {
      if (signal.aborted) throw new PublicIntakeLimitError('timeout');
      const { rows } = await sql<Record<string, unknown>>`
        select allowed, retry_after_seconds, reason
        from private.admit_public_intake(${operation}, ${clientDigest}, ${scopeDigest}::bytea)
      `.execute(connection);
      return rows.length === 1 ? rows[0] : undefined;
    });
}

// Which business a public key belongs to, as a transport learned it: in a file of its own,
// so the booking transport, whose limiter type this file takes, can use it too.
export { createIntakeScopes, type IntakeScopes } from './intake-scopes.js';
