import { requireBusiness, runCommand, type Route } from '@repo/commands';
import { createTag, ensureLeadSourceTags, listTags } from '@repo/contracts';
import { withTenant } from '@repo/db';

import { ensureLeadSourceTagsCommand } from './lead-source-tags.js';
import { createTagCommand, readTags } from './tags.js';

export const listTagsRoute = {
  endpoint: listTags,
  async run({ invocation }, { db }) {
    requireBusiness(invocation.context);
    return { items: await withTenant(db, invocation.context, readTags) };
  },
} satisfies Route<typeof listTags>;

export const createTagRoute = {
  endpoint: createTag,
  command: createTagCommand,
  run: ({ invocation, body }, services) => runCommand(services, createTagCommand, body, invocation),
} satisfies Route<typeof createTag>;

export const ensureLeadSourceTagsRoute = {
  endpoint: ensureLeadSourceTags,
  command: ensureLeadSourceTagsCommand,
  run: ({ invocation, body }, services) =>
    runCommand(services, ensureLeadSourceTagsCommand, body, invocation),
} satisfies Route<typeof ensureLeadSourceTags>;
