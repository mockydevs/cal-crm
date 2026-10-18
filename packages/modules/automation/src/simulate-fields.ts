import { contactFieldPaths, type ConditionValue, type ConditionValues } from '@repo/contracts';
import { ConflictError, ValidationError } from '@repo/kernel';
import { normalizeFieldValue, type FieldNormalizationContext } from '@repo/module-crm';

/** Update isolated state in the same representation as contactValues reads after a write. */
export function simulateCustomFields(
  fields: Readonly<Record<string, string | number | boolean | readonly string[] | null>>,
  values: Record<string, ConditionValues[string]>,
  context: FieldNormalizationContext,
): void {
  for (const [path, given] of Object.entries(fields)) {
    if (!path.startsWith('contact.custom.')) continue;
    const key = path.slice('contact.custom.'.length);
    const definition = context.definitions.find((field) => field.key === key);
    if (definition === undefined)
      throw new ValidationError([
        {
          path: `/config/fields/${path}`,
          code: 'unknown_field',
          message: `${path} is not a field.`,
        },
      ]);
    if (definition.archived)
      throw new ConflictError('Restore this field before changing its value.');
    const current = values[path];
    const previous =
      typeof current === 'number'
        ? String(current)
        : typeof current === 'object' && current !== null
          ? current.filter((value): value is string => typeof value === 'string')
          : (current ?? null);
    const normalized = normalizeFieldValue(
      definition,
      typeof given === 'number'
        ? String(given)
        : typeof given === 'object' && given !== null
          ? [...given]
          : given,
      previous,
      context.country,
    );
    // A text box list is never a value a step sets: automations don't see the field.
    if (normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized))
      throw new ValidationError([
        {
          path: `/config/fields/${path}`,
          code: 'unknown_field',
          message: `${path} is not a field a step can set.`,
        },
      ]);
    let value: ConditionValue = normalized;
    if (typeof normalized === 'string') {
      if (definition.valueType === 'number' || definition.valueType === 'money')
        value = Number(normalized);
      else if (definition.valueType === 'datetime') value = new Date(normalized).toISOString();
      else if (definition.valueType === 'single_choice') value = [normalized];
    }
    // Aliases first, canonical keys last, as in contactValues. Existing real keys win collisions.
    for (const alias of context.aliases)
      if (
        alias.fieldId === definition.id &&
        !context.definitions.some((field) => field.key === alias.key)
      )
        for (const aliasPath of contactFieldPaths(alias.key)) values[aliasPath] = value;
    for (const canonicalPath of contactFieldPaths(key)) values[canonicalPath] = value;
  }
}
