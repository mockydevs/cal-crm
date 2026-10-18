// @vitest-environment jsdom
// The external tracking script on a real DOM (jsdom): what it reports of a page and of a form
// sent on it, what it keeps in the website's storage, and what it never sends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanAddress, formNameOf, readFields, startTracking } from './tracker.js';

const ID = `tk_${'a1'.repeat(16)}`;
const CRM = 'https://crm.example';
const TOKEN = `1790000000000.${'A'.repeat(43)}`;

function tag(attributes: Record<string, string> = {}): HTMLScriptElement {
  const script = document.createElement('script');
  script.src = `${CRM}/tracking/external-tracking.js`;
  for (const [name, value] of Object.entries({ 'data-tracking-id': ID, ...attributes }))
    script.setAttribute(name, value);
  document.body.append(script);
  return script;
}

let fetched: { url: string; body: Record<string, unknown>; init: RequestInit }[] = [];
const fetchMock = vi.fn((url: string, init: RequestInit) => {
  fetched.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown>, init });
  return Promise.resolve(
    new Response(JSON.stringify({ status: 'received', viewToken: TOKEN }), { status: 200 }),
  );
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const stops: (() => void)[] = [];
beforeEach(() => {
  fetched = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  document.title = 'Acme Roofing';
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(
    {},
    '',
    '/pricing?utm_source=google&gclid=abc&email=pat@example.com#top',
  );
  Object.defineProperty(navigator, 'globalPrivacyControl', {
    value: undefined,
    configurable: true,
  });
});
afterEach(() => {
  // The last started first: each puts back what the one before it found.
  for (const stop of stops.splice(0).reverse()) stop();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const start = (script: HTMLScriptElement | null = tag()) => {
  stops.push(startTracking(document, window, script));
};

describe('a page view', () => {
  it('is sent to the CRM the script came from, with campaign parameters and nothing else of the query', async () => {
    start();
    await settle();
    expect(fetched).toHaveLength(1);
    const [sent] = fetched;
    expect(sent?.url).toBe(`${CRM}/api/v1/public/tracking/${ID}/events`);
    expect(sent?.init).toMatchObject({
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
      mode: 'cors',
    });
    expect(sent?.body).toMatchObject({
      type: 'page_view',
      pageUrl: `${location.origin}/pricing?utm_source=google&gclid=abc`,
      title: 'Acme Roofing',
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      visitorId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      deviceType: 'desktop',
    });
    expect(JSON.stringify(sent?.body)).not.toContain('pat@example.com');
  });

  it('keeps the visitor and the visit, so the next page names the same ones', async () => {
    start();
    await settle();
    const first = fetched[0]?.body;
    stops.splice(0).forEach((stop) => {
      stop();
    });
    window.history.replaceState({}, '', '/about');
    start();
    await settle();
    expect(fetched[1]?.body['visitorId']).toBe(first?.['visitorId']);
    expect(fetched[1]?.body['sessionId']).toBe(first?.['sessionId']);
    // The visit began on the first page, and the second says so.
    expect(fetched[1]?.body['first']).toMatchObject({
      pageUrl: `${location.origin}/pricing?utm_source=google&gclid=abc`,
    });
  });

  it('keeps no visitor id for a browser that sends Global Privacy Control', async () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    start();
    await settle();
    expect(fetched[0]?.body['visitorId']).toBeUndefined();
    expect(localStorage.getItem('cal_vid')).toBeNull();
  });

  it('is sent again when a single-page app moves to another page, once a page', async () => {
    start();
    await settle();
    window.history.pushState({}, '', '/services');
    await settle();
    window.history.pushState({}, '', '/services');
    await settle();
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();
    expect(fetched.map(({ body }) => new URL(String(body['pageUrl'])).pathname)).toEqual([
      '/pricing',
      '/services',
    ]);
  });

  it('is not sent without a tracking id, or without the script’s own tag', async () => {
    start(tag({ 'data-tracking-id': '' }));
    start(null);
    await settle();
    expect(fetched).toEqual([]);
  });

  it('still works where the website refuses storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    start();
    await settle();
    expect(fetched).toHaveLength(1);
  });

  it('says what it does in the console only when asked, and never a value', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    start(tag({ 'data-debug': 'true' }));
    await settle();
    expect(info).toHaveBeenCalledWith('[Cal Tracking]', expect.any(String));
    info.mockClear();
    start(tag());
    await settle();
    expect(info).not.toHaveBeenCalled();
  });
});

function form(html: string, attributes: Record<string, string> = {}): HTMLFormElement {
  const element = document.createElement('form');
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

describe('a form sent on the page', () => {
  it('is reported with its fields and name, and is sent on as the website meant', async () => {
    start();
    await settle();
    const element = form(
      `<h2>Free estimate</h2>
       <label for="e">Email</label><input id="e" name="email" value="pat@example.com">
       <input name="first_name" value="Pat">
       <input type="password" name="password" value="hunter2">
       <input type="hidden" name="utm" value="x">
       <input name="off" value="x" disabled>
       <input type="checkbox" name="news" value="yes">
       <input type="checkbox" name="terms" value="agreed" checked>
       <input name="cc" autocomplete="cc-number" value="4111">
       <input name="gone" style="display:none" value="x">
       <select name="size"><option value="s">S</option><option value="m" selected>M</option></select>
       <textarea name="message">Leaking</textarea>`,
    );
    const submitted = new Event('submit', { bubbles: true, cancelable: true });
    element.dispatchEvent(submitted);
    await settle();
    await settle();
    expect(submitted.defaultPrevented).toBe(false);
    const sent = fetched.find(({ body }) => body['type'] === 'form_submission')?.body;
    expect(sent).toMatchObject({
      formName: 'Free estimate',
      viewToken: TOKEN,
      clientSubmissionId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      fields: [
        { name: 'email', label: 'Email', value: 'pat@example.com' },
        { name: 'first_name', value: 'Pat' },
        { name: 'terms', value: 'agreed' },
        { name: 'size', value: 'm' },
        { name: 'message', value: 'Leaking' },
      ],
    });
    expect(JSON.stringify(sent)).not.toContain('hunter2');
    expect(JSON.stringify(sent)).not.toContain('4111');
  });

  it('is reported once when sent twice within a second, and not at all when marked to be left alone', async () => {
    start();
    await settle();
    const element = form('<input name="email" value="a@example.com">');
    element.dispatchEvent(new Event('submit', { bubbles: true }));
    element.dispatchEvent(new Event('submit', { bubbles: true }));
    const ignored = form('<input name="email" value="b@example.com">', { 'data-cal-ignore': '' });
    ignored.dispatchEvent(new Event('submit', { bubbles: true }));
    await settle();
    await settle();
    expect(fetched.filter(({ body }) => body['type'] === 'form_submission')).toHaveLength(1);
  });
});

describe('what the script reads', () => {
  it('names a form as GoHighLevel does: id, name, data attributes, a heading, then a label', () => {
    expect(formNameOf(form('', { id: 'quote' }))).toBe('quote');
    expect(formNameOf(form('<input name="name">', { name: 'contact' }))).toBe('contact');
    expect(formNameOf(form('', { 'data-formid': 'f1' }))).toBe('f1');
    expect(formNameOf(form('', { 'data-name': 'Newsletter' }))).toBe('Newsletter');
    expect(formNameOf(form('<legend> Book a call </legend>'))).toBe('Book a call');
    expect(formNameOf(form('', { 'data-title': 'Titled' }))).toBe('Titled');
    expect(formNameOf(form('', { 'aria-label': 'Labelled' }))).toBe('Labelled');
    expect(formNameOf(form(''))).toBe('Unidentified Form');
  });

  it('takes at most fifty fields of at most a thousand characters, with their labels', () => {
    const many = Array.from(
      { length: 60 },
      (_, i) => `<input name="f${String(i)}" value="v">`,
    ).join('');
    expect(readFields(form(many))).toHaveLength(50);
    const long = readFields(
      form(`<input name="note" aria-label="Note" value="${'x'.repeat(1500)}">`),
    );
    expect(long[0]?.value).toHaveLength(1000);
    expect(long[0]?.label).toBe('Note');
    expect(readFields(form('<input name="q" placeholder="Search">'))).toEqual([]);
  });

  it('sends no card, security or account number labelled in words, whatever the field is named', () => {
    const fields = readFields(
      form(
        `<label for="a">Card number</label><input id="a" name="input_5" value="4111111111111111">
         <label for="b">Security code</label><input id="b" name="input_6" value="737">
         <label for="c">Social Security number</label><input id="c" name="input_7" value="123456789">
         <label for="d">Routing number</label><input id="d" name="input_8" value="011000015">
         <input name="field 9" aria-label="Account number" value="000123456">
         <label for="e">Email</label><input id="e" name="input_1" value="pat@example.com">`,
      ),
    );
    expect(fields).toEqual([{ name: 'input_1', label: 'Email', value: 'pat@example.com' }]);
  });

  it('keeps only campaign parameters of an address, and no fragment', () => {
    expect(cleanAddress('https://a.example/x?utm_source=g&q=secret&fbclid=1#y')).toBe(
      'https://a.example/x?utm_source=g&fbclid=1',
    );
    expect(cleanAddress('https://a.example/x?q=secret')).toBe('https://a.example/x');
  });
});

describe('the edges', () => {
  it('names where the visitor came from by its origin, and the device by the browser', async () => {
    Object.defineProperty(document, 'referrer', {
      value: 'https://www.google.com/search?q=x',
      configurable: true,
    });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone) Mobile');
    start();
    await settle();
    expect(fetched[0]?.body).toMatchObject({
      referrer: 'https://www.google.com',
      deviceType: 'mobile',
    });
    Object.defineProperty(document, 'referrer', { value: 'not an address', configurable: true });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPad)');
    sessionStorage.clear();
    start();
    await settle();
    expect(fetched[1]?.body['referrer']).toBeUndefined();
    expect(fetched[1]?.body['deviceType']).toBe('tablet');
    Object.defineProperty(document, 'referrer', { value: '', configurable: true });
  });

  it('makes its ids without randomUUID, and survives an answer it cannot use', async () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(undefined as never);
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    fetchMock.mockImplementationOnce((url: string, init: RequestInit) => {
      fetched.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown>, init });
      return Promise.resolve(new Response('', { status: 503 }));
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    start(tag({ 'data-debug': 'true' }));
    await settle();
    expect(fetched[0]?.body['sessionId']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    window.history.pushState({}, '', '/next');
    await settle();
    expect(info).toHaveBeenCalledWith('[Cal Tracking]', 'page_view: not sent');
    // A form sent without a view token still goes, for the server to judge.
    const element = form('<input name="email" value="a@example.com">');
    element.dispatchEvent(new Event('submit', { bubbles: true }));
    await settle();
    await settle();
    expect(fetched.at(-1)?.body).toMatchObject({ type: 'form_submission', viewToken: '' });
    Reflect.deleteProperty(crypto, 'randomUUID');
  });

  it('reads a list of choices, skips what is hidden or empty, and ignores what is not a form', async () => {
    start();
    await settle();
    const element = form(
      `<select name="days" multiple><option value="mon" selected>Mon</option><option value="tue" selected>Tue</option></select>
       <div hidden><input name="secret" value="x"></div>
       <input name="faded" style="opacity:0" value="x">
       <input name="invisible" style="visibility:hidden" value="x">
       <input type="radio" name="plan" value="a"><input name="" value="nameless">
       <button name="go" value="1">Go</button>`,
    );
    expect(readFields(element)).toEqual([{ name: 'days', value: 'mon, tue' }]);
    document.body.dispatchEvent(new Event('submit', { bubbles: true }));
    await settle();
    expect(fetched.filter(({ body }) => body['type'] === 'form_submission')).toEqual([]);
  });

  it('stays quiet without the tag, and puts the page back as it found it when stopped', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    start(tag({ 'data-tracking-id': '', 'data-debug': 'true' }));
    expect(info).toHaveBeenCalledWith(
      '[Cal Tracking]',
      expect.stringContaining('No data-tracking-id'),
    );
    const pushState = (): unknown => Reflect.get(window.history, 'pushState');
    const before = pushState();
    const stop = startTracking(document, window, tag());
    expect(pushState()).not.toBe(before);
    stop();
    expect(pushState()).toBe(before);
  });
});
