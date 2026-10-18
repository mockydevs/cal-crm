// What an opportunity's contacts become when one is added, removed or made the primary. The
// server takes the whole of it each time (PUT /deals/{id}/contacts): one primary contact or
// none, and the others, each contact once.

export interface DealContacts {
  readonly primary: string | null;
  readonly additional: readonly string[];
}

export type ContactChange =
  /** Makes it the primary. The primary before it stays with the opportunity as an additional contact. */
  | { readonly kind: 'primary'; readonly id: string }
  | { readonly kind: 'add'; readonly id: string }
  | { readonly kind: 'remove'; readonly id: string };

/**
 * The contacts after a change. A contact made the primary leaves the additional ones, and
 * the primary it replaces takes its place among them, or goes last when the new one was
 * not among them; `limit` is how many additional contacts there may be, and a primary
 * that would be one too many is let go instead.
 */
export function contactsAfter(
  current: DealContacts,
  change: ContactChange,
  limit = 10,
): DealContacts {
  if (change.kind === 'remove')
    return {
      primary: current.primary === change.id ? null : current.primary,
      additional: current.additional.filter((id) => id !== change.id),
    };
  if (change.kind === 'add')
    return change.id === current.primary || current.additional.includes(change.id)
      ? current
      : { primary: current.primary, additional: [...current.additional, change.id] };
  if (change.id === current.primary) return current;
  const before = current.primary;
  const swapped = current.additional.includes(change.id);
  const additional =
    before === null
      ? current.additional.filter((id) => id !== change.id)
      : swapped
        ? current.additional.map((id) => (id === change.id ? before : id))
        : [...current.additional, before];
  return { primary: change.id, additional: additional.slice(0, limit) };
}
