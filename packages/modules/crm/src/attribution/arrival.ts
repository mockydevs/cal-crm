// How a visit began, when the page a lead is taken on is not the page the visitor landed
// on. A visitor follows an ad to the first step of a funnel and sends the form on the
// second: the second page's address has no label and no click id, and its referrer is the
// same site. The CRM's own page script keeps the first page's address in the visitor's
// browser tab and hands it over with the form, the booking or the link (`first`). This file
// decides, once for a form, a booking and a chat, which of the two a touch is read from.
//
// The order, first that applies:
//   1. the page's own address says how the visitor arrived (a label, an ad id, a click id
//      or `source=`): the page's own. A new ad click is a new arrival, whatever was kept;
//   2. there is no `first` that can be believed: the page's own (as before stage 2);
//   3. `first` says how they arrived (any of the above, or a site they came from): `first`;
//   4. `first` says nothing and the page has a site the visitor came from: the page's own
//      (knowing nothing is never taken over knowing something);
//   5. `first`: a visit that began on that page, from nowhere. Direct, with its first page.
//
// `first` is whatever a browser said, so it is believed only for attribution and only when
// it is a web address on the same website as the page that hands it over (nobody can name
// another website's page as the landing), within the bounds every address is read with,
// and not older than ATTRIBUTION_LIMITS.arrivalDays or dated in the future.
import { ATTRIBUTION_LIMITS } from '@repo/contracts';

import { isTracked, readVisit, type VisitFacts } from './session-source.js';

const DAY_MS = 86_400_000;

/** What a public page says of a visit: its own address and referrer, and how the visit began. */
export interface SaidVisit {
  readonly pageUrl?: string | undefined;
  readonly referrer?: string | undefined;
  readonly first?:
    | {
        readonly pageUrl: string;
        readonly referrer?: string | undefined;
        readonly at?: number | undefined;
      }
    | undefined;
}

/** A visit as a touch records it. */
export interface Arrival {
  /** The facts of how the visitor arrived; `landingUrl` is the page the visit began on. */
  readonly visit: VisitFacts;
  /** The page the lead was taken on, without its query; null when it said none it may. */
  readonly pageUrl: string | null;
  /** Whether the facts were handed on from another page, and differ from this page's own. */
  readonly carried: boolean;
  /**
   * The address the facts were read from, with its query: this page's own, or the first
   * page's when they were carried. For a rule of the business that reads a parameter by
   * its name (lead-source-rules.ts). Undefined when no address was read.
   */
  readonly address: string | undefined;
}

const originOf = (address: string | undefined): string | undefined => {
  if (address === undefined || !URL.canParse(address)) return undefined;
  const url = new URL(address);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
};

/** Whether a visit says anything of how the visitor arrived. */
const says = (visit: VisitFacts): boolean =>
  isTracked(visit) || visit.sourceParam !== null || visit.referrerDomain !== null;

const same = (left: VisitFacts, right: VisitFacts): boolean =>
  (Object.keys(left) as (keyof VisitFacts)[]).every((fact) => left[fact] === right[fact]);

/**
 * Reads what a public page said of a visit, by the order at the top of this file. With
 * `pageOrigin`, a page that is not on that website is not read at all, as readVisit has it;
 * without, the website is the one the page's own address is on.
 */
export function readArrival(
  said: SaidVisit,
  options: { readonly pageOrigin?: string | undefined; readonly now?: number | undefined } = {},
): Arrival {
  const own = readVisit({ pageUrl: said.pageUrl, referrer: said.referrer }, options.pageOrigin);
  const here: Arrival = {
    visit: own,
    pageUrl: own.landingUrl,
    carried: false,
    address: own.landingUrl === null ? undefined : said.pageUrl,
  };
  const { first } = said;
  if (first === undefined || isTracked(own) || own.sourceParam !== null) return here;
  // A page that said no address of its own that may be read can vouch for no other.
  if (own.landingUrl === null) return here;
  // The website both pages must be on: the one the request was admitted from, else the
  // page's own.
  const site = options.pageOrigin ?? originOf(said.pageUrl);
  if (site === undefined || originOf(first.pageUrl) !== site) return here;
  const now = options.now ?? Date.now();
  if (
    first.at !== undefined &&
    (first.at > now + DAY_MS || first.at < now - ATTRIBUTION_LIMITS.arrivalDays * DAY_MS)
  )
    return here;
  const began = readVisit({ pageUrl: first.pageUrl, referrer: first.referrer }, site);
  if (began.landingUrl === null) return here;
  if (!says(began) && own.referrerDomain !== null) return here;
  return same(began, own)
    ? here
    : { visit: began, pageUrl: own.landingUrl, carried: true, address: first.pageUrl };
}
