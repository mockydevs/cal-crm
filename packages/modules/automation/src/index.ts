import type { AnyTask } from '@repo/commands';
export { createAutomationProposables } from './proposals.js';

import type { ActionOptions } from './actions.js';
import { matchEventTask } from './match-task.js';
import { startAgainTask } from './reentry.js';
import { createRunStepTask } from './runner.js';
import type { SecretOpener } from './webhook-signing.js';
import { createCallWebhookTask } from './webhook-task.js';
import { createCheckEmailTask } from './email-verify-task.js';
import type { VerificationTaskOptions } from '@repo/module-messaging';

export {
  enrol,
  lockRecordRuns,
  matchEvent,
  publishAutomationVersion,
  type EnrolCause,
  type EnrolOutcome,
  type MatchResult,
} from './enrolment.js';
export { chainOf, chainRefusal, MAX_AUTOMATION_CHAIN } from './chain.js';
export { removedBy, removeFromAutomations, startAutomation } from './actions-automations.js';
export { matchEventCommand, matchEventReference, matchEventTask } from './match-task.js';
export { startAgain, startAgainCommand, startAgainTask } from './reentry.js';
export { startAgainReference } from './reentry-mark.js';
export { bulkWorkflows } from './bulk-enrol.js';
export { createBulkMessages } from './bulk-send.js';
export {
  eventPassesTrigger,
  TRIGGER_EVENTS,
  triggerMismatch,
  type TriggerMismatch,
} from './triggers.js';
export {
  DATE_TRIGGER_CATCH_UP_MS,
  DEFAULT_TRIGGER_TIME,
  sweepDateTriggers,
  type DateSweep,
} from './date-triggers.js';
export { sweepTaskReminders, type TaskReminderSweep } from './task-reminders.js';
export { automationRepliedTo } from './replied-to.js';
export { contactValues, dealValues, type ValuesOf } from './values.js';
export { contactAttributionValues, touchValues } from './attribution-values.js';
export { queueStep } from './queue-step.js';
export {
  createRunStepCommand,
  createRunStepTask,
  runStep,
  runStepReference,
  scheduleDueEnrolments,
} from './runner.js';
export {
  DEFAULT_RETRY_WAIT,
  failurePath,
  planSendingHold,
  planStep,
  retryTime,
  sendingWindowOpening,
  splitBucket,
  UNAVAILABLE_STEPS,
  WINDOWED_STEPS,
  type SendingWindow,
  type StepPlan,
  type WaitedAppointment,
} from './steps.js';
export { APPOINTMENT_CHANGE_EVENTS, readWaitedAppointment, RECORD_CHANGE_EVENTS } from './waits.js';
export type { AppointmentLinks } from './appointment-values.js';
export { addStopWaits, applyStops, clearWaits, type EmitEvent } from './stops.js';
export { addGoalWaits, applyGoals, type GoalMet } from './goals.js';
export {
  AUTOMATION_DELETED,
  cancelRuns,
  exitRuns,
  settleWaitingSteps,
  type EndedRun,
} from './settle.js';
export {
  createDeletionCommands,
  purgeDeletedAutomations,
  purgeDeletedCommand,
  type DeletionCommands,
} from './deletion.js';
export { createFolderCommands, readFolders, type FolderCommands } from './folders.js';
export {
  compactAutomationStats,
  readAutomationStats,
  readEnrolledCounts,
  type EnrolledCounts,
} from './stats.js';
export {
  MAX_SIMULATED_STEPS,
  simulateAutomation,
  type SimulatedAutomation,
  type SimulatedEvent,
  type Trace,
  type TraceOutcome,
  type TraceStep,
} from './simulate.js';
export { type SimulatedDeal, type SimulatedDeals } from './simulate-deals.js';
export { readDealInHand, type DealInHand } from './deal-in-hand.js';
export {
  runAction,
  type ActionOptions,
  type ActionPlan,
  type EnrolledRecord,
  type StepVisit,
} from './actions.js';
export { readTestRun, testRunCommand, testRunInput } from './test-runs.js';
export { retryRunCommand, retryRunInput } from './run-retry.js';
export {
  explainContact,
  explainEvaluation,
  expireTriggerEvaluations,
  readTriggerEvaluations,
  type EvaluationNote,
} from './trigger-evaluations.js';
export { continuableWait, continueRunInput, createContinueRunCommand } from './run-continue.js';
export {
  AUTOMATION_PAGE_SIZE,
  checkedDocument,
  createDraftCommands,
  MAX_DRAFT_SIZE,
  readAutomation,
  readAutomations,
  validationOf,
  type DraftCommands,
  type ReadSetup,
} from './drafts.js';
export {
  readAutomationSetup,
  type InstallCapabilities,
  type ReadAutomationUsers,
} from './setup.js';
export { createAutomationRoutes } from './routes.js';
export { readTemplateFields, readTemplateUseCounts, readTemplateUses } from './template-uses.js';
// The workflow Send email step: sync with a template, the inventory of actions that use
// one, and one step's statistics.
export { createEmailSyncCommands, type EmailSyncCommands } from './email-sync.js';
export { readTemplateWorkflowActions } from './email-template-actions.js';
export {
  countEmailStep,
  emailSkipReason,
  readEmailStepStatistics,
} from './email-step-statistics.js';
// What uses a field, for the CRM's deletion of one.
export { readFieldUses } from './field-uses.js';
export { readObjectUses } from './object-uses.js';
// What a form's page checks ask: which running workflows start when it is sent.
export { readFormListeners, type FormListener } from './form-listeners.js';
// Manual actions: the queue's routes, and its commands for tests.
export { createManualActionRoutes } from './manual-action-routes.js';
export {
  createManualActionCommands,
  readManualAction,
  readManualActions,
  type ManualActionOptions,
} from './manual-actions.js';
export {
  diffVersions,
  HISTORY_PAGE_SIZE,
  readRecordRuns,
  readRun,
  readRuns,
  readStepRuns,
  readVersion,
  readVersions,
} from './history.js';
export { createLifecycleCommands, type LifecycleCommands } from './lifecycle.js';

/**
 * The automation module's background tasks, for the worker to run. The server passes the
 * options it gives the API's task routes, so a step's task is assigned by the same rules.
 */
export function createAutomationTasks(
  options: ActionOptions & {
    /**
     * The worker's vault, which alone opens the webhook signing secret. An install without
     * one has no delivery task, and every other step runs as usual.
     */
    readonly vault?: SecretOpener | undefined;
    /**
     * What an Email verification step's check is made with: the worker's vault, which opens
     * the provider's key, and the DNS it asks. Left out, the system's resolver and no
     * provider, so only the free checks run.
     */
    readonly emailChecks?: VerificationTaskOptions | undefined;
  },
): readonly AnyTask[] {
  return [
    matchEventTask,
    startAgainTask,
    createRunStepTask(options),
    createCheckEmailTask(options.emailChecks),
    ...(options.vault === undefined ? [] : [createCallWebhookTask({ vault: options.vault })]),
  ];
}
export {
  createRotateWebhookSecretCommand,
  openWebhookSecret,
  readWebhookSigningStatus,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNING_PURPOSE,
  type LockBusiness,
  type RotatedWebhookSecret,
  type SecretOpener,
  type SecretSealer,
  type WebhookSigningStatus,
} from './webhook-signing.js';
export {
  checkEmailReference,
  createCheckEmailTask,
  EMAIL_CHECK_MAX_ATTEMPTS,
  recordEmailCheckCommand,
} from './email-verify-task.js';
export {
  callWebhookReference,
  createCallWebhookTask,
  recordWebhookResultCommand,
  webhookBody,
  WEBHOOK_RECOVERY_MS,
} from './webhook-task.js';
export {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  callWebhook,
  signWebhook,
  verifyWebhookSignature,
  webhookRetryDelay,
} from './webhook.js';
