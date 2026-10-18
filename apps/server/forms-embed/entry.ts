// The script a website loads:
//
//   <script async src="https://crm.example.com/forms/embed.js" data-form-key="…"></script>
//
// It puts the form where the script tag is, or inside an element the page marks with
// data-crm-form="<the same key>". It reads the form key from its own tag and the CRM's
// address from its own URL. From the page it takes two things and no more: the page's
// address, to say where the form was sent from, and the query parameters of that address
// that the form's own hidden questions name (a campaign, a referrer's code); and the origin
// of the page the visitor came from, never its path, to say which site sent them. It reads no
// message from another window, no cookie and no storage, and adds no name to the window.
//
// How the visit began, when it began on another page, is handed to it and never looked for:
// on a page of a site the CRM serves, the page's own script writes it on this script's tag
// (data-arr, data-arr-ref, data-arr-at: packages/site-render/runtime/arrival.ts); on the
// CRM's own page for a form, a link from such a site carries it in the address (arr,
// arr_ref, arr_at). It is sent beside the page's own address, as `first`.
//
// On the page the CRM itself serves for a form (page.ts), the tag is the same. For the
// preview of a draft it carries data-form-preview="<token>" instead of a key; that works
// on the CRM's own address only.
//
// It must never break the page it is a guest on. Whatever goes wrong, a missing key, an old
// browser, an unreachable CRM, the outcome is no form or a short notice where the form
// would be, and never an uncaught error or a line in the console.
import {
  createFormApi,
  type AnswerIssue,
  type BotProof,
  type EmbedForm,
  type Fetch,
  type FirstArrival,
  type FormApi,
  type Value,
} from '../src/forms-embed/api.js';
import { strings } from '../src/forms-embed/strings.js';
import { solveAltcha, type Solve } from './bot.js';
import { createView, type Answers, type FormView } from './view.js';

const FORM_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const PREVIEW_TOKEN = /^[A-Za-z0-9_-]{70}\.[A-Za-z0-9_-]{22}$/;
const MOUNTED = 'data-crm-form-mounted';
/** What the CRM's own page for a form carries on its root element (page.ts). */
const OWN_PAGE = 'data-crm-form-page';
const PAGE_URL_LENGTH = 2000;

// Random UUIDs for submission ids. randomUUID needs a secure page; getRandomValues does not.
function newId(crypto: Crypto): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The page the form is on, without its fragment; left out when it is too long to send. */
export function pageUrl(
  location: Pick<Location, 'protocol' | 'origin' | 'pathname' | 'search'>,
): string | undefined {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return undefined;
  const page = `${location.origin}${location.pathname}`;
  const whole = `${page}${location.search}`;
  if (whole.length <= PAGE_URL_LENGTH) return whole;
  return page.length <= PAGE_URL_LENGTH ? page : undefined;
}

/**
 * The site the visitor came from: the origin of `document.referrer`, without its path and
 * query, which are another site's business. Left out when the browser gives none, when it
 * is not a web address, and when it is this same site.
 */
export function referrerOrigin(referrer: string, ownOrigin: string): string | undefined {
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin === ownOrigin ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/** A web address no longer than one may be to be sent, or undefined. */
function webAddress(text: string | null): URL | undefined {
  try {
    const url = new URL(text ?? '');
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.href.length <= PAGE_URL_LENGTH
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How the visit began, as it was handed over: on the script's own tag, or, with `search`
 * (the CRM's own page for a form), in the address. Only what the CRM would accept is
 * passed on, so nothing handed over can make a form unsendable: the page as an address,
 * the site before it as an origin, the moment as a whole number.
 */
export function firstArrival(tag: Element, search?: string): FirstArrival | undefined {
  let query: URLSearchParams | undefined;
  try {
    query = search === undefined ? undefined : new URLSearchParams(search);
  } catch {
    query = undefined;
  }
  const said = (attribute: string, parameter: string): string | null =>
    tag.getAttribute(attribute) ?? query?.get(parameter) ?? null;
  const page = webAddress(said('data-arr', 'arr'));
  if (page === undefined) return undefined;
  const from = webAddress(said('data-arr-ref', 'arr_ref'));
  const at = Number(said('data-arr-at', 'arr_at') ?? '');
  return {
    pageUrl: page.href,
    ...(from === undefined ? {} : { referrer: from.origin }),
    ...(Number.isSafeInteger(at) && at > 0 ? { at } : {}),
  };
}

/**
 * The answers of the form's hidden questions, read from the query of the page's address:
 * the first value of the parameter each one names. One that is not there, is empty, or is
 * longer than a short answer may be is left out; the CRM then uses the form's own fixed
 * answer, if it has one. Nothing else of the query is read.
 */
export function hiddenAnswers(form: EmbedForm, search: string): Record<string, string> {
  return addressAnswers(form, search, true);
}

/**
 * What the page's address says for the questions a visitor sees that name a parameter (a
 * "query key"): read as a hidden question's is, and put in the control when the form is
 * shown. The visitor may change it, and it is checked as a typed answer is.
 */
export function prefillAnswers(form: EmbedForm, search: string): Record<string, string> {
  return addressAnswers(form, search, false);
}

function addressAnswers(form: EmbedForm, search: string, hidden: boolean): Record<string, string> {
  const answers: Record<string, string> = {};
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    return answers;
  }
  for (const field of form.fields) {
    if ((field.type === 'hidden') !== hidden || field.parameter === undefined) continue;
    const value = (query.get(field.parameter) ?? '').trim();
    if (value !== '' && value.length <= form.textLength) answers[field.key] = value;
  }
  return answers;
}

const isEmpty = (value: Value | undefined): boolean =>
  value === undefined || value === '' || (typeof value === 'object' && value.length === 0);

/** What the visitor left out that the form asks for, before anything is sent. */
function missing(form: EmbedForm, answers: Answers): AnswerIssue[] {
  const issues: AnswerIssue[] = [];
  for (const field of form.fields) {
    const value = answers.values[field.key];
    // A hidden question and a block of text are not the visitor's to answer.
    if (!field.required || field.type === 'hidden' || field.type === 'content') continue;
    if (field.type === 'checkbox' || field.type === 'terms') {
      if (value !== true)
        issues.push({ on: 'values', key: field.key, message: strings.tickNeeded });
    } else if (isEmpty(value) || (typeof value === 'string' && value.trim() === ''))
      issues.push({ on: 'values', key: field.key, message: strings.answerNeeded });
  }
  for (const consent of form.consents)
    if (consent.required && answers.consents[consent.key] !== true)
      issues.push({ on: 'consents', key: consent.key, message: strings.tickNeeded });
  return issues;
}

/** What the page a form runs on gives it, besides the form itself. */
export interface Surroundings {
  /** The query of the page's address, as `location.search` has it. */
  readonly search?: string;
  /** The origin of the site the visitor came from (referrerOrigin). */
  readonly referrer?: string;
  /** How the visit began, asked for when the form is sent (firstArrival). */
  readonly first?: () => FirstArrival | undefined;
  /** Sends the visitor on to another page. Left out, a form that asks for it shows its message. */
  readonly navigate?: (url: string) => void;
  /** The form is a draft being previewed: nothing is stored, and nobody is sent on. */
  readonly preview?: boolean;
  /** Told the form's title once it is loaded: the CRM's own page names its tab after it. */
  readonly onTitle?: (title: string) => void;
  /**
   * Solves a form's bot challenge (bot.ts). Left out, a form that asks for one cannot be
   * sent: the check says it did not finish.
   */
  readonly solve?: Solve;
}

/** Seconds before a challenge's expiry when it is no longer sent, but solved again. */
const EXPIRY_MARGIN_SECONDS = 30;

/** Runs one form: loads it now, and returns what sends it when the visitor asks. */
export function run(
  view: FormView,
  api: FormApi,
  makeId: () => string,
  page: string | undefined,
  around: Surroundings = {},
): () => void {
  let form: EmbedForm | undefined;
  let submissionId: string | undefined;
  let busy = false;
  // The proof of work for the showing on the page, while it is being found and once it is.
  let proving: Promise<BotProof | undefined> | undefined;

  /**
   * Starts on the bot check of a form that asks for one, as soon as it is shown: the
   * challenge for its render token, solved while the visitor fills the form in.
   */
  function prove(shown: EmbedForm): void {
    proving = undefined;
    if (shown.botProtection !== 'altcha') return;
    view.showCheck('working');
    const solve = around.solve;
    const attempt: Promise<BotProof | undefined> = api
      .challenge(shown.renderToken)
      .then((given) => (given.ok && solve !== undefined ? solve(given.value) : undefined))
      .then((proof) => {
        // Only the latest showing's check is reported.
        if (proving === attempt) view.showCheck(proof === undefined ? 'failed' : 'done');
        return proof;
      });
    proving = attempt;
  }

  /** The proof to send with the form, solved again when it is about to expire. */
  async function proofToSend(shown: EmbedForm): Promise<BotProof | undefined> {
    let proof = await proving;
    const expiresAt = proof?.challenge.parameters.expiresAt;
    if (expiresAt !== undefined && (expiresAt - EXPIRY_MARGIN_SECONDS) * 1000 < Date.now()) {
      prove(shown);
      proof = await proving;
    }
    return proof;
  }

  async function load(): Promise<boolean> {
    const loaded = await api.load();
    if (!loaded.ok) return false;
    form = loaded.value;
    view.showForm(form);
    prove(form);
    // Only what the visitor has not answered: a form shown again keeps what was typed.
    view.prefill(prefillAnswers(form, around.search ?? ''));
    if (form.title !== '') around.onTitle?.(form.title);
    return true;
  }

  async function submit(): Promise<void> {
    if (form === undefined || busy) return;
    const answers = view.read();
    const left = missing(form, answers);
    if (left.length > 0) {
      view.showProblems(left, strings.checkAnswers);
      return;
    }
    busy = true;
    view.setBusy(true);
    // One id for this filled-in form, however often it is sent: a retry stores nothing new.
    submissionId ??= makeId();
    const values: Record<string, Value> = { ...hiddenAnswers(form, around.search ?? '') };
    const first = around.first?.();
    // An empty answer is left out: the question was not answered.
    for (const [key, value] of Object.entries(answers.values))
      if (!isEmpty(value)) values[key] = value;
    const shown = form;
    const botProof = shown.botProtection === 'altcha' ? await proofToSend(shown) : undefined;
    if (shown.botProtection === 'altcha' && botProof === undefined) {
      // The check did not finish: say so, and start it again for the next try.
      busy = false;
      view.setBusy(false);
      view.showProblems([], strings.botFailed);
      prove(shown);
      return;
    }
    const sent = await api.send({
      clientSubmissionId: submissionId,
      renderToken: shown.renderToken,
      values,
      consents: answers.consents,
      trap: answers.trap,
      ...(botProof === undefined ? {} : { botProof }),
      ...(page === undefined ? {} : { pageUrl: page }),
      ...(around.referrer === undefined ? {} : { referrer: around.referrer }),
      ...(first === undefined ? {} : { first }),
    });
    busy = false;
    view.setBusy(false);
    if (sent.ok) {
      const onward = form.redirectUrl;
      if (onward !== undefined && around.preview === true) {
        // A preview goes nowhere: it says where the published form would.
        view.showDone(`${strings.previewRedirect} ${onward}`);
        return;
      }
      // Shown first, so there is something to read while the next page loads, and
      // something left if the browser does not go.
      view.showDone(form.successMessage);
      if (onward !== undefined) around.navigate?.(onward);
      return;
    }
    if (sent.failure === 'stale') {
      // The form was shown too long ago, or changed: show it again, with what was typed.
      if (await load()) view.showProblems([], strings.updated);
      else view.showUnavailable();
      return;
    }
    const issues = sent.issues ?? [];
    const words = {
      invalid: issues.length > 0 ? strings.checkAnswers : strings.refused,
      limited: strings.slowDown,
      unavailable: strings.unavailable,
      network: strings.offline,
    } as const;
    view.showProblems(issues, words[sent.failure]);
  }

  if (around.preview === true) view.showPreview();
  view.showLoading();
  void load().then((loaded) => {
    if (!loaded) view.showUnavailable();
  });
  return () => void submit();
}

/** Where the form goes: an element the page marked for this key, or right after the script. */
function mountPoint(
  doc: Document,
  script: Element,
  key: string,
): ((host: HTMLElement) => void) | undefined {
  for (const marked of doc.querySelectorAll('[data-crm-form]'))
    if (marked.getAttribute('data-crm-form') === key && !marked.hasAttribute(MOUNTED)) {
      marked.setAttribute(MOUNTED, '');
      return (host) => {
        marked.append(host);
      };
    }
  // A script in the head has nowhere to put a form; the page marks a place instead.
  if (script.parentElement === null || script.closest('head') !== null) return undefined;
  return (host) => {
    script.after(host);
  };
}

/** Starts the form for the script tag it was loaded by. Returns nothing when it cannot. */
export function boot(win: Window, script: HTMLOrSVGScriptElement | null): FormView | undefined {
  const doc = win.document;
  // An HTML script tag has a src; an SVG one does not, and is not what loads this file.
  if (script === null || !('src' in script) || script.hasAttribute(MOUNTED)) return undefined;
  const token = script.getAttribute('data-form-preview') ?? '';
  const preview = PREVIEW_TOKEN.test(token);
  const key = preview ? token : (script.getAttribute('data-form-key') ?? '');
  if (!preview && !FORM_KEY.test(key)) return undefined;
  // The CRM is wherever this script came from; the page cannot point the form elsewhere.
  const base = new URL(script.src, win.location.href);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return undefined;
  // A page of the CRM's own address: the one it serves for a form, or for a preview.
  const ownPage = base.origin === win.location.origin;
  // A draft is shown on the CRM's own page only; anywhere else the CRM would refuse it.
  if (preview && !ownPage) return undefined;
  const mount = mountPoint(doc, script, key);
  if (mount === undefined) return undefined;
  script.setAttribute(MOUNTED, '');

  // The view is made first and calls what runs it, which is made with the view.
  const made: { submit?: () => void } = {};
  const view = createView(doc, strings, () => made.submit?.());
  if (view === undefined) return undefined;
  const fetcher: Fetch = (url, init) => win.fetch(url, init);
  mount(view.host);
  const referrer = referrerOrigin(doc.referrer, win.location.origin);
  // The CRM's own page for a form, which a link from one of its sites may lead to.
  const formPage = ownPage && doc.documentElement.hasAttribute(OWN_PAGE);
  made.submit = run(
    view,
    createFormApi(base.origin, key, fetcher, { preview, ownPage }),
    () => newId(win.crypto),
    pageUrl(win.location),
    {
      search: win.location.search,
      solve: solveAltcha,
      ...(referrer === undefined ? {} : { referrer }),
      // Read when the form is sent: the page's script may run after this one.
      first: () => firstArrival(script, formPage ? win.location.search : undefined),
      navigate: (url) => {
        win.location.assign(url);
      },
      preview,
      // Only the CRM's own page for a form is named after it: a website's tab is its own.
      ...(formPage
        ? {
            onTitle: (title: string) => {
              doc.title = title;
            },
          }
        : {}),
    },
  );
  return view;
}

/** Runs once the page has a body, and swallows anything thrown: a guest does not crash its host. */
export function install(win: Window, script: HTMLOrSVGScriptElement | null): void {
  const start = (): void => {
    try {
      boot(win, script);
    } catch {
      // No form; the page carries on.
    }
  };
  if (win.document.readyState === 'loading')
    win.document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
