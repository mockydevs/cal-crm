// @vitest-environment jsdom
// The booking page's side of the booking embed, in a real frame of jsdom: it says
// `ready` once, answers only its own parent's `hello`, sends heights only to that origin,
// and does nothing at all when it is not framed.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { isFramed, isInsecure, startEmbeddedPage } from './public-booking-embed';

const WEBSITE = 'https://bluebird.example';

let observed: (() => void) | undefined;
let watched: Element[] = [];
let disconnected = 0;
beforeEach(() => {
  observed = undefined;
  watched = [];
  disconnected = 0;
  // jsdom has no layout, so no ResizeObserver: this one hands back the callback.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe(element: Element): void {
        watched.push(element);
      }
      disconnect(): void {
        disconnected += 1;
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** A page in a frame of this test's window, and the height its root reports. */
function framedPage(): {
  inner: Window;
  doc: Document;
  parent: Window;
  height: (value: number) => void;
} {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const inner = frame.contentWindow;
  const doc = frame.contentDocument;
  if (inner === null || doc === null) throw new Error('jsdom gave the frame no window.');
  let current = 0;
  vi.spyOn(doc.documentElement, 'getBoundingClientRect').mockImplementation(
    () => ({ height: current }) as DOMRect,
  );
  return {
    inner,
    doc,
    // The window that holds the frame, as the frame sees it.
    parent: inner.parent,
    height: (value) => {
      current = value;
    },
  };
}

const said = (inner: Window, data: unknown, origin: string, source: Window | null): void => {
  inner.dispatchEvent(new MessageEvent('message', { data, origin, source }));
};

it('does nothing when the page is not in a frame', () => {
  const posted = vi.spyOn(window, 'postMessage');
  expect(isFramed(window)).toBe(false);
  const stop = startEmbeddedPage(window, document);
  expect(posted).not.toHaveBeenCalled();
  expect(document.documentElement.dataset['framed']).toBeUndefined();
  expect(observed).toBeUndefined();
  stop();
});

it('says ready, then sends its height to the website that greeted it, and again when it changes', () => {
  const { inner, doc, parent, height } = framedPage();
  const posted = vi.spyOn(parent, 'postMessage');
  expect(isFramed(inner)).toBe(true);
  height(812.2);
  const stop = startEmbeddedPage(inner, doc);
  expect(doc.documentElement.dataset['framed']).toBe('');
  expect(watched).toEqual([doc.documentElement]);
  // Nothing about the page goes anywhere before a hello: only that it is ready.
  expect(posted.mock.calls).toEqual([[{ crmBooking: 'ready' }, '*']]);
  observed?.();
  expect(posted).toHaveBeenCalledTimes(1);

  said(inner, { crmBooking: 'hello' }, WEBSITE, parent);
  expect(posted).toHaveBeenLastCalledWith({ crmBooking: 'height', height: 813 }, WEBSITE);
  // The same height is not sent twice; a new one is, to the same website only.
  observed?.();
  expect(posted).toHaveBeenCalledTimes(2);
  height(540);
  observed?.();
  expect(posted).toHaveBeenLastCalledWith({ crmBooking: 'height', height: 540 }, WEBSITE);
  // A second hello (the website's script loaded twice) is answered again.
  said(inner, { crmBooking: 'hello' }, WEBSITE, parent);
  expect(posted).toHaveBeenCalledTimes(4);

  stop();
  expect(disconnected).toBe(1);
  expect(doc.documentElement.dataset['framed']).toBeUndefined();
  said(inner, { crmBooking: 'hello' }, 'https://other.example', parent);
  expect(posted).toHaveBeenCalledTimes(4);
});

it('answers no one but its own parent, and only a hello', () => {
  const { inner, doc, parent, height } = framedPage();
  const posted = vi.spyOn(parent, 'postMessage');
  height(700);
  startEmbeddedPage(inner, doc);
  expect(posted).toHaveBeenCalledOnce();
  posted.mockClear();
  // Another window, the page itself, no window, a sandboxed parent, and other shapes.
  const stranger = framedPage().inner;
  said(inner, { crmBooking: 'hello' }, WEBSITE, stranger);
  said(inner, { crmBooking: 'hello' }, WEBSITE, inner);
  said(inner, { crmBooking: 'hello' }, WEBSITE, null);
  said(inner, { crmBooking: 'hello' }, 'null', parent);
  said(inner, { crmBooking: 'hello' }, 'file://', parent);
  for (const data of [null, 'hello', { crmBooking: 'ready' }, { type: 'hello' }])
    said(inner, data, WEBSITE, parent);
  observed?.();
  expect(posted).not.toHaveBeenCalled();
});

it('knows a page is not secure only when the browser says so', () => {
  expect(isInsecure({ isSecureContext: false })).toBe(true);
  expect(isInsecure({ isSecureContext: true })).toBe(false);
  // jsdom, like a browser from before secure contexts, says nothing.
  expect(isInsecure({})).toBe(false);
});
