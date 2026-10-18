// The form on the page: a heading, the questions, the consent boxes and a button, inside a
// shadow root on one element.
//
// Every piece of text, the business's own and whatever the CRM sends, is put on the page
// with textContent or as a form value. Nothing here parses HTML: no markup sink, no
// attribute that holds code. A label that contains markup is shown as the characters it
// is made of. The one address put on the page, the link of a terms box, was read as a
// secure web address before it got here (api.ts), and opens in a tab of its own.
//
// A hidden question is not on the page at all: its answer is read from the page's address
// by what runs the form (entry.ts).
import type {
  AnswerIssue,
  EmbedConsent,
  EmbedField,
  EmbedForm,
  Value,
} from '../src/forms-embed/api.js';
import type { Strings } from '../src/forms-embed/strings.js';
import { css } from '../src/forms-embed/styles.js';

/** What a visitor has filled in, as it is sent. */
export interface Answers {
  readonly values: Readonly<Record<string, Value>>;
  readonly consents: Readonly<Record<string, boolean>>;
  readonly trap: string;
}

export interface FormView {
  /** The one element added to the page. */
  readonly host: HTMLElement;
  /** The form's shadow root. */
  readonly root: ShadowRoot;
  showLoading(): void;
  showUnavailable(): void;
  /** Builds the form. Answers already typed are kept for the questions that are still there. */
  showForm(form: EmbedForm): void;
  setBusy(busy: boolean): void;
  /** Marks each answer that has a problem, says so above the button, and moves focus to the first. */
  showProblems(issues: readonly AnswerIssue[], notice: string): void;
  showDone(message: string): void;
  /** Says, above the form and for as long as it is there, that this is a preview of a draft. */
  showPreview(): void;
  /** Fills the questions still empty with what the page's address said for them, by key. */
  prefill(values: Readonly<Record<string, string>>): void;
  /**
   * Says, above the button and to a screen reader, how the bot check of a form that asks
   * for one is going. Nothing to see or do: the browser does the work.
   */
  showCheck(state: 'working' | 'done' | 'failed'): void;
  read(): Answers;
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
interface Row {
  /** What is marked when the answer has a problem: the control, or the group of a question with several. */
  readonly control: HTMLElement;
  /** What takes focus then: the control, or the first of the group. */
  readonly first: HTMLElement;
  readonly error: HTMLElement;
  /** What describes the control besides its error: its hint, if it has one. */
  readonly described: string;
  read(): Value;
  /** Puts back what the visitor had answered, when it is an answer of this kind. */
  restore(kept: Value): void;
}

const RATINGS = ['1', '2', '3', '4', '5'] as const;

let instances = 0;

/** Builds the embed in `doc`, or returns undefined where a shadow root cannot be made. */
export function createView(
  doc: Document,
  text: Strings,
  onSubmit: () => void,
): FormView | undefined {
  const host = doc.createElement('div');
  if (typeof host.attachShadow !== 'function') return undefined;
  host.setAttribute('data-crm-form-root', '');
  // Open, not closed: a closed root hides nothing from a page's scripts (they can wrap
  // attachShadow before this runs) and would hide the form from accessibility tools.
  const root = host.attachShadow({ mode: 'open' });
  // Ids are unique within a shadow root; the number keeps two forms on one page apart for
  // tools that flatten the page.
  instances += 1;
  const prefix = `crm-form-${String(instances)}`;

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

  const frame = el('section');
  frame.setAttribute('aria-label', text.region);
  const preview = el('p', 'preview', text.preview);
  preview.hidden = true;
  const title = el('h2');
  const description = el('p', 'description');
  const status = el('p', 'status');
  status.setAttribute('role', 'status');
  const form = el('form');
  form.noValidate = true;
  const notice = el('p', 'notice');
  notice.setAttribute('role', 'alert');
  const send = el('button', 'primary');
  send.type = 'submit';
  // Out of sight and out of the tab order: a person never reaches it, a program that fills
  // every field does.
  const trapBox = el('div', 'trap');
  trapBox.setAttribute('aria-hidden', 'true');
  const trap = el('input');
  trap.type = 'text';
  trap.tabIndex = -1;
  trap.autocomplete = 'off';
  trap.name = 'company_website';
  const trapLabel = el('label', '', text.trap);
  trapLabel.append(trap);
  trapBox.append(trapLabel);
  // The bot check's progress: polite, so it never interrupts what a screen reader is saying.
  const check = el('p', 'botcheck');
  check.setAttribute('role', 'status');
  check.hidden = true;
  const done = el('p', 'done');
  done.setAttribute('role', 'status');
  done.tabIndex = -1;
  frame.append(preview, title, description, status, form, done);
  root.append(frame);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit();
  });

  let rows = new Map<string, Row>();
  let boxes = new Map<string, Row>();
  let submitLabel = '';

  function show(part: 'status' | 'form' | 'done'): void {
    status.hidden = part !== 'status';
    form.hidden = part !== 'form';
    done.hidden = part !== 'done';
    title.hidden = title.textContent === '';
    description.hidden = description.textContent === '' || part === 'done';
  }

  function control(field: EmbedField, shown: EmbedForm): Control {
    if (field.type === 'long_text') {
      const area = el('textarea');
      area.rows = 4;
      area.maxLength = shown.longTextLength;
      return area;
    }
    if (field.type === 'single_choice' || field.type === 'multi_choice') {
      const select = el('select');
      if (field.type === 'multi_choice') select.multiple = true;
      else {
        const none = el('option', '', text.choose);
        none.value = '';
        select.append(none);
      }
      for (const option of field.options) {
        const choice = el('option', '', option.label);
        choice.value = option.key;
        select.append(choice);
      }
      return select;
    }
    const input = el('input');
    if (field.type === 'checkbox' || field.type === 'terms') {
      input.type = 'checkbox';
      return input;
    }
    input.maxLength = shown.textLength;
    if (field.type === 'email') {
      input.type = 'email';
      input.autocomplete = 'email';
    } else if (field.type === 'phone') {
      input.type = 'tel';
      input.autocomplete = 'tel';
    } else if (field.type === 'date') {
      input.type = 'date';
    } else if (field.type === 'url') {
      input.type = 'url';
      input.maxLength = 2000;
    } else {
      input.type = 'text';
      if (field.type === 'number') input.inputMode = 'decimal';
    }
    return input;
  }

  const hintOf = (id: string, hint: string): HTMLElement | undefined => {
    if (hint === '') return undefined;
    const help = el('p', 'hint', hint);
    help.id = `${id}-hint`;
    return help;
  };
  const errorOf = (id: string): HTMLElement => {
    const error = el('p', 'error');
    error.id = `${id}-error`;
    error.hidden = true;
    return error;
  };
  const named = (words: string, required: boolean): HTMLElement => {
    const name = el('span', '', words);
    if (required) name.append(' ', el('span', 'req', text.required));
    return name;
  };

  /** One question or box: its label, its control, its hint and the place for its problem. */
  function row(
    key: string,
    words: string,
    required: boolean,
    hint: string,
    input: Control,
    after?: HTMLElement,
  ): { readonly node: HTMLElement; readonly row: Row } {
    const box = input instanceof HTMLInputElement && input.type === 'checkbox';
    const id = `${prefix}-${key}`;
    input.id = id;
    input.required = required;
    const node = el('div', 'field');
    const label = el('label', box ? 'check' : '');
    const name = named(words, required);
    // The link of a terms box is part of its words, and of what the box is named by.
    if (after !== undefined) name.append(' ', after);
    if (box) label.append(input, name);
    else {
      label.htmlFor = id;
      label.append(name);
    }
    const error = errorOf(id);
    const help = hintOf(id, hint);
    node.append(label);
    if (!box) node.append(input);
    if (help !== undefined) {
      node.append(help);
      input.setAttribute('aria-describedby', help.id);
    }
    node.append(error);
    return {
      node,
      row: {
        control: input,
        first: input,
        error,
        described: help?.id ?? '',
        read: () => {
          if (input instanceof HTMLInputElement && box) return input.checked;
          if (input instanceof HTMLSelectElement && input.multiple)
            return Array.from(input.selectedOptions, (option) => option.value);
          return input.value;
        },
        restore: (kept) => {
          if (input instanceof HTMLInputElement && box) {
            if (typeof kept === 'boolean') input.checked = kept;
          } else if (input instanceof HTMLSelectElement && input.multiple) {
            if (typeof kept === 'object')
              for (const option of input.options) option.selected = kept.includes(option.value);
          } else if (typeof kept === 'string') input.value = kept;
        },
      },
    };
  }

  /**
   * A question answered by choosing among buttons: one of them (radio buttons, a rating)
   * or several (checkboxes). The group is named by the question, each button by its
   * choice, as a screen reader reads them.
   */
  function group(
    field: EmbedField,
    choices: readonly { readonly key: string; readonly label: string }[],
    several: boolean,
    className: string,
  ): { readonly node: HTMLElement; readonly row: Row } {
    const id = `${prefix}-${field.key}`;
    const set = el('fieldset', className);
    set.id = id;
    const legend = el('legend');
    legend.append(named(field.label, field.required));
    set.append(legend);
    const inputs = choices.map((choice) => {
      const input = el('input');
      input.type = several ? 'checkbox' : 'radio';
      // One name for the buttons of a question, so choosing one lets go of the others.
      input.name = id;
      input.value = choice.key;
      const label = el('label', 'check');
      label.append(input, el('span', '', choice.label));
      set.append(label);
      return input;
    });
    const error = errorOf(id);
    const help = hintOf(id, field.helpText);
    const node = el('div', 'field');
    node.append(set);
    if (help !== undefined) {
      node.append(help);
      set.setAttribute('aria-describedby', help.id);
    }
    node.append(error);
    const chosen = (): string[] =>
      inputs.filter((input) => input.checked).map((input) => input.value);
    return {
      node,
      row: {
        control: set,
        first: inputs[0] ?? set,
        error,
        described: help?.id ?? '',
        read: () => (several ? chosen() : (chosen()[0] ?? '')),
        restore: (kept) => {
          const keys = typeof kept === 'string' ? [kept] : typeof kept === 'object' ? kept : [];
          for (const input of inputs) input.checked = keys.includes(input.value);
        },
      },
    };
  }

  /** A question as its kind and its way of showing choices have it built. */
  function question(
    field: EmbedField,
    shown: EmbedForm,
  ): { readonly node: HTMLElement; readonly row: Row } {
    if (field.type === 'rating')
      return group(
        field,
        RATINGS.map((rating) => ({ key: rating, label: rating })),
        false,
        'rating',
      );
    if (field.type === 'single_choice' && field.display === 'radio')
      return group(field, field.options, false, '');
    if (field.type === 'multi_choice' && field.display === 'checkboxes')
      return group(field, field.options, true, '');
    const input = control(field, shown);
    if (field.placeholder !== undefined && !(input instanceof HTMLSelectElement))
      input.placeholder = field.placeholder;
    if (field.type !== 'terms')
      return row(field.key, field.label, field.required, field.helpText, input);
    let link: HTMLAnchorElement | undefined;
    if (field.linkUrl !== undefined) {
      const words = field.linkLabel ?? '';
      link = el('a', '', words === '' ? text.termsLink : words);
      link.href = field.linkUrl;
      // A tab of its own, which cannot reach back into this page: what was typed stays.
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    return row(field.key, field.text ?? '', field.required, field.helpText, input, link);
  }

  function clearProblems(): void {
    notice.textContent = '';
    for (const each of [...rows.values(), ...boxes.values()]) {
      each.error.textContent = '';
      each.error.hidden = true;
      each.control.removeAttribute('aria-invalid');
      if (each.described === '') each.control.removeAttribute('aria-describedby');
      else each.control.setAttribute('aria-describedby', each.described);
    }
  }

  return {
    host,
    root,
    showLoading() {
      status.textContent = text.loading;
      show('status');
    },
    showUnavailable() {
      status.textContent = text.unavailable;
      show('status');
    },
    showForm(shown) {
      const before = new Map([...rows].map(([key, each]) => [key, each.read()] as const));
      title.textContent = shown.title;
      description.textContent = shown.description;
      submitLabel = shown.submitLabel;
      send.textContent = submitLabel;
      const nodes: HTMLElement[] = [];
      const next = new Map<string, Row>();
      for (const field of shown.fields) {
        // Not on the page: its answer comes from the page's address.
        if (field.type === 'hidden') continue;
        if (field.type === 'content') {
          const words = field.text ?? '';
          nodes.push(field.heading === true ? el('h3', '', words) : el('p', 'content', words));
          continue;
        }
        const made = question(field, shown);
        // What the visitor had answered stays, when the question is still of the same
        // kind. Not for a terms box: the words beside it may have changed, and agreeing is
        // to the words that are there.
        const kept = field.type === 'terms' ? undefined : before.get(field.key);
        if (kept !== undefined) made.row.restore(kept);
        nodes.push(made.node);
        next.set(field.key, made.row);
      }
      rows = next;
      boxes = new Map(
        shown.consents.map((consent: EmbedConsent) => {
          const input = el('input');
          input.type = 'checkbox';
          // Unticked until the visitor ticks it; nothing in the embed ever ticks it for them.
          // Not even their own earlier tick, when the form is shown again: the words beside
          // the box may have changed, and consent is to the words that are there.
          input.checked = false;
          const made = row(consent.key, consent.wording, consent.required, '', input);
          nodes.push(made.node);
          return [consent.key, made.row];
        }),
      );
      form.replaceChildren(...nodes, trapBox, check, notice, send);
      check.hidden = true;
      check.textContent = '';
      notice.textContent = '';
      show('form');
    },
    setBusy(busy) {
      send.disabled = busy;
      send.textContent = busy ? text.sending : submitLabel;
      if (busy) clearProblems();
    },
    showProblems(issues, words) {
      clearProblems();
      let first: HTMLElement | undefined;
      for (const issue of issues) {
        const found = (issue.on === 'consents' ? boxes : rows).get(issue.key);
        if (issue.on === 'form' || found === undefined) continue;
        found.error.textContent = issue.message;
        found.error.hidden = false;
        found.control.setAttribute('aria-invalid', 'true');
        found.control.setAttribute(
          'aria-describedby',
          found.described === '' ? found.error.id : `${found.described} ${found.error.id}`,
        );
        first ??= found.first;
      }
      // A problem with the form as a whole is said in its own words, above the button.
      notice.textContent = issues.find((issue) => issue.on === 'form')?.message ?? words;
      (first ?? send).focus();
    },
    showDone(message) {
      done.textContent = message;
      show('done');
      done.focus();
    },
    showPreview() {
      preview.hidden = false;
    },
    showCheck(state) {
      check.textContent =
        state === 'working'
          ? text.botChecking
          : state === 'done'
            ? text.botChecked
            : text.botFailed;
      check.hidden = false;
    },
    prefill(values) {
      for (const [key, value] of Object.entries(values)) {
        const row = rows.get(key);
        if (row?.read() === '') row.restore(value);
      }
    },
    read() {
      const values: Record<string, Value> = {};
      for (const [key, each] of rows) values[key] = each.read();
      const consents: Record<string, boolean> = {};
      for (const [key, each] of boxes) consents[key] = each.read() === true;
      return { values, consents, trap: trap.value };
    },
  };
}
