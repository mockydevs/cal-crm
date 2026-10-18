import { requireAgency, runCommand, type Route } from '@repo/commands';
import { getTwoFactorRequirement, setTwoFactorRequirement } from '@repo/contracts';
import { withTenant } from '@repo/db';

import { readTwoFactorRequirement, requireTwoFactorCommand } from './two-factor.js';

export const getTwoFactorRequirementRoute = {
  endpoint: getTwoFactorRequirement,
  run({ invocation }, { db }) {
    const agencyId = requireAgency(invocation.context);
    return withTenant(db, invocation.context, (trx) => readTwoFactorRequirement(trx, agencyId));
  },
} satisfies Route<typeof getTwoFactorRequirement>;

export const setTwoFactorRequirementRoute = {
  endpoint: setTwoFactorRequirement,
  command: requireTwoFactorCommand,
  run: ({ invocation, body }, services) =>
    runCommand(services, requireTwoFactorCommand, body, invocation),
} satisfies Route<typeof setTwoFactorRequirement>;
