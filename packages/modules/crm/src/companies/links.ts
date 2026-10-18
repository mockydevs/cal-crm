import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import { companyLinkCommandInput, companyLinkParams, type ContactCompanies } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { requireRecord } from '../records/access.js';
import { asCompany, companyColumns, readCompany } from './companies.js';

export const COMPANY_LINK_PAGE_SIZE = 50;
async function linkType(trx: DatabaseTransaction, from: string, to: string) {
  const row = await trx
    .selectFrom('crm.link_types')
    .select(['id', 'archived_at', 'allows_primary'])
    .where('key', '=', 'contact_company')
    .where('from_object_type_id', '=', from)
    .where('to_object_type_id', '=', to)
    .forShare()
    .executeTakeFirst();
  if (row?.archived_at !== null || !row.allows_primary)
    throw new ConflictError(
      'Company links are unavailable. Ask an administrator to check the link configuration.',
    );
  return row.id;
}
export async function readContactCompanies(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  after?: string,
): Promise<ContactCompanies> {
  const businessId = requireBusiness(invocation.context);
  const contact = await requireRecord(trx, id);
  let query = trx
    .selectFrom('crm.record_links as l')
    .innerJoin('crm.link_types as t', (join) =>
      join.onRef('t.business_id', '=', 'l.business_id').onRef('t.id', '=', 'l.link_type_id'),
    )
    .innerJoin('crm.companies as c', (join) =>
      join.onRef('c.business_id', '=', 'l.business_id').onRef('c.id', '=', 'l.to_record_id'),
    )
    .select(companyColumns.map((column) => `c.${column}` as const))
    .select(['l.is_primary', 'l.created_at as linked_at'])
    .where('l.business_id', '=', businessId)
    .where('l.from_record_id', '=', contact.id)
    .where('t.key', '=', 'contact_company');
  if (after !== undefined) {
    const uuid = parsePublicId('company', after);
    const anchor =
      uuid === undefined
        ? undefined
        : await query.where('c.id', '=', uuid).select('c.id').executeTakeFirst();
    if (anchor === undefined)
      throw new ValidationError([
        {
          path: '/after',
          code: 'unknown_company',
          message: 'Start after a company linked to this contact.',
        },
      ]);
    query = query.where('c.id', '<', anchor.id);
  }
  const rows = await query
    .orderBy('c.id', 'desc')
    .limit(COMPANY_LINK_PAGE_SIZE + 1)
    .execute();
  const page = rows.slice(0, COMPANY_LINK_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      company: asCompany(row, invocation),
      isPrimary: row.is_primary,
      linkedAt: row.linked_at.toISOString(),
    })),
    next:
      rows.length > COMPANY_LINK_PAGE_SIZE && last !== undefined
        ? toPublicId('company', last.id)
        : null,
    canManage:
      !contact.trashed &&
      (invocation.permissions === 'all' || invocation.permissions.has('contacts.manage')),
  };
}

export const linkContactCompanyCommand = defineCommand({
  name: 'contact.link_company',
  permission: 'contacts.manage',
  input: companyLinkCommandInput,
  async handle(trx, input, command) {
    const businessId = requireBusiness(command.context);
    // Every link change takes the contact first. Its entity lock also serializes with trash.
    const contact = await requireRecord(trx, input.id, true);
    const company = await requireRecord(trx, input.companyId, true);
    const typeId = await linkType(trx, contact.objectTypeId, company.objectTypeId);
    const existing = await trx
      .selectFrom('crm.record_links')
      .select(['id', 'is_primary'])
      .where('from_record_id', '=', contact.id)
      .where('to_record_id', '=', company.id)
      .where('link_type_id', '=', typeId)
      .executeTakeFirst();
    const primary = input.primary ?? existing?.is_primary ?? false;
    const changedRecords = new Set([contact.id, company.id]);
    if (existing?.is_primary !== primary) {
      if (primary) {
        const previous = await trx
          .updateTable('crm.record_links')
          .set({ is_primary: false })
          .where('from_record_id', '=', contact.id)
          .where('link_type_id', '=', typeId)
          .where('is_primary', '=', true)
          .returning('to_record_id')
          .execute();
        for (const row of previous) changedRecords.add(row.to_record_id);
      }
      const source = {
        source_kind: command.context.actorKind,
        source_id: command.context.actorId ?? null,
      };
      if (existing === undefined) {
        await trx
          .insertInto('crm.record_links')
          .values({
            business_id: businessId,
            link_type_id: typeId,
            from_record_id: contact.id,
            to_record_id: company.id,
            is_primary: primary,
            ...source,
          })
          .execute();
      } else {
        await trx
          .updateTable('crm.record_links')
          .set({ is_primary: primary, ...source })
          .where('id', '=', existing.id)
          .execute();
      }
      await command.emit({
        type: existing === undefined ? 'contact.company_linked' : 'contact.company_link_changed',
        subject: { kind: 'contact', id: contact.id },
        records: [...changedRecords],
        payload: { companyId: input.companyId, primary },
      });
    }
    const row = await trx
      .selectFrom('crm.record_links')
      .select('created_at')
      .where('from_record_id', '=', contact.id)
      .where('to_record_id', '=', company.id)
      .where('link_type_id', '=', typeId)
      .executeTakeFirstOrThrow();
    return {
      company: await readCompany(trx, command, input.companyId),
      isPrimary: primary,
      linkedAt: row.created_at.toISOString(),
    };
  },
});
export const unlinkContactCompanyCommand = defineCommand({
  name: 'contact.unlink_company',
  permission: 'contacts.manage',
  input: companyLinkParams,
  async handle(trx, input, command): Promise<undefined> {
    requireBusiness(command.context);
    const contact = await requireRecord(trx, input.id, true);
    // Removing a contact-owned association is allowed even when its company is in trash.
    // The contact lock serializes removals and primary changes; no company entity changes.
    const company = await requireRecord(trx, input.companyId);
    const typeId = await linkType(trx, contact.objectTypeId, company.objectTypeId);
    const removed = await trx
      .deleteFrom('crm.record_links')
      .where('from_record_id', '=', contact.id)
      .where('to_record_id', '=', company.id)
      .where('link_type_id', '=', typeId)
      .returning('id')
      .execute();
    if (removed.length > 0)
      await command.emit({
        type: 'contact.company_unlinked',
        subject: { kind: 'contact', id: contact.id },
        records: [contact.id, company.id],
        payload: { companyId: input.companyId },
      });
    return undefined;
  },
});
