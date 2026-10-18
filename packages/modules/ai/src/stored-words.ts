// Words the database keeps in a text column with a check: a status, a level, a kind. Read
// back, each is one of the words its check allows, and TypeScript should know which.

/**
 * The stored word as one of the words its column's check allows. Anything else is a row
 * no release wrote, and is a fault, not an answer.
 */
export function oneOf<Word extends string>(words: readonly Word[], value: string): Word {
  const found = words.find((word) => word === value);
  if (found === undefined) throw new Error('A stored word is not one its column allows.');
  return found;
}
