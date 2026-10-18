// Deleting an automation, the Deleted list, and restoring from it. Deleting is reversible
// for AUTOMATION_DELETED_DAYS: the automation keeps its draft, its versions and its
// history, and is listed as archived. It stops at once, though. Nothing new starts it (only
// an active automation is matched to an event), every run still going is cancelled in the
// same transaction, and the runner cancels a run it finds in a deleted automation before
// doing anything of its step. Restoring brings the automation back not running; the runs
// cancelled with it stay cancelled.
import { randomUUID } from 'node:crypto';

import {
  defineCommand,
  requireBusiness,
  runCommand,
  type Command,
  type Services,
} from '@repo/commands';
import { AUTOMATION_DELETED_DAYS, type Automation } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError, NotFoundError, parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { readAutomation } from './drafts.js';
import { cancelRuns } from './settle.js';

const idInput = z.strictObject({ id: z.string() });

export interface DeletionCommands {
  readonly remove: Command<typeof idInput, Automation>;
  readonly restore: Command<typeof idInput, Automation>;
}

// The automation's row, held for the change. Not the strongest lock: a run being started
// in it references the row, and must not wait behind a delete that waits for that run.
async function held(trx: DatabaseTransaction, id: string) {
  const uuid = parsePublicId('automation', id);
  const row =
    uuid === undefined
      ? undefined
      : await trx
          .selectFrom('automation.automations')
          .select(['id', 'status', 'published_version_id'])
          .where('id', '=', uuid)
          .forNoKeyUpdate()
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('automation', id);
  return row;
}

/** Deleting to the Deleted list, and restoring from it. */
export function createDeletionCommands(): DeletionCommands {
  const remove = defineCommand({
    name: 'automation.delete',
    // It stops what is live, as pausing does and more, so it takes what publishing takes.
    permission: 'automations.publish',
    input: idInput,
    async handle(trx, input, command): Promise<Automation> {
      requireBusiness(command.context);
      const automation = await held(trx, input.id);
      // Deleted already, it stays as it is and nothing more is said.
      if (automation.status !== 'archived') {
        await trx
          .updateTable('automation.automations')
          .set({ status: 'archived', archived_at: sql<Date>`now()`, folder_id: null })
          .where('id', '=', automation.id)
          .execute();
        const cancelledRuns = await cancelRuns(trx, { automationId: automation.id });
        await command.emit({
          type: 'automation.deleted',
          subject: { kind: 'automation', id: automation.id },
          records: [],
          payload: { was: automation.status, cancelledRuns, days: AUTOMATION_DELETED_DAYS },
        });
      }
      return readAutomation(trx, input.id);
    },
  });

  const restore = defineCommand({
    name: 'automation.restore',
    permission: 'automations.publish',
    input: idInput,
    async handle(trx, input, command): Promise<Automation> {
      requireBusiness(command.context);
      const automation = await held(trx, input.id);
      if (automation.status === 'archived') {
        // A run that slipped in as it was deleted, and whose job has not run since, must
        // not come back to life with it.
        const cancelledRuns = await cancelRuns(trx, { automationId: automation.id });
        // Back, and not running: what was live is paused until someone resumes it.
        const status = automation.published_version_id === null ? 'draft' : 'paused';
        await trx
          .updateTable('automation.automations')
          .set({ status, archived_at: null })
          .where('id', '=', automation.id)
          .execute();
        await command.emit({
          type: 'automation.restored',
          subject: { kind: 'automation', id: automation.id },
          records: [],
          payload: { status, cancelledRuns },
        });
      }
      return readAutomation(trx, input.id);
    },
  });

  return { remove, restore };
}

/** At most this many automations go in one purge of a business; the worker repeats. */
const PURGE_BATCH = 20;

/**
 * Removes for good the business's automations that have been in the Deleted list past
 * their days, with their versions, runs and statistics. Only the engine runs it.
 */
export const purgeDeletedCommand = defineCommand({
  name: 'automation.purge_deleted',
  permission: 'automations.publish',
  input: z.strictObject({}),
  async handle(trx, _input, command): Promise<{ purged: number }> {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the automation engine purges deleted automations.');
    const businessId = requireBusiness(command.context);
    // Never waiting: one being restored at this moment is left for the next run, and is
    // read again under its lock, so one restored since stays.
    const { rows } = await sql<{ id: string }>`
      select id from automation.automations
      where status = 'archived'
        and archived_at < now() - make_interval(days => ${AUTOMATION_DELETED_DAYS})
      order by id limit ${PURGE_BATCH} for update skip locked`.execute(trx);
    if (rows.length === 0) return { purged: 0 };
    await trx
      .deleteFrom('automation.automations')
      .where(
        'id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();
    await command.emit({
      type: 'automation.purged',
      subject: { kind: 'business', id: businessId },
      payload: { automations: rows.length, days: AUTOMATION_DELETED_DAYS },
    });
    return { purged: rows.length };
  },
});

/**
 * The worker's daily purge of deleted automations: each business with one past its days,
 * in its own business as the system, until none is left. Gives how many it removed.
 */
export async function purgeDeletedAutomations(services: Services): Promise<number> {
  let total = 0;
  for (;;) {
    const { rows } = await sql<{ agency_id: string; business_id: string }>`
      select agency_id, business_id
      from private.businesses_with_deleted_automations(${AUTOMATION_DELETED_DAYS}, ${100})
    `.execute(services.db);
    let purged = 0;
    for (const row of rows) {
      const result = await runCommand(
        services,
        purgeDeletedCommand,
        {},
        {
          context: {
            agencyId: row.agency_id,
            businessId: row.business_id,
            actorKind: 'system',
            correlationId: randomUUID(),
          },
          permissions: 'all',
        },
      );
      purged += result.purged;
    }
    total += purged;
    // Nothing found, or nothing removable now: stop rather than ask again.
    if (purged === 0) return total;
  }
}
