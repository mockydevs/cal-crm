import type { ApiRoute } from '@repo/commands';

export { resolveCalendarMember, readCalendarMemberMemberships } from './calendar-members.js';

import { getTwoFactorRequirementRoute, setTwoFactorRequirementRoute } from './agency/routes.js';
import { getMyPermissionsRoute } from './my-permissions.js';

export { builtInRoles, ensureAgency, type BuiltInRole } from './agency/install.js';
export { readApiKeyNames, type PeopleNames } from './api-keys/api-keys.js';
export { apiKeyRoutes, type ApiKeyOptions } from './api-keys/routes.js';
export { marketplaceRoutes, type MarketplaceOptions } from './marketplace/routes.js';
export { readAppsIntegration } from './integration-reading.js';
export {
  APP_WEBHOOK_SECRET_PURPOSE,
  createMarketplaceTasks,
  type AppWebhookOpener,
  type AppWebhookRetryDelay,
  type AppWebhookSealer,
  type SendAppWebhook,
} from './marketplace/webhooks.js';
export { readTwoFactorRequirement, requireTwoFactorCommand } from './agency/two-factor.js';
export { createBusinessCommand, slugFrom, type BusinessSeeder } from './businesses/businesses.js';
export { businessRoutes } from './businesses/routes.js';
export {
  businessProfileRoutes,
  readBusinessProfile,
  type CheckBusinessLogo,
} from './businesses/profile.js';
export { teamRoutes } from './team/routes.js';
export { userRoutes } from './users/routes.js';
export type { CheckAvatar } from './users/users.js';
export { lockActiveBusiness } from './calendar-business.js';
export { holdActiveBusiness } from './active-business.js';
export { readPersonGrants } from './grants.js';
export {
  resolveTaskAssignee,
  readTaskAssignees,
  readTaskAssigneeMemberships,
  readTeamMemberships,
  type EligibleTaskMember,
  type EligibleTaskMembersPage,
} from './task-assignees.js';

/** The tenancy module's API routes, for the server to register. */
export const tenancyRoutes: readonly ApiRoute[] = [
  getMyPermissionsRoute,
  getTwoFactorRequirementRoute,
  setTwoFactorRequirementRoute,
];
