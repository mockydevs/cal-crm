// What the public booking page says about the visit that led to a booking, for the
// contact's attribution: the page's own address with its query, which is where an ad's
// labels and click id are, and the site the visitor came from. The same two facts the form
// embed sends (apps/server/forms-embed/entry.ts: pageUrl, referrerOrigin), worked out the
// same way, so a booking and a form submission reached by the same link are read alike.
//
// A visitor who came here from a page of a site the CRM serves arrived somewhere else
// first: that page's script adds how the visit began to the link it follows (`arr`,
// `arr_ref`, `arr_at`: packages/site-render/runtime/arrival.ts), and it is sent beside this
// page's own address as `first`. The server uses it only when this page's own address says
// nothing of the arrival, and only when it is on this same address.
//
// They are read once, when the page opens, and held by the page while it is open: nothing
// is written to a cookie or to the browser's storage, and nothing is sent before the
// visitor books.
import { ATTRIBUTION_LIMITS, type PublicArrival, type PublicVisit } from '@repo/contracts';

/** The page's address without its fragment; left out when it is too long to send. */
export function pageUrlOf(
  location: Pick<Location, 'protocol' | 'origin' | 'pathname' | 'search'>,
): string | undefined {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return undefined;
  const page = `${location.origin}${location.pathname}`;
  const whole = `${page}${location.search}`;
  if (whole.length <= ATTRIBUTION_LIMITS.urlLength) return whole;
  return page.length <= ATTRIBUTION_LIMITS.urlLength ? page : undefined;
}

/**
 * The site the visitor came from: the origin of `document.referrer`, never its path or
 * query, which are another site's business. Left out when the browser gives none, when it
 * is not a web address, and when it is this same site.
 */
export function referrerOriginOf(referrer: string, ownOrigin: string): string | undefined {
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
      url.href.length <= ATTRIBUTION_LIMITS.urlLength
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How the visit began, as the link that led here carried it in this page's query. Only
 * what the server would accept is passed on, so nothing in an address can make a booking
 * unsendable: the page as an address, the site before it as an origin, the moment as a
 * whole number.
 */
export function firstArrivalOf(search: string): PublicArrival | undefined {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    return undefined;
  }
  const page = webAddress(query.get('arr'));
  if (page === undefined) return undefined;
  const from = webAddress(query.get('arr_ref'));
  const at = Number(query.get('arr_at') ?? '');
  return {
    pageUrl: page.href,
    ...(from === undefined ? {} : { referrer: from.origin }),
    ...(Number.isSafeInteger(at) && at > 0 ? { at } : {}),
  };
}

/** The visit as a booking carries it, or nothing when the page can say neither fact. */
export function visitOf(
  location: Pick<Location, 'protocol' | 'origin' | 'pathname' | 'search'>,
  referrer: string,
): PublicVisit | undefined {
  const pageUrl = pageUrlOf(location);
  const from = referrerOriginOf(referrer, location.origin);
  if (pageUrl === undefined && from === undefined) return undefined;
  const first = firstArrivalOf(location.search);
  return {
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(from === undefined ? {} : { referrer: from }),
    ...(first === undefined ? {} : { first }),
  };
}
