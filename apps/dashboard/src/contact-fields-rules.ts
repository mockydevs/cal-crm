// Which of a contact's fields the "Search fields and folders" box leaves showing.

export interface FieldGroup<Item> {
  readonly id: string;
  readonly name: string;
  readonly items: readonly Item[];
}

/**
 * The groups with something to show for what was typed: a group whose own name has the
 * words keeps all its fields, any other keeps the fields whose label has them, and a group
 * left with none is dropped. Letter case doesn't count.
 */
export function matchingGroups<Item extends { readonly label: string }>(
  groups: readonly FieldGroup<Item>[],
  query: string,
): readonly FieldGroup<Item>[] {
  const words = query.trim().toLowerCase();
  if (words === '') return groups;
  return groups.flatMap((group) => {
    if (group.name.toLowerCase().includes(words)) return [group];
    const items = group.items.filter((item) => item.label.toLowerCase().includes(words));
    return items.length === 0 ? [] : [{ ...group, items }];
  });
}
