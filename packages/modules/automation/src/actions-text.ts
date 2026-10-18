// Merge fields in a record action's own text, such as a task's title or a deal's name.
import { renderMessageTemplate, type ConditionValues } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';

/**
 * The step's text with its merge fields filled in. A field with no value refuses the step
 * rather than leaving a gap, as a message template does.
 */
export function mergedText(
  text: { readonly title: string; readonly notes: string },
  values: ConditionValues,
): { title: string; notes: string } {
  const rendered = renderMessageTemplate({ subject: text.title, body: text.notes }, values);
  if (!rendered.ok)
    throw new ValidationError([
      {
        path: '/config',
        code: rendered.code,
        message:
          rendered.code === 'missing_values'
            ? `There is no value for ${rendered.fields.join(', ')}.`
            : `A line break in ${rendered.fields.join(', ')} can't go in a title or a name.`,
      },
    ]);
  return { title: rendered.subject, notes: rendered.body };
}
