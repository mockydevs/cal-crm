// The routes and the worker's job of bulk actions on contacts. The server hands over who is
// on the team and what people are called, as it does for the contact page
// (detail-routes.ts), and the outbound path and the files service where the install has
// them (bulk-options.ts).
import {
  defineTask,
  requireBusiness,
  requirePermission,
  runCommand,
  type AnyTask,
  type ApiRoute,
  type Invocation,
  type Route,
} from '@repo/commands';
import {
  bulkUpdateContacts,
  cancelContactBulkAction,
  CONTACT_EXPORT_LINK_SECONDS,
  createContactExportLink,
  getContactBulkAction,
  listContactBulkActionItems,
  listContactBulkActions,
  parseInput,
  previewContactEmailChecks,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { actorKinds, ConflictError, toPublicId } from '@repo/kernel';

import type { ContactBulkOptions } from './bulk-options.js';
import {
  contactBulkCommands,
  readContactBulkAction,
  readContactBulkActions,
  readContactBulkItems,
  readContactBulkRun,
  readContactExportFile,
  expireContactExportReference,
  CONTACT_EXPORT_KEPT_DAYS,
  previewContactEmailChecks as previewEmailChecks,
  runContactBulkReference,
} from './bulk.js';

export function contactBulkRoutes(options: ContactBulkOptions): readonly ApiRoute[] {
  const commands = contactBulkCommands(options);

  const start = {
    endpoint: bulkUpdateContacts,
    command: commands.start,
    run: ({ invocation, body }, services) => runCommand(services, commands.start, body, invocation),
  } satisfies Route<typeof bulkUpdateContacts>;

  const list = {
    endpoint: listContactBulkActions,
    run: ({ invocation, query }, { db }) => {
      const parsed = parseInput(listContactBulkActions.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readContactBulkActions(trx, invocation, parsed, options),
      );
    },
  } satisfies Route<typeof listContactBulkActions>;

  const read = {
    endpoint: getContactBulkAction,
    run: ({ invocation, params }, { db }) => {
      const { id } = parseInput(getContactBulkAction.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readContactBulkAction(trx, invocation, id, options),
      );
    },
  } satisfies Route<typeof getContactBulkAction>;

  const cancel = {
    endpoint: cancelContactBulkAction,
    command: commands.cancel,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        commands.cancel,
        parseInput(cancelContactBulkAction.params, params),
        invocation,
      ),
  } satisfies Route<typeof cancelContactBulkAction>;

  const items = {
    endpoint: listContactBulkActionItems,
    run: ({ invocation, params, query }, { db }) => {
      const { id } = parseInput(listContactBulkActionItems.params, params);
      const parsed = parseInput(listContactBulkActionItems.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readContactBulkItems(trx, invocation, id, parsed),
      );
    },
  } satisfies Route<typeof listContactBulkActionItems>;

  // Downloading an export is exporting: it needs the permission that starts one, and a
  // refusal is audited as a command's is.
  const fileLink = {
    endpoint: createContactExportLink,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'contact.bulk.export_file', permission: 'contacts.export' },
        invocation,
      );
      const { id } = parseInput(createContactExportLink.params, params);
      const file = await withTenant(services.db, invocation.context, (trx) =>
        readContactExportFile(trx, invocation, id),
      );
      const { files, apiUrl } = options;
      if (file === 'expired')
        throw new ConflictError(
          `This export's file was kept ${String(CONTACT_EXPORT_KEPT_DAYS)} days and has expired. Export the contacts again.`,
        );
      if (file === 'none' || files === undefined || apiUrl === undefined)
        throw new ConflictError('This action has no file to download.');
      // Only this link reaches an export's file: the general link of a file does not.
      const link = await files.link(services, invocation, toPublicId('file', file.fileId), {
        seconds: CONTACT_EXPORT_LINK_SECONDS,
        purpose: 'contact_export',
      });
      return { url: `${apiUrl}${link.path}`, expiresAt: link.expiresAt };
    },
  } satisfies Route<typeof createContactExportLink>;

  // What "Verify emails" would do, for its confirm dialog: read by whoever may start it.
  const preview = {
    endpoint: previewContactEmailChecks,
    async run({ invocation, body }, services) {
      await requirePermission(
        services,
        { name: 'contact.bulk.preview_email_checks', permission: 'contacts.manage' },
        invocation,
      );
      const input = parseInput(previewContactEmailChecks.body, body);
      return withTenant(services.db, invocation.context, (trx) =>
        previewEmailChecks(trx, invocation, input, options),
      );
    },
  } satisfies Route<typeof previewContactEmailChecks>;

  return [start, preview, list, read, cancel, items, fileLink];
}

/** The invocation a job of an action runs as: whoever started it, with the system's powers. */
function asStarter(
  job: Parameters<AnyTask['run']>[1],
  action: { readonly actorKind: string; readonly actorId: string | null },
): Invocation {
  // Every change is made as whoever started the action: their id is who acted, on each
  // contact's timeline and in the audit log. The job has the system's powers, since what
  // the action does was checked when it started, and is checked again before each batch.
  const actorKind = actorKinds.find((kind) => kind === action.actorKind) ?? 'system';
  return {
    ...job.invocation,
    context: {
      ...job.invocation.context,
      actorKind,
      ...(action.actorId === null ? {} : { actorId: action.actorId }),
      ...(actorKind === 'user' && action.actorId !== null ? { userId: action.actorId } : {}),
    },
    permissions: 'all',
  };
}

/**
 * The jobs of an action. One applies it, a batch at a time, each batch its own transaction,
 * and then writes an export's file; it can run more than once and two runs can overlap,
 * which the batch command makes safe (bulk.ts), so it only asks for batches until the
 * action has ended or waits for its next time. The other removes an export's file once it
 * has been kept thirty days.
 */
export function createContactBulkTasks(options: ContactBulkOptions): readonly AnyTask[] {
  const commands = contactBulkCommands(options);
  const run = defineTask({
    ...runContactBulkReference,
    async run({ bulkActionId }, job) {
      const { services } = job;
      const businessId = requireBusiness(job.invocation.context);
      const action = await withTenant(services.db, job.invocation.context, (trx) =>
        readContactBulkRun(trx, businessId, bulkActionId),
      );
      if (action === undefined) return;
      const invocation = asStarter(job, action);
      for (;;) {
        const { state } = await runCommand(
          services,
          commands.applyBatch,
          { bulkActionId },
          invocation,
        );
        if (state === 'more') continue;
        if (state === 'write_file')
          await runCommand(services, commands.finishExport, { bulkActionId }, invocation);
        return;
      }
    },
  });
  const expire = defineTask({
    ...expireContactExportReference,
    async run({ bulkActionId }, job) {
      await runCommand(
        job.services,
        commands.expireExport,
        { bulkActionId },
        { ...job.invocation, permissions: 'all' },
      );
    },
  });
  return [run, expire];
}
