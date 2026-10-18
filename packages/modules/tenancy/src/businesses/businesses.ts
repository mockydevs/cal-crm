// Creating a business: agency staff, at the agency, add one of their clients. Each module
// seeds what a new business starts with, inside the same transaction.
import { defineCommand, requireAgency, type Command } from '@repo/commands';
import { createBusinessInput, type Business } from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';

/**
 * Seeds what a new business starts with, such as the CRM's object types. It runs with the
 * transaction acting in the new business, so row-level security lets it write there.
 */
export type BusinessSeeder = (trx: DatabaseTransaction, businessId: string) => Promise<void>;

const columns = [
  'id',
  'name',
  'slug',
  'status',
  'timezone',
  'currency',
  'locale',
  'created_at',
] as const;

interface BusinessRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  currency: string;
  locale: string;
  created_at: Date;
}

const statuses = ['active', 'suspended', 'archived'] as const;

/** A business as the API shows it. */
function asBusiness(row: BusinessRow): Business {
  const status = statuses.find((each) => each === row.status);
  if (status === undefined) throw new Error(`Unknown business status: ${row.status}`);
  return {
    id: toPublicId('business', row.id),
    name: row.name,
    slug: row.slug,
    status,
    timezone: row.timezone,
    currency: row.currency,
    locale: row.locale,
    createdAt: row.created_at.toISOString(),
  };
}

const SLUG_LENGTH = 63;

/** A business's address, from its name: lower-case letters, digits and hyphens. */
export function slugFrom(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? 'business' : slug;
}

/** The slug, or the first of slug-2, slug-3… that no business of the agency has. */
async function freeSlug(trx: DatabaseTransaction, slug: string): Promise<string> {
  const taken = new Set(
    (
      await trx
        .selectFrom('tenancy.businesses')
        .select('slug')
        .where((eb) => eb.or([eb('slug', '=', slug), eb('slug', 'like', `${slug}-%`)]))
        .execute()
    ).map((row) => row.slug),
  );
  for (let suffix = 1; ; suffix += 1) {
    const ending = suffix === 1 ? '' : `-${String(suffix)}`;
    const candidate = `${slug.slice(0, SLUG_LENGTH - ending.length).replace(/-+$/, '')}${ending}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Waits until no other business.create of the agency is choosing an address, and holds
 * the turn until this transaction ends. Two made at once with one name then get slug and
 * slug-2, rather than the second being refused for an address it never chose.
 */
async function lockAddresses(trx: DatabaseTransaction, agencyId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`crm.business-address:${agencyId}`}))`.execute(
    trx,
  );
}

/** Points the transaction's tenant context at a business, or back at the agency. */
async function actIn(trx: DatabaseTransaction, businessId: string | undefined): Promise<void> {
  await sql`select set_config('app.business_id', ${businessId ?? ''}, true)`.execute(trx);
}

export function createBusinessCommand(
  seeders: readonly BusinessSeeder[],
): Command<typeof createBusinessInput, Business> {
  return defineCommand({
    name: 'business.create',
    permission: 'businesses.create',
    input: createBusinessInput,
    async handle(trx, input, command): Promise<Business> {
      const agencyId = requireAgency(command.context);
      await lockAddresses(trx, agencyId);
      const row = await trx
        .insertInto('tenancy.businesses')
        .values({
          agency_id: agencyId,
          name: input.name,
          slug: input.slug ?? (await freeSlug(trx, slugFrom(input.name))),
          timezone: input.timezone,
          currency: input.currency,
          locale: input.locale,
        })
        .returning(columns)
        .executeTakeFirstOrThrow()
        .catch(
          explainUniqueViolation({
            businesses_slug_unique: () =>
              new ValidationError([
                {
                  path: '/slug',
                  code: 'taken',
                  message: 'Another business of the agency has this address.',
                },
              ]),
          }),
        );
      // Each module writes the new business's rows as that business; the event and the
      // audit row are then the agency's again.
      await actIn(trx, row.id);
      for (const seed of seeders) await seed(trx, row.id);
      await actIn(trx, undefined);
      await command.emit({
        type: 'business.created',
        subject: { kind: 'business', id: row.id },
        payload: { name: row.name, slug: row.slug },
      });
      return asBusiness(row);
    },
  });
}
