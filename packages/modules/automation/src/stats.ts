// How many each automation has enrolled, and how many visits each of its steps has had. The
// numbers are counters the database keeps in the transaction that writes each run and step
// (migration 0055): changes as rows in automation.stat_deltas, folded into
// automation.stat_counts by the worker. Every read here adds the two in one statement,
// which sees both at one moment, so a fold in progress never shows a number twice or not at
// all. A list of fifty automations reads their counters, not their runs.
import {
  automationStats,
  type AutomationRunCounts,
  type AutomationStats,
  type AutomationStepCounts,
} from '@repo/contracts';
import type { Services } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

/** How many runs an automation has started, and how many are still going. */
export interface EnrolledCounts {
  readonly total: number;
  readonly active: number;
}

const NONE: EnrolledCounts = { total: 0, active: 0 };

/**
 * Total and active enrolled for each of these automations, by stored id: one statement over
 * their run counters, whatever number of runs they have had.
 */
export async function readEnrolledCounts(
  trx: DatabaseTransaction,
  automationIds: readonly string[],
): Promise<(automationId: string) => EnrolledCounts> {
  if (automationIds.length === 0) return () => NONE;
  const { rows } = await sql<{ automation_id: string; metric: string; n: string }>`
    select counted.automation_id, counted.metric, sum(counted.n)::text as n
    from (
      select automation_id, metric, n from automation.stat_counts
      where automation_id = any(${[...automationIds]}::uuid[]) and scope = 'run'
        and metric in ('enrolled', 'running', 'waiting')
      union all
      select automation_id, metric, n::bigint from automation.stat_deltas
      where automation_id = any(${[...automationIds]}::uuid[]) and scope = 'run'
        and metric in ('enrolled', 'running', 'waiting')
    ) counted
    group by counted.automation_id, counted.metric
  `.execute(trx);
  const counts = new Map<string, { total: number; active: number }>();
  for (const row of rows) {
    const entry = counts.get(row.automation_id) ?? { total: 0, active: 0 };
    if (row.metric === 'enrolled') entry.total += Number(row.n);
    else entry.active += Number(row.n);
    counts.set(row.automation_id, entry);
  }
  return (automationId) => counts.get(automationId) ?? NONE;
}

// Only the names are read from the live document, so one a later format would refuse
// still lists its steps.
const liveDocument = z.looseObject({
  triggers: z.array(z.looseObject({ id: z.string(), type: z.string() })).catch([]),
  steps: z
    .record(
      z.string(),
      z.looseObject({ type: z.string().optional(), label: z.string().optional() }),
    )
    .catch({}),
});

interface CounterRow {
  readonly version_id: string;
  readonly version: number;
  readonly scope: string;
  readonly key: string;
  readonly metric: string;
  readonly n: string;
  readonly type: string | null;
  readonly label: string | null;
}

type Metrics = Map<string, number>;

const add = (into: Metrics, metric: string, n: number): void => {
  into.set(metric, (into.get(metric) ?? 0) + n);
};
const of = (metrics: Metrics | undefined, metric: string): number => metrics?.get(metric) ?? 0;

const runCounts = (metrics: Metrics | undefined): AutomationRunCounts => ({
  enrolled: of(metrics, 'enrolled'),
  active: of(metrics, 'running') + of(metrics, 'waiting'),
  completed: of(metrics, 'completed'),
  exited: of(metrics, 'exited'),
  failed: of(metrics, 'failed'),
  cancelled: of(metrics, 'cancelled'),
});

// A visit is one row that began it, and may have a second that continued it: a wait for an
// event answered, a webhook's result, a message sent once its window opened. The first row
// of such a visit succeeded as a wait, which is not the visit completing, so each
// continuation takes one success back.
const stepCounts = (metrics: Metrics | undefined): AutomationStepCounts => ({
  entered: of(metrics, 'entered'),
  completed: Math.max(0, of(metrics, 'succeeded') - of(metrics, 'resumed')),
  failed: of(metrics, 'failed'),
  waiting: of(metrics, 'waiting'),
  skipped: of(metrics, 'skipped'),
});

/**
 * An automation's statistics: its runs, each trigger and each step, for the live version
 * and for every version there has been. A step or trigger the live version no longer has
 * keeps its all-time numbers, named as the newest version that had it named it.
 */
export async function readAutomationStats(
  trx: DatabaseTransaction,
  id: string,
): Promise<AutomationStats> {
  const uuid = parsePublicId('automation', id);
  const automation =
    uuid === undefined
      ? undefined
      : await trx
          .selectFrom('automation.automations as automation')
          .leftJoin('automation.versions as live', (join) =>
            join
              .onRef('live.id', '=', 'automation.published_version_id')
              .onRef('live.business_id', '=', 'automation.business_id'),
          )
          .select([
            'automation.id',
            'live.id as live_id',
            'live.version as live_version',
            'live.document as live_document',
          ])
          .where('automation.id', '=', uuid)
          .executeTakeFirst();
  if (automation === undefined) throw new NotFoundError('automation', id);

  // Each counter, with what its own version calls the step or trigger it counts.
  const { rows } = await sql<CounterRow>`
    select summed.version_id, version.version, summed.scope, summed.key, summed.metric,
           summed.n::text as n,
           case summed.scope
             when 'step' then version.document -> 'steps' -> summed.key ->> 'type'
             when 'trigger' then (
               select listed ->> 'type'
               from jsonb_array_elements(version.document -> 'triggers') as listed
               where listed ->> 'id' = summed.key limit 1)
           end as type,
           case summed.scope
             when 'step' then version.document -> 'steps' -> summed.key ->> 'label'
           end as label
    from (
      select counted.version_id, counted.scope, counted.key, counted.metric, sum(counted.n) as n
      from (
        select version_id, scope, key, metric, n from automation.stat_counts
        where automation_id = ${automation.id}
        union all
        select version_id, scope, key, metric, n::bigint from automation.stat_deltas
        where automation_id = ${automation.id}
      ) counted
      group by counted.version_id, counted.scope, counted.key, counted.metric
    ) summed
    join automation.versions version on version.id = summed.version_id
  `.execute(trx);

  interface Counted {
    readonly allTime: Metrics;
    readonly live: Metrics;
    /** The newest version that names it, and what that version calls it. */
    named: { version: number; type: string | null; label: string | null };
  }
  const counted = new Map<string, Counted>();
  const entry = (scope: string, key: string): Counted => {
    const name = `${scope}:${key}`;
    const found = counted.get(name) ?? {
      allTime: new Map<string, number>(),
      live: new Map<string, number>(),
      named: { version: 0, type: null, label: null },
    };
    counted.set(name, found);
    return found;
  };
  for (const row of rows) {
    const found = entry(row.scope, row.key);
    add(found.allTime, row.metric, Number(row.n));
    if (row.version_id === automation.live_id) add(found.live, row.metric, Number(row.n));
    if (row.version > found.named.version)
      found.named = { version: row.version, type: row.type, label: row.label };
  }

  const live =
    automation.live_id === null ? undefined : liveDocument.parse(automation.live_document);
  const liveTriggers = new Map(live?.triggers.map((trigger) => [trigger.id, trigger.type]));
  const liveSteps = new Map(Object.entries(live?.steps ?? {}));
  const keysOf = (scope: string, inLive: Iterable<string>): string[] => {
    const prefix = `${scope}:`;
    const fromCounters = [...counted.keys()]
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length));
    const liveKeys = [...inLive].sort();
    // The live version's own first, then what only earlier versions had.
    return [...liveKeys, ...fromCounters.filter((key) => !liveKeys.includes(key)).sort()];
  };
  const hasLive = live !== undefined;
  const runs = counted.get('run:');

  return automationStats.parse({
    automationId: toPublicId('automation', automation.id),
    liveVersion: automation.live_version,
    runs: { allTime: runCounts(runs?.allTime), live: hasLive ? runCounts(runs?.live) : null },
    triggers: keysOf('trigger', liveTriggers.keys()).map((key) => {
      const found = counted.get(`trigger:${key}`);
      return {
        trigger: key,
        type: liveTriggers.get(key) ?? found?.named.type ?? null,
        inLiveVersion: liveTriggers.has(key),
        allTime: { enrolled: of(found?.allTime, 'enrolled') },
        live: hasLive ? { enrolled: of(found?.live, 'enrolled') } : null,
      };
    }),
    steps: keysOf('step', liveSteps.keys()).map((key) => {
      const found = counted.get(`step:${key}`);
      const inLive = liveSteps.get(key);
      return {
        step: key,
        type: inLive?.type ?? found?.named.type ?? null,
        label: inLive === undefined ? (found?.named.label ?? null) : (inLive.label ?? null),
        inLiveVersion: inLive !== undefined,
        allTime: stepCounts(found?.allTime),
        live: hasLive ? stepCounts(found?.live) : null,
      };
    }),
  });
}

/**
 * Folds what steps and runs have written since the last fold into the counters, for every
 * business (private.compact_automation_stats crosses them). The worker calls it each
 * minute; reading is right whether it has run or not. Gives how many rows it folded.
 */
export async function compactAutomationStats(services: Services, limit = 10_000): Promise<number> {
  const { rows } = await sql<{ folded: number }>`
    select private.compact_automation_stats(${limit}) as folded
  `.execute(services.db);
  return rows[0]?.folded ?? 0;
}
