// The contact list: contacts not in the trash, in the order asked for, a page at a time.
// Which contacts it holds and how it is walked is list-scope.ts; this is the page: its
// rows, what each can also carry, and the cursor to the next. Every step reads an index, so
// a page costs the same whatever the size of the business.
import type { Invocation } from '@repo/commands';
import {
  CONTACT_PAGE_SIZE,
  contactListExtrasOf,
  contactListFieldsOf,
  type ContactList,
  type listContactsQuery,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import type * as z from 'zod';

import { countryOf } from './contacts.js';
import { readContactExtras } from './extras.js';
import type { FilterPeople } from './filters.js';
import { readListFields } from './list-fields.js';
import { contactListScope, type WalkedContact } from './list-scope.js';
import { asContactPhone } from './phones.js';
import { planFieldList } from '../fields/list-fields.js';

export { searchTerms, type SearchTerms } from './list-scope.js';

type ListQuery = z.output<typeof listContactsQuery>;

const afterUnknown = () =>
  new ValidationError([
    { path: '/after', code: 'unknown_contact', message: 'Start after a contact of this business.' },
  ]);

/** A page of the business's contacts, as the API shows it. */
export async function readContactList(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListQuery,
  people?: FilterPeople,
): Promise<ContactList> {
  const scope = await contactListScope(trx, invocation, query, people);
  const { businessId } = scope;
  // The order by a custom field, which has its own cursor (fields/list-fields.ts).
  const fields = await planFieldList(trx, businessId, 'contact', 'c', {
    sortField: query.sortField,
    fieldOrder: query.fieldOrder,
    after: query.after,
  });
  // The fields asked for as columns are checked before any row is read.
  const columns = await readListFields(trx, businessId, contactListFieldsOf(query.fields));

  const size = query.limit ?? CONTACT_PAGE_SIZE;
  const limit = size + 1;
  let rows: WalkedContact[];
  if (fields.order !== undefined && fields.sortId !== undefined) {
    rows = await scope.walkByField(fields, limit);
  } else {
    let anchor;
    if (query.after !== undefined) {
      const afterId = parsePublicId('contact', query.after);
      anchor = afterId === undefined ? undefined : await scope.anchorOf(query.sort, afterId);
      if (anchor === undefined) throw afterUnknown();
    }
    rows = await scope.walk(query.sort, query.direction, anchor, limit);
  }

  const page = rows.slice(0, size);
  const last = page.at(-1);
  const ids = page.map((row) => row.id);
  const country = await countryOf(trx, businessId);
  // Read for this page's contacts only, and only what the request names.
  const extras = await readContactExtras(trx, businessId, ids, contactListExtrasOf(query.include));
  const values = await columns(ids);
  return {
    items: page.map((row) => ({
      id: toPublicId('contact', row.id),
      name: row.display_name,
      email: row.email,
      phone: row.phone === null ? null : asContactPhone(row.phone, country),
      createdAt: row.created_at.toISOString(),
      ...extras(row.id),
      ...values(row.id),
    })),
    next: rows.length > size && last !== undefined ? toPublicId('contact', last.id) : null,
    canManage: invocation.permissions === 'all' || invocation.permissions.has('contacts.manage'),
  };
}
