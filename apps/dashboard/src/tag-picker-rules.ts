// What the tag picker works out before it draws (tag-picker.tsx): the chips of the tags a
// setting holds, the tags that can still be added for what is typed, grouped as the
// business grouped them, whether a new tag may be made from the words typed, and where the
// arrow keys go.
import type { TagConfiguration, TagDefinition } from '@repo/contracts';

/** Same tag, however it is typed: the server treats case, spaces, hyphens and underscores alike. */
export const sameName = (name: string): string => name.toLowerCase().replace(/[\s_-]+/g, '');

/** The longest name a tag may have (crm.tags, packages/contracts/src/tags.ts). */
export const TAG_NAME_LENGTH = 60;

/** As many tags as the list shows at once: past it, the person types to narrow it. */
export const SHOWN_TAGS = 50;

export interface ChosenTag {
  readonly id: string;
  /** Null for a tag that no longer exists: it is shown as gone, and can be taken off. */
  readonly name: string | null;
}

/**
 * The chips, in the order the setting holds its tags. A tag made a moment ago is known by
 * the name it was made with until the business's list has been read again.
 */
export function chosenTags(
  items: readonly Pick<TagDefinition, 'id' | 'name'>[],
  chosen: readonly string[],
  made: Readonly<Record<string, string>> = {},
): ChosenTag[] {
  return chosen.map((id) => ({
    id,
    name: items.find((item) => item.id === id)?.name ?? made[id] ?? null,
  }));
}

export interface TagChoiceGroup {
  /** Null for the tags that are in no group. */
  readonly id: string | null;
  readonly name: string | null;
  readonly tags: readonly TagDefinition[];
}

export interface TagChoices {
  /** The tags that can be added, by group; a group with none to add is left out. */
  readonly groups: readonly TagChoiceGroup[];
  /** The same tags in the order they are listed, which is the order the arrow keys follow. */
  readonly options: readonly TagDefinition[];
  /** How many tags match in all; more than `options` holds when the list is cut short. */
  readonly matching: number;
  /** The name a new tag would get, when the person may make one from what is typed. */
  readonly create: string | null;
  /** What is typed names a tag the setting already holds. */
  readonly alreadyChosen: boolean;
}

/**
 * The tags to offer for what is typed. A tag the setting already holds is not offered
 * again. Groups come in the business's order with the ungrouped tags last; when the
 * business has no groups there is one list with no heading.
 */
export function tagChoices(
  configuration: Pick<TagConfiguration, 'items' | 'groups' | 'canCreate'> | undefined,
  chosen: readonly string[],
  typed: string,
  shown: number = SHOWN_TAGS,
): TagChoices {
  const name = typed.trim();
  const wanted = sameName(name);
  if (configuration === undefined)
    return { groups: [], options: [], matching: 0, create: null, alreadyChosen: false };
  const held = new Set(chosen);
  const free = configuration.items.filter((item) => !held.has(item.id));
  const matches =
    wanted === '' ? free : free.filter((item) => sameName(item.name).includes(wanted));
  const known = new Set(configuration.groups.map((group) => group.id));
  const ordered = [
    ...configuration.groups.flatMap((group) => matches.filter((item) => item.groupId === group.id)),
    ...matches.filter((item) => item.groupId === null || !known.has(item.groupId)),
  ];
  const options = ordered.slice(0, shown);
  const groups: TagChoiceGroup[] = [];
  for (const group of configuration.groups) {
    const tags = options.filter((item) => item.groupId === group.id);
    if (tags.length > 0) groups.push({ id: group.id, name: group.name, tags });
  }
  const loose = options.filter((item) => item.groupId === null || !known.has(item.groupId));
  if (loose.length > 0) groups.push({ id: null, name: null, tags: loose });
  const exact = wanted !== '' && configuration.items.some((item) => sameName(item.name) === wanted);
  const alreadyChosen =
    wanted !== '' &&
    configuration.items.some((item) => held.has(item.id) && sameName(item.name) === wanted);
  return {
    groups,
    options,
    matching: matches.length,
    create:
      configuration.canCreate && wanted !== '' && !exact && name.length <= TAG_NAME_LENGTH
        ? name
        : null,
    alreadyChosen,
  };
}

/** Whether the setting can take one more tag. */
export const hasRoom = (chosen: readonly string[], limit: number): boolean => chosen.length < limit;

export type ListKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export const isListKey = (key: string): key is ListKey =>
  key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';

/**
 * Which row of the list a key moves to, from the one it is on (-1 for none yet). The arrows
 * go round: down from the last row is the first. With no rows there is nowhere to be.
 */
export function stepped(active: number, count: number, key: ListKey): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return active >= count - 1 ? 0 : active + 1;
  return active <= 0 ? count - 1 : active - 1;
}
