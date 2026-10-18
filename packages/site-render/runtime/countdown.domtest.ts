// @vitest-environment jsdom
// The countdown's script on a real DOM (jsdom), over the markup the renderer itself writes:
// that it ticks, what it does at the end, that it slows down for a visitor who asked for
// less motion, and that the page it leaves behind is text, never markup.
import type { PageElement } from '@repo/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { context, pageOf } from '../src/fixtures.js';
import { renderPage } from '../src/render.js';
import { startCountdowns } from './countdown.js';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const END = '2026-10-12T12:02:05.000Z';

/** The body of a page with one countdown, as the server renders it at NOW. */
function page(whenOver: unknown, endsAt: string = END): void {
  const rendered = renderPage(
    pageOf([{ id: 'cd', type: 'countdown', props: { endsAt, whenOver } } as PageElement]),
    context({ now: NOW }),
  );
  const inner = /<body>\n([\s\S]*)<\/body>/.exec(rendered?.html ?? '')?.[1] ?? '';
  // The test's own fixture, parsed as a browser parses a page: not the script under test.
  document.body.innerHTML = inner;
}

const motion = (reduce: boolean): void => {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
  })) as typeof window.matchMedia;
};
const timer = (): string => document.querySelector('[role=timer]')?.textContent ?? '';
const element = (): HTMLElement | null => document.querySelector<HTMLElement>('.cd');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  motion(false);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('a countdown with its script', () => {
  it('reads to the minute before the script runs, and to the second once it does', () => {
    page({ type: 'hide' });
    expect(timer()).toBe('00h 02m');
    startCountdowns(document, window);
    expect(timer()).toBe('00h 02m 05s');
  });

  it('ticks each second, by the clock and not by how often it was woken', () => {
    page({ type: 'hide' });
    startCountdowns(document, window);
    vi.advanceTimersByTime(1000);
    expect(timer()).toBe('00h 02m 04s');
    vi.advanceTimersByTime(4000);
    expect(timer()).toBe('00h 02m 00s');
    vi.advanceTimersByTime(1000);
    expect(timer()).toBe('00h 01m 59s');
    // A tab that slept for a minute is right the next time it is woken.
    vi.setSystemTime(NOW + 100_000);
    vi.advanceTimersByTime(1000);
    expect(timer()).toBe('00h 00m 24s');
  });

  it('shows the moment it ends in the visitor’s own time, from the instant the page names', () => {
    page({ type: 'hide' });
    const time = document.querySelector('time');
    expect(time?.textContent).toBe('12 October 2026, 12:02 UTC');
    startCountdowns(document, window);
    expect(time?.dateTime).toBe(END);
    expect(time?.textContent).toBe(
      new Date(END).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }),
    );
  });

  it('hides itself at the end when the page says so', () => {
    page({ type: 'hide' });
    startCountdowns(document, window);
    vi.advanceTimersByTime(124_000);
    expect(element()?.hidden).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(element()?.hidden).toBe(true);
    // And it stops: nothing is left running.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the sentence the page chose, as text, never as markup', () => {
    page({ type: 'text', text: 'Too late <img src=x onerror="window.pwned=1"> & gone' });
    startCountdowns(document, window);
    vi.advanceTimersByTime(125_001);
    expect(element()?.hidden).toBe(false);
    expect(element()?.textContent).toBe('Too late <img src=x onerror="window.pwned=1"> & gone');
    expect(element()?.children).toHaveLength(0);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('offers the link the page chose, as the server would have written it', () => {
    page({ type: 'url', href: 'https://example.com/next' });
    startCountdowns(document, window);
    vi.advanceTimersByTime(125_001);
    const link = element()?.querySelector('a');
    expect(element()?.children).toHaveLength(1);
    expect(link?.getAttribute('href')).toBe('https://example.com/next');
    expect(link?.textContent).toBe('Continue');
    // The server refused an address that is not a link, so none reaches the script.
    page({ type: 'url', href: 'javascript:alert(1)' });
    expect(element()?.dataset['cd']).toBe('hide');
  });

  it('does at once what the end does when the page was kept past it', () => {
    page({ type: 'text', text: 'Over' });
    vi.setSystemTime(Date.parse(END) + 5000);
    startCountdowns(document, window);
    expect(element()?.textContent).toBe('Over');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('changes once a minute, without seconds, for a visitor who asked for less motion', () => {
    motion(true);
    page({ type: 'hide' });
    startCountdowns(document, window);
    expect(timer()).toBe('00h 02m');
    vi.advanceTimersByTime(4000);
    expect(timer()).toBe('00h 02m');
    vi.advanceTimersByTime(1001);
    expect(timer()).toBe('00h 01m');
    vi.advanceTimersByTime(60_000);
    expect(timer()).toBe('under 1m');
    // It still ends when it ends.
    vi.advanceTimersByTime(60_000);
    expect(element()?.hidden).toBe(true);
  });

  it('runs every countdown of the page, and leaves alone what it cannot read', () => {
    page({ type: 'hide' });
    const second = element()?.cloneNode(true) as HTMLElement;
    second.querySelector('time')?.setAttribute('datetime', '2026-10-12T13:00:00.000Z');
    const broken = element()?.cloneNode(true) as HTMLElement;
    broken.querySelector('time')?.setAttribute('datetime', 'soon');
    const bare = document.createElement('p');
    bare.dataset['cd'] = 'hide';
    bare.textContent = 'No timer here';
    document.body.append(second, broken, bare);
    startCountdowns(document, window);
    const timers = [...document.querySelectorAll('[role=timer]')].map((each) => each.textContent);
    expect(timers).toEqual(['00h 02m 05s', '01h 00m 00s', '00h 02m']);
    expect(bare.textContent).toBe('No timer here');
  });

  it('does nothing on a page that has no countdown', () => {
    document.body.innerHTML = '<main><p>Hello</p></main>';
    startCountdowns(document, window);
    expect(document.body.innerHTML).toBe('<main><p>Hello</p></main>');
    expect(vi.getTimerCount()).toBe(0);
  });
});
