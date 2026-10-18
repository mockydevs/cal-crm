// A contact's neighbours in a list: the contact before it, the one after it and its place,
// in the list the request's search, filters and order describe. The contact page reads
// this, so "3/36" and its two arrows survive a reload and a shared link: the list is in the
// address, and the place is read again from it.
import type { Invocation } from '@repo/commands';
import {
  CONTACT_COUNT_LIMIT,
  type ContactNeighbours,
  type contactNeighboursQuery,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import type * as z from 'zod';

import type { FilterPeople } from './filters.js';
import { contactListScope, type WalkedContact } from './list-scope.js';

type NeighboursQuery = z.output<typeof contactNeighboursQuery>;

const NOT_IN_LIST: ContactNeighbours = {
  inList: false,
  previous: null,
  next: null,
  position: null,
};

const asNeighbour = (row: WalkedContact | undefined) =>
  row === undefined ? null : { id: toPublicId('contact', row.id), name: row.display_name };

export async function readContactNeighbours(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  query: NeighboursQuery,
  people?: FilterPeople,
): Promise<ContactNeighbours> {
  const scope = await contactListScope(trx, invocation, query, people);
  const contactId = parsePublicId('contact', id);
  // A contact of another business is not found, as everywhere. One of this business that
  // the list does not hold (a filter no longer keeps it, or it is in the trash) has no
  // place in it, and that is an answer, not an error: the page still shows the contact.
  const known =
    contactId === undefined
      ? undefined
      : await trx
          .selectFrom('crm.contacts')
          .select('id')
          .where('business_id', '=', scope.businessId)
          .where('id', '=', contactId)
          .executeTakeFirst();
  if (known === undefined) throw new NotFoundError('Contact', id);
  const anchor = await scope.anchorOf(query.sort, known.id, true);
  if (anchor === undefined) return NOT_IN_LIST;
  const [next] = await scope.walk(query.sort, query.direction, anchor, 1);
  const [previous] = await scope.walk(query.sort, query.direction, anchor, 1, true);
  // The whole list is counted from its index to any depth. A search or a filter is tested
  // contact by contact, so its place is counted as far as the list's own count goes.
  const before = await scope.before(
    query.sort,
    query.direction,
    anchor,
    scope.narrowed ? CONTACT_COUNT_LIMIT + 1 : undefined,
  );
  return {
    inList: true,
    previous: asNeighbour(previous),
    next: asNeighbour(next),
    position: scope.narrowed && before > CONTACT_COUNT_LIMIT ? null : before + 1,
  };
}
