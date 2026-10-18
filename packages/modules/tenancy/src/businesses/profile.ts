import {
  defineCommand,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Command,
} from '@repo/commands';
import {
  getBusinessProfile,
  updateBusinessProfile,
  updateBusinessProfileInput,
  type BusinessProfile,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction, type DB } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import type { Selectable } from 'kysely';
import * as z from 'zod';

/** The files module checks ownership and type in the same transaction as the change. */
export type CheckBusinessLogo = (
  trx: DatabaseTransaction,
  businessId: string,
  fileId: string,
) => Promise<void>;
// What's stored may come from an import, a fix by hand or a later release. A read keeps
// the fields it knows, empty where one is missing or not valid, and ignores the rest,
// rather than failing the page. Writes still go through the strict businessAddress.
const text = z.string().catch('');
const storedAddress = z
  .object({
    line1: text,
    line2: text,
    city: text,
    region: text,
    postalCode: text,
    country: z
      .string()
      .regex(/^(?:[A-Z]{2})?$/)
      .catch(''),
  })
  .nullable()
  .catch(null);

const canManage = (invocation: Invocation) =>
  invocation.permissions === 'all' || invocation.permissions.has('business.profile');
function asProfile(
  row: Selectable<DB['tenancy.businesses']>,
  invocation: Invocation,
): BusinessProfile {
  return {
    id: toPublicId('business', row.id),
    name: row.name,
    timezone: row.timezone,
    currency: row.currency,
    locale: row.locale,
    address: storedAddress.parse(row.address),
    logoFileId: row.logo_file_id === null ? null : toPublicId('file', row.logo_file_id),
    canManage: canManage(invocation),
  };
}
/** The profile of the business the invocation works in, as Settings shows it. */
export async function readBusinessProfile(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<BusinessProfile> {
  const id = requireBusiness(invocation.context);
  const row = await trx
    .selectFrom('tenancy.businesses')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Business', toPublicId('business', id));
  return asProfile(row, invocation);
}
export function updateProfileCommand(
  checkLogo: CheckBusinessLogo,
): Command<typeof updateBusinessProfileInput, BusinessProfile> {
  return defineCommand({
    name: 'business.update_profile',
    permission: 'business.profile',
    input: updateBusinessProfileInput,
    async handle(trx, input, command): Promise<BusinessProfile> {
      const id = requireBusiness(command.context);
      if (input.logoFileId !== null) await checkLogo(trx, id, input.logoFileId);
      const row = await trx
        .updateTable('tenancy.businesses')
        .set({
          name: input.name,
          timezone: input.timezone,
          currency: input.currency,
          locale: input.locale,
          address: input.address,
          logo_file_id: input.logoFileId === null ? null : parsePublicId('file', input.logoFileId),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError('Business', toPublicId('business', id));
      await command.emit({
        type: 'business.profile_updated',
        subject: { kind: 'business', id },
        payload: { name: row.name },
      });
      return asProfile(row, command);
    },
  });
}
export function businessProfileRoutes(checkLogo: CheckBusinessLogo): ApiRoute[] {
  const command = updateProfileCommand(checkLogo);
  return [
    {
      endpoint: getBusinessProfile,
      run: ({ invocation }, { db }) =>
        withTenant(db, invocation.context, (trx) => readBusinessProfile(trx, invocation)),
    },
    {
      endpoint: updateBusinessProfile,
      command,
      run: ({ invocation, body }, services) => runCommand(services, command, body, invocation),
    },
  ];
}
