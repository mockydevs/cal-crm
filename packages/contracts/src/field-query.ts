import * as z from 'zod';
import { publicId } from './ids.js';

export const fieldQueryShape = {
  fieldId: publicId('field').optional(),
  fieldOperator: z
    .enum(['equals', 'contains', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_unset'])
    .optional(),
  fieldValue: z.string().max(1000).optional(),
  sortField: publicId('field').optional(),
  fieldOrder: z.enum(['asc', 'desc']).optional(),
};
export type FieldListOptions = z.infer<z.ZodObject<typeof fieldQueryShape>>;
export function refineFieldQuery(input: FieldListOptions, context: z.RefinementCtx): void {
  const problem = (path: string, message: string) => {
    context.addIssue({ code: 'custom', path: [path], message });
  };
  if (
    input.fieldId === undefined &&
    (input.fieldOperator !== undefined || input.fieldValue !== undefined)
  )
    problem('fieldId', 'Choose a field to filter.');
  if (input.fieldId !== undefined && input.fieldOperator === undefined)
    problem('fieldOperator', 'Choose how to match this field.');
  const presence = input.fieldOperator === 'is_set' || input.fieldOperator === 'is_unset';
  if (presence && input.fieldValue !== undefined)
    problem('fieldValue', 'A set/unset filter takes no value.');
  if (input.fieldOperator !== undefined && !presence && input.fieldValue === undefined)
    problem('fieldValue', 'Enter the field value to match.');
  if (input.sortField === undefined && input.fieldOrder !== undefined)
    problem('sortField', 'Choose a field to sort.');
}
