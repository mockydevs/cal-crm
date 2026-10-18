// The prices AI costs are worked out from: US dollars for a million tokens, each with where
// it came from and the day it was entered. They are the agency's, because the agency
// rebills by them: a business reads them and cannot change them.
import { defineCommand, requireAgency, type Command, type Invocation } from '@repo/commands';
import {
  aiModelPriceKey,
  setAiModelPriceInput,
  type AiModelPrice,
  type AiModelPriceList,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError } from '@repo/kernel';

import { BUILT_IN_PRICES, dollarsToMicros, microsToDollars, priceKey } from './pricing.js';

const columns = [
  'id',
  'provider',
  'model',
  'input_per_mtok',
  'output_per_mtok',
  'cache_read_per_mtok',
  'cache_write_per_mtok',
  'cache_write_1h_per_mtok',
  'source',
  'checked_on',
] as const;

interface PriceRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly input_per_mtok: string;
  readonly output_per_mtok: string;
  readonly cache_read_per_mtok: string;
  readonly cache_write_per_mtok: string;
  readonly cache_write_1h_per_mtok: string | null;
  readonly source: string;
  readonly checked_on: Date;
}

/** A calendar day as the database gave it, without a time zone moving it. */
const day = (date: Date): string =>
  `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const asPrice = (row: PriceRow): AiModelPrice => ({
  shipped: false,
  provider: row.provider,
  model: row.model,
  inputPerMtok: row.input_per_mtok,
  outputPerMtok: row.output_per_mtok,
  cacheReadPerMtok: row.cache_read_per_mtok,
  cacheWritePerMtok: row.cache_write_per_mtok,
  cacheWrite1hPerMtok: row.cache_write_1h_per_mtok,
  source: row.source,
  checkedOn: day(row.checked_on),
});

/** The agency's prices, then the shipped ones it has not replaced. */
export async function readAiModelPrices(
  trx: DatabaseTransaction,
  invocation: Pick<Invocation, 'context'>,
): Promise<AiModelPriceList> {
  const { context } = invocation;
  const rows = await trx
    .selectFrom('ai.model_prices')
    .select(columns)
    .where('agency_id', '=', context.agencyId)
    .orderBy('provider')
    .orderBy('model')
    .execute();
  const entered = new Set(rows.map((row) => priceKey(row.provider, row.model)));
  const shipped = Object.entries(BUILT_IN_PRICES)
    .filter(([key]) => !entered.has(key))
    .map(([key, { prices, source, checkedOn }]): AiModelPrice => {
      const [provider = '', ...model] = key.split('/');
      return {
        shipped: true,
        provider,
        model: model.join('/'),
        inputPerMtok: microsToDollars(prices.input),
        outputPerMtok: microsToDollars(prices.output),
        cacheReadPerMtok: microsToDollars(prices.cacheRead),
        cacheWritePerMtok: microsToDollars(prices.cacheWrite),
        cacheWrite1hPerMtok:
          prices.cacheWrite1h === undefined ? null : microsToDollars(prices.cacheWrite1h),
        source,
        checkedOn,
      };
    });
  return {
    data: [...rows.map(asPrice), ...shipped],
    // Prices are set for the whole agency, outside any business.
    canManage: context.businessId === undefined,
  };
}

/** Six places, as the column keeps a price. */
const exact = (amount: string): string => microsToDollars(dollarsToMicros(amount));

export function createPriceCommands(now: () => Date): {
  readonly set: Command<typeof setAiModelPriceInput, AiModelPrice>;
  readonly remove: Command<typeof aiModelPriceKey, undefined>;
} {
  const set = defineCommand({
    name: 'ai.set_model_price',
    permission: 'ai.manage',
    input: setAiModelPriceInput,
    async handle(trx, input, command): Promise<AiModelPrice> {
      const agencyId = requireAgency(command.context);
      const price = {
        input_per_mtok: exact(input.inputPerMtok),
        output_per_mtok: exact(input.outputPerMtok),
        // A server that does not price its cache apart charges cached input as input.
        cache_read_per_mtok: exact(input.cacheReadPerMtok ?? input.inputPerMtok),
        cache_write_per_mtok: exact(input.cacheWritePerMtok ?? input.inputPerMtok),
        // Not taken from any other price: left out, the hour's cache is never asked for, so
        // its writes are never priced as another cache's.
        cache_write_1h_per_mtok:
          input.cacheWrite1hPerMtok === undefined ? null : exact(input.cacheWrite1hPerMtok),
        source: input.source,
        // The day it was entered, in UTC: the day the price was last looked at.
        checked_on: now().toISOString().slice(0, 10),
        updated_by_id: command.context.userId ?? null,
      };
      const row = await trx
        .insertInto('ai.model_prices')
        .values({ agency_id: agencyId, provider: input.provider, model: input.model, ...price })
        .onConflict((conflict) =>
          conflict.columns(['agency_id', 'provider', 'model']).doUpdateSet(price),
        )
        .returning(columns)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'ai_model_price.set',
        subject: { kind: 'ai_model_price', id: row.id },
        payload: {
          provider: input.provider,
          model: input.model,
          inputPerMtok: price.input_per_mtok,
          outputPerMtok: price.output_per_mtok,
        },
      });
      return asPrice(row);
    },
  });

  const remove = defineCommand({
    name: 'ai.remove_model_price',
    permission: 'ai.manage',
    input: aiModelPriceKey,
    async handle(trx, { provider, model }, command): Promise<undefined> {
      const agencyId = requireAgency(command.context);
      const row = await trx
        .deleteFrom('ai.model_prices')
        .where('agency_id', '=', agencyId)
        .where('provider', '=', provider)
        .where('model', '=', model)
        .returning(['id', 'provider', 'model'])
        .executeTakeFirst();
      // A shipped price is not the agency's to remove: there is no row of it.
      if (row === undefined) throw new NotFoundError('AI model price', `${provider}/${model}`);
      await command.emit({
        type: 'ai_model_price.removed',
        subject: { kind: 'ai_model_price', id: row.id },
        payload: { provider: row.provider, model: row.model },
      });
      return undefined;
    },
  });

  return { set, remove };
}
