import { jsonPointer, ValidationError, type Issue } from '@repo/kernel';
import type * as z from 'zod';

function issuesOf(error: z.ZodError): Issue[] {
  return error.issues.flatMap((problem): Issue[] => {
    const path = problem.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment),
    );
    // One issue for each unknown field, so each points at the field to remove.
    if (problem.code === 'unrecognized_keys') {
      return problem.keys.map((key) => ({
        path: jsonPointer([...path, key]),
        code: problem.code,
        message: `${key} isn't a field here.`,
      }));
    }
    // A refinement may name its problem, such as taken, as the server's checks do.
    const named: unknown = problem.code === 'custom' ? problem.params?.['code'] : undefined;
    const code = typeof named === 'string' ? named : problem.code;
    return [{ path: jsonPointer(path), code, message: problem.message }];
  });
}

/**
 * The input, parsed by a contract's schema. Input that doesn't fit is a ValidationError
 * whose issues point at each field with a JSON Pointer.
 */
export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const [first, ...rest] = issuesOf(result.error);
  if (first === undefined) {
    throw new TypeError('Zod reported a failure with no issues.');
  }
  throw new ValidationError([first, ...rest]);
}
