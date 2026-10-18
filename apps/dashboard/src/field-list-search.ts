import { fieldQueryShape, refineFieldQuery, type FieldListOptions } from '@repo/contracts';
import * as z from 'zod';

// Route search validation is eager; keep it independent of the lazily loaded form controls.
const searchSchema = z.object(fieldQueryShape).superRefine(refineFieldQuery);
export function fieldListSearch(search: Record<string, unknown>): FieldListOptions {
  const parsed = searchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
}
export function withoutFieldSearch<T extends FieldListOptions>(
  search: T,
): Omit<T, keyof FieldListOptions> {
  const {
    fieldId: _id,
    fieldOperator: _operator,
    fieldValue: _value,
    sortField: _sort,
    fieldOrder: _order,
    ...rest
  } = search;
  return rest;
}
