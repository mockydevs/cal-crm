// Merge fields in a task's title and notes or a deal's name are filled in, and a field with
// no value refuses the step instead of leaving a gap.
import { ValidationError } from '@repo/kernel';
import { expect, it } from 'vitest';

import { mergedText } from './actions-text.js';

const values = { 'contact.firstName': 'Ada', 'contact.custom.venue': 'The Old Mill' };

const refusal = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof ValidationError) return error.issues;
    throw error;
  }
  throw new Error('Nothing was refused.');
};

it('fills in the title and the notes', () => {
  expect(
    mergedText(
      { title: 'Call {{contact.firstName}}', notes: 'About {{ contact.custom.venue }}.' },
      values,
    ),
  ).toEqual({ title: 'Call Ada', notes: 'About The Old Mill.' });
});

it('leaves text without merge fields as written, and notes may be empty', () => {
  expect(mergedText({ title: 'Send the quote', notes: '' }, {})).toEqual({
    title: 'Send the quote',
    notes: '',
  });
});

it('refuses a field with no value, naming it', () => {
  expect(
    refusal(() =>
      mergedText({ title: 'Call {{contact.lastName}}', notes: '{{steps.ask.answer}}' }, values),
    ),
  ).toEqual([
    {
      path: '/config',
      code: 'missing_values',
      message: 'There is no value for contact.lastName, steps.ask.answer.',
    },
  ]);
});

it('refuses a title that a value would break onto a second line', () => {
  expect(
    refusal(() =>
      mergedText(
        { title: 'Call {{contact.firstName}}', notes: '' },
        { 'contact.firstName': 'Ada\nLovelace' },
      ),
    ),
  ).toMatchObject([{ path: '/config', code: 'subject_line_break' }]);
});
