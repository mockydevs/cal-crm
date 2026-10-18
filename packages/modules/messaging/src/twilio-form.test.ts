// The raw form body of a Twilio webhook. Values are signed exactly as sent, so nothing
// here may trim, re-encode or drop anything.
import { expect, it } from 'vitest';

import { FORM_LIMITS, parseForm, singleValue } from './twilio-form.js';

const form = (text: string) => parseForm(Buffer.from(text, 'utf8'));

it('reads names and values without trimming them', () => {
  expect(form('Body=++STOP+%20&To=%2B15558675310&Empty=')).toEqual({
    Body: '  STOP  ',
    To: '+15558675310',
    Empty: '',
  });
});

it('decodes percent-encoded UTF-8, in names too', () => {
  expect(form('Body=caf%C3%A9+%F0%9F%98%80&N%C3%A4me=1')).toEqual({
    Body: 'café \u{1F600}',
    Näme: '1',
  });
});

it('keeps every value of a repeated name, in order', () => {
  expect(form('x=b&x=a&x=b&y=1')).toEqual({ x: ['b', 'a', 'b'], y: '1' });
});

it('reads a name without "=" as an empty value, and a value with "=" whole', () => {
  expect(form('flag&eq=a=b')).toEqual({ flag: '', eq: 'a=b' });
});

it('skips empty pairs and reads an empty body as no parameters', () => {
  expect(form('')).toEqual({});
  expect(form('a=1&&b=2&')).toEqual({ a: '1', b: '2' });
});

it('cannot be made to set a prototype', () => {
  const parsed = form('__proto__=x&constructor=y&toString=z');
  expect(Object.keys(parsed ?? {}).sort()).toEqual(['__proto__', 'constructor', 'toString']);
  expect(Object.getPrototypeOf(parsed)).toBeNull();
  expect(Object.prototype).not.toHaveProperty('x');
});

it.each([
  ['a broken escape', 'Body=%zz'],
  ['a cut-off escape', 'Body=%E2%82'],
  ['an escape that is not UTF-8', 'Body=%FF'],
  ['an empty name', '=value'],
])('refuses %s', (_what, text) => {
  expect(form(text)).toBeNull();
});

it('refuses bytes that are not UTF-8', () => {
  expect(parseForm(Buffer.from([0x42, 0x3d, 0xff, 0xfe]))).toBeNull();
});

it('refuses a body over each limit, and accepts one at the limit', () => {
  const fields = (count: number) =>
    Array.from({ length: count }, (_, index) => `f${String(index)}=1`).join('&');
  expect(form(fields(FORM_LIMITS.fields))).not.toBeNull();
  expect(form(fields(FORM_LIMITS.fields + 1))).toBeNull();
  expect(form(`${'n'.repeat(FORM_LIMITS.nameLength)}=1`)).not.toBeNull();
  expect(form(`${'n'.repeat(FORM_LIMITS.nameLength + 1)}=1`)).toBeNull();
  const big = 'a'.repeat(FORM_LIMITS.bytes - 2);
  expect(form(`a=${big}`)).not.toBeNull();
  expect(form(`a=${big}a`)).toBeNull();
});

it('gives a single value only when the name was sent exactly once', () => {
  const parsed = form('a=1&b=2&b=3') ?? {};
  expect(singleValue(parsed, 'a')).toBe('1');
  expect(singleValue(parsed, 'b')).toBeUndefined();
  expect(singleValue(parsed, 'missing')).toBeUndefined();
  expect(singleValue(parsed, 'toString')).toBeUndefined();
});
