import type { TagConfiguration, TagDefinition } from '@repo/contracts';
import { expect, it } from 'vitest';
import {
  chosenTags,
  hasRoom,
  isListKey,
  sameName,
  stepped,
  tagChoices,
  TAG_NAME_LENGTH,
} from './tag-picker-rules';

const at = '2026-10-10T09:00:00.000Z';
const tagOf = (number: number, name: string, groupId: string | null = null): TagDefinition => ({
  id: `tag_01k8e2wzr0e0080000000000${String(number).padStart(2, '0')}`,
  name,
  description: '',
  createdAt: at,
  updatedAt: at,
  groupId,
  revision: 'a'.repeat(64),
});
const groupOf = (number: number, name: string): TagConfiguration['groups'][number] => ({
  id: `tgrp_01k8e2wzr0e0080000000000${String(number).padStart(2, '0')}`,
  name,
  description: '',
  revision: 'a'.repeat(64),
});
const sales = groupOf(1, 'Sales');
const leadSource = groupOf(2, 'Lead source');
const hot = tagOf(1, 'Hot lead', sales.id);
const cold = tagOf(2, 'Cold lead', sales.id);
const google = tagOf(3, 'Source: Google Ads', leadSource.id);
const wedding = tagOf(4, 'Wedding enquiry');
const website = tagOf(5, 'Website');
const orphan = tagOf(6, 'Old campaign', 'tgrp_01k8e2wzr0e008000000000099');
const configuration = (
  patch: Partial<Pick<TagConfiguration, 'items' | 'groups' | 'canCreate'>> = {},
): Pick<TagConfiguration, 'items' | 'groups' | 'canCreate'> => ({
  items: [cold, hot, orphan, google, website, wedding],
  groups: [sales, leadSource],
  canCreate: true,
  ...patch,
});

it('treats case, spaces, hyphens and underscores alike in a tag name', () => {
  expect(sameName('Hot  Lead')).toBe(sameName('hot-lead'));
  expect(sameName('hot_lead')).toBe('hotlead');
});

it('shows the tags a setting holds in its own order, and says which no longer exist', () => {
  expect(chosenTags([hot, wedding], [wedding.id, 'tag_gone', hot.id])).toEqual([
    { id: wedding.id, name: 'Wedding enquiry' },
    { id: 'tag_gone', name: null },
    { id: hot.id, name: 'Hot lead' },
  ]);
  // A tag made a moment ago is named until the list is read again; the list wins after.
  expect(chosenTags([], ['tag_new'], { tag_new: 'VIP' })).toEqual([{ id: 'tag_new', name: 'VIP' }]);
  expect(chosenTags([{ id: 'tag_new', name: 'Vip' }], ['tag_new'], { tag_new: 'VIP' })).toEqual([
    { id: 'tag_new', name: 'Vip' },
  ]);
});

it('offers the tags not yet chosen, by group in the business order with the ungrouped last', () => {
  const choices = tagChoices(configuration(), [hot.id], '');
  expect(choices.groups.map((group) => [group.name, group.tags.map((tag) => tag.name)])).toEqual([
    ['Sales', ['Cold lead']],
    ['Lead source', ['Source: Google Ads']],
    // A tag whose group is gone is listed with the ungrouped ones.
    [null, ['Old campaign', 'Website', 'Wedding enquiry']],
  ]);
  expect(choices.options.map((tag) => tag.name)).toEqual([
    'Cold lead',
    'Source: Google Ads',
    'Old campaign',
    'Website',
    'Wedding enquiry',
  ]);
  expect(choices.matching).toBe(5);
  expect(choices.create).toBeNull();
  expect(choices.alreadyChosen).toBe(false);
});

it('has one list with no heading when the business has no groups', () => {
  const choices = tagChoices(configuration({ items: [website, wedding], groups: [] }), [], '');
  expect(choices.groups).toEqual([{ id: null, name: null, tags: [website, wedding] }]);
});

it('narrows by what is typed, however it is typed, and leaves out a group with nothing to add', () => {
  const choices = tagChoices(configuration(), [], 'D-LEAD');
  expect(choices.groups.map((group) => group.name)).toEqual(['Sales']);
  expect(choices.options.map((tag) => tag.name)).toEqual(['Cold lead']);
  // In the list's own order within a group.
  expect(tagChoices(configuration(), [], ' lead').options.map((tag) => tag.name)).toEqual([
    'Cold lead',
    'Hot lead',
    'Source: Google Ads',
  ]);
  expect(tagChoices(configuration(), [], 'google ads').options).toEqual([google]);
  expect(tagChoices(configuration(), [], 'zzz').groups).toEqual([]);
});

it('offers to make a tag only from a new name, to someone who may, within the length', () => {
  expect(tagChoices(configuration(), [], '  VIP guest ').create).toBe('VIP guest');
  // An existing tag, chosen or not, is never made twice.
  expect(tagChoices(configuration(), [], 'hot-lead').create).toBeNull();
  expect(tagChoices(configuration(), [hot.id], 'Hot Lead')).toMatchObject({
    create: null,
    alreadyChosen: true,
    options: [],
  });
  expect(tagChoices(configuration(), [], 'Hot Lead').alreadyChosen).toBe(false);
  expect(tagChoices(configuration({ canCreate: false }), [], 'VIP').create).toBeNull();
  expect(tagChoices(configuration(), [], '   ').create).toBeNull();
  expect(tagChoices(configuration(), [], 'x'.repeat(TAG_NAME_LENGTH)).create).toBe(
    'x'.repeat(TAG_NAME_LENGTH),
  );
  expect(tagChoices(configuration(), [], 'x'.repeat(TAG_NAME_LENGTH + 1)).create).toBeNull();
});

it('lists a first screenful of a long list and says how many match in all', () => {
  const many = Array.from({ length: 300 }, (_, index) =>
    tagOf(index + 10, `Tag ${String(index)}`, index % 2 === 0 ? sales.id : null),
  ).map((tag, index) => ({ ...tag, id: `tag_${String(index).padStart(26, '0')}` }));
  const choices = tagChoices(configuration({ items: many }), [], '');
  expect(choices.options).toHaveLength(50);
  expect(choices.matching).toBe(300);
  expect(choices.groups.reduce((sum, group) => sum + group.tags.length, 0)).toBe(50);
  expect(tagChoices(configuration({ items: many }), [], 'tag 29', 5).options).toHaveLength(5);
  expect(tagChoices(configuration({ items: many }), [], 'tag 299').matching).toBe(1);
});

it('has nothing to offer until the tags are read', () => {
  expect(tagChoices(undefined, [], 'VIP')).toEqual({
    groups: [],
    options: [],
    matching: 0,
    create: null,
    alreadyChosen: false,
  });
});

it('knows when a setting is full', () => {
  expect(hasRoom(['a', 'b'], 3)).toBe(true);
  expect(hasRoom(['a', 'b', 'c'], 3)).toBe(false);
});

it('moves through the list with the arrows, round the ends, and to either end', () => {
  expect(isListKey('ArrowDown')).toBe(true);
  expect(isListKey('ArrowUp')).toBe(true);
  expect(isListKey('Home')).toBe(true);
  expect(isListKey('End')).toBe(true);
  expect(isListKey('Enter')).toBe(false);
  expect(stepped(-1, 3, 'ArrowDown')).toBe(0);
  expect(stepped(0, 3, 'ArrowDown')).toBe(1);
  expect(stepped(2, 3, 'ArrowDown')).toBe(0);
  expect(stepped(-1, 3, 'ArrowUp')).toBe(2);
  expect(stepped(0, 3, 'ArrowUp')).toBe(2);
  expect(stepped(2, 3, 'ArrowUp')).toBe(1);
  expect(stepped(1, 3, 'Home')).toBe(0);
  expect(stepped(1, 3, 'End')).toBe(2);
  expect(stepped(0, 0, 'ArrowDown')).toBe(-1);
});
