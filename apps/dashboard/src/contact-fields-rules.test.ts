import { expect, it } from 'vitest';
import { matchingGroups, type FieldGroup } from './contact-fields-rules';

const groups: readonly FieldGroup<{ readonly label: string }>[] = [
  { id: 'contact', name: 'Contact', items: [{ label: 'First name' }, { label: 'Email' }] },
  { id: 'additional', name: 'Additional Info', items: [{ label: 'Budget' }, { label: 'Venue' }] },
];

it('shows every group while nothing is searched for', () => {
  expect(matchingGroups(groups, '')).toEqual(groups);
  expect(matchingGroups(groups, '   ')).toEqual(groups);
});

it('keeps the fields whose label has the words, whatever their case', () => {
  expect(matchingGroups(groups, ' BUD ')).toEqual([
    { id: 'additional', name: 'Additional Info', items: [{ label: 'Budget' }] },
  ]);
  expect(matchingGroups(groups, 'e')).toEqual([
    { id: 'contact', name: 'Contact', items: [{ label: 'First name' }, { label: 'Email' }] },
    { id: 'additional', name: 'Additional Info', items: [{ label: 'Budget' }, { label: 'Venue' }] },
  ]);
});

it('keeps a whole group when its own name matches', () => {
  expect(matchingGroups(groups, 'additional')).toEqual([groups[1]]);
});

it('leaves out the groups nothing matches in', () => {
  expect(matchingGroups(groups, 'zzz')).toEqual([]);
});
