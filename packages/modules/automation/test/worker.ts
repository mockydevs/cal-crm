// A worker for integration tests: it takes the engine's queued jobs from graphile_worker in
// the order the real worker would (lowest priority first, then the earliest run_at:
// graphile-worker 0.18's getJobs), one at a time, and runs each with its own envelope's
// business and correlation, as apps/server's worker does. So loops, re-entry, fan-out and
// fairness between businesses behave here as they do in production.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import { withTenant } from '@repo/db';
import { readRecordField, setRecordFieldCommand } from '@repo/module-crm';
import { toPublicId } from '@repo/kernel';

import { matchEventCommand, startAgainCommand } from '../src/index.js';
import { runStepCommand, type Harness, type Tenant } from './workflows.js';

export const as = (
  tenant: Tenant,
  correlationId: string = randomUUID(),
): { context: Tenant & { correlationId: string }; permissions: 'all' } => ({
  context: { ...tenant, correlationId },
  permissions: 'all' as const,
});

/** A custom contact field of the business, by key, as the id the API shows. */
export async function contactField(
  h: Harness,
  tenant: Tenant,
  key: string,
  type: 'number' | 'date' | 'text',
): Promise<string> {
  const { id } = await h.database.withTenant(tenant, (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), id, $1::text, $1::text, 'test', $2::text, 'system'
       from crm.object_types where kind = 'contact'
       returning id`,
      [key, type],
    ),
  );
  return toPublicId('field', id);
}

/** Sets a contact's field as a person does: its own request, its own correlation. */
export async function setField(
  h: Harness,
  tenant: Tenant,
  contact: string,
  fieldId: string,
  value: unknown,
): Promise<void> {
  const current = await withTenant(h.db, tenant, (trx) =>
    readRecordField(trx, as(tenant), contact, fieldId),
  );
  await runCommand(
    h.services,
    setRecordFieldCommand,
    { id: contact, fieldId, value: value as never, revision: current.revision },
    as(tenant),
  );
}

export async function fieldValue(
  h: Harness,
  tenant: Tenant,
  contact: string,
  fieldId: string,
): Promise<unknown> {
  const current = await withTenant(h.db, tenant, (trx) =>
    readRecordField(trx, as(tenant), contact, fieldId),
  );
  return (current as { value: unknown }).value;
}

export interface QueuedJob {
  readonly id: string;
  readonly task_identifier: string;
  readonly priority: number;
  readonly payload: {
    readonly businessId: string;
    readonly correlationId: string;
    readonly data: Readonly<Record<string, unknown>>;
  };
  readonly run_at: Date;
  readonly key: string | null;
}

/** The jobs waiting, due by `until` when given, in the order the worker takes them. */
export const queued = (h: Harness, until?: Date): Promise<QueuedJob[]> =>
  h.database.as('postgres', (sql) =>
    sql.query<QueuedJob>(
      `select j.id::text, t.identifier as task_identifier, j.priority, j.payload, j.run_at, j.key
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
       where j.locked_at is null ${until === undefined ? '' : 'and j.run_at <= $1'}
       order by j.priority, j.run_at, j.id`,
      until === undefined ? [] : [until],
    ),
  );

/**
 * Runs the engine's due jobs one at a time until none is left or `max` have run, and says
 * how many of each task ran. Other tasks' jobs are taken and dropped. `tenants` maps a
 * business id to its tenant.
 */
export async function drain(
  h: Harness,
  tenants: readonly Tenant[],
  options: { readonly now?: Date; readonly max?: number } = {},
): Promise<Record<string, number>> {
  const byBusiness = new Map(tenants.map((tenant) => [tenant.businessId, tenant]));
  const counts: Record<string, number> = {};
  for (let ran = 0; ran < (options.max ?? 500); ran += 1) {
    const now = options.now ?? new Date(Date.now() + 2000);
    const [job] = await queued(h, now);
    if (job === undefined) break;
    counts[job.task_identifier] = (counts[job.task_identifier] ?? 0) + 1;
    await h.database.as('postgres', (sql) =>
      sql.query('select graphile_worker.complete_jobs(array[$1]::bigint[])', [job.id]),
    );
    const tenant = byBusiness.get(job.payload.businessId);
    if (tenant === undefined) continue;
    const invocation = as(tenant, job.payload.correlationId);
    const data = job.payload.data;
    if (job.task_identifier === 'automations.match_event')
      await runCommand(
        h.services,
        matchEventCommand,
        { eventId: data['eventId'] as string },
        invocation,
      );
    else if (job.task_identifier === 'automations.run_step')
      await runCommand(
        h.services,
        runStepCommand,
        {
          enrolmentId: data['enrolmentId'] as string,
          sequence: data['sequence'] as number,
          now: now.toISOString(),
        },
        invocation,
      );
    else if (job.task_identifier === 'automations.start_again')
      await runCommand(h.services, startAgainCommand, data, invocation);
  }
  return counts;
}

/** Removes every job waiting, so a test starts from an empty queue. */
export const clearQueue = async (h: Harness): Promise<void> => {
  await h.database.as('postgres', (sql) => sql.query('delete from graphile_worker._private_jobs'));
};

export interface RunRow {
  id: string;
  status: string;
  exit_reason: string | null;
  current_step: string | null;
  wake_at: Date | null;
  correlation_id: string;
}

export const runsOf = (h: Harness, tenant: Tenant, automationId: string): Promise<RunRow[]> =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<RunRow>(
      `select id, status, exit_reason, current_step, wake_at, correlation_id
       from automation.enrolments where automation_id = $1 order by started_at, id`,
      [automationId],
    ),
  );

export const evaluationsOf = (
  h: Harness,
  tenant: Tenant,
  automationId: string,
): Promise<{ reason: string; detail: Record<string, unknown> }[]> =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ reason: string; detail: Record<string, unknown> }>(
      `select reason, detail from automation.trigger_evaluations
       where automation_id = $1 order by evaluated_at, id`,
      [automationId],
    ),
  );
