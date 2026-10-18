// What a searchable list works out before it draws (search-picker.tsx): the rows that fit
// what is typed, under their headings, how many there are in all, and whether what is
// typed could be added as a choice of the person's own. One set of rules for every list of
// this kind: an email template by name or subject, a form, the lead sources of a filter.
export { isListKey, stepped, type ListKey } from './tag-picker-rules';

export interface PickerItem {
  readonly id: string;
  /** What it is called: shown, searched, and what the closed control reads. */
  readonly name: string;
  /** A quieter second line that is searched too, such as an email's subject. */
  readonly detail?: string | undefined;
  /** A short mark beside the name, such as "Formatted" or "Draft". */
  readonly mark?: string | undefined;
  /** The heading it is listed under, such as a folder's path; none for the top of the list. */
  readonly group?: string | undefined;
}

export interface PickerGroup {
  /** Nothing for the rows that are under no heading. */
  readonly name: string | undefined;
  readonly items: readonly PickerItem[];
}

export interface PickerChoices {
  /** The rows to show, by heading, in the order the headings first appear. */
  readonly groups: readonly PickerGroup[];
  /** The same rows in the order they are listed, which the arrow keys follow. */
  readonly options: readonly PickerItem[];
  /** How many rows fit what is typed; more than `options` holds when the list is cut short. */
  readonly matching: number;
}

/** As many rows as a list shows at once: past it, the person types to narrow it. */
export const SHOWN_ROWS = 50;

/** Text as it is compared: without capitals, accents or doubled spaces. */
export const plain = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Whether a row fits what is typed: every word typed is in its name or its second line. */
export function fits(item: PickerItem, typed: string): boolean {
  const words = plain(typed).split(' ');
  const text = plain(`${item.name} ${item.detail ?? ''}`);
  return words.every((word) => text.includes(word));
}

/**
 * The rows for what is typed. Rows keep the order they are given in; a heading's rows are
 * gathered under it where the heading first appears, and the rows under no heading come
 * first. Past `shown` rows the list is cut short and says how many there are.
 */
export function pickerChoices(
  items: readonly PickerItem[],
  typed: string,
  shown: number = SHOWN_ROWS,
): PickerChoices {
  const matches = plain(typed) === '' ? items : items.filter((item) => fits(item, typed));
  const names: (string | undefined)[] = [];
  for (const item of matches) if (!names.includes(item.group)) names.push(item.group);
  // The rows under no heading lead: a heading above them would claim the rows that follow.
  const order = names.includes(undefined)
    ? [undefined, ...names.filter((name) => name !== undefined)]
    : names;
  const ordered = order.flatMap((name) => matches.filter((item) => item.group === name));
  const options = ordered.slice(0, shown);
  return {
    groups: order
      .map((name) => ({ name, items: options.filter((item) => item.group === name) }))
      .filter((group) => group.items.length > 0),
    options,
    matching: matches.length,
  };
}

/**
 * What is typed, as a choice of the person's own, for a list that takes them (a lead
 * source that is the business's own name): nothing when it is empty, too long, or already
 * a row or chosen.
 */
export function ownChoice(
  typed: string,
  items: readonly PickerItem[],
  chosen: readonly string[],
  longest: number,
): string | undefined {
  const name = typed.trim();
  if (name === '' || name.length > longest) return undefined;
  const wanted = plain(name);
  const taken =
    items.some((item) => plain(item.name) === wanted) ||
    chosen.some((each) => plain(each) === wanted);
  return taken ? undefined : name;
}

/** The ids chosen after one row is pressed in a list that takes several. */
export function toggled(chosen: readonly string[], id: string): string[] {
  return chosen.includes(id) ? chosen.filter((each) => each !== id) : [...chosen, id];
}
