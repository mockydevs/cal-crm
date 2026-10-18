// "Test" in Settings → AI models. The app cannot open a key, so a test is a row it writes
// and a job the worker runs:
//
//   * in a business, the worker asks the connection's model for one short answer through
//     the gateway. The call is admitted under the business's limit and is in ai.requests
//     with its cost, like any call;
//   * at the agency there is no account to put a call on, so the worker only asks the
//     provider which models the key can use. That calls no model and costs nothing.
//
// Either way the test ends with how long the provider took and one outcome, and the
// connection keeps what the last test that reached its provider found.
import {
  defineCommand,
  defineTask,
  type Command,
  type CommandContext,
  type Task,
  type TaskReference,
} from '@repo/commands';
import {
  aiConnectionTestJob,
  startAiConnectionTestInput,
  type AiConnectionTest,
  type AiTestOutcome,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';

import { visibleConnection } from './connection-rows.js';
import type {
  AiGateway,
  ConnectionProblem,
  ConnectionTestResult,
  KeyCheckResult,
} from './gateway.js';

export const testAiConnectionReference = {
  name: 'ai.test_connection',
  data: aiConnectionTestJob,
} satisfies TaskReference<typeof aiConnectionTestJob>;

const DAY_MS = 86_400_000;
/** How long a worker has to run a test before it is shown as expired. */
export const TEST_WINDOW_MS = 120_000;

const columns = [
  'id',
  'business_id',
  'connection_id',
  'status',
  'outcome',
  'latency_ms',
  'request_id',
  'created_at',
  'expires_at',
  'finished_at',
] as const;

interface TestRow {
  readonly id: string;
  readonly business_id: string | null;
  readonly connection_id: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly latency_ms: number | null;
  readonly request_id: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly finished_at: Date | null;
}

/** The tests asked for where the request works: a business's, or the agency's own. */
function mine(trx: DatabaseTransaction, context: TenantContext) {
  const { businessId } = context;
  return trx
    .selectFrom('ai.connection_tests')
    .select(columns)
    .where('agency_id', '=', context.agencyId)
    .where((eb) =>
      businessId === undefined ? eb('business_id', 'is', null) : eb('business_id', '=', businessId),
    );
}

function asTest(row: TestRow, costEstimate: string | null, at: Date): AiConnectionTest {
  // A test nobody ran in its two minutes: no worker took the job.
  const expired = row.status === 'pending' && row.expires_at.getTime() <= at.getTime();
  const finished = row.status === 'finished';
  return {
    id: toPublicId('ai_connection_test', row.id),
    connectionId: toPublicId('ai_connection', row.connection_id),
    kind: row.business_id === null ? 'key_check' : 'model_call',
    status: finished || expired ? 'finished' : 'pending',
    // The column's check keeps it to the outcomes the contract lists.
    outcome: expired ? 'expired' : (row.outcome as AiTestOutcome | null),
    latencyMs: row.latency_ms,
    call:
      row.request_id === null
        ? null
        : { id: toPublicId('ai_request', row.request_id), costEstimate },
    createdAt: row.created_at.toISOString(),
    finishedAt: expired ? row.expires_at.toISOString() : (row.finished_at?.toISOString() ?? null),
  };
}

async function costOf(trx: DatabaseTransaction, row: TestRow): Promise<string | null> {
  if (row.request_id === null || row.business_id === null) return null;
  const call = await trx
    .selectFrom('ai.requests')
    .select('cost_estimate')
    .where('business_id', '=', row.business_id)
    .where('id', '=', row.request_id)
    .executeTakeFirst();
  return call?.cost_estimate ?? null;
}

export async function readAiConnectionTest(
  trx: DatabaseTransaction,
  context: TenantContext,
  publicId: string,
  now: () => Date,
): Promise<AiConnectionTest> {
  const id = parsePublicId('ai_connection_test', publicId);
  const row =
    id === undefined ? undefined : await mine(trx, context).where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('AI connection test', publicId);
  return asTest(row, await costOf(trx, row), now());
}

/**
 * Queues a test of a connection, in the command's transaction. A test of the same
 * connection that is still waiting is given back instead: pressing "Test" twice asks the
 * provider once.
 */
export async function startTest(
  trx: DatabaseTransaction,
  command: CommandContext,
  connectionId: string,
  now: () => Date,
): Promise<AiConnectionTest> {
  const { context } = command;
  const at = now();
  const waiting = await mine(trx, context)
    .where('connection_id', '=', connectionId)
    .where('status', '=', 'pending')
    .where('expires_at', '>', at)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (waiting !== undefined) return asTest(waiting, null, at);
  // Yesterday's tests of this connection have been read by whoever asked for them.
  await trx
    .deleteFrom('ai.connection_tests')
    .where('agency_id', '=', context.agencyId)
    .where('connection_id', '=', connectionId)
    .where((eb) =>
      context.businessId === undefined
        ? eb('business_id', 'is', null)
        : eb('business_id', '=', context.businessId),
    )
    .where('created_at', '<', new Date(at.getTime() - DAY_MS))
    .execute();
  const row = await trx
    .insertInto('ai.connection_tests')
    .values({
      agency_id: context.agencyId,
      business_id: context.businessId ?? null,
      connection_id: connectionId,
      requested_by_id: context.userId ?? null,
      created_at: at,
      expires_at: new Date(at.getTime() + TEST_WINDOW_MS),
    })
    .returning(columns)
    .executeTakeFirstOrThrow();
  command.enqueue(testAiConnectionReference, { testId: row.id });
  return asTest(row, null, at);
}

/** Tests a connection the request may use: its own, or in a business its agency's. */
export function createStartTestCommand(
  now: () => Date,
): Command<typeof startAiConnectionTestInput, AiConnectionTest> {
  return defineCommand({
    name: 'ai.test_connection',
    permission: 'ai.manage',
    input: startAiConnectionTestInput,
    async handle(trx, { connectionId }, command): Promise<AiConnectionTest> {
      const connection = await visibleConnection(trx, command.context, connectionId);
      return startTest(trx, command, connection.id, now);
    },
  });
}

const PROBLEMS: Readonly<Record<ConnectionProblem, AiTestOutcome>> = {
  // The connection went while its test waited; the test's row went with it.
  no_connection: 'key_unreadable',
  key_unreadable: 'key_unreadable',
  provider_not_supported: 'not_supported',
  no_model: 'no_model',
};

interface Finding {
  readonly outcome: AiTestOutcome;
  readonly latencyMs: number | null;
  readonly requestId: string | null;
  /** Whether this says something of the connection itself, for its row to keep. */
  readonly ofConnection: boolean;
}

function found(result: ConnectionTestResult | KeyCheckResult): Finding {
  switch (result.outcome) {
    case 'ok':
      return {
        outcome: 'ok',
        latencyMs: result.latencyMs,
        requestId: 'requestId' in result ? result.requestId : null,
        ofConnection: true,
      };
    case 'failed':
      return {
        outcome: result.code,
        latencyMs: result.latencyMs,
        requestId: 'requestId' in result ? result.requestId : null,
        ofConnection: true,
      };
    case 'not_configured':
      return {
        outcome: PROBLEMS[result.reason],
        latencyMs: null,
        requestId: null,
        ofConnection: result.reason === 'key_unreadable',
      };
    // The business's own settings stopped the call: that says nothing of the key.
    case 'paused':
      return { outcome: result.reason, latencyMs: null, requestId: null, ofConnection: false };
    case 'off':
      return { outcome: 'ai_off', latencyMs: null, requestId: null, ofConnection: false };
  }
}

/**
 * Runs a queued test. Only the worker has a gateway that can open a key. The one request
 * to the provider is made outside any database transaction.
 */
export function createTestAiConnectionTask(
  gateway: Pick<AiGateway, 'testConnection' | 'checkConnection'>,
  now: () => Date = () => new Date(),
): Task<typeof testAiConnectionReference.data> {
  return defineTask({
    ...testAiConnectionReference,
    async run({ testId }, { invocation, services }) {
      const { context } = invocation;
      const { businessId } = context;
      const pending = (trx: DatabaseTransaction) =>
        mine(trx, context).where('id', '=', testId).forUpdate().executeTakeFirst();
      const end = (trx: DatabaseTransaction, finding: Finding, at: Date) =>
        trx
          .updateTable('ai.connection_tests')
          .set({
            status: 'finished',
            outcome: finding.outcome,
            latency_ms: finding.latencyMs,
            request_id: finding.requestId,
            finished_at: at,
          })
          .where('id', '=', testId)
          .where('status', '=', 'pending')
          .execute();

      const connectionId = await withTenant(services.db, context, async (trx) => {
        const row = await pending(trx);
        if (row?.status !== 'pending') return undefined;
        const at = now();
        if (row.expires_at.getTime() <= at.getTime()) {
          // Too late to be of use to whoever asked: nothing is sent.
          await end(
            trx,
            { outcome: 'expired', latencyMs: null, requestId: null, ofConnection: false },
            at,
          );
          return undefined;
        }
        return row.connection_id;
      });
      if (connectionId === undefined) return;

      const finding = found(
        businessId === undefined
          ? await gateway.checkConnection(context, connectionId)
          : await gateway.testConnection(context, connectionId),
      );

      await withTenant(services.db, context, async (trx) => {
        const row = await pending(trx);
        if (row?.status !== 'pending') return;
        const at = now();
        await end(trx, finding, at);
        if (finding.ofConnection)
          await trx
            .updateTable('ai.provider_keys')
            .set({
              status: finding.outcome === 'ok' ? 'working' : 'failing',
              last_tested_at: at,
              last_test_latency_ms: finding.latencyMs,
              last_test_outcome: finding.outcome,
            })
            .where('agency_id', '=', context.agencyId)
            .where('id', '=', connectionId)
            .execute();
        // Settings in an open tab reads the result again. No row data is sent.
        if (businessId !== undefined)
          await trx
            .selectNoFrom((eb) =>
              eb
                .fn<null>('pg_notify', [eb.val('crm_business_changed'), eb.val(businessId)])
                .as('notified'),
            )
            .execute();
      });
    },
  });
}
