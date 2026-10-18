// The routes of merging contacts: the preview the merge dialog reads, and the merge. Both are
// Manage Duplicates' (contacts.merge), which GoHighLevel gives admins only.
import { requirePermission, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  mergeContacts,
  mergeContactsInput,
  parseInput,
  previewContactMerge,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import {
  mergeContactsCommand,
  readContactMergePreview,
  type ContactMergeOptions,
} from './merge.js';

/** The routes, with each module's part in a merge as the server hands them in. */
export function contactMergeRoutes(options: ContactMergeOptions): readonly ApiRoute[] {
  const command = mergeContactsCommand(options);

  // Seeing what a merge would move is part of merging: a refusal is audited as a command's is.
  const preview = {
    endpoint: previewContactMerge,
    async run({ invocation, params, query }, services) {
      await requirePermission(
        services,
        { name: 'contact_merge.preview', permission: 'contacts.merge' },
        invocation,
      );
      const { id } = parseInput(previewContactMerge.params, params);
      const { mergeIds } = parseInput(previewContactMerge.query, query);
      return withTenant(services.db, invocation.context, (trx) =>
        readContactMergePreview(trx, invocation, id, mergeIds, options),
      );
    },
  } satisfies Route<typeof previewContactMerge>;

  // The body's issues point into the body, as the caller sent it; the id comes from the path.
  const merge = {
    endpoint: mergeContacts,
    command,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        command,
        { ...parseInput(mergeContactsInput, body), ...parseInput(mergeContacts.params, params) },
        invocation,
      ),
  } satisfies Route<typeof mergeContacts>;

  return [preview, merge];
}
