// The external tracking script: pasted into every page of a business's other website as
// `<script src="…/tracking/external-tracking.js" data-tracking-id="tk_…"></script>`.
//
// What it does, and nothing else:
// - reports each page view to the CRM the script came from, and again when a single-page
//   app moves to another page (GoHighLevel's script reports one per load);
// - reports each form sent on the page: its name and its named, enabled, visible fields,
//   never a hidden field, a password, a card or an account number. The form is sent on as the
//   website meant: nothing here stops or changes it. A form marked `data-cal-ignore` is left
//   alone;
// - keeps, in the website's own storage: a random visitor id (`cal_vid`, never for a browser
//   that sends Global Privacy Control), a random id of the tab's visit and how the visit began
//   (`cal_sid`, `cal_first`, for the tab's session only). No cookie.
// Of a page's address it sends only the campaign parameters of the query, and of the page
// before it only its origin. `data-debug="true"` logs what it does, never a value.

/** The query parameters kept: the ones the CRM reads (ATTRIBUTION_PARAMETERS). */
const KEPT = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_keyword',
  'utm_matchtype',
  'matchtype',
  'campaign_id',
  'utm_id',
  'ad_group_id',
  'adgroup_id',
  'adset_id',
  'ad_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'ctwa_clid',
  'ttclid',
  'li_fat_id',
  'source',
]);

const MAX_FIELDS = 50;
const MAX_VALUE = 1000;
const MAX_LABEL = 200;
const SKIPPED_TYPES = /^(hidden|password|submit|button|reset|file|image)$/;
const SENSITIVE =
  /pass(word|wd)|^pwd$|card(number|no|num)|^cc(num|number|no|exp|cvv|cvc|csc)?$|creditcard|cvv|cvc|^csc$|securitycode|iban|^ssn$|socialsecurity|routingnumber|accountnumber/;

export interface SentField {
  readonly name: string;
  readonly label?: string;
  readonly value: string;
}

/** An address with only its campaign parameters, and no fragment. */
export function cleanAddress(address: string): string {
  const url = new URL(address);
  const kept = new URLSearchParams();
  url.searchParams.forEach((value, name) => {
    if (KEPT.has(name)) kept.append(name, value);
  });
  const query = kept.toString();
  return `${url.origin}${url.pathname}${query === '' ? '' : `?${query}`}`;
}

const text = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();

/** A form's name, by GoHighLevel's order: id, name, data attributes, a heading, a label. */
export function formNameOf(form: HTMLFormElement): string {
  const heading = form.querySelector('h1,h2,h3,h4,h5,h6,legend');
  for (const candidate of [
    form.getAttribute('id'),
    form.getAttribute('name'),
    form.getAttribute('data-formid'),
    form.getAttribute('data-name'),
    heading?.textContent,
    form.getAttribute('data-title'),
    form.getAttribute('aria-label'),
  ]) {
    const name = text(candidate).slice(0, 200);
    if (name !== '') return name;
  }
  return 'Unidentified Form';
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function hidden(element: Element, form: HTMLFormElement): boolean {
  for (
    let node: Element | null = element;
    node !== null && node !== form;
    node = node.parentElement
  ) {
    if (node instanceof HTMLElement && node.hidden) return true;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
      return true;
  }
  return false;
}

function labelOf(control: Control): string {
  return text(control.labels?.[0]?.textContent ?? control.getAttribute('aria-label')).slice(
    0,
    MAX_LABEL,
  );
}

/** The fields a form sends: see the top of this file. */
export function readFields(form: HTMLFormElement): SentField[] {
  const fields: SentField[] = [];
  for (const element of Array.from(form.elements)) {
    if (fields.length >= MAX_FIELDS) break;
    if (
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLSelectElement) &&
      !(element instanceof HTMLTextAreaElement)
    )
      continue;
    const { name } = element;
    if (name === '' || element.disabled) continue;
    const type = element instanceof HTMLInputElement ? element.type : '';
    if (SKIPPED_TYPES.test(type)) continue;
    if ((element.getAttribute('autocomplete') ?? '').startsWith('cc-')) continue;
    const label = labelOf(element);
    // Each word of the name and the label, and each of them whole: "Card number" is a card
    // field whatever the field is named.
    const words = `${name} ${label}`.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const whole = [name, label].map((each) => each.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if ([...words.split(' '), ...whole].some((part) => SENSITIVE.test(part))) continue;
    if ((type === 'checkbox' || type === 'radio') && !(element as HTMLInputElement).checked)
      continue;
    if (hidden(element, form)) continue;
    const value =
      element instanceof HTMLSelectElement && element.multiple
        ? Array.from(element.selectedOptions, (option) => option.value).join(', ')
        : element.value;
    if (value.trim() === '') continue;
    fields.push({
      name: name.slice(0, 100),
      ...(label === '' ? {} : { label }),
      value: value.slice(0, MAX_VALUE),
    });
  }
  return fields;
}

function uuid(win: Window): string {
  if (typeof win.crypto.randomUUID === 'function') return win.crypto.randomUUID();
  const bytes = win.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A stored value, made the first time; where storage is refused, one for this page only. */
function kept(storage: () => Storage, key: string, make: () => string): string {
  try {
    const found = storage().getItem(key);
    if (found !== null && found !== '') return found;
    const made = make();
    storage().setItem(key, made);
    return made;
  } catch {
    return make();
  }
}

function deviceOf(win: Window): 'desktop' | 'tablet' | 'mobile' {
  const agent = win.navigator.userAgent;
  if (/iPad|Tablet/i.test(agent)) return 'tablet';
  return /Mobi|Android/i.test(agent) ? 'mobile' : 'desktop';
}

/** Starts tracking for the script tag this file was loaded by. Gives a way to stop. */
export function startTracking(
  doc: Document,
  win: Window,
  script: HTMLScriptElement | null,
): () => void {
  const id = script?.getAttribute('data-tracking-id') ?? '';
  const debug = script?.getAttribute('data-debug') === 'true';
  const log = (message: string): void => {
    // eslint-disable-next-line no-console -- data-debug="true" on the tag asks for exactly this.
    if (debug) console.info('[Cal Tracking]', message);
  };
  if (script === null || id === '') {
    log('No data-tracking-id on the script tag: nothing is tracked.');
    return () => undefined;
  }
  const endpoint = `${new URL(script.src).origin}/api/v1/public/tracking/${encodeURIComponent(id)}/events`;
  const gpc =
    (win.navigator as { readonly globalPrivacyControl?: unknown }).globalPrivacyControl === true;
  const visitorId = gpc
    ? undefined
    : kept(
        () => win.localStorage,
        'cal_vid',
        () => uuid(win),
      );
  const sessionId = kept(
    () => win.sessionStorage,
    'cal_sid',
    () => uuid(win),
  );
  let referrer: string | undefined;
  try {
    const from = new URL(doc.referrer);
    if (/^https?:$/.test(from.protocol) && from.origin !== win.location.origin)
      referrer = from.origin;
  } catch {
    // No referrer: the visitor came from nowhere this page knows.
  }
  const page = (): string => cleanAddress(win.location.href);
  const firstPage = page();
  const first = kept(
    () => win.sessionStorage,
    'cal_first',
    () =>
      JSON.stringify({
        pageUrl: firstPage,
        ...(referrer === undefined ? {} : { referrer }),
        at: Date.now(),
      }),
  );
  const common = () => {
    const pageUrl = page();
    let began: unknown;
    try {
      const read = JSON.parse(first) as { pageUrl?: unknown };
      if (typeof read.pageUrl === 'string' && read.pageUrl !== pageUrl) began = read;
    } catch {
      began = undefined;
    }
    return {
      pageUrl,
      ...(doc.title.trim() === '' ? {} : { title: doc.title.trim().slice(0, 300) }),
      ...(referrer === undefined ? {} : { referrer }),
      ...(visitorId === undefined ? {} : { visitorId }),
      sessionId,
      ...(began === undefined ? {} : { first: began }),
      deviceType: deviceOf(win),
    };
  };
  const send = (body: Record<string, unknown>): Promise<{ viewToken?: string } | undefined> =>
    win
      .fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        credentials: 'omit',
        mode: 'cors',
      })
      .then((response) => {
        log(`${String(body['type'])}: ${String(response.status)}`);
        return response.ok ? (response.json() as Promise<{ viewToken?: string }>) : undefined;
      })
      .catch(() => {
        log(`${String(body['type'])}: not sent`);
        return undefined;
      });

  let viewToken: string | undefined;
  let lastPage = '';
  let ready: Promise<unknown> = Promise.resolve();
  const view = (): void => {
    const here = win.location.pathname + win.location.search;
    if (here === lastPage) return;
    lastPage = here;
    ready = send({ type: 'page_view', ...common() }).then((answer) => {
      if (answer?.viewToken !== undefined) viewToken = answer.viewToken;
    });
  };

  const sentAt = new WeakMap<HTMLFormElement, number>();
  const onSubmit = (event: Event): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.hasAttribute('data-cal-ignore')) return;
    const now = Date.now();
    if (now - (sentAt.get(form) ?? 0) < 1000) return;
    sentAt.set(form, now);
    const body = {
      type: 'form_submission',
      clientSubmissionId: uuid(win),
      formName: formNameOf(form),
      fields: readFields(form),
    };
    void ready.then(() => send({ ...common(), ...body, viewToken: viewToken ?? '' }));
  };

  const history = win.history;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with history below
  const push = history.pushState;
  history.pushState = (...args: Parameters<History['pushState']>) => {
    push.apply(history, args);
    view();
  };
  win.addEventListener('popstate', view);
  doc.addEventListener('submit', onSubmit, true);
  view();
  log('Tracking started.');
  return () => {
    history.pushState = push;
    win.removeEventListener('popstate', view);
    doc.removeEventListener('submit', onSubmit, true);
  };
}
