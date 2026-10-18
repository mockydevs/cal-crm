import { fieldValueTypes } from '@repo/contracts';
import { expect, it } from 'vitest';
import { fieldKinds, kindOf, typeOfKind } from './custom-field-words';

it("offers every value type, and GoHighLevel's Radio select and Checkbox as choices shown their way", () => {
  expect([...fieldKinds].sort()).toEqual([...fieldValueTypes, 'radio', 'checkbox'].sort());
  expect(typeOfKind('radio')).toEqual({ valueType: 'single_choice', display: 'radio' });
  expect(typeOfKind('checkbox')).toEqual({ valueType: 'multi_choice', display: 'checkbox' });
  expect(typeOfKind('text_list')).toEqual({ valueType: 'text_list' });
});

it('names a saved field by its type and how its choices are shown', () => {
  expect(kindOf({ valueType: 'single_choice', display: 'radio' })).toBe('radio');
  expect(kindOf({ valueType: 'multi_choice', display: 'checkbox' })).toBe('checkbox');
  expect(kindOf({ valueType: 'single_choice', display: 'dropdown' })).toBe('single_choice');
  expect(kindOf({ valueType: 'file', display: null })).toBe('file');
  for (const kind of fieldKinds) expect(kindOf(typeOfKind(kind))).toBe(kind);
});
