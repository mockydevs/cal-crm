import { ATTRIBUTION_LIMITS, publicVisit } from '@repo/contracts';
import { expect, it } from 'vitest';
import { firstArrivalOf, pageUrlOf, referrerOriginOf, visitOf } from './public-booking-visit';

const at = (address: string): Pick<Location, 'protocol' | 'origin' | 'pathname' | 'search'> => {
  const url = new URL(address);
  return { protocol: url.protocol, origin: url.origin, pathname: url.pathname, search: url.search };
};
const page = 'https://crm.example.test/book/agency/events/venue-tour';

it("sends the page's address with its query and without its fragment", () => {
  expect(pageUrlOf(at(`${page}?utm_source=google&gclid=abc#times`))).toBe(
    `${page}?utm_source=google&gclid=abc`,
  );
  expect(pageUrlOf(at(page))).toBe(page);
});

it('drops a query that makes the address too long, and the address when it alone is', () => {
  const long = `?utm_campaign=${'x'.repeat(ATTRIBUTION_LIMITS.urlLength)}`;
  expect(pageUrlOf(at(`${page}${long}`))).toBe(page);
  expect(
    pageUrlOf(at(`https://crm.example.test/${'p'.repeat(ATTRIBUTION_LIMITS.urlLength)}`)),
  ).toBeUndefined();
  // Exactly at the limit is sent whole.
  const fits = `${page}?x=`;
  const whole = `${fits}${'y'.repeat(ATTRIBUTION_LIMITS.urlLength - fits.length)}`;
  expect(pageUrlOf(at(whole))).toBe(whole);
});

it('sends no address for a page that is not on the web', () => {
  expect(
    pageUrlOf({ protocol: 'file:', origin: 'null', pathname: '/book.html', search: '' }),
  ).toBeUndefined();
});

it("keeps only the origin of where the visitor came from, never another site's path", () => {
  expect(
    referrerOriginOf('https://www.google.com/search?q=venue+tour', 'https://crm.example.test'),
  ).toBe('https://www.google.com');
  expect(referrerOriginOf('http://l.facebook.com/l.php?u=x', 'https://crm.example.test')).toBe(
    'http://l.facebook.com',
  );
});

it('says nothing of a referrer that is this site, is missing, or is not a web address', () => {
  expect(
    referrerOriginOf('https://crm.example.test/s/site/home', 'https://crm.example.test'),
  ).toBeUndefined();
  expect(referrerOriginOf('', 'https://crm.example.test')).toBeUndefined();
  expect(referrerOriginOf('android-app://com.example', 'https://crm.example.test')).toBeUndefined();
  expect(referrerOriginOf('not an address', 'https://crm.example.test')).toBeUndefined();
});

it("carries an ad link's labels and click id, and the site the click came from", () => {
  const visit = visitOf(
    at(`${page}?utm_source=google&utm_medium=cpc&campaign_id=42&gclid=Cj0abc`),
    'https://www.google.com/aclk?sa=l',
  );
  expect(visit).toEqual({
    pageUrl: `${page}?utm_source=google&utm_medium=cpc&campaign_id=42&gclid=Cj0abc`,
    referrer: 'https://www.google.com',
  });
  // What the page sends is what the public booking contract takes.
  expect(publicVisit.parse(visit)).toEqual(visit);
});

it('carries only the bare address of a page opened by a bare link', () => {
  const visit = visitOf(at(page), '');
  expect(visit).toEqual({ pageUrl: page });
  expect(new URL(visit?.pageUrl ?? '').search).toBe('');
  expect(publicVisit.parse(visit)).toEqual(visit);
});

it('says where the visitor came from even when its own address cannot be sent', () => {
  expect(
    visitOf(
      at(`https://crm.example.test/${'p'.repeat(ATTRIBUTION_LIMITS.urlLength)}`),
      'https://www.bing.com/',
    ),
  ).toEqual({ referrer: 'https://www.bing.com' });
});

it('sends no visit at all when it can say nothing', () => {
  expect(
    visitOf({ protocol: 'file:', origin: 'null', pathname: '/book.html', search: '' }, ''),
  ).toBeUndefined();
});

// A visitor who followed a link from a page of a site the CRM serves: that page's script
// added how the visit began to the link.
const landing = 'https://crm.example.test/s/site/offer?utm_source=google&utm_medium=cpc&gclid=abc';
const carried = (more = ''): string =>
  `?arr=${encodeURIComponent(landing)}&arr_ref=${encodeURIComponent('https://www.google.com')}&arr_at=1791882000000${more}`;

it('sends how the visit began beside its own address, as the booking contract takes it', () => {
  const visit = visitOf(at(`${page}${carried()}`), 'https://crm.example.test/s/site/details');
  expect(visit).toEqual({
    pageUrl: `${page}${carried()}`,
    first: { pageUrl: landing, referrer: 'https://www.google.com', at: 1_791_882_000_000 },
  });
  expect(publicVisit.parse(visit)).toEqual(visit);
  // The carried address says nothing of this page's own: its labels stay inside `arr`.
  expect(new URL(visit?.pageUrl ?? '').searchParams.get('utm_source')).toBeNull();
});

it('reads the page, the origin before it and the moment, each only when it can be sent', () => {
  expect(firstArrivalOf(carried())).toEqual({
    pageUrl: landing,
    referrer: 'https://www.google.com',
    at: 1_791_882_000_000,
  });
  expect(firstArrivalOf(`?arr=${encodeURIComponent(landing)}`)).toEqual({ pageUrl: landing });
  // The site before it is sent as an origin, whatever the link held.
  expect(
    firstArrivalOf(
      `?arr=${encodeURIComponent(landing)}&arr_ref=${encodeURIComponent('https://www.bing.com/search?q=x')}`,
    ),
  ).toEqual({ pageUrl: landing, referrer: 'https://www.bing.com' });
  for (const at of ['soon', '-5', '1.5', '0', ''])
    expect(firstArrivalOf(`?arr=${encodeURIComponent(landing)}&arr_at=${at}`), at).toEqual({
      pageUrl: landing,
    });
});

it('passes on nothing the server would refuse, so a booking can always be sent', () => {
  for (const bad of [
    '',
    'not an address',
    'javascript:alert(1)',
    'ftp://crm.example.test/a',
    `https://crm.example.test/${'a'.repeat(ATTRIBUTION_LIMITS.urlLength)}`,
  ]) {
    expect(firstArrivalOf(`?arr=${encodeURIComponent(bad)}`), bad).toBeUndefined();
    const visit = visitOf(at(`${page}?arr=${encodeURIComponent(bad)}`), '');
    expect(visit).not.toHaveProperty('first');
    expect(publicVisit.safeParse(visit).success, bad).toBe(true);
  }
  expect(firstArrivalOf('')).toBeUndefined();
  expect(firstArrivalOf('?plan=gold')).toBeUndefined();
});
