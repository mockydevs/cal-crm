// Every task the worker runs. Each module exports its tasks; the server only concatenates
// them, as it does the API routes.
import type { AnyTask } from '@repo/commands';
import {
  createContactBulkTasks,
  createImportTasks,
  createTaskSeriesTasks,
  crmTasks,
  type ImportTaskOptions,
} from '@repo/module-crm';
import {
  bulkWorkflows,
  callWebhook,
  createAutomationTasks,
  createBulkMessages,
  webhookRetryDelay,
} from '@repo/module-automation';
import { appointmentManageUrl } from '@repo/module-calendar';
import {
  bulkEmailChecks,
  smsDeliveryAvailable,
  createVerifyEmailAddressTask,
  createTestEmailVerificationProviderTask,
} from '@repo/module-messaging';
import { notificationTasks, notifyTeam } from '@repo/module-notifications';
import type { Files } from '@repo/module-files';
import { createMarketplaceTasks, readPersonGrants } from '@repo/module-tenancy';
import type { Vault } from '@repo/module-vault';
import { taskOptions } from './task-options.js';

export const workerTasks = (
  vault?: Vault,
  /** PUBLIC_URL, as start() hands it over: what the install can be reached at. */
  publicUrl?: string,
  /**
   * The files service an import reads its file from, in a role that has file storage. A
   * role without one still takes an import's job, to end the import saying why.
   */
  imports: ImportTaskOptions = { files: undefined },
  /**
   * PUBLIC_INTAKE_SECRET, where it is set: what a reminder's reschedule-or-cancel link is
   * keyed with (migration 0107). Without it the install serves no public pages, and
   * appointment.manageUrl is empty.
   */
  linkSecret?: string,
  /**
   * What a bulk action on contacts needs of the install: the files service an export's
   * file is kept by, where this role has one, and CAMPAIGN_AGENCY_DAILY_LIMIT, which bulk
   * email counts against.
   */
  contactBulk: {
    readonly files?: Files | undefined;
    readonly agencyDailyLimit?: number | undefined;
  } = {},
  /**
   * What an email address check asks DNS through. Left out, the system's resolver; the
   * whole-product suite answers it locally, as it does for mailbox checks.
   */
  emailChecks: Pick<
    NonNullable<Parameters<typeof createVerifyEmailAddressTask>[0]>,
    'resolve'
  > = {},
): readonly AnyTask[] => [
  createVerifyEmailAddressTask({ ...emailChecks, ...(vault === undefined ? {} : { vault }) }),
  createTestEmailVerificationProviderTask(vault),
  ...crmTasks,
  // Each task of a recurring series, made at its time (migration 0121).
  ...createTaskSeriesTasks(taskOptions),
  // What the bell shows: the jobs the database queues for an event that tells someone
  // something, and at a task's due time (migration 0056).
  ...notificationTasks,
  ...createImportTasks(imports),
  // A deleted file's bytes leave storage once the deletion commits; the database queues the
  // job. Only a role with file storage can remove them.
  ...(contactBulk.files?.tasks ?? []),
  // A bulk action on more contacts than a request applies, a batch at a time. "Add to
  // workflow" enrols each contact through the automation module, a bulk email or text is
  // each contact's workflow send step, an export's file is kept by the files service, and
  // whoever started an action is asked again before each batch.
  ...createContactBulkTasks({
    ...taskOptions,
    workflows: bulkWorkflows,
    messages: createBulkMessages({
      smsAvailable: vault !== undefined && smsDeliveryAvailable(publicUrl),
      publicUrl,
      agencyDailyLimit: contactBulk.agencyDailyLimit,
    }),
    ...(contactBulk.files === undefined ? {} : { files: contactBulk.files }),
    emailChecks: bulkEmailChecks,
    grants: readPersonGrants,
  }),
  ...createAutomationTasks({
    tasks: taskOptions,
    notifyTeam,
    // A text message step runs only where the dispatch job could hand its message to the
    // provider: with a vault for the credentials and an address for delivery reports.
    smsAvailable: vault !== undefined && smsDeliveryAvailable(publicUrl),
    // Where a trigger link in a message gets its address.
    publicUrl,
    // A reminder's link to reschedule or cancel (appointment.manageUrl).
    ...(linkSecret === undefined || publicUrl === undefined
      ? {}
      : {
          appointmentLinks: {
            manageUrl: (trx, appointmentId) =>
              appointmentManageUrl(trx, { secret: linkSecret, publicUrl }, appointmentId),
          },
        }),
    ...(vault === undefined ? {} : { vault }),
    // An Email verification step checks with the same vault and DNS as the address job.
    emailChecks: { ...emailChecks, ...(vault === undefined ? {} : { vault }) },
  }),
  // Webhooks to installed apps: signed with the app's secret, which only this vault opens,
  // and sent by the same request code as an automation's webhook step.
  ...(vault === undefined
    ? []
    : createMarketplaceTasks({
        vault,
        send: (url, body, options) => callWebhook({ url, method: 'POST' }, body, options),
        retryDelay: webhookRetryDelay,
      })),
];
