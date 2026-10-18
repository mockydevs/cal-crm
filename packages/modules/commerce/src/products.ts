// The catalogue of products and services with their rates. Anyone in the business reads it;
// payments.manage keeps it. A line on a quote or an invoice keeps its own copy of what it
// was taken from, so changing a product changes no document, and a product a document names
// is archived, never deleted.
import { defineCommand, requireBusiness, type Command, type Invocation } from '@repo/commands';
import {
  createProductInput,
  productKinds,
  productRevisionInput,
  updateProductInput,
  type Product,
  type ProductList,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { fourPlaces, likePattern } from './rules.js';
import {
  actorOf,
  canManage,
  heldBusiness,
  MANAGE,
  notFound,
  rowId,
  type CommerceOptions,
} from './shared.js';

const products = (trx: DatabaseTransaction) =>
  trx
    .selectFrom('commerce.products as p')
    .select([
      'p.id',
      'p.kind',
      'p.name',
      'p.description',
      'p.sku',
      'p.unit',
      'p.unit_price',
      'p.currency',
      'p.tax_rate',
      'p.archived_at',
      'p.revision',
      'p.created_at',
      'p.updated_at',
    ])
    .select(
      sql<boolean>`exists (select 1 from commerce.document_lines l
        where l.business_id = p.business_id and l.product_id = p.id)`.as('used'),
    );

type ProductRow = Awaited<ReturnType<ReturnType<typeof products>['executeTakeFirstOrThrow']>>;

function present(row: ProductRow, invocation: Invocation): Product {
  return {
    id: toPublicId('product', row.id),
    kind: productKinds.find((kind) => kind === row.kind) ?? 'product',
    name: row.name,
    description: row.description,
    sku: row.sku,
    unit: row.unit,
    unitPrice: fourPlaces(row.unit_price),
    currency: row.currency,
    taxRate: row.tax_rate === null ? null : fourPlaces(row.tax_rate),
    archived: row.archived_at !== null,
    archivedAt: row.archived_at === null ? null : row.archived_at.toISOString(),
    used: row.used,
    revision: row.revision,
    canManage: canManage(invocation),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** One product, as anyone in the business may read it. */
export async function readProduct(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<Product> {
  requireBusiness(invocation.context);
  const row = await products(trx).where('p.id', '=', rowId('product', publicId)).executeTakeFirst();
  if (row === undefined) throw notFound('product', publicId);
  return present(row, invocation);
}

/** The catalogue by name: in use or archived, all kinds or one, found by name or code. */
export async function readProducts(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: {
    readonly q?: string | undefined;
    readonly kind?: Product['kind'] | undefined;
    readonly archived: 'true' | 'false';
    readonly after?: string | undefined;
    readonly limit: number;
  },
): Promise<ProductList> {
  requireBusiness(invocation.context);
  let query = products(trx)
    .where('p.archived_at', input.archived === 'true' ? 'is not' : 'is', null)
    .orderBy('p.name_normalized')
    .orderBy('p.id');
  if (input.kind !== undefined) query = query.where('p.kind', '=', input.kind);
  if (input.q !== undefined && input.q !== '') {
    const pattern = likePattern(input.q);
    query = query.where((where) =>
      where.or([
        where('p.name_normalized', 'like', pattern),
        where('p.sku_normalized', 'like', pattern),
      ]),
    );
  }
  if (input.after !== undefined) {
    // The page starts after the product the last one ended on, by name and then by id.
    const cursor = await trx
      .selectFrom('commerce.products')
      .select(['id', 'name_normalized'])
      .where('id', '=', rowId('product', input.after))
      .executeTakeFirst();
    if (cursor === undefined)
      throw new ValidationError([
        { path: '/after', code: 'unknown_cursor', message: 'This page no longer exists.' },
      ]);
    query = query.where(
      sql<boolean>`(p.name_normalized, p.id) > (${cursor.name_normalized}, ${cursor.id}::uuid)`,
    );
  }
  const found = await query.limit(input.limit + 1).execute();
  const rows = found.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => present(row, invocation)),
    nextCursor:
      found.length > input.limit && last !== undefined ? toPublicId('product', last.id) : null,
    canManage: canManage(invocation),
  };
}

const duplicateSku = explainUniqueViolation({
  products_sku_unique: () =>
    new ValidationError([
      { path: '/sku', code: 'taken', message: 'Another product already has this code.' },
    ]),
});

/** The product's row, held until the command ends. */
async function locked(trx: DatabaseTransaction, publicId: string): Promise<ProductRow> {
  const row = await products(trx)
    .where('p.id', '=', rowId('product', publicId))
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw notFound('product', publicId);
  return row;
}

const stale = (): ConflictError =>
  new ConflictError('This product changed since you opened it. Reload before saving.');

const withId = updateProductInput.extend({ id: z.string() });
const revisionWithId = productRevisionInput.extend({ id: z.string() });
const idOnly = z.strictObject({ id: z.string() });

export interface ProductCommands {
  readonly create: Command<typeof createProductInput, Product>;
  readonly update: Command<typeof withId, Product>;
  readonly archive: Command<typeof revisionWithId, Product>;
  readonly restore: Command<typeof revisionWithId, Product>;
  readonly remove: Command<typeof idOnly, undefined>;
}

export function createProductCommands(options: CommerceOptions): ProductCommands {
  const create = defineCommand({
    name: 'product.create',
    permission: MANAGE,
    input: createProductInput,
    async handle(trx, input, command): Promise<Product> {
      const businessId = await heldBusiness(options, trx, command);
      const actor = actorOf(command.context);
      const row = await trx
        .insertInto('commerce.products')
        .values({
          business_id: businessId,
          kind: input.kind,
          name: input.name,
          description: input.description,
          sku: input.sku,
          unit: input.unit,
          unit_price: input.unitPrice,
          currency: input.currency,
          tax_rate: input.taxRate,
          created_by_kind: actor.kind,
          created_by_id: actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch(duplicateSku);
      await command.emit({
        type: 'product.created',
        subject: { kind: 'product', id: row.id },
        payload: { name: input.name },
      });
      return readProduct(trx, command, toPublicId('product', row.id));
    },
  });

  const update = defineCommand({
    name: 'product.update',
    permission: MANAGE,
    input: withId,
    async handle(trx, input, command): Promise<Product> {
      await heldBusiness(options, trx, command);
      const row = await locked(trx, input.id);
      if (row.revision !== input.revision) throw stale();
      await trx
        .updateTable('commerce.products')
        .set({
          kind: input.kind,
          name: input.name,
          description: input.description,
          sku: input.sku,
          unit: input.unit,
          unit_price: input.unitPrice,
          currency: input.currency,
          tax_rate: input.taxRate,
          revision: row.revision + 1,
        })
        .where('id', '=', row.id)
        .execute()
        .catch(duplicateSku);
      await command.emit({
        type: 'product.updated',
        subject: { kind: 'product', id: row.id },
        payload: { name: input.name },
      });
      return readProduct(trx, command, input.id);
    },
  });

  /** Archives a product or brings one back, from the revision it was read at. */
  const shelve = (
    name: string,
    event: string,
    archive: boolean,
    refusal: string,
  ): Command<typeof revisionWithId, Product> =>
    defineCommand({
      name,
      permission: MANAGE,
      input: revisionWithId,
      async handle(trx, input, command): Promise<Product> {
        await heldBusiness(options, trx, command);
        const row = await locked(trx, input.id);
        if (row.revision !== input.revision) throw stale();
        if ((row.archived_at !== null) === archive) throw new ConflictError(refusal);
        await trx
          .updateTable('commerce.products')
          .set({
            archived_at: archive ? sql<Date>`now()` : null,
            revision: row.revision + 1,
          })
          .where('id', '=', row.id)
          .execute();
        await command.emit({
          type: event,
          subject: { kind: 'product', id: row.id },
          payload: { name: row.name },
        });
        return readProduct(trx, command, input.id);
      },
    });

  const remove = defineCommand({
    name: 'product.delete',
    permission: MANAGE,
    input: idOnly,
    async handle(trx, input, command): Promise<undefined> {
      await heldBusiness(options, trx, command);
      const row = await locked(trx, input.id);
      if (row.used)
        throw new ConflictError(
          'A quote or an invoice names this product, so it is kept. Archive it instead.',
        );
      await trx.deleteFrom('commerce.products').where('id', '=', row.id).execute();
      await command.emit({
        type: 'product.deleted',
        subject: { kind: 'product', id: row.id },
        payload: { name: row.name },
      });
      return undefined;
    },
  });

  return {
    create,
    update,
    archive: shelve(
      'product.archive',
      'product.archived',
      true,
      'This product is already archived.',
    ),
    restore: shelve('product.restore', 'product.restored', false, 'This product is not archived.'),
    remove,
  };
}
