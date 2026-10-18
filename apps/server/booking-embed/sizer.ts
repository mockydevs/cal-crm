// The booking embed's script, served at /calendars/embed.js. A calendar's booking page is
// shown on a website in a frame of its own (`<iframe data-crm-booking src="…/book/…">`); a
// frame does not grow with what it shows, so this makes each such frame as tall as its
// page. With no script the frame keeps the height its tag gives it and scrolls inside.
//
// It talks to the booking page in the frame and to nothing else (the page's side is
// apps/dashboard/src/public-booking-embed.ts):
//
// 1. the page says `ready` once it can answer, to whatever window holds it;
// 2. this says `hello` to that frame, at the frame's own origin, and says it at once to
//    every frame already on the page, in case their `ready` came before this script;
// 3. the page answers with its height, to the origin the `hello` came from, and again
//    whenever its height changes.
//
// A message counts only when it comes from the window inside one of these frames, from the
// origin that frame was pointed at, and has the shape below. Anything else is ignored: any
// window may post a message to any other (MDN, Window.postMessage, "Security concerns").
// A height is a whole number of pixels within bounds, so no page can make a frame vanish or
// swallow the website. Styles are set through the frame's style object, which a website's
// Content-Security-Policy does not govern, so a strict policy needs only this address in
// `script-src` and `frame-src`.
//
// It writes no markup, keeps nothing, reads no cookie, and adds no name to the page.

/** The key every message of the booking embed carries, by both sides. */
export const MESSAGE_KEY = 'crmBooking';
/** What marks a frame as a booking page this script may size. */
export const FRAME_SELECTOR = 'iframe[data-crm-booking]';
/** The least and the most a frame is made, in CSS pixels. */
export const HEIGHT_BOUNDS = { min: 200, max: 20_000 } as const;

type Message =
  { readonly kind: 'ready' } | { readonly kind: 'height'; readonly height: number } | undefined;

/** What a message from a booking page says, or undefined when it is not one. */
export function readMessage(data: unknown): Message {
  if (typeof data !== 'object' || data === null) return undefined;
  const said = (data as Record<string, unknown>)[MESSAGE_KEY];
  if (said === 'ready') return { kind: 'ready' };
  if (said !== 'height') return undefined;
  const height = (data as Record<string, unknown>)['height'];
  if (typeof height !== 'number' || !Number.isInteger(height)) return undefined;
  if (height < 0 || height > 1_000_000) return undefined;
  return {
    kind: 'height',
    height: Math.min(HEIGHT_BOUNDS.max, Math.max(HEIGHT_BOUNDS.min, height)),
  };
}

/** The origin a frame was pointed at, or undefined when it is not a web address. */
export function frameOrigin(frame: HTMLIFrameElement, base: string): string | undefined {
  try {
    const url = new URL(frame.getAttribute('src') ?? '', base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Sizes every booking frame of the page, now and as they are added. */
export function startBookingFrames(doc: Document, win: Window): void {
  const frames = (): HTMLIFrameElement[] => [
    ...doc.querySelectorAll<HTMLIFrameElement>(FRAME_SELECTOR),
  ];
  const greet = (frame: HTMLIFrameElement): void => {
    const origin = frameOrigin(frame, doc.baseURI);
    if (origin === undefined) return;
    // The frame's own look, as a script sets it: a style attribute in the tag may be
    // refused by the website's policy, this is not.
    frame.style.border = '0';
    frame.style.width = '100%';
    frame.style.display = 'block';
    try {
      frame.contentWindow?.postMessage({ [MESSAGE_KEY]: 'hello' }, origin);
    } catch {
      // A frame that is not there yet, or has gone: its `ready` greets it later.
    }
  };
  win.addEventListener('message', (event: MessageEvent) => {
    const message = readMessage(event.data);
    if (message === undefined || event.source === null) return;
    const frame = frames().find((each) => each.contentWindow === event.source);
    if (frame === undefined || frameOrigin(frame, doc.baseURI) !== event.origin) return;
    if (message.kind === 'ready') greet(frame);
    else frame.style.height = `${String(message.height)}px`;
  });
  for (const frame of frames()) greet(frame);
}
