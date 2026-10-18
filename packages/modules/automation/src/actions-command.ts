import type { Command, CommandContext } from '@repo/commands';
import type * as z from 'zod';

/** Mutating workflow actions must retain the canonical command boundary. */
export function runActionCommand<Input extends z.ZodType, Output>(
  context: CommandContext,
  command: Command<Input, Output>,
  input: unknown,
): Promise<Output> {
  if (context.runChild === undefined)
    throw new Error('Automation actions require the canonical child command runner.');
  return context.runChild(command, input);
}
