// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://crm.example/"}
// The arrival's script on a real DOM (jsdom), over the markup the renderer itself writes:
// what it keeps on the first page, that a later page reads it back, when a second arrival
// takes its place, what it does where storage is refused and for a visitor who sends the
// privacy signal, and that only the CRM's own forms and its own lead pages are told.
import { ATTRIBUTION_PARAMETERS, type PageElement } from '@repo/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { context, ELEMENTS, pageOf, SCRIPTS } from '../src/fixtures.js';
import { renderPage } from '../src/render.js';
import { ARRIVAL_PARAMETERS, isLabelled, startArrival } from './arrival.js';

const SITE = '0123456789abcdef0123456789abcdef';
const KEY = `arr:${SITE}`;
const ORIGIN = 'https://crm.example';
const STEP_1 = `${ORIGIN}/s/${SITE}/offer`;
const STEP_2 = `${ORIGIN}/s/${SITE}/details`;
const AD = '?utm_source=google&utm_medium=cpc&gclid=abc123';
const NOW = Date.parse('2026-10-13T09:00:00.000Z');

const link = (id: string, href: string): PageElement => ({
  id,
  type: 'button',
  props: { label: id, subLabel: '', action: { type: 'url', href, newTab: false } },
});

/** The elements every page of these tests holds: a form, a calendar and links elsewhere. */
const CHILDREN: PageElement[] = [
  ELEMENTS.form,
  ELEMENTS.calendar,
  link('hosted', `${ORIGIN}/f/abcdefghijklmnop?plan=gold`),
  link('away', 'https://other.example/book/acme/main/intro'),
  link('step', `${ORIGIN}/s/${SITE}/thanks`),
  link('lookalike', `${ORIGIN}/booking/terms`),
];

/**
 * What the script listens for on the document. Every page of a visit is a document of its
 * own; here they share one, so each page opened takes the listeners of the one before away.
 */
const listening: [string, EventListenerOrEventListenerObject, boolean][] = [];
function leave(): void {
  for (const [type, listener, capture] of listening.splice(0))
    document.removeEventListener(type, listener, capture);
}
const listen = document.addEventListener.bind(document);
document.addEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void => {
  listening.push([type, listener, options === true]);
  listen(type, listener, options);
};

/**
 * Opens a page of the site at an address, as the server renders it for a site that keeps
 * the arrival, and runs the script as its own tag would. Returns that tag.
 */
function open(
  address: string,
  referrer = '',
  options: { always?: boolean; signal?: unknown } = {},
): Element {
  const rendered = renderPage(
    pageOf(CHILDREN),
    context({ arrival: { site: SITE, always: options.always === true } }),
  );
  const html = rendered?.html ?? '';
  leave();
  const tag = /<script defer[^>]*data-site[^>]*>/.exec(html)?.[0] ?? '';
  expect(tag).toContain(SCRIPTS.arrival);
  // The test's own fixture, parsed as a browser parses a page: not the script under test.
  document.head.innerHTML = `${tag}</script>`;
  document.body.innerHTML = /<body>\n([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
  window.history.replaceState(null, '', address.slice(ORIGIN.length));
  Object.defineProperty(document, 'referrer', { configurable: true, value: referrer });
  Object.defineProperty(window.navigator, 'globalPrivacyControl', {
    configurable: true,
    value: options.signal,
  });
  const script = document.head.querySelector('script');
  if (script === null) throw new Error('The page names the arrival script.');
  startArrival(document, window, script);
  return script;
}

const kept = (): unknown => JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null');
const formTag = (): Element => {
  const found = document.querySelector('script[data-form-key]');
  if (found === null) throw new Error('The page shows a form.');
  return found;
};
const handed = () => ({
  url: formTag().getAttribute('data-arr'),
  from: formTag().getAttribute('data-arr-ref'),
  at: formTag().getAttribute('data-arr-at'),
});
const anchor = (words: string): HTMLAnchorElement => {
  const found = [...document.querySelectorAll('a')].find((each) => each.textContent === words);
  if (found === undefined) throw new Error(`No link says ${words}.`);
  return found;
};
/** Follows a link as a visitor does, without leaving the page (jsdom goes nowhere). */
const follow = (words: string, type = 'click'): URL => {
  const target = anchor(words);
  target.addEventListener('click', (event) => {
    event.preventDefault();
  });
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  return new URL(target.href);
};

beforeEach(() => {
  // jsdom answers at this address: the pages are opened by moving its history.
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  leave();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('the first page of a visit', () => {
  it('keeps the landing address with its query, the origin they came from and the moment', () => {
    open(`${STEP_1}${AD}`, 'https://www.google.com/search?q=wedding+venue');
    // Only the origin of the site before: never its path or its query.
    expect(kept()).toEqual([`${STEP_1}${AD}`, 'https://www.google.com', NOW]);
    expect(Object.keys(window.sessionStorage)).toEqual([KEY]);
    expect(document.cookie).toBe('');
    expect(window.localStorage).toHaveLength(0);
  });

  it('keeps a visit from nowhere too, and leaves the address out past its length', () => {
    open(STEP_1);
    expect(kept()).toEqual([STEP_1, '', NOW]);
    window.sessionStorage.clear();
    open(`${STEP_1}?utm_source=x&pad=${'a'.repeat(2000)}`);
    // Too long to hand over whole: the page without its query, as the form embed does.
    expect(kept()).toEqual([STEP_1, '', NOW]);
  });

  it('tells the form on the page, on its own script tag', () => {
    open(`${STEP_1}${AD}`, 'https://l.facebook.com/l.php?u=x');
    expect(handed()).toEqual({
      url: `${STEP_1}${AD}`,
      from: 'https://l.facebook.com',
      at: String(NOW),
    });
  });
});

describe('a later page', () => {
  it('reads back what the first page kept, and never writes over it', () => {
    open(`${STEP_1}${AD}`, 'https://www.google.com/');
    vi.setSystemTime(NOW + 60_000);
    // The next step: no label in its address, and the referrer is this same site.
    open(STEP_2, `${STEP_1}${AD}`);
    expect(kept()).toEqual([`${STEP_1}${AD}`, 'https://www.google.com', NOW]);
    expect(handed()).toEqual({
      url: `${STEP_1}${AD}`,
      from: 'https://www.google.com',
      at: String(NOW),
    });
    // Coming back from another site (a payment page, a map) does not rename the arrival.
    open(STEP_2, 'https://pay.example/done');
    expect(kept()).toEqual([`${STEP_1}${AD}`, 'https://www.google.com', NOW]);
    // Nor does a parameter that says nothing of how they arrived.
    open(`${STEP_2}?plan=gold&sourcery=1`);
    expect(kept()).toEqual([`${STEP_1}${AD}`, 'https://www.google.com', NOW]);
  });

  it('takes a second ad click in the same tab as a new arrival', () => {
    open(`${STEP_1}${AD}`, 'https://www.google.com/');
    vi.setSystemTime(NOW + 3_600_000);
    open(`${STEP_2}?utm_source=facebook&utm_medium=paid_social&fbclid=xyz`);
    expect(kept()).toEqual([
      `${STEP_2}?utm_source=facebook&utm_medium=paid_social&fbclid=xyz`,
      '',
      NOW + 3_600_000,
    ]);
    // `source=` alone names a lead too.
    open(`${STEP_1}?source=Spring%20flyer`);
    expect(kept()).toEqual([`${STEP_1}?source=Spring%20flyer`, '', NOW + 3_600_000]);
  });

  it('lets a visit that said nothing be named by the site they come from next', () => {
    open(STEP_1);
    vi.setSystemTime(NOW + 5000);
    open(STEP_2, 'https://www.bing.com/search?q=x');
    expect(kept()).toEqual([STEP_2, 'https://www.bing.com', NOW + 5000]);
    // Now it says something, and stays.
    open(STEP_1, 'https://duckduckgo.com/');
    expect(kept()).toEqual([STEP_2, 'https://www.bing.com', NOW + 5000]);
  });

  it('keeps each site’s arrival under its own key on an address sites share', () => {
    window.sessionStorage.setItem('arr:another', JSON.stringify(['https://x/', '', 1]));
    open(`${STEP_1}${AD}`);
    expect(JSON.parse(window.sessionStorage.getItem('arr:another') ?? '')).toEqual([
      'https://x/',
      '',
      1,
    ]);
    expect(handed().url).toBe(`${STEP_1}${AD}`);
  });

  it('starts again from this page when what was kept cannot be read', () => {
    for (const broken of ['{', 'null', '{}', '["only"]', '[1,2,3]', '["a","b","c"]']) {
      window.sessionStorage.setItem(KEY, broken);
      open(STEP_2);
      expect(kept(), broken).toEqual([STEP_2, '', NOW]);
    }
  });
});

describe('where storage is refused', () => {
  it('hands over the page’s own arrival and throws nothing', () => {
    const refuse = (): never => {
      throw new DOMException('refused', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
    expect(() => open(`${STEP_1}${AD}`, 'https://www.google.com/')).not.toThrow();
    expect(handed()).toEqual({
      url: `${STEP_1}${AD}`,
      from: 'https://www.google.com',
      at: String(NOW),
    });
    // A link from this page still carries what this page knows.
    expect(follow('Book a time').searchParams.get('arr')).toBe(`${STEP_1}${AD}`);
    // The next page knows only itself: nothing was carried, and nothing breaks.
    expect(() => open(STEP_2, `${STEP_1}${AD}`)).not.toThrow();
    expect(handed()).toEqual({ url: STEP_2, from: '', at: String(NOW) });
  });

  it('does the same where the window has no storage at all', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('refused', 'SecurityError');
    });
    expect(() => open(`${STEP_1}${AD}`)).not.toThrow();
    expect(handed().url).toBe(`${STEP_1}${AD}`);
  });
});

describe('a visitor whose browser sends the Global Privacy Control signal', () => {
  it('is left alone: nothing kept, nothing handed over, no link changed', () => {
    open(`${STEP_1}${AD}`, 'https://www.google.com/', { signal: true });
    expect(window.sessionStorage).toHaveLength(0);
    expect(handed()).toEqual({ url: null, from: null, at: null });
    expect(follow('Book a time').search).toBe('');
  });

  it('is kept as any other when the site says every visitor', () => {
    const script = open(`${STEP_1}${AD}`, 'https://www.google.com/', {
      signal: true,
      always: true,
    });
    expect(script.getAttribute('data-gpc')).toBe('keep');
    expect(kept()).toEqual([`${STEP_1}${AD}`, 'https://www.google.com', NOW]);
  });

  it('is not taken for one by a value that is not true', () => {
    for (const signal of [false, undefined, 'true', 1]) {
      window.sessionStorage.clear();
      open(`${STEP_1}${AD}`, '', { signal });
      expect(kept(), String(signal)).toEqual([`${STEP_1}${AD}`, '', NOW]);
    }
  });
});

describe('the links of the page', () => {
  beforeEach(() => {
    open(`${STEP_1}${AD}`, 'https://www.google.com/');
    vi.setSystemTime(NOW + 60_000);
    open(STEP_2, `${STEP_1}${AD}`);
  });

  it('are not touched until one is followed', () => {
    for (const each of document.querySelectorAll('a')) expect(each.href).not.toContain('arr');
  });

  it('carry the arrival to the booking page of this address, in plain text', () => {
    const target = follow('Book a time');
    expect(`${target.origin}${target.pathname}`).toBe(`${ORIGIN}/book/acme/main/intro`);
    expect(Object.fromEntries(target.searchParams)).toEqual({
      arr: `${STEP_1}${AD}`,
      arr_ref: 'https://www.google.com',
      arr_at: String(NOW),
    });
    // Followed twice (the visitor came back): written once.
    expect(follow('Book a time').href).toBe(target.href);
  });

  it('carry it to a hosted form, beside what the link already said', () => {
    const target = follow('hosted');
    expect(Object.fromEntries(target.searchParams)).toEqual({
      plan: 'gold',
      arr: `${STEP_1}${AD}`,
      arr_ref: 'https://www.google.com',
      arr_at: String(NOW),
    });
  });

  it('carry it when opened in another tab with the middle button', () => {
    expect(follow('Book a time', 'auxclick').searchParams.get('arr')).toBe(`${STEP_1}${AD}`);
  });

  it('leave out the site they came from when there was none', () => {
    window.sessionStorage.clear();
    open(`${STEP_1}${AD}`);
    expect([...follow('Book a time').searchParams.keys()]).toEqual(['arr', 'arr_at']);
  });

  it('never change a link to another address, to another page of the site or to a lookalike', () => {
    for (const words of ['away', 'step', 'lookalike']) {
      const before = anchor(words).href;
      expect(follow(words).href, words).toBe(before);
    }
    // A click on something that is no link is nothing.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('click'));
  });
});

describe('what it does not run on', () => {
  it('does nothing without its tag, or without the site’s key on it', () => {
    document.body.innerHTML = '<script data-form-key="k"></script>';
    startArrival(document, window, null);
    startArrival(document, window, document.createElement('script'));
    expect(window.sessionStorage).toHaveLength(0);
    expect(document.querySelector('script')?.hasAttribute('data-arr')).toBe(false);
  });
});

describe('what makes an address an arrival of its own', () => {
  it('is every parameter the CRM reads from an address, and no other', () => {
    expect([...ARRIVAL_PARAMETERS]).toEqual([...ATTRIBUTION_PARAMETERS]);
    for (const name of ATTRIBUTION_PARAMETERS) {
      expect(isLabelled(`?${name}=x`), name).toBe(true);
      expect(isLabelled(`?a=1&${name}=x`), name).toBe(true);
      // Empty says nothing, and a longer name is another parameter.
      expect(isLabelled(`?${name}=`), name).toBe(false);
      expect(isLabelled(`?${name}=&b=1`), name).toBe(false);
      expect(isLabelled(`?x${name}=1`), name).toBe(false);
      expect(isLabelled(`?${name}x=1`), name).toBe(false);
    }
    expect(isLabelled('')).toBe(false);
    expect(isLabelled('?plan=gold&ref=friend')).toBe(false);
  });
});
