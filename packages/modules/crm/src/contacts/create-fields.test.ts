import { expect, it } from 'vitest';

import { asChoiceKeys } from './create-fields.js';

const options = [
  { key: 'dj', label: 'DJ', archived: false },
  { key: 'photo_video', label: 'Photo/Video', archived: false },
];

it('gives a choice field the key of a choice named by its label, and leaves the rest to its check', () => {
  expect(asChoiceKeys('single_choice', options, 'Photo/Video')).toBe('photo_video');
  expect(asChoiceKeys('single_choice', options, 'dj')).toBe('dj');
  expect(asChoiceKeys('single_choice', options, 'Harp')).toBe('Harp');
  expect(asChoiceKeys('single_choice', options, ['DJ'])).toEqual(['DJ']);
  expect(asChoiceKeys('multi_choice', options, 'DJ, Photo/Video')).toEqual(['dj', 'photo_video']);
  expect(asChoiceKeys('multi_choice', options, ['photo/video', 'Harp'])).toEqual([
    'photo_video',
    'Harp',
  ]);
  expect(asChoiceKeys('multi_choice', options, 'Harp')).toBe('Harp');
  expect(asChoiceKeys('text', options, 'DJ')).toBe('DJ');
  expect(asChoiceKeys('boolean', options, true)).toBe(true);
  expect(asChoiceKeys('text', options, ['a'])).toEqual(['a']);
});
