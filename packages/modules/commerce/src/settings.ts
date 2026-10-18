// The business's settings for quotes, invoices and receipts, and the counters their numbers
// come from. A number is taken in the transaction that writes it on a document or a
// payment, under the counter's row lock: two at once wait for each other, and one that
// rolls back gives its number back, so a kind's numbers have no gap.
import { defineCommand, type Command, type Invocation } from '@repo/commands';
import {
  DEFAULT_NUMBER_PREFIXES,
  formatDocumentNumber,
  numberKinds,
  updateCommerceSettingsInput,
  type CommerceSettings,
  type NumberKind,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, ValidationError, type Issue } from '@repo/kernel';
import { sql } from 'kysely';

import { DEFAULT_SETTINGS, fourPlaces, nextNumberRefusal, numbersLeft } from './rules.js';
import { canManage, heldBusiness, MANAGE, type CommerceOptions } from './shared.js';

/** The settings a document is issued by. */
export interface StoredSettings {
  readonly paymentTermsDays: number;
  readonly quoteValidityDays: number;
  readonly defaultNotes: string;
  readonly defaultTerms: string;
  readonly paymentInstructions: string;
  readonly taxNumber: string | null;
  readonly defaultTaxRate: string | null;
  readonly revision: number;
}

/** The business's settings, or the defaults while it has saved none. */
export async function storedSettings(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<StoredSettings> {
  const row = await trx
    .selectFrom('commerce.settings')
    .selectAll()
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  if (row === undefined) return DEFAULT_SETTINGS;
  return {
    paymentTermsDays: row.payment_terms_days,
    quoteValidityDays: row.quote_validity_days,
    defaultNotes: row.default_notes,
    defaultTerms: row.default_terms,
    paymentInstructions: row.payment_instructions,
    taxNumber: row.tax_number,
    defaultTaxRate: row.default_tax_rate === null ? null : fourPlaces(row.default_tax_rate),
    revision: row.revision,
  };
}

interface Counter {
  readonly prefix: string;
  readonly next: number;
  readonly last: number;
}

/** The counter's row, made if the business has none yet, and held until the command ends. */
async function lockedCounter(
  trx: DatabaseTransaction,
  businessId: string,
  kind: NumberKind,
): Promise<Counter> {
  await trx
    .insertInto('commerce.sequences')
    .values({ business_id: businessId, kind, prefix: DEFAULT_NUMBER_PREFIXES[kind] })
    .onConflict((conflict) => conflict.columns(['business_id', 'kind']).doNothing())
    .execute();
  const row = await trx
    .selectFrom('commerce.sequences')
    .select([
      'prefix',
      sql<string>`next_number::text`.as('next'),
      sql<string>`last_number::text`.as('last'),
    ])
    .where('business_id', '=', businessId)
    .where('kind', '=', kind)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return { prefix: row.prefix, next: Number(row.next), last: Number(row.last) };
}

/**
 * Takes the kind's next number for the document or payment this transaction is writing.
 * The counter stays locked until the transaction ends; if it rolls back, the number was
 * never taken.
 */
export async function takeNumber(
  trx: DatabaseTransaction,
  businessId: string,
  kind: NumberKind,
): Promise<{ readonly number: string; readonly sequence: number }> {
  const counter = await lockedCounter(trx, businessId, kind);
  if (!numbersLeft(counter.next))
    throw new ConflictError(
      'This counter has no number left. Change the numbering in the settings.',
    );
  await trx
    .updateTable('commerce.sequences')
    .set({ last_number: counter.next, next_number: counter.next + 1 })
    .where('business_id', '=', businessId)
    .where('kind', '=', kind)
    .execute();
  return { number: formatDocumentNumber(counter.prefix, counter.next), sequence: counter.next };
}

/** The settings and the three counters, as Settings shows them. */
export async function readSettings(
  trx: DatabaseTransaction,
  invocation: Invocation,
  businessId: string,
): Promise<CommerceSettings> {
  const { revision, ...settings } = await storedSettings(trx, businessId);
  const rows = await trx
    .selectFrom('commerce.sequences')
    .select([
      'kind',
      'prefix',
      sql<string>`next_number::text`.as('next'),
      sql<string>`last_number::text`.as('last'),
    ])
    .where('business_id', '=', businessId)
    .execute();
  const counter = (kind: NumberKind) => {
    const row = rows.find((each) => each.kind === kind);
    const prefix = row?.prefix ?? DEFAULT_NUMBER_PREFIXES[kind];
    const nextNumber = Number(row?.next ?? '1');
    return {
      prefix,
      nextNumber,
      lastNumber: Number(row?.last ?? '0'),
      example: formatDocumentNumber(prefix, nextNumber),
    };
  };
  return {
    numbering: {
      quote: counter('quote'),
      invoice: counter('invoice'),
      receipt: counter('receipt'),
    },
    ...settings,
    revision,
    canManage: canManage(invocation),
  };
}

export type UpdateSettingsCommand = Command<typeof updateCommerceSettingsInput, CommerceSettings>;

export function createSettingsCommand(options: CommerceOptions): UpdateSettingsCommand {
  return defineCommand({
    name: 'commerce_settings.update',
    permission: MANAGE,
    input: updateCommerceSettingsInput,
    async handle(trx, input, command): Promise<CommerceSettings> {
      const businessId = await heldBusiness(options, trx, command);
      // The row is made first, so two first saves at once meet on its lock.
      await trx
        .insertInto('commerce.settings')
        .values({ business_id: businessId })
        .onConflict((conflict) => conflict.column('business_id').doNothing())
        .execute();
      const current = await trx
        .selectFrom('commerce.settings')
        .select('revision')
        .where('business_id', '=', businessId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.revision !== input.revision)
        throw new ConflictError(
          'These settings changed since you opened them. Reload before saving.',
        );

      // The counters, in one order always, so two saves never wait on each other.
      const issues: Issue[] = [];
      for (const kind of numberKinds) {
        const wanted = input.numbering[kind];
        const counter = await lockedCounter(trx, businessId, kind);
        const next = wanted.nextNumber ?? counter.next;
        const refusal = nextNumberRefusal(next, counter.last);
        if (refusal !== undefined) {
          issues.push({
            path: `/numbering/${kind}/nextNumber`,
            code: 'number_used',
            message: refusal,
          });
          continue;
        }
        await trx
          .updateTable('commerce.sequences')
          .set({ prefix: wanted.prefix, next_number: next })
          .where('business_id', '=', businessId)
          .where('kind', '=', kind)
          .execute();
      }
      const [first, ...rest] = issues;
      if (first !== undefined) throw new ValidationError([first, ...rest]);

      await trx
        .updateTable('commerce.settings')
        .set({
          payment_terms_days: input.paymentTermsDays,
          quote_validity_days: input.quoteValidityDays,
          default_notes: input.defaultNotes,
          default_terms: input.defaultTerms,
          payment_instructions: input.paymentInstructions,
          tax_number: input.taxNumber,
          default_tax_rate: input.defaultTaxRate,
          revision: current.revision + 1,
        })
        .where('business_id', '=', businessId)
        .execute();
      await command.emit({
        type: 'commerce.settings_updated',
        subject: { kind: 'business', id: businessId },
      });
      return readSettings(trx, command, businessId);
    },
  });
}
