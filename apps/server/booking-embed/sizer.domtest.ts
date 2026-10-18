// @vitest-environment jsdom
// The booking embed's script on a real DOM (jsdom): which messages size a frame and which
// are ignored. A message counts only from the window inside a marked frame, from the origin
// that frame was pointed at, in the embed's own shape, with a height in bounds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { frameOrigin, HEIGHT_BOUNDS, readMessage, startBookingFrames } from './sizer.js';

const CRM = 'https://crm.example';

/** A frame as the embed code writes it, not loaded: jsdom gives it a window of its own. */
function frame(src = `${CRM}/book/bluebird/harbor/tours`, marked = true): HTMLIFrameElement {
  const element = document.createElement('iframe');
  if (marked) element.setAttribute('data-crm-booking', '');
  element.setAttribute('src', src);
  element.setAttribute('height', '860');
  document.body.append(element);
  return element;
}

function post(data: unknown, origin: string, source: Window | null): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
}

const height = (value: unknown) => ({ crmBooking: 'height', height: value });

/** The window inside a frame, which jsdom gives every frame on the page. */
function windowOf(element: HTMLIFrameElement): Window {
  const inside = element.contentWindow;
  if (inside === null) throw new Error('jsdom gave the frame no window.');
  return inside;
}

let listeners: ((event: Event) => void)[] = [];
beforeEach(() => {
  // Each test starts the script once; its listener is removed after the test.
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'message' && typeof listener === 'function') listeners.push(listener);
    add(type, listener, options);
  });
});
afterEach(() => {
  for (const listener of listeners) window.removeEventListener('message', listener);
  listeners = [];
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('the booking embed script', () => {
  it('greets each frame already on the page, at the frame’s own origin, and styles it', () => {
    const shown = frame();
    const other = frame('https://video.example/watch', false);
    const said = vi.spyOn(windowOf(shown), 'postMessage');
    const unsaid = vi.spyOn(windowOf(other), 'postMessage');
    startBookingFrames(document, window);
    expect(said).toHaveBeenCalledWith({ crmBooking: 'hello' }, CRM);
    expect(unsaid).not.toHaveBeenCalled();
    expect(shown.style.border).toBe('0px');
    expect(shown.style.width).toBe('100%');
    expect(other.style.width).toBe('');
  });

  it('sizes a frame from its own page’s height', () => {
    const shown = frame();
    startBookingFrames(document, window);
    post(height(1234), CRM, shown.contentWindow);
    expect(shown.style.height).toBe('1234px');
    post(height(640), CRM, shown.contentWindow);
    expect(shown.style.height).toBe('640px');
  });

  it('greets a frame that says it is ready, as one added after the script ran', () => {
    startBookingFrames(document, window);
    const late = frame();
    const said = vi.spyOn(windowOf(late), 'postMessage');
    post({ crmBooking: 'ready' }, CRM, late.contentWindow);
    expect(said).toHaveBeenCalledWith({ crmBooking: 'hello' }, CRM);
  });

  it('ignores a message from another origin, even from the frame’s own window', () => {
    const shown = frame();
    startBookingFrames(document, window);
    const said = vi.spyOn(windowOf(shown), 'postMessage');
    post(height(1234), 'https://evil.example', shown.contentWindow);
    post(height(1234), 'https://crm.example.evil.example', shown.contentWindow);
    post(height(1234), 'http://crm.example', shown.contentWindow);
    post({ crmBooking: 'ready' }, 'https://evil.example', shown.contentWindow);
    expect(shown.style.height).toBe('');
    expect(said).not.toHaveBeenCalled();
  });

  it('ignores a message from a window that is not one of its frames', () => {
    const shown = frame();
    const unmarked = frame(`${CRM}/book/bluebird/harbor/other`, false);
    startBookingFrames(document, window);
    // The page itself, a frame it did not mark, and no window at all.
    post(height(1234), CRM, window);
    post(height(1234), CRM, unmarked.contentWindow);
    post(height(1234), CRM, null);
    expect(shown.style.height).toBe('');
    expect(unmarked.style.height).toBe('');
  });

  it('sizes only the frame whose window spoke', () => {
    const first = frame();
    const second = frame(`${CRM}/book/bluebird/harbor/other`);
    startBookingFrames(document, window);
    post(height(900), CRM, second.contentWindow);
    expect(second.style.height).toBe('900px');
    expect(first.style.height).toBe('');
  });

  it('ignores a frame that points at no web address', () => {
    const odd = frame('javascript:void 0');
    const said = vi.spyOn(windowOf(odd), 'postMessage');
    startBookingFrames(document, window);
    post(height(900), 'null', odd.contentWindow);
    expect(said).not.toHaveBeenCalled();
    expect(odd.style.height).toBe('');
  });

  it('keeps a height within bounds', () => {
    const shown = frame();
    startBookingFrames(document, window);
    post(height(3), CRM, shown.contentWindow);
    expect(shown.style.height).toBe(`${String(HEIGHT_BOUNDS.min)}px`);
    post(height(50_000), CRM, shown.contentWindow);
    expect(shown.style.height).toBe(`${String(HEIGHT_BOUNDS.max)}px`);
  });
});

describe('what counts as a message of the booking embed', () => {
  it('reads the two things a page says', () => {
    expect(readMessage({ crmBooking: 'ready' })).toEqual({ kind: 'ready' });
    expect(readMessage(height(700))).toEqual({ kind: 'height', height: 700 });
  });

  it('reads nothing else', () => {
    for (const [index, data] of [
      null,
      undefined,
      'height',
      700,
      { crmBooking: 'hello' },
      { crmBooking: 'height' },
      height('700'),
      height(700.5),
      height(Number.NaN),
      height(Number.POSITIVE_INFINITY),
      height(-1),
      height(2_000_000),
      { type: 'height', height: 700 },
    ].entries())
      expect(readMessage(data), `case ${String(index)}`).toBeUndefined();
  });

  it('takes a frame’s origin from its address, relative or absolute', () => {
    const element = document.createElement('iframe');
    element.setAttribute('src', '/book/a/b/c');
    expect(frameOrigin(element, 'https://site.example/page')).toBe('https://site.example');
    element.setAttribute('src', `${CRM}:8443/book/a/b/c?x=1`);
    expect(frameOrigin(element, 'https://site.example/')).toBe(`${CRM}:8443`);
    element.setAttribute('src', 'data:text/html,hi');
    expect(frameOrigin(element, 'https://site.example/')).toBeUndefined();
    element.setAttribute('src', 'http://[bad');
    expect(frameOrigin(element, 'https://site.example/')).toBeUndefined();
  });
});
