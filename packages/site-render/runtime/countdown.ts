// The countdown's script: what makes the time left on a published page
// tick. The page already says the time left, to the minute, and the moment it ends, and
// says both with no script at all; this only keeps the first of them current, shows the
// second in the visitor's own time, and at the end does what the page was set to do. A page
// that holds a running countdown loads it, deferred; no other page does.
//
// It reads what the renderer wrote (render.ts, `countdown`) and nothing else:
//   <p data-cd="hide|text|url" data-cd-text="…" data-cd-href="…">
//     <span role="timer">2d 03h 14m</span> left, ends <time datetime="…">…</time></p>
// It writes text as text and one link whose address the server already checked; it asks
// nothing of any server and keeps nothing in the browser.
import { countdownStep, countdownText } from '../src/countdown.js';

/** What a visitor asked their device for: less movement on the screen. */
const REDUCED = '(prefers-reduced-motion: reduce)';

/** The end as the page was set to show it: hidden, a sentence, or a link to go on by. */
function finish(element: HTMLElement, doc: Document): void {
  const { cd, cdText, cdHref } = element.dataset;
  if (cd === 'text' && cdText !== undefined && cdText !== '') {
    element.textContent = cdText;
  } else if (cd === 'url' && cdHref !== undefined && cdHref !== '') {
    const link = doc.createElement('a');
    link.href = cdHref;
    link.textContent = 'Continue';
    element.replaceChildren(link);
  } else {
    element.hidden = true;
  }
}

/**
 * Starts every countdown of the page. With `prefers-reduced-motion: reduce` the time left
 * is written to the minute and changes once a minute, as the page itself wrote it;
 * otherwise to the second.
 */
export function startCountdowns(doc: Document, win: Window): void {
  const seconds = !win.matchMedia(REDUCED).matches;
  for (const element of doc.querySelectorAll<HTMLElement>('[data-cd]')) {
    const time = element.querySelector('time');
    const timer = element.querySelector('[role=timer]');
    // An instant: the same moment whatever the visitor's time zone is.
    const end = Date.parse(time?.dateTime ?? '');
    if (time === null || timer === null || !Number.isFinite(end)) continue;
    // The moment it ends, on the visitor's own clock and in their own words for it.
    time.textContent = new Date(end).toLocaleString(undefined, {
      dateStyle: 'long',
      timeStyle: 'short',
    });
    const tick = (): void => {
      // Asked of the clock each time, so a tab that slept is right when it wakes.
      const left = end - Date.now();
      if (left <= 0) {
        finish(element, doc);
        return;
      }
      timer.textContent = countdownText(left, seconds);
      win.setTimeout(tick, countdownStep(left, seconds));
    };
    tick();
  }
}
