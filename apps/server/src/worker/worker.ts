// The worker role: Graphile Worker runs the jobs that commands add. It works the queue as
// crm_worker, and runs each job's task as crm_app, in the business that added the job.
// Failed jobs are retried with exponential backoff, by Graphile Worker.
import { EventEmitter } from 'node:events';

import type { AnyTask, Services } from '@repo/commands';
import { connectPool, workerPreset } from '@repo/db';
import { expireAiProposals, expireAiRequestLogs, expireAssistantThreads } from '@repo/module-ai';
import {
  compactAutomationStats,
  expireTriggerEvaluations,
  purgeDeletedAutomations,
  scheduleDueEnrolments,
  sweepDateTriggers,
  sweepTaskReminders,
} from '@repo/module-automation';
import { scheduleGoogleRefreshes } from '@repo/module-calendar';
import { purgeExpiredTrash, recoverStalledImports } from '@repo/module-crm';
import { expireExternalTracking } from '@repo/module-forms';
import {
  expireMailboxAttempts,
  expireInstallMessages,
  expireSmsConnectionAttempts,
  expireSmsWebhooks,
  expireVoiceGrants,
  expireWebchatSessions,
  scheduleEmailCampaigns,
  scheduleMailboxChecks,
  scheduleMailboxSyncs,
} from '@repo/module-messaging';
import { maintainIntegrations, scheduleIntegrationChecks } from '@repo/module-integrations';
import { expireNotifications } from '@repo/module-notifications';
import type { SealingVault } from '@repo/module-vault';
import {
  Logger,
  parseCronItems,
  run,
  type Task as GraphileTask,
  type WorkerEvents,
  type WorkerPool,
} from 'graphile-worker';
import { sql } from 'kysely';
import type { Logger as Pino } from 'pino';
import * as z from 'zod';

export interface WorkerOptions {
  /** crm_worker's connection string. */
  readonly connectionString: string;
  /** The crm_app pool and authorization, for the tasks. */
  readonly services: Services;
  readonly tasks: readonly AnyTask[];
  /** Pending credentials are removed after ten minutes, even if verification never ran. */
  readonly mailboxVault?: SealingVault;
  readonly logger: Pino;
  /** How long stop() lets running jobs go on. One still running then fails, to retry. */
  readonly shutdownTimeoutMs: number;
}

export interface Worker {
  /**
   * Settles when the worker has stopped: after stop(), or by itself, after a fatal error
   * or when a newer release migrates the queue. Stopped by itself, the process should exit
   * so that it's restarted.
   */
  readonly ended: Promise<void>;
  /** Stops taking jobs, and lets those running finish, until the shutdown deadline. */
  stop(): Promise<void>;
}

/** Creates the monthly partitions three months ahead. */
export const MAINTAIN_PARTITIONS = 'partitions.maintain';

/** Purges what's been in each business's trash past its retention days. */
export const PURGE_TRASH = 'trash.purge';
export const EXPIRE_MAILBOX_ATTEMPTS = 'mailboxes.expire_attempts';
export const SCHEDULE_MAILBOX_CHECKS = 'mailboxes.schedule_checks';
export const SCHEDULE_MAILBOX_SYNCS = 'mailboxes.schedule_syncs';
export const SCHEDULE_AUTOMATIONS = 'automations.schedule_due';
export const MAINTAIN_SMS = 'sms.maintain';
export const MAINTAIN_WEBCHAT = 'webchat.maintain';
/** Clears expired browser calling tokens and deletes day-old requests for them. */
export const MAINTAIN_VOICE = 'voice.maintain';
/** Queues a run for every email campaign with work due. */
export const SCHEDULE_CAMPAIGNS = 'campaigns.schedule';
/** Clears AI request logs past the days their business keeps them. */
export const MAINTAIN_AI = 'ai.maintain';
/** Takes up imports whose worker died before they ended. */
export const RECOVER_IMPORTS = 'imports.recover';
/** Removes notifications 30 days after they were read, or 90 after they were made. */
export const MAINTAIN_NOTIFICATIONS = 'notifications.maintain';
/** Queues the Google Calendar readings that are due, and clears what is spent. */
export const SCHEDULE_GOOGLE = 'calendar.google.schedule';
/** Queues the integration checks that are due, and clears what has expired. */
export const SCHEDULE_INTEGRATIONS = 'integrations.schedule';

// What private.enqueue_job wraps each job's data in (0013_jobs.sql). The event behind the
// job came with 0020; a job queued before it has none.
// Loose: during a deploy, the worker of the release before may take jobs the next one
// queued. It must still run them, ignoring envelope fields added after it was built.
const envelope = z.looseObject({
  agencyId: z.uuid(),
  businessId: z.uuid().nullable(),
  correlationId: z.uuid(),
  causationId: z.uuid().nullable().optional(),
  data: z.unknown(),
});

/**
 * Runs one job of a task: in the job's business, acting as the system, caused by the event
 * behind the job, so the events of the commands it runs point at it.
 */
function graphileTask(task: AnyTask, services: Services): GraphileTask {
  return async (payload, helpers) => {
    const job = envelope.parse(payload);
    const causationId = job.causationId ?? undefined;
    await task.run(task.data.parse(job.data), {
      // Graphile Worker's own record of the job (JobHelpers.job, a DbJob): its priority.
      job: { priority: helpers.job.priority },
      invocation: {
        context: {
          agencyId: job.agencyId,
          ...(job.businessId === null ? {} : { businessId: job.businessId }),
          actorKind: 'system',
          correlationId: job.correlationId,
        },
        // The system: a job follows from a command that was allowed when it ran.
        permissions: 'all',
        ...(causationId === undefined ? {} : { causationId }),
      },
      services,
    });
  };
}

// Graphile Worker's log levels, and pino's names for them.
const levels: Record<'error' | 'warning' | 'info' | 'debug', 'error' | 'warn' | 'info' | 'debug'> =
  {
    error: 'error',
    warning: 'warn',
    info: 'info',
    debug: 'debug',
  };

/** Reports readiness only after the queue's first acquisition succeeds. */
export async function startWorker(options: WorkerOptions): Promise<Worker> {
  const { logger, services } = options;
  const pool = connectPool({
    connectionString: options.connectionString,
    // The pool has already dropped the failed connection; this only records it.
    onConnectionError: (error) => {
      logger.error({ err: error }, 'job queue connection failed');
    },
  });
  // At the shutdown deadline, the worker pool's forcefulShutdown fails the jobs still
  // running, so that they're retried soon. Graphile Worker 0.18's runner.kill() can't
  // reach it once a graceful stop has begun, so the pool is taken from its creation event,
  // which fires before run() resolves. It's boxed: a WorkerPool is itself thenable, so a
  // promise of one would wait for the pool to end.
  const events: WorkerEvents = new EventEmitter();
  const created = new Promise<{ workerPool: WorkerPool }>((resolve) => {
    events.once('pool:create', (event) => {
      resolve({ workerPool: event.workerPool });
    });
  });
  // run() resolves before task registration and the first poll. In 0.18, an initial
  // registration error remains cached, so a listening connection alone isn't readiness.
  const firstPoll = new Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  >((resolve) => {
    const cleanup = () => {
      events.off('worker:getJob:empty', ready);
      events.off('job:start', ready);
      events.off('worker:getJob:error', failed);
    };
    const ready = () => {
      cleanup();
      resolve({ ok: true });
    };
    const failed = ({ error }: { readonly error: unknown }) => {
      cleanup();
      resolve({ ok: false, error });
    };
    events.once('worker:getJob:empty', ready);
    events.once('job:start', ready);
    events.once('worker:getJob:error', failed);
  });

  let stopping = false;
  const mailboxVault = options.mailboxVault;
  const hasMailboxChecks = options.tasks.some((task) => task.name === 'mailboxes.check');
  const hasMailboxSyncs = options.tasks.some((task) => task.name === 'mailboxes.sync');
  const hasAutomationSteps = options.tasks.some((task) => task.name === 'automations.run_step');
  const hasImports = options.tasks.some((task) => task.name === 'imports.run');
  const hasCampaigns = options.tasks.some((task) => task.name === 'campaigns.run');
  const hasGoogle = options.tasks.some((task) => task.name === 'calendar.google.refresh_busy');
  const hasIntegrations = options.tasks.some((task) => task.name === 'integrations.check');
  const runner = await run({
    pgPool: pool,
    events,
    preset: workerPreset,
    // The process handles signals, and stops the worker with the HTTP server.
    noHandleSignals: true,
    // Graphile Worker passes errors as meta.error; pino serializes them under err.
    logger: new Logger((scope) => (level, message, { error, ...meta }) => {
      logger[levels[level]](
        { ...scope, ...meta, ...(error === undefined ? {} : { err: error }) },
        message,
      );
    }),
    taskList: {
      ...Object.fromEntries(options.tasks.map((task) => [task.name, graphileTask(task, services)])),
      ...(hasAutomationSteps
        ? {
            [SCHEDULE_AUTOMATIONS]: async () => {
              const queued = await scheduleDueEnrolments(services);
              if (queued > 0) logger.info({ queued }, 'queued due automation enrolments');
              // Dates that came round since the last minute enrol their contacts. A trigger
              // left unswept for longer than a firing may be late has skipped some.
              const dates = await sweepDateTriggers(services);
              if (dates.enrolled > 0)
                logger.info({ enrolled: dates.enrolled }, 'enrolled contacts on their dates');
              if (dates.late > 0)
                logger.warn({ triggers: dates.late }, 'date triggers skipped firings too old');
              // And tasks that came due, for the Task Reminder trigger, the same way. Kept
              // apart: whatever goes wrong there neither stops the date sweep before it nor
              // the statistics after it.
              try {
                const reminders = await sweepTaskReminders(services);
                if (reminders.enrolled > 0)
                  logger.info(
                    { enrolled: reminders.enrolled },
                    'enrolled contacts on task reminders',
                  );
                if (reminders.late > 0)
                  logger.warn(
                    { triggers: reminders.late },
                    'task reminders skipped firings too old',
                  );
                if (reminders.failed.length > 0)
                  logger.error(
                    { automations: reminders.failed },
                    'task reminders could not sweep these automations',
                  );
              } catch (error) {
                logger.error({ err: error }, 'the task reminder sweep failed');
              }
              // What runs and steps wrote to the statistics since the last minute is folded
              // into the counters; reading them is right either way.
              const folded = await compactAutomationStats(services);
              if (folded > 0) logger.debug({ folded }, 'folded automation statistics');
            },
          }
        : {}),
      [MAINTAIN_PARTITIONS]: async () => {
        await sql`select private.maintain_partitions()`.execute(services.db);
      },
      [PURGE_TRASH]: async () => {
        const purged = await purgeExpiredTrash(services);
        if (purged > 0) logger.info({ purged }, 'purged expired trash');
        // Automations that have been on the Deleted list past their days go the same way.
        const automations = await purgeDeletedAutomations(services);
        if (automations > 0) logger.info({ automations }, 'purged deleted automations');
        // Why a workflow did not start is kept thirty days, and then goes.
        const evaluations = await expireTriggerEvaluations(services);
        if (evaluations > 0) logger.info({ evaluations }, 'removed expired trigger evaluations');
        // External Tracking: raw events after thirty days, a page's days after thirteen months.
        const tracking = await expireExternalTracking(services);
        if (tracking > 0) logger.info({ tracking }, 'removed expired external tracking data');
      },
      [MAINTAIN_SMS]: async () => {
        if (mailboxVault !== undefined) {
          const expired = await expireSmsConnectionAttempts(services, mailboxVault);
          if (expired > 0) logger.info({ expired }, 'removed expired SMS credentials');
        }
        const removed = await expireSmsWebhooks(services);
        if (removed > 0) logger.info({ removed }, 'removed expired SMS webhooks');
      },
      [MAINTAIN_WEBCHAT]: async () => {
        // Chats a visitor began and never wrote in still hold the name and address typed.
        const ended = await expireWebchatSessions(services);
        if (ended > 0) logger.info({ ended }, 'removed expired web chat sessions');
      },
      [MAINTAIN_VOICE]: async () => {
        // An expired token signs nothing, but it is still a credential at rest.
        const changed = await expireVoiceGrants(services);
        if (changed > 0) logger.info({ changed }, 'cleared expired calling tokens');
      },
      ...(hasImports
        ? {
            [RECOVER_IMPORTS]: async () => {
              // An import that has made no progress for five minutes is queued again in its
              // own business; one started a day ago is closed, so the business can import.
              const { queued, failed } = await recoverStalledImports(services);
              if (queued + failed > 0) logger.info({ queued, failed }, 'took up stalled imports');
            },
          }
        : {}),
      [MAINTAIN_AI]: async () => {
        // What was said to a model, and what it answered, goes; the call's cost stays.
        const cleared = await expireAiRequestLogs(services);
        if (cleared > 0) logger.info({ cleared }, 'cleared expired AI request logs');
        // A proposal nobody decided in its time is closed: it no longer waits for anyone.
        const expired = await expireAiProposals(services);
        if (expired > 0) logger.info({ expired }, 'closed expired AI proposals');
        // A conversation with the assistant nobody went back to goes, with its messages.
        const threads = await expireAssistantThreads(services);
        if (threads > 0) logger.info({ threads }, 'removed expired assistant conversations');
      },
      [MAINTAIN_NOTIFICATIONS]: async () => {
        // What a person was told long ago goes: the bell is not a record of what happened.
        const removed = await expireNotifications(services);
        if (removed > 0) logger.info({ removed }, 'removed expired notifications');
      },
      ...(hasGoogle
        ? {
            [SCHEDULE_GOOGLE]: async () => {
              // Each connected member's Google busy time, about every five minutes.
              const queued = await scheduleGoogleRefreshes(services);
              if (queued > 0) logger.debug({ queued }, 'queued Google Calendar readings');
            },
          }
        : {}),
      ...(hasIntegrations
        ? {
            [SCHEDULE_INTEGRATIONS]: async () => {
              // Each connected account about daily, and the attempts, activity and webhooks
              // past their time.
              const queued = await scheduleIntegrationChecks(services);
              if (queued > 0) logger.debug({ queued }, 'queued integration checks');
              const cleared = await maintainIntegrations(services);
              if (cleared > 0) logger.info({ cleared }, 'cleared expired integration data');
            },
          }
        : {}),
      ...(hasCampaigns
        ? {
            [SCHEDULE_CAMPAIGNS]: async () => {
              // A scheduled campaign whose time has come, one that is sending, and one whose
              // released emails are still on their way. Each gets one job, in its own queue.
              const queued = await scheduleEmailCampaigns(services);
              if (queued > 0) logger.debug({ queued }, 'queued due email campaigns');
            },
          }
        : {}),
      ...(hasMailboxChecks
        ? {
            [SCHEDULE_MAILBOX_CHECKS]: async () => {
              const queued = await scheduleMailboxChecks(services);
              if (queued > 0) logger.info({ queued }, 'queued due mailbox checks');
            },
          }
        : {}),
      ...(mailboxVault === undefined
        ? {}
        : {
            [EXPIRE_MAILBOX_ATTEMPTS]: async () => {
              const expired = await expireMailboxAttempts(services, mailboxVault);
              if (expired > 0) logger.info({ expired }, 'removed expired mailbox credentials');
              const expiredMessages = await expireInstallMessages(services, mailboxVault);
              if (expiredMessages > 0)
                logger.info({ expiredMessages }, 'removed expired install messages');
            },
          }),
      ...(hasMailboxSyncs
        ? {
            [SCHEDULE_MAILBOX_SYNCS]: async () => {
              const queued = await scheduleMailboxSyncs(services);
              if (queued > 0) logger.info({ queued }, 'queued due inbox syncs');
            },
          }
        : {}),
    },
    // Daily at 03:00 and 03:30 UTC; a worker that was down then catches up when it starts.
    parsedCronItems: parseCronItems([
      { task: MAINTAIN_PARTITIONS, match: '0 3 * * *', options: { backfillPeriod: 86_400_000 } },
      { task: PURGE_TRASH, match: '30 3 * * *', options: { backfillPeriod: 86_400_000 } },
      {
        task: MAINTAIN_SMS,
        match: '*/5 * * * *',
        options: { backfillPeriod: 300_000, queueName: MAINTAIN_SMS },
      },
      {
        task: MAINTAIN_WEBCHAT,
        match: '17 * * * *',
        options: { backfillPeriod: 3_600_000, queueName: MAINTAIN_WEBCHAT },
      },
      {
        task: MAINTAIN_VOICE,
        match: '*/10 * * * *',
        options: { backfillPeriod: 600_000, queueName: MAINTAIN_VOICE },
      },
      {
        task: MAINTAIN_AI,
        match: '43 * * * *',
        options: { backfillPeriod: 3_600_000, queueName: MAINTAIN_AI },
      },
      {
        task: MAINTAIN_NOTIFICATIONS,
        match: '29 * * * *',
        options: { backfillPeriod: 3_600_000, queueName: MAINTAIN_NOTIFICATIONS },
      },
      // Every minute; a fixed queue keeps one sweep from overlapping the next.
      ...(hasImports
        ? [
            {
              task: RECOVER_IMPORTS,
              match: '* * * * *',
              options: { backfillPeriod: 60_000, queueName: RECOVER_IMPORTS },
            },
          ]
        : []),
      // One bounded recovery pass per minute; a fixed queue serializes overlapping passes.
      ...(hasAutomationSteps
        ? [
            {
              task: SCHEDULE_AUTOMATIONS,
              match: '* * * * *',
              options: { backfillPeriod: 60_000, queueName: SCHEDULE_AUTOMATIONS },
            },
          ]
        : []),
      // Every minute; each connection is due about every five. A fixed queue keeps one
      // sweep from overlapping the next.
      ...(hasGoogle
        ? [
            {
              task: SCHEDULE_GOOGLE,
              match: '* * * * *',
              options: { backfillPeriod: 60_000, queueName: SCHEDULE_GOOGLE },
            },
          ]
        : []),
      // Every five minutes; each account is due about daily. A fixed queue keeps one sweep
      // from overlapping the next.
      ...(hasIntegrations
        ? [
            {
              task: SCHEDULE_INTEGRATIONS,
              match: '*/5 * * * *',
              options: { backfillPeriod: 300_000, queueName: SCHEDULE_INTEGRATIONS },
            },
          ]
        : []),
      // Every minute, which is the pace campaigns are released at; a fixed queue keeps one
      // sweep from overlapping the next.
      ...(hasCampaigns
        ? [
            {
              task: SCHEDULE_CAMPAIGNS,
              match: '* * * * *',
              options: { backfillPeriod: 60_000, queueName: SCHEDULE_CAMPAIGNS },
            },
          ]
        : []),
      ...(hasMailboxSyncs
        ? [
            {
              task: SCHEDULE_MAILBOX_SYNCS,
              match: '*/2 * * * *',
              options: { backfillPeriod: 120_000 },
            },
          ]
        : []),
      // Poll a bounded batch every five minutes; each mailbox is checked at most daily,
      // except a manual request or recovery of an abandoned pending job.
      ...(hasMailboxChecks
        ? [
            {
              task: SCHEDULE_MAILBOX_CHECKS,
              match: '*/5 * * * *',
              options: { backfillPeriod: 300_000 },
            },
          ]
        : []),
      ...(mailboxVault === undefined
        ? []
        : [
            {
              task: EXPIRE_MAILBOX_ATTEMPTS,
              match: '*/5 * * * *',
              options: { backfillPeriod: 300_000 },
            },
          ]),
    ]),
  })
    .then(async (runner) => {
      const startup = await firstPoll;
      if (!startup.ok) {
        await runner.stop();
        throw startup.error;
      }
      return runner;
    })
    .catch(async (error: unknown) => {
      await pool.end();
      throw new Error(
        `The worker couldn't start the job queue; is the database up and migrated? ${String(error)}`,
        { cause: error },
      );
    });

  // In 0.18 runner.promise only resolves: the pool's and the cron's errors are caught and
  // logged inside it. Either way, once it settles the worker has ended.
  const settled = () => undefined;
  const ended = runner.promise.then(settled, settled).then(() => {
    if (!stopping) logger.fatal('the worker stopped by itself');
  });

  let stopped: Promise<void> | undefined;
  return {
    ended,
    stop() {
      stopped ??= (async () => {
        stopping = true;
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<'late'>((resolve) => {
          timer = setTimeout(() => {
            resolve('late');
          }, options.shutdownTimeoutMs);
        });
        // Graphile Worker's stop() rejects only when the runner has already stopped by
        // itself; then there's nothing left to do but let it finish ending.
        const graceful = runner.stop().catch(() => ended);
        if ((await Promise.race([graceful, late])) === 'late') {
          logger.warn('jobs ran past the shutdown deadline; failing them, to be retried');
          const { workerPool } = await created;
          await workerPool.forcefulShutdown('the shutdown deadline passed');
          await graceful;
        }
        clearTimeout(timer);
        await pool.end();
      })();
      return stopped;
    },
  };
}
