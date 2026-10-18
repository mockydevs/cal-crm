import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  companyIdInput,
  createCompanyInput,
  updateCompanyCommandInput,
  type Actor,
  type Company,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction, type DB } from '@repo/db';
import {
  actorKinds,
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql, type Selectable } from 'kysely';
import { namesOf, type ActorNames } from '../activity/activity.js';
import { countryOf } from '../contacts/contacts.js';
import { normalizePhone } from '../contacts/phones.js';

/**
 * What the Companies list shows beside the name, phone and domain (migration 0068): each
 * key of a company as it is served, and the column that holds it.
 */
export const companyDetailColumns = {
  email: 'email',
  website: 'website',
  address: 'address_line',
  city: 'city',
  state: 'state',
  postalCode: 'postal_code',
  country: 'country',
  description: 'description',
} as const;
type DetailKey = keyof typeof companyDetailColumns;
const detailKeys = Object.keys(companyDetailColumns) as DetailKey[];

export const companyColumns = [
  'id',
  'name',
  'domain',
  'phone_e164',
  'email',
  'website',
  'address_line',
  'city',
  'state',
  'postal_code',
  'country',
  'description',
  'created_by_kind',
  'created_by_id',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;
export type CompanyRow = Pick<Selectable<DB['crm.companies']>, (typeof companyColumns)[number]>;

/** Who made each of these companies, by `kind:id`, as far as the reader may see a name. */
export function creatorNamesOf(
  trx: DatabaseTransaction,
  rows: readonly Pick<CompanyRow, 'created_by_kind' | 'created_by_id'>[],
  actorNames: ActorNames,
): Promise<ReadonlyMap<string, string>> {
  return namesOf(
    trx,
    rows.map((row) => ({ actor_kind: creatorKind(row), actor_id: row.created_by_id })),
    actorNames,
  );
}
/** The kind of actor that made a company; a kind this version does not know is the system. */
function creatorKind(row: Pick<CompanyRow, 'created_by_kind'>): Actor['kind'] {
  return actorKinds.find((kind) => kind === row.created_by_kind) ?? 'system';
}

/**
 * A company as it is served. With the names of who made companies it says who made this
 * one; without them (a contact's company links) it leaves that out.
 */
export function asCompany(
  row: CompanyRow,
  invocation: Invocation,
  creators?: ReadonlyMap<string, string>,
): Company {
  const kind = creatorKind(row);
  return {
    id: toPublicId('company', row.id),
    name: row.name,
    domain: row.domain,
    phone: row.phone_e164,
    email: row.email,
    website: row.website,
    address: row.address_line,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    description: row.description,
    ...(creators === undefined
      ? {}
      : {
          createdBy: {
            kind,
            name:
              row.created_by_id === null
                ? null
                : (creators.get(`${kind}:${row.created_by_id}`) ?? null),
            you:
              kind === 'user' &&
              invocation.context.actorKind === 'user' &&
              row.created_by_id === invocation.context.userId,
          },
        }),
    trashedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('companies.manage'),
  };
}
export function companyUuid(id: string): string {
  const uuid = parsePublicId('company', id);
  if (uuid === undefined) throw new NotFoundError('Company', id);
  return uuid;
}
export const domainError = explainUniqueViolation({
  companies_domain_unique_idx: () =>
    new ValidationError([
      {
        path: '/domain',
        code: 'taken',
        message:
          'Another company uses this domain. Choose that company or enter a different domain.',
      },
    ]),
});
export async function companyPhone(
  trx: DatabaseTransaction,
  businessId: string,
  phone: string | null,
): Promise<string | null> {
  if (phone === null) return null;
  const normalized = normalizePhone(phone, await countryOf(trx, businessId));
  if (typeof normalized !== 'string')
    throw new ValidationError([{ path: '/phone', ...normalized }]);
  return normalized;
}
/** A detail as stored: left out, null and blank are all none. */
const stored = (value: string | null | undefined): string | null =>
  value === undefined || value === '' ? null : value;

export async function readCompany(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  actorNames: ActorNames = {},
): Promise<Company> {
  const businessId = requireBusiness(invocation.context);
  const row = await trx
    .selectFrom('crm.companies')
    .select(companyColumns)
    .where('business_id', '=', businessId)
    .where('id', '=', companyUuid(id))
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Company', id);
  return asCompany(row, invocation, await creatorNamesOf(trx, [row], actorNames));
}

async function lockCompany(trx: DatabaseTransaction, businessId: string, id: string) {
  const row = await trx
    .selectFrom('crm.companies')
    .select(companyColumns)
    .where('business_id', '=', businessId)
    .where('id', '=', companyUuid(id))
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Company', id);
  return row;
}
async function setTrashed(
  trx: DatabaseTransaction,
  id: string,
  command: CommandContext,
  trashed: boolean,
  actorNames: ActorNames,
): Promise<Company> {
  const businessId = requireBusiness(command.context);
  const row = await lockCompany(trx, businessId, id);
  if ((row.deleted_at !== null) !== trashed) {
    await trx
      .updateTable('crm.companies')
      .set({ deleted_at: trashed ? sql<Date>`now()` : null })
      .where('business_id', '=', businessId)
      .where('id', '=', row.id)
      .execute()
      .catch(domainError);
    await command.emit({
      type: trashed ? 'company.trashed' : 'company.restored',
      subject: { kind: 'company', id: row.id },
      records: [row.id],
    });
  }
  return readCompany(trx, command, id, actorNames);
}

export interface CompanyCommands {
  readonly create: Command<typeof createCompanyInput, Company>;
  readonly update: Command<typeof updateCompanyCommandInput, Company>;
  readonly trash: Command<typeof companyIdInput, Company>;
  readonly restore: Command<typeof companyIdInput, Company>;
}

/**
 * The commands on a company. Each answers the company as it now is, which names who made
 * it: `actorNames` is how the server reads that name.
 */
export function companyCommands(actorNames: ActorNames = {}): CompanyCommands {
  return {
    create: defineCommand({
      name: 'company.create',
      permission: 'companies.manage',
      input: createCompanyInput,
      async handle(trx, input, command): Promise<Company> {
        const businessId = requireBusiness(command.context);
        const phone = await companyPhone(trx, businessId, input.phone);
        const object = await trx
          .selectFrom('crm.object_types')
          .select('id')
          .where('business_id', '=', businessId)
          .where('kind', '=', 'company')
          .executeTakeFirstOrThrow();
        const { id } = await trx
          .insertInto('crm.records')
          .values({ business_id: businessId, kind: 'company', object_type_id: object.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('crm.companies')
          .values({
            business_id: businessId,
            id,
            name: input.name,
            domain: input.domain,
            phone_e164: phone,
            email: stored(input.email),
            website: stored(input.website),
            address_line: stored(input.address),
            city: stored(input.city),
            state: stored(input.state),
            postal_code: stored(input.postalCode),
            country: stored(input.country),
            description: stored(input.description),
            created_by_kind: command.context.actorKind,
            created_by_id: command.context.actorId ?? null,
          })
          .execute()
          .catch(domainError);
        await command.emit({
          type: 'company.created',
          subject: { kind: 'company', id },
          records: [id],
        });
        return readCompany(trx, command, toPublicId('company', id), actorNames);
      },
    }),
    update: defineCommand({
      name: 'company.update',
      permission: 'companies.manage',
      input: updateCompanyCommandInput,
      async handle(trx, input, command): Promise<Company> {
        const businessId = requireBusiness(command.context);
        const row = await lockCompany(trx, businessId, input.id);
        if (row.deleted_at !== null)
          throw new ConflictError('Restore this company before changing it.');
        const name = input.name ?? row.name;
        const domain = input.domain === undefined ? row.domain : input.domain;
        const phone =
          input.phone === undefined
            ? row.phone_e164
            : await companyPhone(trx, businessId, input.phone);
        // A detail left out stays as it is; null or blank removes it.
        const details = Object.fromEntries(
          detailKeys.flatMap((key) =>
            input[key] === undefined || stored(input[key]) === row[companyDetailColumns[key]]
              ? []
              : [[companyDetailColumns[key], stored(input[key])] as const],
          ),
        );
        const changed = [
          ...(name === row.name ? [] : ['name']),
          ...(domain === row.domain ? [] : ['domain']),
          ...(phone === row.phone_e164 ? [] : ['phone']),
          ...detailKeys.filter((key) => companyDetailColumns[key] in details),
        ];
        if (changed.length > 0) {
          await trx
            .updateTable('crm.companies')
            .set({ name, domain, phone_e164: phone, ...details })
            .where('business_id', '=', businessId)
            .where('id', '=', row.id)
            .execute()
            .catch(domainError);
          await command.emit({
            type: 'company.updated',
            subject: { kind: 'company', id: row.id },
            records: [row.id],
            payload: { changed },
          });
        }
        return readCompany(trx, command, input.id, actorNames);
      },
    }),
    trash: defineCommand({
      name: 'company.trash',
      permission: 'companies.manage',
      input: companyIdInput,
      handle: (trx, input, command) => setTrashed(trx, input.id, command, true, actorNames),
    }),
    restore: defineCommand({
      name: 'company.restore',
      permission: 'companies.manage',
      input: companyIdInput,
      handle: (trx, input, command) => setTrashed(trx, input.id, command, false, actorNames),
    }),
  };
}
