import { describe, expect, it } from 'vitest';

const at = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];
  if (item === undefined) throw new Error(`Nothing at ${String(index)}.`);
  return item;
};
import {
  fits,
  ownChoice,
  pickerChoices,
  plain,
  toggled,
  type PickerItem,
} from './search-picker-rules';

const templates: PickerItem[] = [
  { id: 'a', name: 'Welcome', detail: 'Hello from Harbor Lights' },
  { id: 'b', name: 'Pricing guide', detail: 'Your guide, {{contact.firstName}}', group: 'Sales' },
  { id: 'c', name: 'Follow-up', detail: 'Still thinking it over?', group: 'Sales / Weddings' },
  { id: 'd', name: 'Thank you', detail: 'Thanks for booking', group: 'Sales' },
  { id: 'e', name: 'Décor ideas', detail: undefined },
];

describe('what fits what is typed', () => {
  it('compares without capitals, accents or doubled spaces', () => {
    expect(plain('  Décor   IDEAS ')).toBe('decor ideas');
    expect(fits(at(templates, 4), 'decor')).toBe(true);
  });

  it('finds a row by its name or by its second line, every word typed', () => {
    expect(fits(at(templates, 1), 'pricing')).toBe(true);
    expect(fits(at(templates, 1), 'your guide')).toBe(true);
    expect(fits(at(templates, 1), 'guide pricing')).toBe(true);
    expect(fits(at(templates, 1), 'guide wedding')).toBe(false);
  });
});

describe('the rows of a list', () => {
  it('lists the rows under no heading first, then each heading where it first appears', () => {
    const choices = pickerChoices(templates, '');
    expect(choices.groups.map((group) => [group.name, group.items.map((item) => item.id)])).toEqual(
      [
        [undefined, ['a', 'e']],
        ['Sales', ['b', 'd']],
        ['Sales / Weddings', ['c']],
      ],
    );
    expect(choices.options.map((item) => item.id)).toEqual(['a', 'e', 'b', 'd', 'c']);
    expect(choices.matching).toBe(5);
  });

  it('narrows by subject, and leaves out a heading with nothing under it', () => {
    const choices = pickerChoices(templates, 'thinking');
    expect(choices.groups).toEqual([{ name: 'Sales / Weddings', items: [templates[2]] }]);
    expect(choices.matching).toBe(1);
  });

  it('cuts a long list short and says how many there are', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: String(index),
      name: `Template ${String(index)}`,
    }));
    const choices = pickerChoices(many, '');
    expect(choices.options).toHaveLength(50);
    expect(choices.matching).toBe(60);
    // Every name with a 5 in it: 5, 15 to 45, and 50 to 59.
    expect(pickerChoices(many, 'template 5').matching).toBe(15);
  });

  it('holds nothing when nothing fits', () => {
    expect(pickerChoices(templates, 'zzz')).toEqual({ groups: [], options: [], matching: 0 });
  });
});

describe("a choice of the person's own", () => {
  const sources: PickerItem[] = [{ id: 'Google Ads', name: 'Google Ads' }];
  it('is what was typed, trimmed', () => {
    expect(ownChoice('  Radio  ', sources, [], 200)).toBe('Radio');
  });
  it('is nothing when empty, too long, a row already, or chosen already', () => {
    expect(ownChoice('  ', sources, [], 200)).toBeUndefined();
    expect(ownChoice('abcdef', sources, [], 5)).toBeUndefined();
    expect(ownChoice('google ads', sources, [], 200)).toBeUndefined();
    expect(ownChoice('radio', sources, ['Radio'], 200)).toBeUndefined();
  });
});

it('ticks and unticks a row of a list that takes several', () => {
  expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
  expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
});
