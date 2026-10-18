// The script a website loads:
//
//   <script async src="https://crm.example.com/webchat/widget.js" data-widget-key="…"></script>
//
// It adds one element to the page and one name to the window: `CRMWebchat`, with `open()`
// and `close()`. It reads the widget key from its own tag and the CRM's address from its
// own URL, and takes nothing else from the page: no query parameter, no message from
// another window, no cookie.
//
// It must never break the page it is a guest on. Whatever goes wrong, a missing key, an old
// browser, an unreachable CRM, a page that removed the element, the outcome is no widget
// or a short notice in the panel, and never an uncaught error or a line in the console.
import { createWidgetApi, type Fetch } from '../src/webchat-widget/api.js';
import { createController, type Controller } from '../src/webchat-widget/controller.js';
import { createSessionStore } from '../src/webchat-widget/storage.js';
import { strings } from '../src/webchat-widget/strings.js';
import { createView } from './view.js';

/** The one name the widget adds to the page. */
export interface CRMWebchat {
  open(): void;
  close(): void;
}

const WIDGET_KEY = /^[A-Za-z0-9_-]{32}$/;

// Random UUIDs for message ids. randomUUID needs a secure page; getRandomValues does not.
function newId(crypto: Crypto): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Starts the widget for the script tag it was loaded by. Returns nothing when it cannot. */
export function boot(win: Window, script: HTMLOrSVGScriptElement | null): CRMWebchat | undefined {
  const doc = win.document;
  // An HTML script tag has a src; an SVG one does not, and is not what loads this file.
  if (script === null || !('src' in script) || 'CRMWebchat' in win) return undefined;
  const key = script.getAttribute('data-widget-key') ?? '';
  if (!WIDGET_KEY.test(key)) return undefined;
  // The CRM is wherever this script came from; the page cannot point the widget elsewhere.
  const base = new URL(script.src, win.location.href);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return undefined;

  const fetcher: Fetch = (url, init) => win.fetch(url, init);
  // The view is made first and calls the controller, which is made with the view.
  const made: { controller?: Controller } = {};
  const view = createView(
    doc,
    {
      open: () => made.controller?.open(),
      close: () => made.controller?.close(),
      begin: (details) => void made.controller?.begin(details),
      send: (text) => void made.controller?.send(text),
      retry: (id) => void made.controller?.retry(id),
      end: () => made.controller?.end(),
    },
    strings,
  );
  if (view === undefined) return undefined;
  const running = createController({
    api: createWidgetApi(base.origin, key, fetcher),
    store: createSessionStore(
      key,
      () => win.localStorage,
      () => Date.now(),
    ),
    render: (state, unread) => {
      view.render(state, unread);
    },
    newId: () => newId(win.crypto),
    setTimer: (run, ms) => win.setTimeout(run, ms),
    clearTimer: (timer) => {
      if (typeof timer === 'number') win.clearTimeout(timer);
    },
    isHidden: () => doc.visibilityState === 'hidden',
  });
  made.controller = running;
  doc.addEventListener('visibilitychange', () => {
    running.visibilityChanged();
  });
  view.render(running.state(), 0);
  doc.body.append(view.host);
  return Object.freeze({
    open: () => {
      running.open();
    },
    close: () => {
      running.close();
    },
  });
}

/** Runs once the page has a body, and swallows anything thrown: a guest does not crash its host. */
export function install(win: Window, script: HTMLOrSVGScriptElement | null): void {
  const run = (): void => {
    try {
      const api = boot(win, script);
      if (api !== undefined)
        Object.defineProperty(win, 'CRMWebchat', {
          value: api,
          writable: false,
          configurable: false,
        });
    } catch {
      // No widget; the page carries on.
    }
  };
  if (win.document.readyState === 'loading')
    win.document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
}
