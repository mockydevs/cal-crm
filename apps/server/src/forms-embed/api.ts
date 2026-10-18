// The form embed's calls to the CRM. Runs in a visitor's browser on someone else's website,
// so it trusts nothing it receives and never throws: every outcome is a value, and anything
// unexpected reads as "not available".

export const FIELD_TYPES = [
  'text',
  'long_text',
  'email',
  'phone',
  'number',
  'date',
  'single_choice',
  'checkbox',
  'multi_choice',
  'url',
  'rating',
  'hidden',
  'content',
  'terms',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const DISPLAYS = ['dropdown', 'radio', 'checkboxes'] as const;
export type Display = (typeof DISPLAYS)[number];

export interface EmbedField {
  readonly key: string;
  readonly type: FieldType;
  /** Empty for a block of text and a terms box, which show `text` instead. */
  readonly label: string;
  readonly helpText: string;
  readonly required: boolean;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  /** An example in the empty box of a question that is typed into. */
  readonly placeholder?: string;
  /** How a choice question shows its choices. */
  readonly display?: Display;
  /** For a hidden question: the query parameter of the page its answer is read from. */
  readonly parameter?: string;
  /** The words of a block of text, or the wording beside a terms box. */
  readonly text?: string;
  /** Whether a block of text is a heading. */
  readonly heading?: boolean;
  /** For a terms box: a secure address where the terms are, and the words of the link. */
  readonly linkUrl?: string;
  readonly linkLabel?: string;
}
export interface EmbedConsent {
  readonly key: string;
  readonly wording: string;
  readonly required: boolean;
}
/** What the embed shows, from GET /public/forms/{key}. */
export interface EmbedForm {
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
  readonly successMessage: string;
  /** A secure address the visitor is sent on to once the form is sent. */
  readonly redirectUrl?: string;
  readonly fields: readonly EmbedField[];
  readonly consents: readonly EmbedConsent[];
  readonly renderToken: string;
  /** The form asks the browser for ALTCHA's proof of work before it is sent. */
  readonly botProtection?: 'altcha';
  readonly textLength: number;
  readonly longTextLength: number;
}

/**
 * An ALTCHA v2 challenge as the CRM gave it, from POST /public/forms/{key}/challenge. Only
 * what the solver reads is checked here; the whole is sent back as it came, and the CRM
 * checks its signature.
 */
export interface EmbedChallenge {
  readonly parameters: {
    readonly algorithm: 'PBKDF2/SHA-256';
    readonly nonce: string;
    readonly salt: string;
    readonly cost: number;
    readonly keyLength: number;
    readonly keyPrefix: string;
    readonly expiresAt?: number;
  } & Readonly<Record<string, unknown>>;
  readonly signature: string;
}

/** The solved challenge, sent with the submission. */
export interface BotProof {
  readonly kind: 'altcha';
  readonly challenge: EmbedChallenge;
  readonly solution: { readonly counter: number; readonly derivedKey: string };
}

/** An answer as it is sent: text, a tick, or the keys of several choices. */
export type Value = string | boolean | readonly string[];

/** What is sent: POST /public/forms/{key}/submissions. */
export interface Submission {
  readonly clientSubmissionId: string;
  readonly renderToken: string;
  readonly values: Readonly<Record<string, Value>>;
  readonly consents: Readonly<Record<string, boolean>>;
  readonly trap: string;
  /** The solved challenge, when the form asks for one. */
  readonly botProof?: BotProof;
  readonly pageUrl?: string;
  /** The origin of the page the visitor came from, when the browser says. */
  readonly referrer?: string;
  /** How the visit began, when it began on another page of the same website. */
  readonly first?: FirstArrival;
}

/** The page a visit began on, the origin of the site before it, and when (milliseconds). */
export interface FirstArrival {
  readonly pageUrl: string;
  readonly referrer?: string;
  readonly at?: number;
}

/** A problem with one answer: the question or box it is about, and what to say. */
export interface AnswerIssue {
  /** `values` for a question, `consents` for a box, or neither for the form as a whole. */
  readonly on: 'values' | 'consents' | 'form';
  readonly key: string;
  readonly message: string;
}

export type Failure =
  /** The form is not published, the website is not allowed, or the CRM answered with an error. */
  | 'unavailable'
  /** Sent too soon, or the form has taken all it takes for now: wait. */
  | 'limited'
  /** The form was shown too long ago or has changed: load it again. */
  | 'stale'
  /** The answers were refused. */
  | 'invalid'
  /** No answer at all: offline, blocked, or refused before the CRM could say why. */
  | 'network';

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly failure: Failure;
      readonly retryAfterSeconds?: number;
      readonly issues?: readonly AnswerIssue[];
    };

/** The part of fetch the client uses; tests pass their own. */
export type Fetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly credentials: 'omit';
    readonly mode: 'cors';
    readonly cache: 'no-store';
    readonly referrerPolicy: 'no-referrer';
    readonly redirect: 'error';
  },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface FormApi {
  load(): Promise<Outcome<EmbedForm>>;
  send(submission: Submission): Promise<Outcome<null>>;
  /** The challenge for the showing this render token stands for. */
  challenge(renderToken: string): Promise<Outcome<EmbedChallenge>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isLength = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
/** A key goes into the request and into element ids: only the alphabet it is made of. */
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const isKey = (value: unknown): value is string => typeof value === 'string' && KEY.test(value);
const isFieldType = (value: unknown): value is FieldType =>
  FIELD_TYPES.some((type) => type === value);

/** The name of a query parameter: it is looked up in the page's address, never run. */
const PARAMETER = /^[A-Za-z][A-Za-z0-9_.-]{0,59}$/;

/**
 * A secure web address, or undefined. Checked by the browser's own reading of it, since
 * that is what will follow it, and given back as the browser read it: nothing but https is
 * ever put in a link or navigated to, and what is used is exactly what was checked.
 */
export function secureUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** What only some kinds of question have. Anything of the wrong kind makes the form unreadable. */
function readExtras(
  value: Readonly<Record<string, unknown>>,
): Omit<EmbedField, 'key' | 'type' | 'label' | 'helpText' | 'required' | 'options'> | undefined {
  const { placeholder, display, parameter, text, style, linkUrl, linkLabel } = value;
  for (const words of [placeholder, text, linkLabel])
    if (words !== undefined && typeof words !== 'string') return undefined;
  if (display !== undefined && !DISPLAYS.some((each) => each === display)) return undefined;
  if (parameter !== undefined && (typeof parameter !== 'string' || !PARAMETER.test(parameter)))
    return undefined;
  if (style !== undefined && style !== 'heading' && style !== 'paragraph') return undefined;
  const link = linkUrl === undefined ? undefined : secureUrl(linkUrl);
  if (linkUrl !== undefined && link === undefined) return undefined;
  return {
    ...(typeof placeholder === 'string' ? { placeholder } : {}),
    ...(typeof display === 'string' ? { display: display as Display } : {}),
    ...(typeof parameter === 'string' ? { parameter } : {}),
    ...(typeof text === 'string' ? { text } : {}),
    ...(style === 'heading' ? { heading: true } : {}),
    ...(link === undefined ? {} : { linkUrl: link }),
    ...(typeof linkLabel === 'string' ? { linkLabel } : {}),
  };
}

function readField(value: unknown): EmbedField | undefined {
  if (!isRecord(value)) return undefined;
  const { key, type, label, helpText, required, options } = value;
  if (!isKey(key) || !isFieldType(type)) return undefined;
  if (typeof label !== 'string' || typeof helpText !== 'string') return undefined;
  if (typeof required !== 'boolean' || !Array.isArray(options)) return undefined;
  const choices: { key: string; label: string }[] = [];
  for (const option of options) {
    if (!isRecord(option) || !isKey(option['key']) || typeof option['label'] !== 'string')
      return undefined;
    choices.push({ key: option['key'], label: option['label'] });
  }
  const extras = readExtras(value);
  if (extras === undefined) return undefined;
  return { key, type, label, helpText, required, options: choices, ...extras };
}

function readConsent(value: unknown): EmbedConsent | undefined {
  if (!isRecord(value)) return undefined;
  const { key, wording, required } = value;
  return isKey(key) && typeof wording === 'string' && typeof required === 'boolean'
    ? { key, wording, required }
    : undefined;
}

/** A form exactly as the contract gives it, or undefined: nothing else is ever shown. */
export function readForm(value: unknown): EmbedForm | undefined {
  if (!isRecord(value)) return undefined;
  const { title, description, submitLabel, successMessage, renderToken } = value;
  if (typeof title !== 'string' || typeof description !== 'string') return undefined;
  if (typeof submitLabel !== 'string' || typeof successMessage !== 'string') return undefined;
  // The token goes back in a request body: only the alphabet it is made of.
  if (typeof renderToken !== 'string' || !/^[0-9]{13}\.[A-Za-z0-9_-]{43}$/.test(renderToken))
    return undefined;
  if (!isLength(value['textLength']) || !isLength(value['longTextLength'])) return undefined;
  if (!Array.isArray(value['fields']) || !Array.isArray(value['consents'])) return undefined;
  const fields: EmbedField[] = [];
  for (const each of value['fields']) {
    const field = readField(each);
    if (field === undefined) return undefined;
    fields.push(field);
  }
  const consents: EmbedConsent[] = [];
  for (const each of value['consents']) {
    const consent = readConsent(each);
    if (consent === undefined) return undefined;
    consents.push(consent);
  }
  // A kind of protection this embed cannot give is a form it cannot send.
  const bot = value['botProtection'];
  if (bot !== undefined && bot !== 'altcha' && bot !== 'off') return undefined;
  const redirectUrl =
    value['redirectUrl'] === undefined ? undefined : secureUrl(value['redirectUrl']);
  // Somewhere to send the visitor that is not a secure address is nowhere to send them.
  if (value['redirectUrl'] !== undefined && redirectUrl === undefined) return undefined;
  return {
    title,
    description,
    submitLabel,
    successMessage,
    ...(redirectUrl === undefined ? {} : { redirectUrl }),
    fields,
    consents,
    renderToken,
    ...(bot === 'altcha' ? { botProtection: 'altcha' as const } : {}),
    textLength: value['textLength'],
    longTextLength: value['longTextLength'],
  };
}

const HEX = /^(?:[0-9a-f]{2}){1,64}$/;
/** The most work a challenge may ask for before the embed declines to try it. */
const MOST_COST = 100_000;

/** A challenge the solver can work on, or undefined. */
export function readChallenge(value: unknown): EmbedChallenge | undefined {
  if (!isRecord(value) || value['kind'] !== 'altcha') return undefined;
  const challenge = value['challenge'];
  if (!isRecord(challenge) || typeof challenge['signature'] !== 'string') return undefined;
  const parameters = challenge['parameters'];
  if (!isRecord(parameters)) return undefined;
  const { algorithm, nonce, salt, cost, keyLength, keyPrefix, expiresAt } = parameters;
  if (algorithm !== 'PBKDF2/SHA-256') return undefined;
  if (typeof nonce !== 'string' || !HEX.test(nonce)) return undefined;
  if (typeof salt !== 'string' || !HEX.test(salt)) return undefined;
  if (typeof keyPrefix !== 'string' || !/^[0-9a-f]{1,128}$/.test(keyPrefix)) return undefined;
  if (!isLength(cost) || cost > MOST_COST || !isLength(keyLength) || keyLength > 64)
    return undefined;
  if (expiresAt !== undefined && !isLength(expiresAt)) return undefined;
  return {
    parameters: { ...parameters, algorithm, nonce, salt, cost, keyLength, keyPrefix },
    signature: challenge['signature'],
  };
}

/** The problems of a refused submission, as far as they name a question or a box. */
export function readIssues(value: unknown): AnswerIssue[] {
  const errors = isRecord(value) ? value['errors'] : undefined;
  if (!Array.isArray(errors)) return [];
  const issues: AnswerIssue[] = [];
  for (const each of errors) {
    if (!isRecord(each) || typeof each['message'] !== 'string') continue;
    const path = typeof each['path'] === 'string' ? each['path'] : '';
    const [, on, key] = /^\/(values|consents)\/([a-z][a-z0-9_]{0,39})$/.exec(path) ?? [];
    if ((on === 'values' || on === 'consents') && key !== undefined)
      issues.push({ on, key, message: each['message'] });
    else if (path === '') issues.push({ on: 'form', key: '', message: each['message'] });
  }
  return issues;
}

function failureOf(status: number): Failure {
  if (status === 409) return 'stale';
  if (status === 429) return 'limited';
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'invalid';
  return 'unavailable';
}

function retryAfter(header: string | null): number | undefined {
  if (header === null || !/^\d{1,5}$/.test(header)) return undefined;
  const seconds = Number(header);
  return seconds >= 1 ? seconds : undefined;
}

/** Which form the client is for, and where it runs. */
export interface FormApiOptions {
  /** The form is a draft, named by a preview link's token instead of a form key. */
  readonly preview?: boolean;
  /**
   * The page is the CRM's own (same address as `base`). A browser sends no Origin with a
   * GET to the page's own address, so the request says so itself, with a header no page
   * on another website can send (the CRM's preflight does not allow it).
   */
  readonly ownPage?: boolean;
}

/**
 * The client for one form. `base` is the CRM's own address, taken from the script's URL;
 * `formKey` (or a preview's token) comes from the embedding page and is checked before it
 * is put in a path. Requests carry no cookies, no referrer and follow no redirect.
 */
export function createFormApi(
  base: string,
  formKey: string,
  fetch: Fetch,
  options: FormApiOptions = {},
): FormApi {
  const root = `${base}/api/v1/public/forms/${options.preview === true ? 'preview/' : ''}${encodeURIComponent(formKey)}`;

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    read: (value: unknown) => T | undefined,
    body?: unknown,
  ): Promise<Outcome<T>> {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.ownPage === true) headers['x-crm-form'] = '1';
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${root}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
      if (response.status < 200 || response.status > 299) {
        const failure = failureOf(response.status);
        const wait = retryAfter(response.headers.get('retry-after'));
        // Only a refusal of the answers says which; a body that cannot be read says none.
        const issues =
          response.status === 422 ? readIssues(await response.json().catch(() => null)) : [];
        return {
          ok: false,
          failure,
          ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
          ...(issues.length === 0 ? {} : { issues }),
        };
      }
      const value = read(await response.json());
      return value === undefined ? { ok: false, failure: 'unavailable' } : { ok: true, value };
    } catch {
      return { ok: false, failure: 'network' };
    }
  }

  return {
    load: () => call('GET', '', readForm),
    send: (submission) =>
      call(
        'POST',
        '/submissions',
        (value) => (isRecord(value) && value['status'] === 'received' ? null : undefined),
        submission,
      ),
    challenge: (renderToken) => call('POST', '/challenge', readChallenge, { renderToken }),
  };
}
