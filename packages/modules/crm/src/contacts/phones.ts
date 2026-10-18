// Phone numbers in E.164, with libphonenumber-js's default ("min") metadata. A number is
// accepted when its length is possible for its country (isPossible), not when its digits
// match the current numbering plan (isValid): plans change, and an install that isn't
// updated must still accept newly issued numbers (the library's README, "Using phone
// number validation feature").
//
// The North American Numbering Plan (+1) is the exception, for the parts of its format that
// are fixed (from NANPA's "NPA (Area) Codes" and "555 Line Numbers" pages):
// - a number is NXX-NXX-XXXX, where N is 2 to 9, so an area code or an exchange that
//   starts with 0 or 1 cannot exist;
// - the eight N11 codes (211 to 911) are service codes and never area codes;
// - ten equal digits (000 000 0000, 222 222 2222) are typed placeholders, not numbers.
// 555-0100 to 555-0199 are reserved for fiction and advertising in every area code: they
// are accepted as written, and never used to find a contact (isMatchablePhone).
import type { ContactPhone } from '@repo/contracts';
import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

/** What crm.contact_identities keeps (contact_identities_phone_format). */
const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Why a number was refused: a code for programs and words for people. */
export interface PhoneProblem {
  readonly code: 'phone_invalid' | 'phone_country_unknown' | 'phone_extension';
  readonly message: string;
}

/** A business's two-letter country, if the library knows it: for numbers in national form. */
export function phoneCountry(code: string | null | undefined): CountryCode | undefined {
  return typeof code === 'string' && isSupportedCountry(code) ? code : undefined;
}

/** A number as written, in E.164, or why it isn't one. */
export function normalizePhone(
  text: string,
  country: CountryCode | undefined,
): string | PhoneProblem {
  const parsed = parsePhoneNumberFromString(
    text,
    country === undefined ? { extract: false } : { defaultCountry: country, extract: false },
  );
  if (parsed === undefined && country === undefined && !text.trimStart().startsWith('+'))
    return {
      code: 'phone_country_unknown',
      message:
        "Start with + and the country code, such as +1 212 555 0142, or set the business's country in its profile.",
    };
  if (
    parsed === undefined ||
    !parsed.isPossible() ||
    !E164.test(parsed.number) ||
    impossibleInNanp(parsed.number)
  )
    return { code: 'phone_invalid', message: 'Enter a phone number, such as +1 212 555 0142.' };
  if (parsed.ext !== undefined)
    return { code: 'phone_extension', message: 'Leave out the extension.' };
  return parsed.number;
}

const NANP = /^\+1(\d{3})(\d{3})(\d{4})$/;

/** Whether a +1 number breaks the plan's fixed format (the notes at the top). */
function impossibleInNanp(number: string): boolean {
  if (!number.startsWith('+1')) return false;
  const match = NANP.exec(number);
  if (match === null) return true;
  const [, area = '', exchange = ''] = match;
  return (
    !/^[2-9]/.test(area) ||
    !/^[2-9]/.test(exchange) ||
    /^[2-9]11$/.test(area) ||
    /^(\d)\1{9}$/.test(number.slice(2))
  );
}

/** 555-0100 to 555-0199 in any area code: reserved for fiction, so typed by people testing. */
export function isFictionalPhone(number: string): boolean {
  return /^\+1\d{3}55501\d{2}$/.test(number);
}

/**
 * Whether a stored number may find the contact that holds it, for details nobody has
 * verified: never a fictional number, and never one of the business's own.
 */
export function isMatchablePhone(number: string, ownNumbers: ReadonlySet<string>): boolean {
  return !isFictionalPhone(number) && !ownNumbers.has(number);
}

/** A stored number, and how people write it: in national form in the business's country. */
export function asContactPhone(number: string, country: CountryCode | undefined): ContactPhone {
  const parsed = parsePhoneNumberFromString(number);
  if (parsed === undefined) return { number, display: number };
  return {
    number,
    display: parsed.country === country ? parsed.formatNational() : parsed.formatInternational(),
  };
}
