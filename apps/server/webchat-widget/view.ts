// The web chat widget on the page: a launcher button and a panel, inside a shadow root on
// one element appended to the body.
//
// Every piece of text, the visitor's own and whatever the CRM sends, is put on the page
// with textContent or as a form value. Nothing here parses HTML: no innerHTML, no
// insertAdjacentHTML, no document.write, no attribute that holds code. A reply that
// contains markup is shown as the characters it is made of.
import type { Details } from '../src/webchat-widget/controller.js';
import type { ChatItem, WidgetState } from '../src/webchat-widget/state.js';
import type { Strings } from '../src/webchat-widget/strings.js';
import { css } from '../src/webchat-widget/styles.js';

export interface ViewHandlers {
  open(): void;
  close(): void;
  begin(details: Details): void;
  send(text: string): void;
  retry(id: string): void;
  end(): void;
}

export interface View {
  /** The one element added to the page. */
  readonly host: HTMLElement;
  /** The widget's shadow root. */
  readonly root: ShadowRoot;
  render(state: WidgetState, unread: number): void;
}

const SVG = 'http://www.w3.org/2000/svg';
// A speech bubble. Drawn with DOM calls, as everything is.
const BUBBLE = 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';

/** Builds the widget in `doc`, or returns undefined where a shadow root cannot be made. */
export function createView(doc: Document, handlers: ViewHandlers, text: Strings): View | undefined {
  const host = doc.createElement('div');
  if (typeof host.attachShadow !== 'function') return undefined;
  host.setAttribute('data-crm-webchat', '');
  // Open, not closed: a closed root hides nothing from a page's scripts (they can wrap
  // attachShadow before this runs) and would hide the widget from accessibility tools.
  const root = host.attachShadow({ mode: 'open' });

  // A constructed sheet needs no <style> element, so it works where a website's
  // Content-Security-Policy refuses inline styles. Older browsers get the element.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = doc.createElement('style');
    style.textContent = css;
    root.append(style);
  }

  function el<Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    className = '',
    content = '',
  ): HTMLElementTagNameMap[Tag] {
    const node = doc.createElement(tag);
    if (className !== '') node.className = className;
    if (content !== '') node.textContent = content;
    return node;
  }
  function button(className: string, label: string, submit = false): HTMLButtonElement {
    const node = el('button', className, label);
    node.type = submit ? 'submit' : 'button';
    return node;
  }
  /** A label with its words and its control inside it, which is what names the control. */
  function field(words: string, control: HTMLElement): HTMLLabelElement {
    const label = el('label');
    label.append(el('span', '', words), control);
    return label;
  }

  const panel = el('section', 'panel');
  panel.id = 'crm-webchat-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', 'crm-webchat-title');
  panel.hidden = true;

  const head = el('div', 'head');
  const title = el('h2', '', text.launcher);
  title.id = 'crm-webchat-title';
  const close = button('close', '×');
  close.setAttribute('aria-label', text.close);
  head.append(title, close);

  const body = el('div', 'body');
  const status = el('p', 'status');
  status.setAttribute('role', 'status');
  const notice = el('p', 'notice');
  notice.setAttribute('role', 'alert');

  // The first form.
  const details = el('form', 'details');
  details.noValidate = true;
  const greeting = el('p');
  const name = el('input');
  name.type = 'text';
  name.autocomplete = 'name';
  name.maxLength = 80;
  const nameLabel = field(text.nameLabel, name);
  nameLabel.firstElementChild?.append(' ', el('span', 'hint', text.optional));
  const email = el('input');
  email.type = 'email';
  email.autocomplete = 'email';
  email.maxLength = 320;
  const emailHint = el('span', 'hint', text.optional);
  const emailLabel = field(text.emailLabel, email);
  emailLabel.firstElementChild?.append(' ', emailHint);
  const consent = el('input');
  consent.type = 'checkbox';
  // Unticked until the visitor ticks it; nothing in the widget ever ticks it for them.
  consent.checked = false;
  const consentWords = el('span');
  const consentLabel = el('label', 'check');
  consentLabel.append(consent, consentWords);
  const first = el('textarea');
  first.rows = 3;
  const start = button('primary', text.start, true);
  details.append(
    greeting,
    nameLabel,
    emailLabel,
    field(text.messageLabel, first),
    consentLabel,
    start,
    el('p', 'privacy', text.privacy),
  );

  // The chat.
  const chat = el('div', 'chat');
  // The live region is around the list, not the list itself: a list that is given another
  // role stops being a list, and its items are then items of nothing.
  const feed = el('div', 'feed');
  feed.setAttribute('role', 'log');
  feed.setAttribute('aria-live', 'polite');
  const log = el('ol', 'log');
  feed.append(log);
  const composer = el('form', 'composer');
  composer.noValidate = true;
  const next = el('textarea');
  next.rows = 1;
  next.placeholder = text.messagePlaceholder;
  const nextLabel = el('label');
  nextLabel.append(el('span', 'sr', text.messageLabel), next);
  const send = button('primary', text.send, true);
  composer.append(nextLabel, send);
  const end = button('link end', text.endChat);
  chat.append(feed, composer, end);

  body.append(status, details, chat, notice);
  panel.append(head, body);

  const launcher = button('launcher', '');
  launcher.setAttribute('aria-controls', panel.id);
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-label', text.launcher);
  const icon = doc.createElementNS(SVG, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(SVG, 'path');
  path.setAttribute('d', BUBBLE);
  icon.append(path);
  const badge = el('span', 'badge');
  badge.hidden = true;
  launcher.append(icon, badge);

  // One landmark around both, so nothing of the widget sits outside every region of the page.
  const frame = el('aside');
  frame.setAttribute('aria-label', text.region);
  frame.append(panel, launcher);
  root.append(frame);

  let shown: WidgetState | undefined;
  const rows = new Map<string, HTMLLIElement>();

  launcher.addEventListener('click', () => {
    if (shown?.open === true) handlers.close();
    else handlers.open();
  });
  close.addEventListener('click', () => {
    handlers.close();
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      handlers.close();
    }
  });
  details.addEventListener('submit', (event) => {
    event.preventDefault();
    handlers.begin({
      name: name.value,
      email: email.value,
      marketingConsent: !consentLabel.hidden && consent.checked,
      text: first.value,
    });
  });
  const submitNext = (): void => {
    const value = next.value;
    if (value.trim() === '') return;
    next.value = '';
    handlers.send(value);
  };
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submitNext();
  });
  // Enter sends; Shift+Enter makes a new line. Not while an input method is composing.
  next.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitNext();
    }
  });
  end.addEventListener('click', () => {
    handlers.end();
  });

  function row(item: ChatItem): HTMLLIElement {
    let node = rows.get(item.id);
    if (node === undefined) {
      node = el('li');
      node.append(el('span', 'sr'), el('span', 'text'));
      rows.set(item.id, node);
    }
    const [who, words] = [node.children[0], node.children[1]];
    node.className = `item ${item.from}${item.status === 'failed' ? ' failed' : ''}`;
    if (who !== undefined) who.textContent = `${item.from === 'visitor' ? text.you : text.team}: `;
    // As text, whatever it holds.
    if (words !== undefined && words.textContent !== item.text) words.textContent = item.text;
    const meta = node.children[2];
    if (item.status === 'sent') meta?.remove();
    else {
      const line = meta ?? node.appendChild(el('span', 'meta'));
      const wanted = item.status;
      if (line.getAttribute('data-status') !== wanted) {
        line.setAttribute('data-status', wanted);
        line.textContent = wanted === 'sending' ? text.sending : `${text.failed} `;
        if (wanted === 'failed') {
          const again = button('link', text.retry);
          again.addEventListener('click', () => {
            handlers.retry(item.id);
          });
          line.append(again);
        }
      }
    }
    return node;
  }

  function render(state: WidgetState, unread: number): void {
    const before = shown;
    shown = state;
    const { config } = state;

    launcher.setAttribute('aria-expanded', String(state.open));
    launcher.setAttribute('aria-label', unread > 0 ? text.launcherUnread : text.launcher);
    badge.hidden = unread === 0;
    panel.hidden = !state.open;
    title.textContent = config?.title ?? text.launcher;

    status.hidden = state.view !== 'loading' && state.view !== 'unavailable';
    status.textContent =
      state.view === 'loading'
        ? text.loading
        : state.view === 'unavailable'
          ? text.unavailable
          : '';
    details.hidden = state.view !== 'form';
    chat.hidden = state.view !== 'chat';
    notice.textContent = state.notice === null ? '' : text[state.notice];
    notice.hidden = state.notice === null;

    if (config !== null) {
      greeting.textContent = config.greeting;
      greeting.hidden = config.greeting === '';
      email.required = config.emailRequired;
      emailHint.hidden = config.emailRequired;
      const wording = config.marketingConsentWording;
      consentLabel.hidden = wording === null;
      consentWords.textContent = wording ?? '';
      // A box that is not shown is not ticked.
      if (wording === null) consent.checked = false;
      first.maxLength = config.messageLength;
      next.maxLength = config.messageLength;
    }
    start.disabled = state.busy;
    send.disabled = state.busy;

    // The list follows the state: rows are made once, moved if their place changed, and
    // removed when their message is gone.
    const wanted = new Set(state.items.map((item) => item.id));
    for (const [id, node] of rows) {
      if (!wanted.has(id)) {
        node.remove();
        rows.delete(id);
      }
    }
    let added = false;
    for (const [index, item] of state.items.entries()) {
      const node = row(item);
      const at = log.children[index];
      if (at !== node) {
        log.insertBefore(node, at ?? null);
        added = true;
      }
    }
    if (added) body.scrollTop = body.scrollHeight;

    // A chat that ended leaves nothing typed behind for the next person at this browser.
    if (before?.view === 'chat' && state.view === 'form') {
      for (const control of [name, email, first, next]) control.value = '';
      consent.checked = false;
    }
    if (before?.view === 'form' && state.view === 'chat') first.value = '';

    // Focus goes into the panel when it opens or changes what it asks for, and back to the
    // launcher when it closes, so a keyboard user is never left on something hidden.
    const opened = state.open && before?.open !== true;
    const changed = state.open && before !== undefined && before.view !== state.view;
    if (opened || changed) {
      if (state.view === 'form') name.focus();
      else if (state.view === 'chat') next.focus();
      else close.focus();
    } else if (!state.open && before?.open === true) launcher.focus();
  }

  return { host, root, render };
}
