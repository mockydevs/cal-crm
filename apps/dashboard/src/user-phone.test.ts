import { describe, expect, it } from 'vitest';
import { countryChoices, countryOr, partsOf, phoneOf } from './user-phone';

describe('the country picker', () => {
  it('starts on the country given, or the US when there is none it knows', () => {
    expect(countryOr('KE')).toBe('KE');
    expect(countryOr('ke')).toBe('KE');
    expect(countryOr(null)).toBe('US');
    expect(countryOr('Kenya')).toBe('US');
  });

  it('lists libphonenumber’s countries by name, each with its calling code', () => {
    const choices = countryChoices('en');
    expect(choices.length).toBeGreaterThan(200);
    expect(choices.find((each) => each.code === 'KE')).toEqual({
      code: 'KE',
      name: 'Kenya',
      dial: '254',
    });
    expect(choices.find((each) => each.code === 'US')?.dial).toBe('1');
    const names = choices.map((each) => each.name);
    expect(names).toEqual(names.toSorted((one, other) => one.localeCompare(other, 'en')));
  });
});

describe('a typed number', () => {
  it('becomes E.164 for the country picked, however it is spaced', () => {
    expect(phoneOf('US', '(305) 555-0123')).toEqual({ value: '+13055550123', valid: true });
    expect(phoneOf('KE', '0712 345 678')).toEqual({ value: '+254712345678', valid: true });
    expect(phoneOf('US', '+254 712 345678')).toEqual({ value: '+254712345678', valid: true });
  });

  it('is no phone when nothing is typed, and not a number when the country has none like it', () => {
    expect(phoneOf('US', '  ')).toEqual({ value: null, valid: true });
    expect(phoneOf('US', '12345')).toEqual({ value: null, valid: false });
    expect(phoneOf('US', 'call me')).toEqual({ value: null, valid: false });
  });
});

describe('a saved number', () => {
  it('opens in its own country, written as that country writes it', () => {
    expect(partsOf('+254712345678', 'US')).toEqual({ country: 'KE', typed: '0712 345678' });
    expect(partsOf(null, 'KE')).toEqual({ country: 'KE', typed: '' });
  });

  it('reads back as the same number', () => {
    for (const saved of ['+13055550123', '+254712345678', '+442079460958']) {
      const { country, typed } = partsOf(saved, 'US');
      expect(phoneOf(country, typed)).toEqual({ value: saved, valid: true });
    }
  });
});
