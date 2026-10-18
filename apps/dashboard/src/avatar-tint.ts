// The tint behind someone's initials. On its own so a page that only draws an avatar
// doesn't carry the Inbox's rules with it.

/** One of the four avatar tints, always the same for the same contact. */
export function tintOf(id: string): 1 | 2 | 3 | 4 {
  let sum = 0;
  for (const letter of id) sum = (sum + (letter.codePointAt(0) ?? 0)) % 4;
  const tints = [1, 2, 3, 4] as const;
  return tints[sum] ?? 4;
}
