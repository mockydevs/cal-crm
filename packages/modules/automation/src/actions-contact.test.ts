// What a contact.update step asks the CRM's contact command to change for built-in fields.
// Setting an email or a phone makes it the primary one and keeps the others.
import { ValidationError } from '@repo/kernel';
import { expect, it } from 'vitest';

import { contactChanges, withoutRepeatedPhones } from './actions-contact.js';

const nobody = { emails: [], phones: [] };

const refusal = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof ValidationError) return error.issues;
    throw error;
  }
  throw new Error('Nothing was refused.');
};

it('sets and clears names', () => {
  expect(contactChanges({ 'contact.firstName': 'Ada', 'contact.lastName': null }, nobody)).toEqual({
    firstName: 'Ada',
    lastName: null,
  });
});

it('asks for nothing when no built-in field is named', () => {
  expect(contactChanges({}, { emails: ['ada@example.test'], phones: ['+254712345678'] })).toEqual(
    {},
  );
});

it('makes an email the primary one and keeps the rest after it', () => {
  expect(
    contactChanges(
      { 'contact.email': ' New@Example.test ' },
      { emails: ['old@example.test', 'second@example.test'], phones: [] },
    ),
  ).toEqual({ emails: ['new@example.test', 'old@example.test', 'second@example.test'] });
  // One the contact already has moves to the front; it is not listed twice.
  expect(
    contactChanges(
      { 'contact.email': 'SECOND@example.test' },
      { emails: ['old@example.test', 'second@example.test'], phones: [] },
    ),
  ).toEqual({ emails: ['second@example.test', 'old@example.test'] });
});

it('makes a phone the primary one and keeps the rest after it', () => {
  expect(
    contactChanges(
      { 'contact.phone': ' +254 700 000001 ' },
      { emails: [], phones: ['+254712345678'] },
    ),
  ).toEqual({ phones: ['+254 700 000001', '+254712345678'] });
  expect(
    contactChanges(
      { 'contact.phone': '+254712345678' },
      { emails: [], phones: ['+254700000001', '+254712345678'] },
    ),
  ).toEqual({ phones: ['+254712345678', '+254700000001'] });
});

it.each([
  ['contact.email', null],
  ['contact.phone', null],
  ['contact.email', '  '],
] as const)('refuses to empty %s (%s)', (path, value) => {
  expect(refusal(() => contactChanges({ [path]: value }, nobody))).toEqual([
    {
      path: `/config/fields/${path}`,
      code: 'unsupported_value',
      message: `${path} can be set, but not emptied.`,
    },
  ]);
});

it.each([
  ['contact.firstName', 5],
  ['contact.lastName', false],
  ['contact.phone', 254712345678],
  ['contact.email', true],
] as const)('refuses a value that is not text: %s', (path, value) => {
  expect(refusal(() => contactChanges({ [path]: value }, nobody))).toEqual([
    { path: `/config/fields/${path}`, code: 'invalid_value', message: `${path} takes text.` },
  ]);
});

it.each(['contact.name', 'contact.tags', 'contact.createdAt', 'deal.name', 'contact.nickname'])(
  'refuses %s, which the contact command cannot set',
  (path) => {
    expect(refusal(() => contactChanges({ [path]: 'x' }, nobody))).toEqual([
      {
        path: `/config/fields/${path}`,
        code: 'unsupported_field',
        message: `${path} can't be set by an automation.`,
      },
    ]);
  },
);

const repeated = (index: number) => ({
  path: `/phones/${String(index)}`,
  code: 'repeated',
  message: 'This phone number is already listed.',
});

it('drops the phone numbers the CRM found written twice, keeping the step’s own first', () => {
  const phones = ['0712 345678', '+254700000001', '+254712345678'];
  expect(withoutRepeatedPhones(phones, [repeated(2)])).toEqual(['0712 345678', '+254700000001']);
  expect(withoutRepeatedPhones(phones, [repeated(1), repeated(2)])).toEqual(['0712 345678']);
});

it('leaves any other refusal alone', () => {
  const phones = ['not a phone', '+254712345678'];
  expect(
    withoutRepeatedPhones(phones, [
      { path: '/phones/0', code: 'invalid_phone', message: 'Enter a phone number.' },
    ]),
  ).toBeUndefined();
  // A repeat reported at the step's own number is not one this can settle.
  expect(withoutRepeatedPhones(phones, [repeated(0)])).toBeUndefined();
  expect(
    withoutRepeatedPhones(phones, [
      repeated(1),
      { path: '/emails/0', code: 'taken', message: 'Another contact has this email address.' },
    ]),
  ).toBeUndefined();
});
