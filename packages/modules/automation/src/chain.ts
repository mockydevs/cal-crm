// The automations that led to a run: a run another automation started, by a step or by one
// of its runs ending, keeps the automations above it. It is what stops automations starting
// one another without end when their documents have come to hold a loop the validator never
// saw.
import * as z from 'zod';

/**
 * The most automations that may have started one another to reach a run: the run-time
 * guard behind the validator's loop check, since documents change between publish and run.
 */
export const MAX_AUTOMATION_CHAIN = 10;

const withChain = z.looseObject({ chain: z.array(z.uuid()).catch([]) }).catch({ chain: [] });

/** The automations above a run, oldest first: empty for one an outside event enrolled. */
export const chainOf = (state: unknown): readonly string[] => withChain.parse(state).chain;

/**
 * Why an automation may not be started from a chain, if it may not: it is already in the
 * chain (starting it would loop), or the chain is as long as one may be.
 */
export function chainRefusal(
  chain: readonly string[],
  automationId: string,
): 'loop' | 'too_long' | undefined {
  if (chain.includes(automationId)) return 'loop';
  return chain.length >= MAX_AUTOMATION_CHAIN ? 'too_long' : undefined;
}
