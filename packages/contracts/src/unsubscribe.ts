import * as z from 'zod';

/** A 256-bit URL capability; contains no recipient or tenant identifier. */
export const unsubscribeToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const unsubscribeRequest = z.strictObject({
  'List-Unsubscribe': z.literal('One-Click'),
});
