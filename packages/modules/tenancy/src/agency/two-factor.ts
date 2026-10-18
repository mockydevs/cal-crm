// Whether the agency requires its staff to sign in with two factors. Sign-in reads it
// through crm_auth (@repo/module-auth); agency staff change it here.
import { defineCommand, requireAgency } from '@repo/commands';
import { twoFactorRequirement, type TwoFactorRequirement } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';

export const requireTwoFactorCommand = defineCommand({
  name: 'agency.require_two_factor',
  permission: 'agency.security',
  input: twoFactorRequirement,
  async handle(trx, input, command): Promise<TwoFactorRequirement> {
    const agencyId = requireAgency(command.context);
    const row = await trx
      .updateTable('tenancy.agencies')
      .set({ two_factor_required: input.required })
      .where('id', '=', agencyId)
      .returning('two_factor_required')
      .executeTakeFirstOrThrow();
    await command.emit({
      type: 'agency.two_factor_requirement_changed',
      subject: { kind: 'agency', id: agencyId },
      payload: { required: row.two_factor_required },
    });
    return { required: row.two_factor_required };
  },
});

/** The requirement of the transaction's agency. */
export async function readTwoFactorRequirement(
  trx: DatabaseTransaction,
  agencyId: string,
): Promise<TwoFactorRequirement> {
  const row = await trx
    .selectFrom('tenancy.agencies')
    .select('two_factor_required')
    .where('id', '=', agencyId)
    .executeTakeFirstOrThrow();
  return { required: row.two_factor_required };
}
