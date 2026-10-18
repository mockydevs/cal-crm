// Contacts as an audience: who a smart list, some tags or a filter names, for whoever sends
// to many contacts at once (an email campaign). It is the contact list's own reading
// (list-scope.ts), so an audience is exactly the contacts the list would show.
//
// An audience is first made fixed: a smart list becomes the search and filter it holds
// now, and "added this week" becomes a date. What is fixed can be stored and read again
// later, in batches, and still means the same contacts.
import type { Invocation } from '@repo/commands';
import { contactFilter, contactViewState, type ContactFilter } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError } from '@repo/kernel';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import * as z from 'zod';

import { requireView } from '../views/views.js';
import type { FilterPeople } from './filters.js';
import { contactListScope } from './list-scope.js';

/** Who an audience is, as its sender describes it. */
export type ContactAudience =
  | { readonly kind: 'all' }
  | { readonly kind: 'smart_list'; readonly viewId: string }
  | {
      readonly kind: 'tags';
      readonly tagIds: readonly string[];
      readonly match: 'any' | 'all';
    }
  | { readonly kind: 'filter'; readonly filter: ContactFilter };

/** An audience with nothing left to look up: the contact list's own search and filters. */
export const fixedContactAudience = z.strictObject({
  q: z.string().optional(),
  createdFrom: z.string().optional(),
  filter: contactFilter.optional(),
  fieldId: z.string().optional(),
  fieldOperator: z.string().optional(),
  fieldValue: z.string().optional(),
});
export type FixedContactAudience = z.output<typeof fixedContactAudience>;

const DAY = 86_400_000;

/**
 * The audience as it is now. A smart list is read as whoever asks may read it: a private
 * view of someone else, a view of deals and a view that is gone are all not found.
 */
export async function fixContactAudience(
  trx: DatabaseTransaction,
  audience: ContactAudience,
): Promise<FixedContactAudience> {
  if (audience.kind === 'all') return {};
  if (audience.kind === 'filter') return { filter: audience.filter };
  if (audience.kind === 'tags')
    return {
      filter: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [
              {
                field: 'tags',
                operator: audience.match === 'all' ? 'all_of' : 'any_of',
                values: [...audience.tagIds],
              },
            ],
          },
        ],
      },
    };
  const view = await requireView(trx, audience.viewId);
  if (view.object_key !== 'contact') throw new NotFoundError('View', audience.viewId);
  const state = contactViewState.parse(
    Object.fromEntries(
      Object.entries(z.record(z.string(), z.unknown()).parse(view.filters)).filter(
        // What orders the list says nothing of who is in it.
        ([key]) => !['sort', 'direction', 'sortField', 'fieldOrder'].includes(key),
      ),
    ),
  );
  const {
    rows: [clock],
  } =
    state.added === undefined
      ? { rows: [] }
      : await sql<{ now: Date }>`select now() as now`.execute(trx);
  return {
    ...(state.q === undefined || state.q === '' ? {} : { q: state.q }),
    ...(state.added === undefined || clock === undefined
      ? {}
      : {
          createdFrom: new Date(
            clock.now.getTime() - (state.added === 'week' ? 7 : 30) * DAY,
          ).toISOString(),
        }),
    ...(state.filter === undefined ? {} : { filter: state.filter }),
    ...(state.fieldId === undefined ? {} : { fieldId: state.fieldId }),
    ...(state.fieldOperator === undefined ? {} : { fieldOperator: state.fieldOperator }),
    ...(state.fieldValue === undefined ? {} : { fieldValue: state.fieldValue }),
  };
}

/**
 * A fixed audience as a test of the contact `c`: of this business, not in the trash, and
 * kept by the audience's search and filters. A filter that names something the business no
 * longer has (a deleted tag or field) is a ValidationError, as on the contact list.
 */
export async function contactAudienceTest(
  trx: DatabaseTransaction,
  invocation: Invocation,
  audience: FixedContactAudience,
  people?: FilterPeople,
): Promise<RawBuilder<SqlBool>> {
  const scope = await contactListScope(
    trx,
    invocation,
    {
      q: audience.q,
      createdFrom: audience.createdFrom,
      filter: audience.filter === undefined ? undefined : JSON.stringify(audience.filter),
      fieldId: audience.fieldId,
      fieldOperator: z
        .enum(['equals', 'contains', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_unset'])
        .optional()
        .parse(audience.fieldOperator),
      fieldValue: audience.fieldValue,
    },
    people,
  );
  return scope.test;
}
