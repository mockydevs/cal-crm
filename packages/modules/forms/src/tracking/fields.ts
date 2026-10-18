// What a form on another website sent, read as GoHighLevel's external tracking reads it: a
// field whose name or label names a contact property fills that property (an email address,
// a phone number, a first, last or full name), and everything else is kept as it was sent,
// unmapped, for the team to read. The script already leaves out passwords and card fields;
// they are left out here again, whatever a program sent.
import type { PublicTrackingField } from '@repo/contracts';

export type CapturedField = PublicTrackingField;

export interface MappedForm {
  readonly email?: string;
  readonly phone?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  /** Every field kept: not sensitive, and with a value. */
  readonly kept: readonly CapturedField[];
  /** What filled no contact property. */
  readonly unmapped: readonly CapturedField[];
}

/** A name or label, as compared: lowercase letters and digits only. */
const keyOf = (text: string | undefined): string =>
  (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const SENSITIVE =
  /pass(word|wd)|^pwd$|userpass|card(number|no|num)|^cc(num|number|no|exp|cvv|cvc|csc)?$|creditcard|debitcard|cvv|cvc|^csc$|securitycode|iban|^ssn$|socialsecurity|routingnumber|accountnumber|sortcode|taxid/;

/** Whether a field is one no tracking keeps: a password, a card, an account number. */
export function isSensitive(field: CapturedField): boolean {
  return SENSITIVE.test(keyOf(field.name)) || SENSITIVE.test(keyOf(field.label));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const looksLikeEmail = (value: string): boolean => value.length <= 254 && EMAIL.test(value);
const looksLikePhone = (value: string): boolean =>
  value.length <= 40 && /^[+()\-.\s\d]+$/.test(value) && (value.match(/\d/g)?.length ?? 0) >= 7;

const FIRST = new Set(['firstname', 'fname', 'first', 'givenname', 'yourfirstname', 'namefirst']);
const LAST = new Set([
  'lastname',
  'lname',
  'last',
  'surname',
  'familyname',
  'yourlastname',
  'namelast',
]);
const FULL = new Set(['name', 'fullname', 'yourname', 'yourfullname', 'contactname']);

const names = (field: CapturedField): readonly string[] => [keyOf(field.name), keyOf(field.label)];
const isEmailField = (field: CapturedField): boolean =>
  names(field).some((key) => key.includes('email') || key === 'mail');
const isPhoneField = (field: CapturedField): boolean =>
  names(field).some(
    (key) =>
      key.includes('phone') ||
      ['tel', 'telephone', 'mobile', 'cell', 'yourtel', 'mobilenumber'].includes(key),
  );
const isIn = (set: ReadonlySet<string>) => (field: CapturedField) =>
  names(field).some((key) => set.has(key));

/** Reads the contact out of a form's fields; see the top of this file. */
export function mapFields(fields: readonly CapturedField[]): MappedForm {
  const kept: CapturedField[] = [];
  for (const field of fields) {
    if (isSensitive(field)) continue;
    // A NUL is the one character Postgres text cannot hold.
    const value = field.value.replaceAll('\u0000', '').trim();
    if (value === '') continue;
    kept.push({ ...field, value });
  }
  const used = new Set<CapturedField>();
  const take = (
    matches: (field: CapturedField) => boolean,
    valid: (value: string) => boolean = () => true,
  ): string | undefined => {
    const found = kept.find((field) => !used.has(field) && matches(field) && valid(field.value));
    if (found === undefined) return undefined;
    used.add(found);
    return found.value;
  };
  const email =
    take(isEmailField, looksLikeEmail) ?? take((field) => !isPhoneField(field), looksLikeEmail);
  const phone = take(isPhoneField, looksLikePhone);
  let firstName = take(isIn(FIRST));
  let lastName = take(isIn(LAST));
  if (firstName === undefined && lastName === undefined) {
    const full = take(isIn(FULL));
    if (full !== undefined) {
      const [first = full, ...rest] = full.split(/\s+/);
      firstName = first;
      if (rest.length > 0) lastName = rest.join(' ');
    }
  }
  return {
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(firstName === undefined ? {} : { firstName }),
    ...(lastName === undefined ? {} : { lastName }),
    kept,
    unmapped: kept.filter((field) => !used.has(field)),
  };
}
