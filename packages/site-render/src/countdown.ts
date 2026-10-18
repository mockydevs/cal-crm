// How a countdown's time left is written, by the server when it renders a page and by the
// page's own small script when it ticks (runtime/countdown.ts): one function, so the two
// can never disagree about what a visitor reads.
//
// The end of a countdown is an instant, and the time left is that instant less now: no
// time zone and no daylight-saving change has any part in it.

/** Milliseconds in a minute: how often the server's own wording of the time left changes. */
export const MINUTE = 60_000;

const two = (value: number): string => String(value).padStart(2, '0');

/**
 * The time left, in whole units: `2d 03h 14m`, with seconds `2d 03h 14m 09s`. Days are
 * left out when there are none. Without seconds, the last minute reads `under 1m`, since
 * `00h 00m` would say it was over. Anything not a positive time is the end.
 */
export function countdownText(remaining: number, seconds: boolean): string {
  const total = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining / 1000)) : 0;
  if (!seconds && total < 60) return 'under 1m';
  const days = Math.floor(total / 86_400);
  const text = `${days > 0 ? `${String(days)}d ` : ''}${two(Math.floor((total % 86_400) / 3600))}h ${two(Math.floor((total % 3600) / 60))}m`;
  return seconds ? `${text} ${two(total % 60)}s` : text;
}

/**
 * How long until the wording changes, in milliseconds, given the time left now: to the
 * next whole second or minute, and never past the end.
 */
export function countdownStep(remaining: number, seconds: boolean): number {
  const unit = seconds ? 1000 : MINUTE;
  // Without seconds the whole last minute reads the same, up to the end itself.
  if (!seconds && remaining <= MINUTE) return Math.max(1, remaining);
  return Math.min(Math.max(1, remaining), (remaining % unit) + 1);
}
