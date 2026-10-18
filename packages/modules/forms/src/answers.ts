// A submission's answers against the form that was published, with no database. Everything
// a visitor sends is checked here against the question it answers: nothing is taken that
// the form did not ask for, and nothing is cut short to make it fit.
//
// One kind of answer is not the visitor's own: a hidden question's, which the embed reads
// from the address of the page. It is untrusted text all the same, held to the limits of
// a short answer; but a visitor cannot correct what they are not shown, so one that does
// not fit is left out, and the form's fixed answer, if it has one, is used.
import {
  FORM_LIMITS,
  type FormDefinition,
  type FormField,
  type FormFieldTarget,
} from '@repo/contracts';
import type { Issue } from '@repo/kernel';
import * as z from 'zod';

/** What an answer can be: text, a tick, or the keys of several choices. */
export type AnswerValue = string | boolean | readonly string[];

/** One question's answer, as it is stored and as it goes to the contact. */
export interface Answer {
  readonly key: string;
  readonly label: string;
  readonly type: FormField['type'];
  /**
   * Null for a question left empty. A checkbox is always true or false. A question that
   * takes several choices has their keys, in the order the form lists them.
   */
  readonly value: AnswerValue | null;
  readonly target: FormFieldTarget;
}

/** One terms box of the form, with what was shown beside it, and whether it was ticked. */
export interface AcceptedTerms {
  readonly key: string;
  readonly wording: string;
  readonly linkUrl: string | null;
  readonly accepted: boolean;
}

/** One consent box of the form, and whether the visitor ticked it. */
export interface TickedConsent {
  readonly key: string;
  readonly channel: 'email' | 'sms';
  readonly wording: string;
  readonly ticked: boolean;
}

export type ReadAnswers =
  | {
      readonly ok: true;
      readonly answers: readonly Answer[];
      readonly terms: readonly AcceptedTerms[];
      readonly consents: readonly TickedConsent[];
    }
  | { readonly ok: false; readonly issues: readonly [Issue, ...Issue[]] };

const EMAIL = z.string().max(320).regex(z.regexes.email);
const DATE = z.iso.date().refine((date) => !date.startsWith('0000-'));
const WEB_ADDRESS = z.url({ protocol: /^https?$/, hostname: z.regexes.domain });
/** A whole or decimal number as people type it; exact, never a float. */
const NUMBER = /^-?\d{1,15}(?:\.\d{1,6})?$/;
/** Digits with the punctuation people write phone numbers with; the CRM checks the rest. */
const PHONE = /^\+?[\d\s().-]{3,40}$/;
const ONE_LINE = /^\P{Cc}*$/u;
const PLAIN_TEXT = /^[\P{Cc}\t\n\r]*$/u;
/** How an address starts when it says how it is reached: `https:`, `mailto:` and so on. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

type Checked =
  { readonly value: AnswerValue | null } | { readonly code: string; readonly message: string };

const refuse = (code: string, message: string): Checked => ({ code, message });
const INVALID = refuse('invalid', 'This answer is not what the question asks for.');

/** The kinds of question whose answer arrives as text. */
type TextType = Exclude<FormField['type'], 'checkbox' | 'terms' | 'multi_choice' | 'content'>;

function checkText(raw: string, field: FormField, type: TextType): Checked {
  const text = raw.trim();
  if (text === '') return { value: null };
  switch (type) {
    case 'text':
    case 'hidden':
      if (text.length > FORM_LIMITS.textLength)
        return refuse('too_long', `Use at most ${String(FORM_LIMITS.textLength)} characters.`);
      return ONE_LINE.test(text) ? { value: text } : refuse('invalid', 'Use one line of text.');
    case 'long_text':
      if (text.length > FORM_LIMITS.longTextLength)
        return refuse('too_long', `Use at most ${String(FORM_LIMITS.longTextLength)} characters.`);
      return PLAIN_TEXT.test(text) ? { value: text } : refuse('invalid', 'Use plain text.');
    case 'email': {
      const address = text.toLowerCase();
      return EMAIL.safeParse(address).success
        ? { value: address }
        : refuse('invalid_email', 'Enter an email address, such as maya@example.com.');
    }
    case 'phone':
      return text.length <= 40 && PHONE.test(text) && /\d/.test(text)
        ? { value: text }
        : refuse('invalid_phone', 'Enter a phone number, with its country code.');
    case 'number':
      return NUMBER.test(text) ? { value: text } : refuse('invalid_number', 'Enter a number.');
    case 'date':
      return DATE.safeParse(text).success
        ? { value: text }
        : refuse('invalid_date', 'Enter a date.');
    case 'single_choice':
      return field.options.some((option) => option.key === text)
        ? { value: text }
        : refuse('invalid_choice', 'Choose one of the choices.');
    case 'rating':
      return /^[1-9]\d?$/.test(text) && Number(text) <= FORM_LIMITS.ratingMax
        ? { value: text }
        : refuse('invalid_rating', `Choose a rating from 1 to ${String(FORM_LIMITS.ratingMax)}.`);
    case 'url': {
      // People write "www.example.com": an address that names no way to reach it is a
      // secure web address. One that names another way (mailto:, ftp:) is not a website.
      const address = SCHEME.test(text) ? text : `https://${text}`;
      return address.length <= FORM_LIMITS.urlLength &&
        ONE_LINE.test(address) &&
        !/\s/.test(address) &&
        WEB_ADDRESS.safeParse(address).success
        ? { value: address }
        : refuse('invalid_url', 'Enter a web address, such as https://www.example.com.');
    }
  }
}

/** Several of the listed choices, each once, in the order the form lists them. */
function checkChoices(raw: readonly string[], field: FormField): Checked {
  const chosen = new Set(raw);
  if (chosen.size !== raw.length) return refuse('invalid_choice', 'Choose each choice once.');
  const listed = field.options.map((option) => option.key);
  if (raw.some((key) => !listed.includes(key)))
    return refuse('invalid_choice', 'Choose from the choices.');
  return { value: chosen.size === 0 ? null : listed.filter((key) => chosen.has(key)) };
}

/** A field that asks something. A block of text does not: it has no answer to read. */
type Question = FormField & { readonly type: Exclude<FormField['type'], 'content'> };
const isQuestion = (field: FormField): field is Question => field.type !== 'content';

function check(raw: string | boolean | readonly string[] | undefined, field: Question): Checked {
  const { type } = field;
  if (type === 'checkbox' || type === 'terms') {
    // A box that was not sent is a box that was not ticked.
    if (raw === undefined) return { value: false };
    return typeof raw === 'boolean' ? { value: raw } : INVALID;
  }
  if (type === 'hidden') {
    // Read from the page's address by the embed, never typed: one that does not fit is
    // left out, as if the address had none, and the form's fixed answer is used.
    const read = typeof raw === 'string' ? checkText(raw, field, type) : INVALID;
    if ('value' in read && read.value !== null) return read;
    const fixed = field.defaultValue ?? '';
    return { value: fixed === '' ? null : fixed };
  }
  if (raw === undefined) return { value: null };
  if (type === 'multi_choice') return Array.isArray(raw) ? checkChoices(raw, field) : INVALID;
  return typeof raw === 'string' ? checkText(raw, field, type) : INVALID;
}

const isBox = (field: FormField): boolean => field.type === 'checkbox' || field.type === 'terms';

const unanswered = (field: FormField, value: AnswerValue | null): boolean =>
  isBox(field) ? value !== true : value === null;

/**
 * The answers to a published form, checked, or every problem with them. An issue's path is
 * /values/<key> or /consents/<key>, so the embed can put each message by its question. The
 * messages are this file's own words: none repeats what a visitor typed.
 *
 * A block of text is not a question: it has no answer, and a value sent under its key is
 * refused like any other the form did not ask for. A terms box is read like a checkbox
 * and kept apart from the answers, with the wording it was shown with.
 */
export function readAnswers(
  definition: FormDefinition,
  input: {
    readonly values: Readonly<Record<string, string | boolean | readonly string[]>>;
    readonly consents: Readonly<Record<string, boolean>>;
  },
): ReadAnswers {
  const issues: Issue[] = [];
  const questions = definition.fields.filter(isQuestion);
  const asked = new Set(questions.map((field) => field.key));
  for (const key of Object.keys(input.values))
    if (!asked.has(key))
      issues.push({
        path: `/values/${key}`,
        code: 'unknown_question',
        message: 'This form does not ask that.',
      });
  const offered = new Set(definition.consents.map((consent) => consent.key));
  for (const key of Object.keys(input.consents))
    if (!offered.has(key))
      issues.push({
        path: `/consents/${key}`,
        code: 'unknown_box',
        message: 'This form does not offer that.',
      });

  const answers: Answer[] = [];
  const terms: AcceptedTerms[] = [];
  for (const field of questions) {
    const checked = check(
      Object.hasOwn(input.values, field.key) ? input.values[field.key] : undefined,
      field,
    );
    if ('code' in checked) {
      issues.push({ path: `/values/${field.key}`, ...checked });
      continue;
    }
    if (field.required && unanswered(field, checked.value)) {
      issues.push({
        path: `/values/${field.key}`,
        code: 'required',
        message: isBox(field) ? 'Tick this box to continue.' : 'Answer this question.',
      });
      continue;
    }
    if (field.type === 'terms')
      terms.push({
        key: field.key,
        // The words kept are the form's own, as they were shown.
        wording: field.text ?? '',
        linkUrl: field.linkUrl ?? null,
        accepted: checked.value === true,
      });
    else
      answers.push({
        key: field.key,
        label: field.label,
        type: field.type,
        value: checked.value,
        target: field.target,
      });
  }

  const consents: TickedConsent[] = [];
  for (const consent of definition.consents) {
    // Only a box sent as true was ticked; nothing here ever ticks one for the visitor.
    const ticked =
      Object.hasOwn(input.consents, consent.key) && input.consents[consent.key] === true;
    if (consent.required && !ticked) {
      issues.push({
        path: `/consents/${consent.key}`,
        code: 'required',
        message: 'Tick this box to continue.',
      });
      continue;
    }
    consents.push({ key: consent.key, channel: consent.channel, wording: consent.wording, ticked });
  }

  const [first, ...rest] = issues;
  return first === undefined
    ? { ok: true, answers, terms, consents }
    : { ok: false, issues: [first, ...rest] };
}

const UTM = ['source', 'medium', 'campaign', 'term', 'content'] as const;

/**
 * What is kept of the page a form was on. The page is whatever the embed says it is, so
 * it is kept only when it is on the website the request was admitted from, and without
 * its query and fragment, which can hold anything, a visitor's own details included. The
 * campaign labels are read out of the query first, each bounded.
 */
export function readPage(
  pageUrl: string | undefined,
  origin: string,
): { readonly pageUrl: string | null; readonly utm: Readonly<Record<string, string>> } {
  if (pageUrl === undefined || !URL.canParse(pageUrl)) return { pageUrl: null, utm: {} };
  const url = new URL(pageUrl);
  if (url.origin !== origin) return { pageUrl: null, utm: {} };
  const utm: Record<string, string> = {};
  for (const name of UTM) {
    const value = url.searchParams.get(`utm_${name}`)?.trim() ?? '';
    if (value !== '' && value.length <= 200 && ONE_LINE.test(value)) utm[name] = value;
  }
  const page = `${url.origin}${url.pathname}`;
  return { pageUrl: page.length <= FORM_LIMITS.pageUrlLength ? page : null, utm };
}
