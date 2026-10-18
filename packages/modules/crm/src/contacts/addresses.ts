// One of a contact's email addresses or phone numbers at a time: add one, label a phone
// number, make one the primary, remove it. These are the same rows the contact command
// replaces as lists (contacts.ts), claimed the same way, so an address still belongs to one
// contact in a business whichever way it arrives, and a contact still has at most ten of
// each kind and something to know it by.
//
// Each change is reported as the contact command reports it: contact.updated, with `emails`
// or `phones` as the field that changed and no values.
import { defineCommand, requireBusiness, type Command, type CommandContext } from '@repo/commands';
import {
  addContactAddressCommandInput,
  MAX_CONTACT_IDENTITIES,
  removeContactAddressCommandInput,
  updateContactAddressCommandInput,
  type ContactDetails,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';

import { claim, countryOf, makePrimary, type IdentityKind } from './contacts.js';
import {
  addressesRevisionOf,
  lockLiveContact,
  readAddressRows,
  readContactDetails,
  requireRevision,
  touchContact,
  type AddressRow,
  type ContactDetailOptions,
} from './details.js';
import { normalizePhone } from './phones.js';

const words = {
  email: { field: 'emails', one: 'email address', many: 'email addresses' },
  phone: { field: 'phones', one: 'phone number', many: 'phone numbers' },
} as const;

const refuse = (code: string, message: string, path = '/value') =>
  new ValidationError([{ path, code, message }]);

/**
 * Refuses a label another of the contact's numbers has: a contact uses each label once, as
 * GoHighLevel has it. The database holds the same rule (contact_identities_one_label_idx);
 * this says so on the field, in words.
 */
function requireFreeLabel(
  rows: readonly AddressRow[],
  label: string | null | undefined,
  except?: string,
): void {
  if (label === null || label === undefined) return;
  if (rows.some((row) => row.label === label && row.id !== except))
    throw refuse('label_taken', 'Another of this contact’s numbers has this label.', '/label');
}

/** Says the contact changed, as the contact command does when its identities do. */
async function reportChange(
  trx: DatabaseTransaction,
  command: CommandContext,
  businessId: string,
  contactId: string,
  kind: IdentityKind,
): Promise<void> {
  await touchContact(trx, businessId, contactId);
  // Which field changed, not its value: events can't be erased.
  await command.emit({
    type: 'contact.updated',
    subject: { kind: 'contact', id: contactId },
    payload: { changed: [words[kind].field] },
    records: [contactId],
  });
}

/** The contact's address a path names, or not found. An id of another contact's finds none. */
function addressOf(rows: readonly AddressRow[], id: string): AddressRow & { kind: IdentityKind } {
  const uuid = parsePublicId('contact_identity', id);
  const row = rows.find((each) => each.id === uuid);
  if (row === undefined) throw new NotFoundError('Address', id);
  return { ...row, kind: row.kind === 'email' ? 'email' : 'phone' };
}

export function addContactAddressCommand(
  options: ContactDetailOptions,
): Command<typeof addContactAddressCommandInput, ContactDetails> {
  return defineCommand({
    name: 'contact.add_address',
    permission: 'contacts.manage',
    input: addContactAddressCommandInput,
    // Which contact and what kind of address, never the address: the audit log outlives it.
    audit: ({ id, kind, label }) => ({ id, kind, label }),
    async handle(trx, input, command): Promise<ContactDetails> {
      const businessId = requireBusiness(command.context);
      const contact = await lockLiveContact(trx, businessId, input.id);
      const { kind } = input;
      const normalized =
        kind === 'email'
          ? input.value.toLowerCase()
          : normalizePhone(input.value, await countryOf(trx, businessId));
      if (typeof normalized !== 'string') throw refuse(normalized.code, normalized.message);
      const rows = await readAddressRows(trx, businessId, contact.id);
      const ofKind = rows.filter((row) => row.kind === kind);
      requireFreeLabel(rows, input.label);
      if (ofKind.some((row) => row.value_normalized === normalized))
        throw refuse('repeated', `The contact already has this ${words[kind].one}.`);
      if (ofKind.length >= MAX_CONTACT_IDENTITIES)
        throw refuse(
          'too_many',
          `A contact has at most ${String(MAX_CONTACT_IDENTITIES)} ${words[kind].many}.`,
        );
      // The first of its kind is the primary; a later one never changes which is.
      const issues = await claim(
        trx,
        businessId,
        contact.id,
        [{ kind, value: kind === 'email' ? normalized : input.value, normalized }],
        ofKind.length === 0,
      );
      const [first, ...rest] = issues.map((issue) => ({ ...issue, path: '/value' }));
      if (first !== undefined) throw new ValidationError([first, ...rest]);
      if (input.label !== null)
        await trx
          .updateTable('crm.contact_identities')
          .set({ label: input.label })
          .where('business_id', '=', businessId)
          .where('contact_id', '=', contact.id)
          .where('kind', '=', kind)
          .where('value_normalized', '=', normalized)
          .execute();
      await reportChange(trx, command, businessId, contact.id, kind);
      return readContactDetails(trx, command, input.id, options);
    },
  });
}

export function updateContactAddressCommand(
  options: ContactDetailOptions,
): Command<typeof updateContactAddressCommandInput, ContactDetails> {
  return defineCommand({
    name: 'contact.update_address',
    permission: 'contacts.manage',
    input: updateContactAddressCommandInput,
    async handle(trx, input, command): Promise<ContactDetails> {
      const businessId = requireBusiness(command.context);
      const contact = await lockLiveContact(trx, businessId, input.id);
      const rows = await readAddressRows(trx, businessId, contact.id);
      const address = addressOf(rows, input.addressId);
      requireRevision("This contact's addresses", addressesRevisionOf(rows), input.revision);
      const relabel = input.label !== undefined && input.label !== address.label;
      if (relabel && input.label !== null && address.kind !== 'phone')
        throw refuse('label_not_for_email', 'Only a phone number has a label.', '/label');
      if (relabel) requireFreeLabel(rows, input.label, address.id);
      const promote = input.primary === true && !address.is_primary;
      if (relabel)
        await trx
          .updateTable('crm.contact_identities')
          .set({ label: input.label ?? null })
          .where('business_id', '=', businessId)
          .where('id', '=', address.id)
          .execute();
      if (promote)
        await makePrimary(trx, businessId, contact.id, address.kind, {
          kind: address.kind,
          value: address.value_normalized,
          normalized: address.value_normalized,
        });
      if (relabel || promote)
        await reportChange(trx, command, businessId, contact.id, address.kind);
      return readContactDetails(trx, command, input.id, options);
    },
  });
}

export function removeContactAddressCommand(
  options: ContactDetailOptions,
): Command<typeof removeContactAddressCommandInput, ContactDetails> {
  return defineCommand({
    name: 'contact.remove_address',
    permission: 'contacts.manage',
    input: removeContactAddressCommandInput,
    async handle(trx, input, command): Promise<ContactDetails> {
      const businessId = requireBusiness(command.context);
      const contact = await lockLiveContact(trx, businessId, input.id);
      const rows = await readAddressRows(trx, businessId, contact.id);
      const address = addressOf(rows, input.addressId);
      requireRevision("This contact's addresses", addressesRevisionOf(rows), input.revision);
      if (contact.first_name === null && contact.last_name === null && rows.length === 1)
        throw new ValidationError([
          {
            path: '',
            code: 'contact_empty',
            message: 'Give the contact a name, an email address or a phone number.',
          },
        ]);
      // A message already queued to it is refused at dispatch (recipient_changed), as when
      // the contact command drops an address.
      await trx
        .deleteFrom('crm.contact_identities')
        .where('business_id', '=', businessId)
        .where('id', '=', address.id)
        .execute();
      if (address.is_primary) {
        // The oldest of the rest takes its place; readAddressRows orders by id, which is by
        // the time each was added.
        const next = rows.find((row) => row.kind === address.kind && row.id !== address.id);
        if (next !== undefined)
          await makePrimary(trx, businessId, contact.id, address.kind, {
            kind: address.kind,
            value: next.value_normalized,
            normalized: next.value_normalized,
          });
      }
      await reportChange(trx, command, businessId, contact.id, address.kind);
      return readContactDetails(trx, command, input.id, options);
    },
  });
}
