// Steps that start and end other runs of the enrolled record: automation.run enrols the
// record in another automation by the rules every enrolment keeps, and automation.remove
// ends the runs the record is in. Both run inside the step's transaction, with the record's
// runs held still (lockRecordRuns, taken by the runner before the step's own row).
import { requireBusiness, type CommandContext } from '@repo/commands';
import { automationDocument, type AutomationStep } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';

import { chainOf, chainRefusal } from './chain.js';
import { enrol } from './enrolment.js';
import { exitRuns } from './settle.js';

type RunStep = Extract<AutomationStep, { type: 'automation.run' }>;
type RemoveStep = Extract<AutomationStep, { type: 'automation.remove' }>;

/** What a step leaves for later steps, and what it says it did. */
interface Done {
  readonly output: Readonly<Record<string, unknown>>;
  readonly explanation: string;
}

/** The step a run is at, for the record it is on. */
export interface StepOfRun {
  readonly enrolmentId: string;
  readonly stepKey: string;
  readonly recordId: string;
}

// A published document names automations by id (the validator resolved the names). What
// is not an id here names nothing that can be found.
function automationIdOf(reference: string, path: string): string {
  const id = parsePublicId('automation', reference);
  if (id === undefined) throw unknownAutomation(reference, path);
  return id;
}

const unknownAutomation = (reference: string, path: string) =>
  new ValidationError([
    { path, code: 'unknown_reference', message: `There's no automation "${reference}".` },
  ]);

const NOT_ACTIVE: Readonly<Record<string, string>> = {
  draft: 'is not published',
  paused: 'is paused',
  archived: 'was deleted',
};

/**
 * Starts another automation for the step's record: the same enrolment an event makes, on
 * the version published now, caused by the event that began the parent. The parent goes on
 * whatever comes of it; only an automation that can't be found refuses the step.
 */
export async function startAutomation(
  trx: DatabaseTransaction,
  command: CommandContext,
  at: StepOfRun,
  config: RunStep['config'],
): Promise<Done> {
  const businessId = requireBusiness(command.context);
  const targetId = automationIdOf(config.automation, '/config/automation');
  const target = await trx
    .selectFrom('automation.automations as automation')
    .leftJoin('automation.versions as version', (join) =>
      join
        .onRef('version.id', '=', 'automation.published_version_id')
        .onRef('version.business_id', '=', 'automation.business_id'),
    )
    .select([
      'automation.id',
      'automation.name',
      'automation.status',
      'version.id as version_id',
      'version.document',
    ])
    .where('automation.id', '=', targetId)
    .where('automation.business_id', '=', businessId)
    .executeTakeFirst();
  // Another business's automation, or one purged since: there is nothing to start.
  if (target === undefined) throw unknownAutomation(config.automation, '/config/automation');
  if (target.status !== 'active' || target.version_id === null)
    return {
      output: { outcome: 'not_active' },
      explanation: `"${target.name}" ${NOT_ACTIVE[target.status] ?? 'is not active'}, so nothing was started.`,
    };
  // The runner holds the parent's row, so what is read of it here is what it is.
  const parent = await trx
    .selectFrom('automation.enrolments')
    .select(['automation_id', 'state', 'trigger_event_id', 'correlation_id'])
    .where('id', '=', at.enrolmentId)
    .where('record_id', '=', at.recordId)
    .executeTakeFirstOrThrow();
  // Who led here is settled before any other run is looked at or locked.
  const chain = [...chainOf(parent.state), parent.automation_id];
  const refusal = chainRefusal(chain, target.id);
  if (refusal === 'loop')
    return {
      output: { outcome: 'refused_loop' },
      explanation: `Starting "${target.name}" would loop back to an automation that led here, so it was refused.`,
    };
  if (refusal === 'too_long')
    return {
      output: { outcome: 'refused_loop' },
      explanation: `Ten automations in a row have started one another, so "${target.name}" was not started.`,
    };
  const result = await enrol(
    trx,
    businessId,
    target.id,
    target.version_id,
    at.recordId,
    automationDocument.parse(target.document),
    {
      eventId: parent.trigger_event_id,
      correlationId: parent.correlation_id,
      triggerId: null,
      state: {
        startedBy: {
          enrolmentId: at.enrolmentId,
          automationId: parent.automation_id,
          stepKey: at.stepKey,
        },
        chain,
      },
    },
  );
  if (result.outcome === 'started')
    return {
      output: {
        outcome: 'started',
        enrolmentId: toPublicId('automation_enrolment', result.enrolmentId),
      },
      explanation: `Started "${target.name}" for this record.`,
    };
  return {
    output: { outcome: result.outcome },
    explanation:
      result.outcome === 'already_running'
        ? `This record is already in "${target.name}".`
        : `This record already went through "${target.name}", which enrols a record once.`,
  };
}

/** Why a run ended that a removal step ended: who removed it. */
export const removedBy = (automationId: string): string =>
  `removed:${toPublicId('automation', automationId)}`;

/**
 * Ends the other runs a removal step names, of the step's record only, and tells of each
 * as a stop condition does. Its own run is not ended here: `endsOwn` says whether the step
 * removes it too, and the runner ends it as it records the step, so nothing of it runs on.
 */
export async function removeFromAutomations(
  trx: DatabaseTransaction,
  command: CommandContext,
  at: StepOfRun,
  config: RemoveStep['config'],
): Promise<Done & { readonly endsOwn: boolean; readonly reason: string }> {
  const own = await trx
    .selectFrom('automation.enrolments')
    .select('automation_id')
    .where('id', '=', at.enrolmentId)
    .where('record_id', '=', at.recordId)
    .executeTakeFirstOrThrow();
  const reason = removedBy(own.automation_id);
  const listed = (key: 'automations' | 'except', references: readonly string[]) =>
    references.map((reference, index) =>
      automationIdOf(reference, `/config/${key}/${String(index)}`),
    );
  // Which other runs of the record end, as a condition on their automation; none for
  // `current`, which is the step's own run alone.
  let others: ReturnType<typeof sql> | undefined;
  let endsOwn: boolean;
  if (config.from === 'current') endsOwn = true;
  else if (config.from === 'automations') {
    const ids = listed('automations', config.automations);
    endsOwn = ids.includes(own.automation_id);
    others = sql`e.automation_id = any(${ids}::uuid[])`;
  } else {
    const except = listed('except', config.except ?? []);
    endsOwn = config.from === 'all' && !except.includes(own.automation_id);
    others = sql`not (e.automation_id = any(${except}::uuid[]))`;
  }
  const ended =
    others === undefined
      ? []
      : await exitRuns(
          trx,
          sql`e.record_id = ${at.recordId} and e.id <> ${at.enrolmentId} and ${others}`,
          reason,
        );
  for (const run of ended)
    await command.emit({
      type: 'automation.run.stopped',
      subject: { kind: 'automation_run', id: run.id },
      records: [run.record_id],
      payload: { automationId: toPublicId('automation', run.automation_id), reason },
    });
  const removed = ended.length + (endsOwn ? 1 : 0);
  return {
    output: { removed },
    explanation:
      removed === 0
        ? // Often a run's own stop condition ended it first, on the very event that led here.
          `Removed nothing: no run of ${config.from === 'automations' ? 'the chosen automations' : 'another automation'} was still going for this record.`
        : `Removed this record from ${String(removed)} ${removed === 1 ? 'automation' : 'automations'}${endsOwn ? ', this one among them, so this run ended here' : ''}.`,
    endsOwn,
    reason,
  };
}
