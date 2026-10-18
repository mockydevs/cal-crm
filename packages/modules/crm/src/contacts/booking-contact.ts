import { requireBusiness } from '@repo/commands';
import { parseInput } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, toPublicId, type TenantContext } from '@repo/kernel';
import * as z from 'zod';
import { lockContact } from './contacts.js';

const inputSchema = z.strictObject({ contactId: z.uuid() });

/** The private management command derives this contact from its locked appointment scope. */
export async function lockBookingContact(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: { readonly contactId: string },
): Promise<boolean> {
  const { contactId } = parseInput(inputSchema, input);
  const businessId = requireBusiness(context);
  try {
    const contact = await lockContact(trx, businessId, toPublicId('contact', contactId));
    return contact.deleted_at === null;
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}
