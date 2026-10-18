// The arrival's script. A visitor lands on one page of
// a site from an ad, with the ad's labels and click id in the address, and sends the form
// two pages on, where the address has none. This keeps how they arrived for as long as the
// browser tab's session lasts, and hands it to the CRM's own things on the page, so the
// lead is named after the ad and not "Direct".
//
// What it keeps, under one key for the site (`arr:<site key>`), in the tab's session
// storage: the address of the page the visit began on, with its query; the ORIGIN of the
// site the visitor came from, never its path; and the moment. No cookie, nothing that
// outlives the tab, nothing that names a person, and nothing is sent anywhere by this file:
// it calls no server at all.
//
// When it is written:
// - on the first page of the site seen in the tab, whatever it says (a visit with no
//   label and no referrer is an arrival too: Direct, on that page);
// - again, in place of what was kept, when the page's own address carries a label, a click
//   id or `source=` (a second ad click in the same tab is a new arrival);
// - again when what was kept says nothing (no label and no referrer) and the visitor now
//   comes from another site: knowing nothing is never kept over knowing something.
// Otherwise what was kept stays, so coming back from a payment page or a map does not
// rename the lead.
//
// Who is told, and nobody else:
// - each form of the CRM's on the page: its script tag is given `data-arr`,
//   `data-arr-ref` and `data-arr-at`, which the form embed reads from its own tag when the
//   visitor sends the form (apps/server/forms-embed/entry.ts);
// - a link on the page to a booking page or a hosted form on this same address, when it is
//   followed: `arr`, `arr_ref` and `arr_at` are added to that link's query, in plain text.
//   A link anywhere else is never touched.
//
// A visitor whose browser sends the Global Privacy Control signal
// (`navigator.globalPrivacyControl`, https://www.w3.org/TR/gpc/) is left alone: nothing is
// kept, handed over or added to a link, unless the site was set to keep the arrival for
// every visitor (`data-gpc="keep"` on this script's tag). Where storage is refused, the
// page still hands over its own arrival, which is all it knows.

/** The longest address kept or handed over: what the CRM reads of one (ATTRIBUTION_LIMITS). */
const URL_LENGTH = 2000;

/**
 * The query parameters that make a page's address an arrival of its own: every one the
 * CRM reads from an address (ATTRIBUTION_PARAMETERS in @repo/contracts, which this file
 * cannot load in a browser: arrival.domtest.ts holds the two lists to each other).
 */
export const ARRIVAL_PARAMETERS = [
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
] as const;

const LABELLED = new RegExp(`[?&](${ARRIVAL_PARAMETERS.join('|')})=[^&#]`);

/** Where the CRM's own pages that take a lead are, on the install's address. */
const OWN_PAGES = /^\/(book|f)\//;

/** An arrival as it is kept: the landing address, the referrer's origin or '', the moment. */
type Arrival = readonly [url: string, from: string, at: number];

/** Whether an address says how its visitor arrived: a label, a click id or `source=`. */
export const isLabelled = (address: string): boolean => LABELLED.test(address);

function kept(text: string | null): Arrival | undefined {
  try {
    const read: unknown = JSON.parse(text ?? '');
    if (!Array.isArray(read)) return undefined;
    const [url, from, at] = read as unknown[];
    return typeof url === 'string' && typeof from === 'string' && typeof at === 'number'
      ? [url, from, at]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Starts keeping and handing over the arrival, for the script tag this file was loaded by. */
export function startArrival(doc: Document, win: Window, script: Element | null): void {
  const site = script?.getAttribute('data-site') ?? '';
  if (script === null || site === '') return;
  const signal = (win.navigator as { readonly globalPrivacyControl?: unknown })
    .globalPrivacyControl;
  if (signal === true && script.getAttribute('data-gpc') !== 'keep') return;
  const { location } = win;
  if (!/^https?:$/.test(location.protocol)) return;
  const page = location.origin + location.pathname;
  if (page.length > URL_LENGTH) return;
  const whole = page + location.search;
  let from = '';
  try {
    const referrer = new URL(doc.referrer);
    if (/^https?:$/.test(referrer.protocol) && referrer.origin !== location.origin)
      from = referrer.origin;
  } catch {
    // No referrer, or not an address: the visitor came from nowhere this page knows.
  }
  const key = `arr:${site}`;
  let arrival: Arrival | undefined;
  try {
    arrival = kept(win.sessionStorage.getItem(key));
  } catch {
    // Storage is refused: this page's own arrival is all there is.
  }
  if (
    arrival === undefined ||
    isLabelled(location.search) ||
    (from !== '' && arrival[1] === '' && !isLabelled(arrival[0]))
  ) {
    arrival = [whole.length > URL_LENGTH ? page : whole, from, Date.now()];
    try {
      win.sessionStorage.setItem(key, JSON.stringify(arrival));
    } catch {
      // Refused or full: the next page will not know, which is all that is lost.
    }
  }
  const [url, origin, at] = arrival;

  for (const form of doc.querySelectorAll('script[data-form-key]')) {
    form.setAttribute('data-arr', url);
    form.setAttribute('data-arr-ref', origin);
    form.setAttribute('data-arr-at', String(at));
  }

  const decorate = (event: Event): void => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement)) return;
    let target: URL;
    try {
      target = new URL(link.href);
    } catch {
      return;
    }
    if (target.origin !== location.origin || !OWN_PAGES.test(target.pathname)) return;
    target.searchParams.set('arr', url);
    if (origin === '') target.searchParams.delete('arr_ref');
    else target.searchParams.set('arr_ref', origin);
    target.searchParams.set('arr_at', String(at));
    link.href = target.href;
  };
  // A click, a key press on the link, and the middle button, which opens another tab.
  doc.addEventListener('click', decorate, true);
  doc.addEventListener('auxclick', decorate, true);
}
