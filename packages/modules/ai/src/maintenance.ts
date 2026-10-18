// The AI module's housekeeping, for the worker's maintenance schedule.
import type { Services } from '@repo/commands';

/** Logs cleared in one run; private.expire_ai_request_logs takes at most 10,000. */
const BATCH = 5000;

/**
 * Clears the request logs that are past the day their business keeps them to, in every
 * business, and says how many. The call's record stays: its tokens and cost are the
 * month's spend. Only what was said goes.
 */
export async function expireAiRequestLogs(services: Services): Promise<number> {
  const row = await services.db
    .selectNoFrom((eb) =>
      // Kysely writes a function's name as given, so this is private.expire_ai_request_logs.
      eb.fn<number>('private.expire_ai_request_logs', [eb.val(BATCH)]).as('cleared'),
    )
    .executeTakeFirstOrThrow();
  return row.cleared;
}

/** Proposals closed in one run. */
const PROPOSAL_BATCH = 1000;

/**
 * Closes the proposals whose time is up, in every business, and says how many. Apply
 * refuses an expired proposal from the moment it expires, swept or not; the sweep is what
 * takes it out of the lists of what is waiting. Draft requests a week old go with it, and
 * so do the extraction job's runs of a month ago (0061): each only said how a reading
 * ended, and what it proposed stands on its own.
 */
export async function expireAiProposals(services: Services): Promise<number> {
  const row = await services.db
    .selectNoFrom((eb) =>
      eb.fn<number>('private.expire_ai_proposals', [eb.val(PROPOSAL_BATCH)]).as('expired'),
    )
    .executeTakeFirstOrThrow();
  await services.db
    .selectNoFrom((eb) =>
      eb.fn<number>('private.expire_ai_extractions', [eb.val(PROPOSAL_BATCH)]).as('removed'),
    )
    .execute();
  return row.expired;
}

/** Threads removed in one run. */
const THREAD_BATCH = 1000;

/**
 * Removes the in-app assistant's conversations that are past their time, in every business,
 * with their turns and messages, and says how many. What the assistant made stays, and so
 * do the proposals it stored.
 */
export async function expireAssistantThreads(services: Services): Promise<number> {
  const row = await services.db
    .selectNoFrom((eb) =>
      eb.fn<number>('private.expire_assistant_threads', [eb.val(THREAD_BATCH)]).as('removed'),
    )
    .executeTakeFirstOrThrow();
  return row.removed;
}
