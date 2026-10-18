// The booking page's side of the booking embed. A website shows the page in a frame and
// loads the CRM's small script beside it (apps/server/booking-embed/sizer.ts), which makes
// the frame as tall as the page. The two talk with three messages, each an object under the
// key `crmBooking`:
//
// 1. this page says `ready` to the window that holds it. It carries nothing, and it cannot
//    know who that is, so it is said to any origin;
// 2. the website's script answers `hello`. Only a `hello` from that same window counts, and
//    its origin is where heights are sent from then on, never to any other;
// 3. this page sends its height, and again whenever the height changes.
//
// Outside a frame none of this runs. The page is told it is framed by an attribute on the
// root element (`data-framed`): a framed page does not stretch to the frame's height, or it
// could never become shorter.

/** The key every message of the booking embed carries, on both sides. */
export const MESSAGE_KEY = 'crmBooking';

/** Whether the page is shown in a frame of another page. */
export function isFramed(win: Window): boolean {
  return win.parent !== win;
}

/**
 * Whether the page knows it is not secure, as in a frame on a website served over plain
 * http: the top-level page decides (HTML, "secure context"), and such a page has neither
 * `crypto.randomUUID` nor WebCrypto's digests, so it cannot book. A browser (or a test's
 * DOM) that does not say is taken at its word as secure.
 */
export function isInsecure(win: object): boolean {
  return 'isSecureContext' in win && win.isSecureContext === false;
}

/** What a message to the page says, if it is the website's `hello`. */
function isHello(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)[MESSAGE_KEY] === 'hello'
  );
}

/**
 * Starts telling the website that frames the page how tall the page is. Returns what stops
 * it. Does nothing outside a frame.
 */
export function startEmbeddedPage(win: Window, doc: Document): () => void {
  if (!isFramed(win)) return () => undefined;
  const root = doc.documentElement;
  root.dataset['framed'] = '';
  let website: string | undefined;
  let sent: number | undefined;
  const send = (): void => {
    if (website === undefined) return;
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height === sent) return;
    sent = height;
    win.parent.postMessage({ [MESSAGE_KEY]: 'height', height }, website);
  };
  const listen = (event: MessageEvent): void => {
    if (event.source !== win.parent || !isHello(event.data)) return;
    // An opaque origin ("null") cannot be named as a message's target: it gets nothing.
    if (!/^https?:\/\//.test(event.origin)) return;
    website = event.origin;
    sent = undefined;
    send();
  };
  win.addEventListener('message', listen);
  const observer = new ResizeObserver(send);
  observer.observe(root);
  win.parent.postMessage({ [MESSAGE_KEY]: 'ready' }, '*');
  return () => {
    win.removeEventListener('message', listen);
    observer.disconnect();
    delete root.dataset['framed'];
  };
}
