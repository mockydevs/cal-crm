// A phone number with a country picker, for Settings → Users. The countries, their calling
// codes and what a valid number is are libphonenumber's own (its "min" metadata); nothing
// here lists a code by hand. Fetched with the phone field, not with the page.
import {
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';
import type { PhoneDraft } from './users-rules';

export type { CountryCode };

/** The API's own shape for a phone: E.164, seven to fifteen digits. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

/** The country the picker starts on: the one given when libphonenumber knows it, else the US. */
export function countryOr(code: string | null | undefined): CountryCode {
  const wanted = (code ?? '').toUpperCase();
  return isSupportedCountry(wanted) ? wanted : 'US';
}

export interface CountryChoice {
  readonly code: CountryCode;
  /** The country's name in the reader's language, or its code when the browser has none. */
  readonly name: string;
  /** Its calling code, without the plus. */
  readonly dial: string;
}

/** Every country libphonenumber knows, by name in the language given. */
export function countryChoices(locale: string): CountryChoice[] {
  const names = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
  return getCountries()
    .map((code) => ({
      code,
      name: names.of(code) ?? code,
      dial: getCountryCallingCode(code),
    }))
    .toSorted((one, other) => one.name.localeCompare(other.name, locale));
}

/** What is typed, as the number the API keeps: nothing typed is no phone, and is fine. */
export function phoneOf(country: CountryCode, typed: string): PhoneDraft {
  if (typed.trim() === '') return { value: null, valid: true };
  const parsed = parsePhoneNumberFromString(typed, country);
  return parsed?.isValid() === true && E164.test(parsed.number)
    ? { value: parsed.number, valid: true }
    : { value: null, valid: false };
}

/**
 * A saved number as the field shows it: its country, and the number as that country writes
 * it. A number with no country of its own (a global service number) stays whole, with its
 * plus, which is read the same whichever country is picked.
 */
export function partsOf(
  phone: string | null,
  fallback: CountryCode,
): { readonly country: CountryCode; readonly typed: string } {
  if (phone === null) return { country: fallback, typed: '' };
  const parsed = parsePhoneNumberFromString(phone);
  if (parsed?.country === undefined) return { country: fallback, typed: phone };
  return { country: parsed.country, typed: parsed.formatNational() };
}
