import { readUserNames } from '@repo/module-auth';
import type { TaskOptions } from '@repo/module-crm';
import {
  readApiKeyNames,
  readTaskAssigneeMemberships,
  readTaskAssignees,
  resolveTaskAssignee,
} from '@repo/module-tenancy';

/** HTTP and automation task commands resolve the same current tenant memberships. */
export const taskOptions: TaskOptions = {
  actorNames: { user: readUserNames, api_key: readApiKeyNames },
  assignees: {
    resolve: resolveTaskAssignee,
    read: readTaskAssignees,
    memberships: readTaskAssigneeMemberships,
  },
};
