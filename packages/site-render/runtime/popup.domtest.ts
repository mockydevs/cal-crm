// @vitest-environment jsdom
// The popups' script on a real DOM (jsdom), over the markup the renderer itself writes:
// when a popup opens by itself, that it does so once in a visit, and that an open popup is
// a dialog a keyboard can use (focus in, Tab kept inside, Escape out, focus back, the page
// behind inert).
import type { PageElement } from '@repo/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { context, pageOf } from '../src/fixtures.js';
import { renderPage } from '../src/render.js';
import { startPopups } from './popup.js';

interface PopupProps {
  readonly trigger?: 'none' | 'delay' | 'exit';
  readonly delaySeconds?: number;
  readonly frequency?: 'session' | 'always';
}

const text = (id: string, words: string): PageElement => ({
  id,
  type: 'paragraph',
  props: { text: [{ text: words }] },
});
const button = (id: string, popupId: string): PageElement => ({
  id,
  type: 'button',
  props: { label: `Open ${popupId}`, subLabel: '', action: { type: 'popup', popupId } },
});

const popup = (id: string, props: PopupProps, children: PageElement[] = []) => ({
  id,
  type: 'popup' as const,
  name: `Popup ${id}`,
  props: { trigger: 'none', delaySeconds: 0, width: 'small', ...props },
  rows: [
    {
      id: `${id}-row`,
      type: 'row' as const,
      columns: [{ id: `${id}-col`, type: 'column' as const, props: { span: 12 }, children }],
    },
  ],
});

/** The body of a page with these popups, as the server renders it. */
function page(popups: ReturnType<typeof popup>[], over: Parameters<typeof context>[0] = {}): void {
  const rendered = renderPage(
    {
      ...pageOf([
        text('intro', 'Read me'),
        ...popups.map((each) => button(`open-${each.id}`, each.id)),
      ]),
      popups,
    } as never,
    context(over),
  );
  const inner = /<body>\n([\s\S]*)<\/body>/.exec(rendered?.html ?? '')?.[1] ?? '';
  // The test's own fixture, parsed as a browser parses a page: not the script under test.
  document.body.innerHTML = inner;
}

const hovering = (hover: boolean): void => {
  window.matchMedia = ((query: string) => ({
    matches: hover && query === '(hover: hover)',
  })) as typeof window.matchMedia;
};
const byId = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`No element ${id}.`);
  return found;
};
const isOpen = (id: string): boolean => byId(id).classList.contains('on');
const opener = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`main a[href="#${id}"]`);
  if (found === null) throw new Error(`No link to ${id}.`);
  return found;
};
const press = (key: string, shiftKey = false): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
};
const click = (target: Element): MouseEvent => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};
const leaveAt = (clientY: number): void => {
  document.documentElement.dispatchEvent(new MouseEvent('mouseleave', { clientY }));
};
const scrollTo = (y: number): void => {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  window.dispatchEvent(new Event('scroll'));
};
const inert = (): boolean => document.querySelector('main')?.hasAttribute('inert') === true;

// One document serves every test of this file, as one page would serve one script: what a
// test's script listens for is noted here and taken off again when the test ends.
type Listening = readonly [EventTarget, string, EventListenerOrEventListenerObject];
let listening: Listening[] = [];
const heard = (target: EventTarget): string[] =>
  listening.filter(([each]) => each === target).map(([, type]) => type);

beforeEach(() => {
  hovering(true);
  window.sessionStorage.clear();
  window.history.replaceState(null, '', window.location.pathname);
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  listening = [];
  for (const target of [document, document.documentElement, window] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation(
      (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (listener !== null) listening.push([target, type, listener]);
        add(type, listener, options);
      },
    );
  }
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [target, type, listener] of listening) target.removeEventListener(type, listener);
  document.body.innerHTML = '';
});

describe('a popup that opens after a delay', () => {
  it('opens when its seconds have passed, and not before', () => {
    page([popup('offer', { trigger: 'delay', delaySeconds: 5 })]);
    startPopups(document, window);
    vi.advanceTimersByTime(4999);
    expect(isOpen('offer')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isOpen('offer')).toBe(true);
  });

  it('opens once in a visit: the next page view of the same tab leaves it shut', () => {
    page([popup('offer', { trigger: 'delay', delaySeconds: 1 })]);
    startPopups(document, window);
    vi.advanceTimersByTime(1000);
    expect(isOpen('offer')).toBe(true);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.key(0)).toBe(`pp:${window.location.pathname}:offer`);
    // The same page, loaded again in the same tab.
    page([popup('offer', { trigger: 'delay', delaySeconds: 1 })]);
    startPopups(document, window);
    vi.advanceTimersByTime(5000);
    expect(isOpen('offer')).toBe(false);
    // A link still opens it: only opening by itself is once.
    click(opener('offer'));
    expect(isOpen('offer')).toBe(true);
  });

  it('opens on every page view when the page says always, and keeps nothing', () => {
    for (let view = 0; view < 2; view += 1) {
      page([popup('offer', { trigger: 'delay', delaySeconds: 1, frequency: 'always' })]);
      startPopups(document, window);
      vi.advanceTimersByTime(1000);
      expect(isOpen('offer')).toBe(true);
    }
    expect(window.sessionStorage.length).toBe(0);
  });

  it('keeps nothing in the browser for a draft shown to its editor', () => {
    page([popup('offer', { trigger: 'delay', delaySeconds: 0 })], { preview: true });
    startPopups(document, window);
    vi.advanceTimersByTime(0);
    expect(isOpen('offer')).toBe(true);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('still opens where the browser refuses storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('refused', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('refused', 'SecurityError');
    });
    page([popup('offer', { trigger: 'delay', delaySeconds: 1 })]);
    startPopups(document, window);
    vi.advanceTimersByTime(1000);
    expect(isOpen('offer')).toBe(true);
  });

  it('waits its turn behind a popup that is open, and opens when that one closes', () => {
    page([
      popup('first', { trigger: 'delay', delaySeconds: 1 }),
      popup('second', { trigger: 'delay', delaySeconds: 2 }),
    ]);
    startPopups(document, window);
    vi.advanceTimersByTime(2000);
    expect([isOpen('first'), isOpen('second')]).toEqual([true, false]);
    press('Escape');
    expect([isOpen('first'), isOpen('second')]).toEqual([false, true]);
    press('Escape');
    expect([isOpen('first'), isOpen('second'), inert()]).toEqual([false, false, false]);
  });
});

describe('a popup that opens as the visitor leaves', () => {
  it('opens when the pointer goes out through the top, and only the first time', () => {
    page([popup('stay', { trigger: 'exit' })]);
    startPopups(document, window);
    // Out through a side or the bottom is not leaving for the address bar.
    leaveAt(300);
    expect(isOpen('stay')).toBe(false);
    leaveAt(0);
    expect(isOpen('stay')).toBe(true);
    press('Escape');
    leaveAt(-4);
    expect(isOpen('stay')).toBe(false);
  });

  it('shows one popup for one leaving, the first that has not been seen', () => {
    page([popup('a', { trigger: 'exit' }), popup('b', { trigger: 'exit' })]);
    window.sessionStorage.setItem(`pp:${window.location.pathname}:a`, '1');
    startPopups(document, window);
    leaveAt(0);
    expect([isOpen('a'), isOpen('b')]).toEqual([false, true]);
    press('Escape');
    expect([isOpen('a'), isOpen('b')]).toEqual([false, false]);
  });

  it('on a touch screen, opens when the visitor has read down a screen and scrolls back up', () => {
    hovering(false);
    page([popup('stay', { trigger: 'exit' })]);
    startPopups(document, window);
    // The pointer's own sign means nothing where nothing hovers.
    leaveAt(0);
    expect(isOpen('stay')).toBe(false);
    scrollTo(300);
    scrollTo(0);
    expect(isOpen('stay')).toBe(false);
    scrollTo(1200);
    scrollTo(900);
    expect(isOpen('stay')).toBe(false);
    scrollTo(800);
    expect(isOpen('stay')).toBe(true);
    press('Escape');
    scrollTo(0);
    expect(isOpen('stay')).toBe(false);
  });

  it('listens for nothing on a page whose popups only a link opens', () => {
    page([popup('offer', {})]);
    startPopups(document, window);
    expect(heard(document.documentElement)).toEqual([]);
    expect(heard(window)).toEqual(['hashchange']);
    expect(heard(document).sort()).toEqual(['click', 'keydown']);
    expect(vi.getTimerCount()).toBe(0);
    // And where one opens as the visitor leaves, for that one sign alone.
    page([popup('stay', { trigger: 'exit' })]);
    startPopups(document, window);
    expect(heard(document.documentElement)).toEqual(['mouseleave']);
  });
});

describe('an open popup, as a dialog', () => {
  const inside = [
    {
      id: 'go',
      type: 'button',
      props: {
        label: 'Go',
        subLabel: '',
        action: { type: 'url', href: 'https://example.com', newTab: false },
      },
    } as PageElement,
  ];

  it('is named a dialog by the page itself, and can take the focus', () => {
    page([popup('offer', {})]);
    const dialog = byId('offer');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Popup offer');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
  });

  it('opens from its link without leaving the page, and takes the focus inside', () => {
    page([popup('offer', {}, inside)]);
    startPopups(document, window);
    const link = opener('offer');
    link.focus();
    const event = click(link);
    expect(event.defaultPrevented).toBe(true);
    expect(isOpen('offer')).toBe(true);
    expect(window.location.hash).toBe('');
    // The first thing in it that can be focused.
    expect(document.activeElement?.textContent).toBe('Go');
    expect(byId('offer').contains(document.activeElement)).toBe(true);
    expect(inert()).toBe(true);
  });

  it('closes on Escape, gives the focus back, and frees the page behind', () => {
    page([popup('offer', {}, inside)]);
    startPopups(document, window);
    const link = opener('offer');
    link.focus();
    click(link);
    const event = press('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(isOpen('offer')).toBe(false);
    expect(document.activeElement).toBe(link);
    expect(inert()).toBe(false);
    // With nothing open, a key is the page's own again.
    expect(press('Escape').defaultPrevented).toBe(false);
    expect(press('Tab').defaultPrevented).toBe(false);
  });

  it('keeps Tab and Shift+Tab inside it, going round', () => {
    page([popup('offer', {}, inside)]);
    startPopups(document, window);
    click(opener('offer'));
    const [first, last] = [...byId('offer').querySelectorAll<HTMLElement>('a')];
    expect([first?.textContent, last?.getAttribute('aria-label')]).toEqual(['Go', 'Close']);
    expect(document.activeElement).toBe(first);
    // In the middle the browser's own Tab moves the focus: the script leaves it alone.
    last?.focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(press('Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(press('Tab', true).defaultPrevented).toBe(false);
    expect(press('a').defaultPrevented).toBe(false);
    // From the popup itself, backwards is its last thing.
    byId('offer').focus();
    press('Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('holds the focus on the popup itself when nothing in it can be focused', () => {
    page([popup('offer', { trigger: 'delay', delaySeconds: 0 }, [text('t', 'Just words')])]);
    byId('offer').querySelector('.px')?.remove();
    startPopups(document, window);
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(byId('offer'));
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('offer'));
  });

  it('closes from its own Close link and from a click on what dims the page', () => {
    page([popup('offer', {}, inside)]);
    startPopups(document, window);
    click(opener('offer'));
    const closing = byId('offer').querySelector('.px');
    if (closing === null) throw new Error('A popup has a way out.');
    expect(click(closing).defaultPrevented).toBe(true);
    expect(isOpen('offer')).toBe(false);
    click(opener('offer'));
    // Inside the box is not outside it.
    const box = byId('offer').querySelector('.pb');
    if (box === null) throw new Error('A popup has a box.');
    click(box);
    expect(isOpen('offer')).toBe(true);
    click(byId('offer'));
    expect(isOpen('offer')).toBe(false);
    expect(inert()).toBe(false);
  });

  it('gives the focus back to where it was before the first of two popups', () => {
    page([popup('first', {}, [button('to-second', 'second')]), popup('second', {}, inside)]);
    startPopups(document, window);
    const link = opener('first');
    link.focus();
    click(link);
    const onward = byId('first').querySelector('a[href="#second"]');
    if (onward === null) throw new Error('The first popup links to the second.');
    click(onward);
    expect([isOpen('first'), isOpen('second')]).toEqual([false, true]);
    expect(inert()).toBe(true);
    press('Escape');
    expect(document.activeElement).toBe(link);
    // Opening what is open already changes nothing.
    click(link);
    click(link);
    expect(isOpen('first')).toBe(true);
  });

  it('makes a popup the page was opened at a dialog too, and moves the address off it', () => {
    page([popup('offer', {}, inside)]);
    window.history.replaceState(null, '', '#offer');
    startPopups(document, window);
    expect(isOpen('offer')).toBe(true);
    expect(window.location.hash).toBe('#_');
    press('Escape');
    expect(isOpen('offer')).toBe(false);
    // Going back to that address opens it again.
    window.history.replaceState(null, '', '#offer');
    window.dispatchEvent(new Event('hashchange'));
    expect(isOpen('offer')).toBe(true);
    // An address that names no popup opens none.
    press('Escape');
    window.history.replaceState(null, '', '#intro');
    window.dispatchEvent(new Event('hashchange'));
    expect(isOpen('offer')).toBe(false);
  });

  it('leaves every other link and click of the page alone', () => {
    page([popup('offer', {})]);
    const main = document.querySelector('main');
    const plain = document.createElement('a');
    plain.href = '#intro';
    const outside = document.createElement('a');
    outside.href = 'https://example.com/';
    const fake = document.createElement('div');
    fake.id = 'intro';
    main?.append(plain, outside, fake);
    startPopups(document, window);
    expect(click(plain).defaultPrevented).toBe(false);
    expect(click(outside).defaultPrevented).toBe(false);
    expect(click(document.body).defaultPrevented).toBe(false);
    document.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(isOpen('offer')).toBe(false);
    // The Close link of a popup that is shut is an ordinary link.
    const closing = byId('offer').querySelector('.px');
    if (closing === null) throw new Error('A popup has a way out.');
    expect(click(closing).defaultPrevented).toBe(false);
  });

  it('does nothing on a page that has no popup', () => {
    document.body.innerHTML = '<main><a href="#x">x</a></main>';
    startPopups(document, window);
    expect(vi.getTimerCount()).toBe(0);
    const link = document.querySelector('a');
    if (link === null) throw new Error('The page has a link.');
    expect(click(link).defaultPrevented).toBe(false);
  });
});
