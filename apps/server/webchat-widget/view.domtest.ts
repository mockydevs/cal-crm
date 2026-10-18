// @vitest-environment jsdom
// The widget on a real DOM (jsdom): what it adds to a page, that it shows every text as
// text, and that it can be used with a keyboard and a screen reader. Part of the server's
// unit run (vitest.config.js includes it; the line above gives it its DOM).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WidgetConfig } from '../src/webchat-widget/api.js';
import {
  initialState,
  reduce,
  type WidgetEvent,
  type WidgetState,
} from '../src/webchat-widget/state.js';
import { strings } from '../src/webchat-widget/strings.js';
import { css } from '../src/webchat-widget/styles.js';
import { boot, install } from './entry.js';
import { createView, type ViewHandlers } from './view.js';

const KEY = 'k'.repeat(32);
const ATTACK = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script><b>bold</b>';
const config: WidgetConfig = {
  title: 'Chat with us',
  greeting: 'Hello.',
  emailRequired: true,
  marketingConsentWording: 'Email me news and offers.',
  messageLength: 2000,
};

function handlersOf(): {
  [Name in keyof ViewHandlers]: ReturnType<typeof vi.fn<ViewHandlers[Name]>>;
} {
  return {
    open: vi.fn<ViewHandlers['open']>(),
    close: vi.fn<ViewHandlers['close']>(),
    begin: vi.fn<ViewHandlers['begin']>(),
    send: vi.fn<ViewHandlers['send']>(),
    retry: vi.fn<ViewHandlers['retry']>(),
    end: vi.fn<ViewHandlers['end']>(),
  };
}

function asInput(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error('Not an input.');
  return element;
}
function asButton(element: HTMLElement): HTMLButtonElement {
  if (!(element instanceof HTMLButtonElement)) throw new Error('Not a button.');
  return element;
}
function asArea(element: HTMLElement): HTMLTextAreaElement {
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('Not a text area.');
  return element;
}

function mounted() {
  const handlers = handlersOf();
  const view = createView(document, handlers, strings);
  if (view === undefined) throw new Error('No view.');
  document.body.append(view.host);
  let state = initialState(0);
  const apply = (...events: WidgetEvent[]): WidgetState => {
    for (const event of events) state = reduce(state, event);
    view.render(state, 0);
    return state;
  };
  const one = (selector: string): HTMLElement => {
    const found = view.root.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`Nothing matches ${selector}`);
    return found;
  };
  return { handlers, view, apply, one, root: view.root };
}

const team = (seq: number, text: string) => ({
  seq,
  from: 'team' as const,
  text,
  sentAt: '2026-10-09T09:00:00.000Z',
});

beforeEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'pwned');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('text is shown as text', () => {
  it("never turns the team's reply into elements", () => {
    const { apply, root } = mounted();
    apply(
      { type: 'config', config, session: true },
      { type: 'opened' },
      {
        type: 'page',
        messages: [team(1, ATTACK)],
        cursor: 1,
      },
    );
    expect(root.querySelector('img, script, b, iframe, a')).toBeNull();
    expect(root.querySelector('.item.team .text')?.textContent).toBe(ATTACK);
    expect(root.querySelector('.item.team .text')?.childElementCount).toBe(0);
    expect('pwned' in window).toBe(false);
  });

  it("never turns the visitor's own message into elements, sending, sent or failed", () => {
    const { apply, root } = mounted();
    apply({ type: 'config', config, session: true }, { type: 'queued', id: 'a', text: ATTACK });
    expect(root.querySelector('img, script, b')).toBeNull();
    apply({ type: 'undelivered', id: 'a', notice: 'offline' });
    expect(root.querySelector('img, script, b')).toBeNull();
    expect(root.querySelector('.item.visitor .text')?.textContent).toBe(ATTACK);
  });

  it('never turns the title, the greeting or the consent wording into elements', () => {
    const { apply, root, one } = mounted();
    apply({
      type: 'config',
      config: { ...config, title: ATTACK, greeting: ATTACK, marketingConsentWording: ATTACK },
      session: false,
    });
    expect(root.querySelector('img, script, b')).toBeNull();
    expect(one('h2').textContent).toBe(ATTACK);
    expect(one('.check span').textContent).toBe(ATTACK);
  });

  it('has no inline style, no event attribute and no link or frame anywhere', () => {
    const { apply, root } = mounted();
    apply(
      { type: 'config', config, session: true },
      { type: 'opened' },
      {
        type: 'page',
        messages: [team(1, ATTACK), team(2, 'https://example.com/click-me')],
        cursor: 2,
      },
    );
    for (const element of root.querySelectorAll('*')) {
      expect(element.hasAttribute('style')).toBe(false);
      for (const name of element.getAttributeNames()) expect(name.startsWith('on')).toBe(false);
      expect(['A', 'IFRAME', 'OBJECT', 'EMBED', 'SCRIPT', 'IMG', 'LINK']).not.toContain(
        element.tagName,
      );
    }
  });

  it('keeps line breaks as typed, in one text node', () => {
    const { apply, root } = mounted();
    apply(
      { type: 'config', config, session: true },
      {
        type: 'page',
        messages: [team(1, 'one\ntwo')],
        cursor: 1,
      },
    );
    expect(root.querySelector('.item .text')?.textContent).toBe('one\ntwo');
    expect(css).toContain('white-space:pre-wrap');
  });
});

describe('on the host page', () => {
  it('lives in one element with a shadow root, styled from inside', () => {
    const { view, root } = mounted();
    expect(document.body.children).toHaveLength(1);
    expect(view.host.shadowRoot).toBe(root);
    expect(view.host.childElementCount).toBe(0);
    // Everything is inside one named landmark.
    expect(root.children).toHaveLength(root.querySelector('style') === null ? 1 : 2);
    expect(root.querySelector('aside')?.getAttribute('aria-label')).toBe(strings.region);
    expect(root.querySelector('aside')?.contains(root.querySelector('.launcher'))).toBe(true);
    expect(document.querySelector('button')).toBeNull();
    // jsdom has no constructed style sheets, so this is the fallback: a style element
    // inside the shadow root. A browser with them gets no element at all.
    expect(root.querySelector('style')?.textContent ?? css).toBe(css);
    expect(document.head.querySelector('style')).toBeNull();
  });

  it('resets what it would inherit from the page and stays above it', () => {
    expect(css).toContain(':host{all:initial');
    expect(css).toMatch(/z-index:\d{9,}/);
    expect(css).toContain('@media (prefers-reduced-motion:reduce)');
    expect(css).toContain('min(360px,calc(100vw - 24px))');
  });
});

describe('with a keyboard and a screen reader', () => {
  it('has a named launcher button that says whether the panel is open', () => {
    const { apply, one, handlers } = mounted();
    const launcher = asButton(one('.launcher'));
    expect(launcher.tagName).toBe('BUTTON');
    expect(launcher.type).toBe('button');
    expect(launcher.getAttribute('aria-label')).toBe(strings.launcher);
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    expect(launcher.getAttribute('aria-controls')).toBe(one('.panel').id);
    expect(one('.panel').hidden).toBe(true);
    launcher.click();
    expect(handlers.open).toHaveBeenCalledOnce();
    apply({ type: 'opened' });
    expect(launcher.getAttribute('aria-expanded')).toBe('true');
    expect(one('.panel').hidden).toBe(false);
    launcher.click();
    expect(handlers.close).toHaveBeenCalledOnce();
  });

  it('says so on the launcher when a reply is waiting', () => {
    const { view, one } = mounted();
    view.render(initialState(0), 2);
    expect(one('.launcher').getAttribute('aria-label')).toBe(strings.launcherUnread);
    expect(one('.badge').hidden).toBe(false);
    view.render(initialState(0), 0);
    expect(one('.badge').hidden).toBe(true);
  });

  it('is a dialog named by its title, with a named close button', () => {
    const { apply, one, root } = mounted();
    apply({ type: 'config', config, session: false }, { type: 'opened' });
    const panel = one('.panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('false');
    const title = root.getElementById(panel.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Chat with us');
    expect(one('.close').getAttribute('aria-label')).toBe(strings.close);
  });

  it('names every field with a label around it', () => {
    const { apply, root } = mounted();
    apply({ type: 'config', config, session: false }, { type: 'opened' });
    const controls = [...root.querySelectorAll('input, textarea')];
    expect(controls).toHaveLength(5);
    for (const control of controls) {
      const label = control.closest('label');
      expect(label).not.toBeNull();
      expect((label?.textContent ?? '').trim()).not.toBe('');
    }
    expect(root.querySelector('.composer .sr')?.textContent).toBe(strings.messageLabel);
  });

  it('marks the email address required or optional as the widget asks', () => {
    const { apply, one } = mounted();
    apply({ type: 'config', config, session: false });
    expect(asInput(one('input[type=email]')).required).toBe(true);
    apply({ type: 'config', config: { ...config, emailRequired: false }, session: false });
    expect(asInput(one('input[type=email]')).required).toBe(false);
    expect(one('input[type=email]').closest('label')?.textContent).toContain(strings.optional);
  });

  it('announces new messages politely and problems at once', () => {
    const { apply, one } = mounted();
    apply({ type: 'config', config, session: true }, { type: 'notice', notice: 'offline' });
    expect(one('.feed').getAttribute('role')).toBe('log');
    expect(one('.feed').getAttribute('aria-live')).toBe('polite');
    // The messages are a list inside it, and stay one: the list has no role of its own.
    expect(one('.feed > ol.log').hasAttribute('role')).toBe(false);
    expect(one('.notice').getAttribute('role')).toBe('alert');
    expect(one('.notice').textContent).toBe(strings.offline);
    expect(one('.status').getAttribute('role')).toBe('status');
  });

  it('says who each message is from without relying on colour', () => {
    const { apply, root } = mounted();
    apply(
      { type: 'config', config, session: true },
      { type: 'queued', id: 'a', text: 'Hi' },
      {
        type: 'page',
        messages: [team(1, 'Hello')],
        cursor: 1,
      },
    );
    expect([...root.querySelectorAll('.item .sr')].map((node) => node.textContent)).toEqual([
      `${strings.team}: `,
      `${strings.you}: `,
    ]);
  });

  it('moves focus into the panel when it opens and back to the launcher when it closes', () => {
    const { apply, root, one } = mounted();
    apply({ type: 'config', config, session: false });
    apply({ type: 'opened' });
    expect(root.activeElement).toBe(one('input[type=text]'));
    apply({ type: 'closed' });
    expect(root.activeElement).toBe(one('.launcher'));
  });

  it('moves focus to the message box when the chat starts, and to close when there is nothing to fill', () => {
    const { apply, root, one } = mounted();
    apply({ type: 'opened' });
    expect(root.activeElement).toBe(one('.close'));
    apply({ type: 'config', config, session: false });
    expect(root.activeElement).toBe(one('input[type=text]'));
    apply({ type: 'started' });
    expect(root.activeElement).toBe(one('.composer textarea'));
  });

  it('closes on Escape, and does not pass the key on to the page', () => {
    const { apply, one, handlers } = mounted();
    apply({ type: 'config', config, session: false }, { type: 'opened' });
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    one('input[type=email]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
    );
    document.removeEventListener('keydown', heard);
    expect(handlers.close).toHaveBeenCalledOnce();
    expect(heard).not.toHaveBeenCalled();
  });

  it('sends on Enter, makes a new line on Shift+Enter, and waits for an input method', () => {
    const { apply, one, handlers } = mounted();
    apply({ type: 'config', config, session: true }, { type: 'opened' });
    const box = asArea(one('.composer textarea'));
    const press = (init: KeyboardEventInit): boolean =>
      box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    box.value = 'Hello';
    expect(press({ key: 'Enter', shiftKey: true })).toBe(true);
    expect(press({ key: 'Enter', isComposing: true })).toBe(true);
    expect(handlers.send).not.toHaveBeenCalled();
    expect(press({ key: 'Enter' })).toBe(false);
    expect(handlers.send).toHaveBeenCalledExactlyOnceWith('Hello');
    expect(box.value).toBe('');
    box.value = '   ';
    press({ key: 'Enter' });
    expect(handlers.send).toHaveBeenCalledOnce();
  });

  it('offers to send a failed message again', () => {
    const { apply, one, handlers } = mounted();
    apply(
      { type: 'config', config, session: true },
      { type: 'queued', id: 'a', text: 'Hi' },
      { type: 'undelivered', id: 'a', notice: 'offline' },
    );
    const again = asButton(one('.item.failed button'));
    expect(again.textContent).toBe(strings.retry);
    again.click();
    expect(handlers.retry).toHaveBeenCalledExactlyOnceWith('a');
    apply({ type: 'queued', id: 'a', text: 'Hi' });
    expect(one('.item .meta').textContent).toBe(strings.sending);
  });

  it('makes buttons wait while a request is on its way', () => {
    const { apply, one } = mounted();
    apply({ type: 'config', config, session: false }, { type: 'busy', busy: true });
    expect(asButton(one('.details .primary')).disabled).toBe(true);
    apply({ type: 'busy', busy: false });
    expect(asButton(one('.details .primary')).disabled).toBe(false);
  });
});

describe('the first form', () => {
  const submit = (form: Element): void => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  };

  it('never ticks the marketing box for the visitor', () => {
    const { apply, one, handlers } = mounted();
    apply({ type: 'config', config, session: false }, { type: 'opened' });
    const box = asInput(one('input[type=checkbox]'));
    expect(box.checked).toBe(false);
    expect(box.closest('label')?.textContent).toBe('Email me news and offers.');
    asInput(one('input[type=email]')).value = 'maya@example.test';
    asArea(one('.details textarea')).value = 'Hello';
    submit(one('.details'));
    expect(handlers.begin).toHaveBeenLastCalledWith({
      name: '',
      email: 'maya@example.test',
      marketingConsent: false,
      text: 'Hello',
    });
    box.click();
    submit(one('.details'));
    expect(handlers.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ marketingConsent: true }),
    );
  });

  it('shows no box, and reports no tick, when the widget has no wording', () => {
    const { apply, one, handlers } = mounted();
    apply({ type: 'config', config, session: false });
    asInput(one('input[type=checkbox]')).checked = true;
    apply({ type: 'config', config: { ...config, marketingConsentWording: null }, session: false });
    expect(one('.check').hidden).toBe(true);
    submit(one('.details'));
    expect(handlers.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ marketingConsent: false }),
    );
  });

  it('does not reload the page when submitted', () => {
    const { apply, one } = mounted();
    apply({ type: 'config', config, session: false });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    one('.details').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves nothing typed behind when a chat ends', () => {
    const { apply, one, root } = mounted();
    apply(
      { type: 'config', config, session: true },
      { type: 'page', messages: [team(1, 'x')], cursor: 1 },
    );
    asInput(one('input[type=email]')).value = 'maya@example.test';
    asArea(one('.composer textarea')).value = 'half a thought';
    asInput(one('input[type=checkbox]')).checked = true;
    apply({ type: 'ended', notice: null });
    expect(root.querySelectorAll('.item')).toHaveLength(0);
    for (const control of root.querySelectorAll<HTMLInputElement>(
      'input[type=text], input[type=email], textarea',
    ))
      expect(control.value).toBe('');
    expect(asInput(one('input[type=checkbox]')).checked).toBe(false);
  });
});

describe('starting on a page', () => {
  function tag(attributes: Record<string, string>): HTMLScriptElement {
    const script = document.createElement('script');
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    return script;
  }
  const SRC = 'https://crm.example.test/webchat/widget.js';
  const good = (): HTMLScriptElement => tag({ src: SRC, 'data-widget-key': KEY });

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('adds one element and returns open and close, and nothing else', () => {
    const api = boot(window, good());
    expect(document.querySelectorAll('[data-crm-webchat]')).toHaveLength(1);
    expect(Object.keys(api ?? {}).sort()).toEqual(['close', 'open']);
    expect(Object.isFrozen(api)).toBe(true);
    // No session token, key or internals are reachable through it.
    expect(JSON.stringify(api)).toBe('{}');
  });

  it('asks the CRM for nothing on a page view', () => {
    const fetch = vi.spyOn(window, 'fetch').mockRejectedValue(new TypeError('offline'));
    boot(window, good());
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['no key', { src: SRC }],
    ['a key of the wrong shape', { src: SRC, 'data-widget-key': '../admin' }],
    ['a key with markup', { src: SRC, 'data-widget-key': '<img src=x>' }],
    [
      'a script address that is not the web',
      { src: 'data:text/javascript,0', 'data-widget-key': KEY },
    ],
  ])('does nothing with %s', (_why, attributes) => {
    expect(boot(window, tag(attributes))).toBeUndefined();
    expect(document.querySelector('[data-crm-webchat]')).toBeNull();
  });

  it('does nothing without a script tag', () => {
    expect(boot(window, null)).toBeUndefined();
    expect(document.querySelector('[data-crm-webchat]')).toBeNull();
  });

  it('calls only the host its script came from, with the widget key, when opened', async () => {
    const fetch = vi.spyOn(window, 'fetch').mockRejectedValue(new TypeError('offline'));
    const api = boot(window, good());
    api?.open();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://crm.example.test/api/v1/public/webchat/${KEY}`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  });

  it('fails quietly when the CRM cannot be reached: no error and nothing in the console', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    window.addEventListener('error', unhandled);
    vi.spyOn(window, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const api = boot(window, good());
    api?.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    api?.close();
    window.removeEventListener('unhandledrejection', unhandled);
    window.removeEventListener('error', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    for (const spy of [errors, warnings, logs]) expect(spy).not.toHaveBeenCalled();
  });

  it('works when the browser refuses storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(boot(window, good())).toBeDefined();
    expect(document.querySelectorAll('[data-crm-webchat]')).toHaveLength(1);
  });

  it('reads a stored session at once, and takes none from the address of the page', async () => {
    const token = 't'.repeat(43);
    const fetch = vi.spyOn(window, 'fetch').mockRejectedValue(new TypeError('offline'));
    window.history.replaceState(null, '', `/?token=${token}&crm-webchat=${token}#${token}`);
    boot(window, good());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    window.history.replaceState(null, '', '/');

    document.body.replaceChildren();
    window.localStorage.setItem(
      `crm-webchat:${KEY}`,
      JSON.stringify({ token, expiresAt: '2999-01-01T00:00:00.000Z', seen: 0 }),
    );
    boot(window, good());
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://crm.example.test/api/v1/public/webchat/${KEY}/messages?after=0`,
    );
    expect(JSON.stringify(fetch.mock.calls[0]?.[0])).not.toContain(token);
  });

  // Last: the name it defines cannot be removed again, by this test or by a page's script.
  it('defines one name on the window, once, and never throws into the page', () => {
    expect(() => {
      install(window, null);
      install(window, tag({ src: SRC, 'data-widget-key': 'bad' }));
    }).not.toThrow();
    expect('CRMWebchat' in window).toBe(false);

    // A page that breaks the widget while it starts gets no widget, and no error.
    const append = vi.spyOn(document.body, 'append').mockImplementation(() => {
      throw new Error('the page froze its body');
    });
    expect(() => {
      install(window, good());
    }).not.toThrow();
    expect('CRMWebchat' in window).toBe(false);
    append.mockRestore();

    const before = new Set(Object.getOwnPropertyNames(window));
    install(window, good());
    const added = Object.getOwnPropertyNames(window).filter((name) => !before.has(name));
    expect(added).toEqual(['CRMWebchat']);
    expect(document.querySelectorAll('[data-crm-webchat]')).toHaveLength(1);
    expect(Object.getOwnPropertyDescriptor(window, 'CRMWebchat')).toMatchObject({
      writable: false,
      configurable: false,
    });
    // Included a second time by mistake: still one widget.
    install(window, good());
    expect(document.querySelectorAll('[data-crm-webchat]')).toHaveLength(1);
  });
});
