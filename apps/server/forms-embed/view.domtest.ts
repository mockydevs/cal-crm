// @vitest-environment jsdom
// The form embed on a real DOM (jsdom): what it adds to a page, that it shows every text as
// text, that it can be used with a keyboard and a screen reader, and what it sends. Part of
// the server's unit run (vitest.config.js includes it; the line above gives it its DOM).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BotProof,
  EmbedChallenge,
  EmbedForm,
  FormApi,
  Outcome,
  Submission,
} from '../src/forms-embed/api.js';
import { strings } from '../src/forms-embed/strings.js';
import { css } from '../src/forms-embed/styles.js';
import {
  boot,
  firstArrival,
  hiddenAnswers,
  install,
  pageUrl,
  referrerOrigin,
  run,
  type Surroundings,
} from './entry.js';
import { createView, type FormView } from './view.js';

const KEY = 'k'.repeat(32);
const TOKEN = `1790000000000.${'A'.repeat(43)}`;
const ATTACK = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script><b>bold</b>';
const shown: EmbedForm = {
  title: 'Plan your event',
  description: 'We answer within a day.',
  submitLabel: 'Send enquiry',
  successMessage: 'Thank you. We will be in touch.',
  fields: [
    {
      key: 'first_name',
      type: 'text',
      label: 'First name',
      helpText: '',
      required: false,
      options: [],
    },
    {
      key: 'email',
      type: 'email',
      label: 'Email',
      helpText: 'We reply here.',
      required: true,
      options: [],
    },
    { key: 'phone', type: 'phone', label: 'Phone', helpText: '', required: false, options: [] },
    { key: 'guests', type: 'number', label: 'Guests', helpText: '', required: false, options: [] },
    { key: 'day', type: 'date', label: 'Event date', helpText: '', required: false, options: [] },
    {
      key: 'venue',
      type: 'single_choice',
      label: 'Venue',
      helpText: '',
      required: false,
      options: [
        { key: 'harbor', label: 'Harbor room' },
        { key: 'garden', label: 'Garden' },
      ],
    },
    {
      key: 'notes',
      type: 'long_text',
      label: 'Anything else?',
      helpText: '',
      required: false,
      options: [],
    },
    {
      key: 'terms',
      type: 'checkbox',
      label: 'I accept the terms',
      helpText: '',
      required: true,
      options: [],
    },
  ],
  consents: [{ key: 'news', wording: 'Email me news and offers.', required: false }],
  renderToken: TOKEN,
  textLength: 500,
  longTextLength: 5000,
};

function mounted(form: EmbedForm = shown) {
  const onSubmit = vi.fn<() => void>();
  const view = createView(document, strings, onSubmit);
  if (view === undefined) throw new Error('No view.');
  document.body.append(view.host);
  view.showForm(form);
  return { view, onSubmit, ...tools(view) };
}
function tools(view: FormView) {
  const one = (selector: string): HTMLElement => {
    const found = view.root.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`Nothing matches ${selector}`);
    return found;
  };
  /** The control a visitor would find by this label, as a screen reader names it. */
  const labelled = (words: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
    for (const label of view.root.querySelectorAll('label')) {
      const name = label.querySelector('span')?.firstChild?.textContent ?? '';
      if (name !== words) continue;
      const control =
        label.htmlFor === ''
          ? label.querySelector('input')
          : view.root.getElementById(label.htmlFor);
      if (
        control instanceof HTMLInputElement ||
        control instanceof HTMLTextAreaElement ||
        control instanceof HTMLSelectElement
      )
        return control;
    }
    throw new Error(`No control is labelled ${words}`);
  };
  const type = (words: string, value: string): void => {
    labelled(words).value = value;
  };
  const tick = (words: string, checked = true): void => {
    const box = labelled(words);
    if (!(box instanceof HTMLInputElement)) throw new Error('Not a box.');
    box.checked = checked;
  };
  const send = (): void => {
    one('form').dispatchEvent(new Event('submit', { cancelable: true }));
  };
  return { one, labelled, type, tick, send };
}

beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});
afterEach(() => {
  expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
});

describe('what the form puts on the page', () => {
  it('is one element with a shadow root, and nothing in the page around it', () => {
    const { view } = mounted();
    expect(document.body.children).toHaveLength(1);
    expect(document.body.firstElementChild).toBe(view.host);
    expect(view.host.hasAttribute('data-crm-form-root')).toBe(true);
    expect(view.host.shadowRoot).toBe(view.root);
    // The page's own document holds none of the form: no label, no input, no style.
    expect(document.querySelectorAll('form, input, label, style, link')).toHaveLength(0);
    expect(view.host.getAttribute('style')).toBeNull();
    expect(view.host.className).toBe('');
  });

  it('styles itself without a style attribute anywhere, as a strict page policy needs', () => {
    const { view } = mounted();
    // One sheet, adopted or in an element, and no style attribute on anything.
    expect(view.root.adoptedStyleSheets.length + view.root.querySelectorAll('style').length).toBe(
      1,
    );
    expect(view.root.querySelectorAll('[style]')).toHaveLength(0);
    for (const element of view.root.querySelectorAll('*'))
      for (const attribute of element.attributes) expect(attribute.name).not.toMatch(/^on/);
  });

  it('adopts a constructed sheet where the browser has them, and adds no style element', () => {
    const replaceSync = vi.fn<(text: string) => void>();
    class Sheet {
      replaceSync = replaceSync;
    }
    vi.stubGlobal('CSSStyleSheet', Sheet);
    try {
      const view = createView(document, strings, vi.fn<() => void>());
      expect(replaceSync).toHaveBeenCalledExactlyOnceWith(css);
      expect(view?.root.adoptedStyleSheets).toHaveLength(1);
      expect(view?.root.querySelectorAll('style')).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to a style element where a sheet cannot be constructed', () => {
    vi.stubGlobal('CSSStyleSheet', undefined);
    try {
      const view = createView(document, strings, vi.fn<() => void>());
      const sheets = view?.root.querySelectorAll('style');
      expect(sheets).toHaveLength(1);
      expect(sheets?.[0]?.textContent).toBe(css);
      // Nothing was adopted: this DOM has the property only once a sheet is given to it.
      expect(view?.root.adoptedStyleSheets ?? []).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is not made where a shadow root cannot be', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow');
    if (original === undefined) throw new Error('No attachShadow to take away.');
    Reflect.deleteProperty(Element.prototype, 'attachShadow');
    try {
      expect(createView(document, strings, vi.fn<() => void>())).toBeUndefined();
    } finally {
      Object.defineProperty(Element.prototype, 'attachShadow', original);
    }
  });
});

describe('the questions', () => {
  it('each have a control of their kind, named by their label, in the order of the form', () => {
    const { view, labelled } = mounted();
    const kinds = shown.fields.map((field) => {
      const control = labelled(field.label);
      return control instanceof HTMLInputElement ? `input:${control.type}` : control.tagName;
    });
    expect(kinds).toEqual([
      'input:text',
      'input:email',
      'input:tel',
      'input:text',
      'input:date',
      'SELECT',
      'TEXTAREA',
      'input:checkbox',
    ]);
    const order = [...view.root.querySelectorAll('form input, form select, form textarea')].map(
      (control) => control.id,
    );
    expect(order.filter((id) => id !== '')).toEqual(
      [...shown.fields.map((field) => field.key), 'news'].map((key): unknown =>
        expect.stringMatching(new RegExp(`^crm-form-\\d+-${key}$`)),
      ),
    );
    expect(labelled('Email')).toMatchObject({
      autocomplete: 'email',
      required: true,
      maxLength: 500,
    });
    expect(labelled('Phone')).toMatchObject({ autocomplete: 'tel', required: false });
    expect(labelled('Guests')).toMatchObject({ inputMode: 'decimal' });
    expect(labelled('Anything else?')).toMatchObject({ maxLength: 5000 });
    const venue = labelled('Venue');
    expect(
      [...venue.querySelectorAll('option')].map((option) => [option.value, option.textContent]),
    ).toEqual([
      ['', strings.choose],
      ['harbor', 'Harbor room'],
      ['garden', 'Garden'],
    ]);
  });

  it('say which are required in words, and describe a control by its hint', () => {
    const { view, labelled } = mounted();
    const email = labelled('Email');
    expect(view.root.querySelector(`label[for="${email.id}"]`)?.textContent).toBe(
      `Email ${strings.required}`,
    );
    const hint = view.root.getElementById(email.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('We reply here.');
    expect(labelled('Phone').hasAttribute('aria-describedby')).toBe(false);
    expect(view.root.querySelector('section')?.getAttribute('aria-label')).toBe(strings.region);
    expect(view.root.querySelector('h2')?.textContent).toBe('Plan your event');
    expect(view.root.querySelector('.description')?.textContent).toBe('We answer within a day.');
    expect(view.root.querySelector<HTMLButtonElement>('button')?.textContent).toBe('Send enquiry');
    expect(view.root.querySelector<HTMLButtonElement>('button')?.type).toBe('submit');
  });

  it('leave a consent box unticked until the visitor ticks it', () => {
    const { labelled, view } = mounted();
    const box = labelled('Email me news and offers.');
    expect(box).toMatchObject({ type: 'checkbox', checked: false, required: false });
    expect(view.read().consents).toEqual({ news: false });
  });

  it('show every word as text, whatever it contains', () => {
    const hostile: EmbedForm = {
      ...shown,
      title: ATTACK,
      description: ATTACK,
      submitLabel: ATTACK,
      successMessage: ATTACK,
      fields: [
        { key: 'a', type: 'text', label: ATTACK, helpText: ATTACK, required: true, options: [] },
        {
          key: 'b',
          type: 'single_choice',
          label: 'Choice',
          helpText: '',
          required: false,
          options: [{ key: 'x', label: ATTACK }],
        },
      ],
      consents: [{ key: 'c', wording: ATTACK, required: false }],
    };
    const { view } = mounted(hostile);
    expect(view.root.querySelectorAll('img, script, b')).toHaveLength(0);
    expect(view.root.querySelector('h2')?.textContent).toBe(ATTACK);
    expect(view.root.querySelector('.hint')?.textContent).toBe(ATTACK);
    expect(view.root.querySelector('option[value="x"]')?.textContent).toBe(ATTACK);
    view.showProblems([{ on: 'values', key: 'a', message: ATTACK }], ATTACK);
    expect(view.root.querySelector('.error')?.textContent).toBe(ATTACK);
    expect(view.root.querySelector('.notice')?.textContent).toBe(ATTACK);
    view.showDone(ATTACK);
    expect(view.root.querySelector('.done')?.textContent).toBe(ATTACK);
    expect(view.root.querySelectorAll('img, script, b')).toHaveLength(0);
  });

  it('hide a field no person reaches, which a program that fills every field does', () => {
    const { view, one } = mounted();
    const trap = one('input[name="company_website"]');
    if (!(trap instanceof HTMLInputElement)) throw new Error('The hidden field is no input.');
    expect(trap.tabIndex).toBe(-1);
    expect(trap.autocomplete).toBe('off');
    expect(trap.closest('.trap')?.getAttribute('aria-hidden')).toBe('true');
    // Still a field of the form, and sent as it is.
    expect(trap.closest('form')).not.toBeNull();
    expect(view.read().trap).toBe('');
    trap.value = 'https://spam.example';
    expect(view.read().trap).toBe('https://spam.example');
  });
});

describe('what a visitor filled in', () => {
  it('is read as text, and a box as ticked or not', () => {
    const { view, type, tick } = mounted();
    type('First name', 'Maya');
    type('Email', 'maya@example.test');
    type('Venue', 'garden');
    type('Anything else?', 'Line one\nLine two');
    tick('I accept the terms');
    tick('Email me news and offers.');
    expect(view.read()).toEqual({
      values: {
        first_name: 'Maya',
        email: 'maya@example.test',
        phone: '',
        guests: '',
        day: '',
        venue: 'garden',
        notes: 'Line one\nLine two',
        terms: true,
      },
      consents: { news: true },
      trap: '',
    });
  });

  it('is kept when the form is shown again, for the questions that are still there', () => {
    const { view, type, tick, labelled } = mounted();
    type('Email', 'maya@example.test');
    type('Venue', 'garden');
    tick('I accept the terms');
    tick('Email me news and offers.');
    const [first, email, , , , venue, , terms] = shown.fields;
    if (first === undefined || email === undefined || venue === undefined || terms === undefined)
      throw new Error('The fixture has these questions.');
    view.showForm({
      ...shown,
      title: 'Plan your event with us',
      // One question gone, one new, one that is now a box, one whose choice was removed.
      fields: [
        email,
        { ...venue, options: [{ key: 'harbor', label: 'Harbor room' }] },
        terms,
        {
          key: 'budget',
          type: 'number',
          label: 'Budget',
          helpText: '',
          required: false,
          options: [],
        },
        { ...first, key: 'first_name', type: 'checkbox', label: 'First visit?' },
      ],
    });
    expect(view.root.querySelector('h2')?.textContent).toBe('Plan your event with us');
    expect(labelled('Email').value).toBe('maya@example.test');
    // The garden is no longer offered, so nothing is chosen.
    expect(labelled('Venue').value).toBe('');
    expect(view.read()).toEqual({
      values: { email: 'maya@example.test', venue: '', terms: true, budget: '', first_name: false },
      // A consent box is never ticked for the visitor, not even one they had ticked before
      // the wording may have changed.
      consents: { news: false },
      trap: '',
    });
  });
});

describe('problems', () => {
  it('are put by their question, announced, and take the focus to the first of them', () => {
    const { view, labelled } = mounted();
    view.showProblems(
      [
        { on: 'values', key: 'email', message: 'Enter an email address.' },
        { on: 'consents', key: 'news', message: 'Tick this box to continue.' },
        { on: 'values', key: 'gone', message: 'A question this form no longer has.' },
      ],
      strings.checkAnswers,
    );
    const email = labelled('Email');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    const described = (email.getAttribute('aria-describedby') ?? '').split(' ');
    // The hint first, then the problem: both are read with the field.
    expect(described.map((id) => view.root.getElementById(id)?.textContent)).toEqual([
      'We reply here.',
      'Enter an email address.',
    ]);
    const box = labelled('Email me news and offers.');
    expect(view.root.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Tick this box to continue.',
    );
    expect(view.root.querySelector('.notice')).toMatchObject({ textContent: strings.checkAnswers });
    expect(view.root.querySelector('.notice')?.getAttribute('role')).toBe('alert');
    expect(view.root.activeElement).toBe(email);
    expect([...view.root.querySelectorAll('.error:not([hidden])')]).toHaveLength(2);
  });

  it('are cleared when the form is sent again, and the hint describes the field once more', () => {
    const { view, labelled } = mounted();
    view.showProblems(
      [{ on: 'values', key: 'email', message: 'Enter an email address.' }],
      'Check.',
    );
    view.setBusy(true);
    const email = labelled('Email');
    expect(email.hasAttribute('aria-invalid')).toBe(false);
    expect(
      view.root.getElementById(email.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('We reply here.');
    expect([...view.root.querySelectorAll('.error:not([hidden])')]).toHaveLength(0);
    expect(view.root.querySelector('.notice')?.textContent).toBe('');
    view.showProblems([{ on: 'values', key: 'phone', message: 'Enter a phone number.' }], 'Check.');
    view.showProblems([], 'Check.');
    expect(labelled('Phone').hasAttribute('aria-describedby')).toBe(false);
  });

  it('about the form as a whole are said above the button, where the focus goes', () => {
    const { view } = mounted();
    view.showProblems([{ on: 'form', key: '', message: 'Check your details and try again.' }], 'x');
    expect(view.root.querySelector('.notice')?.textContent).toBe(
      'Check your details and try again.',
    );
    expect(view.root.activeElement).toBe(view.root.querySelector('button'));
  });
});

describe('the states', () => {
  it('say loading, then show the form, a busy button, and the thanks with the focus on it', () => {
    const onSubmit = vi.fn<() => void>();
    const view = createView(document, strings, onSubmit);
    if (view === undefined) throw new Error('No view.');
    document.body.append(view.host);
    const { one, send } = tools(view);
    view.showLoading();
    expect(one('.status')).toMatchObject({ hidden: false, textContent: strings.loading });
    expect(one('.status').getAttribute('role')).toBe('status');
    expect(one('form').hidden).toBe(true);
    // Nothing to show yet, so no empty heading for a screen reader to find.
    expect(one('h2').hidden).toBe(true);
    view.showForm(shown);
    expect(one('form').hidden).toBe(false);
    expect(one('.status').hidden).toBe(true);
    expect(one('h2').hidden).toBe(false);
    send();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    view.setBusy(true);
    expect(one('button')).toMatchObject({
      disabled: true,
      textContent: strings.sending,
    });
    view.setBusy(false);
    expect(one('button')).toMatchObject({
      disabled: false,
      textContent: 'Send enquiry',
    });
    view.showDone(shown.successMessage);
    expect(one('form').hidden).toBe(true);
    expect(one('.done')).toMatchObject({ hidden: false, textContent: shown.successMessage });
    expect(one('.done').getAttribute('role')).toBe('status');
    expect(view.root.activeElement).toBe(one('.done'));
    expect(one('.description').hidden).toBe(true);
    view.showUnavailable();
    expect(one('.status')).toMatchObject({ hidden: false, textContent: strings.unavailable });
    expect(one('.done').hidden).toBe(true);
  });

  it('leave out a heading and a description the form does not have', () => {
    const { one } = mounted({ ...shown, title: '', description: '' });
    expect(one('h2').hidden).toBe(true);
    expect(one('.description').hidden).toBe(true);
  });
});

/** An API stand-in whose answers a test chooses. */
function standIn(
  load: Outcome<EmbedForm>[],
  send: Outcome<null>[],
  challenges: Outcome<EmbedChallenge>[] = [],
) {
  const sent: Submission[] = [];
  const asked: string[] = [];
  const api: FormApi = {
    load: () => Promise.resolve(load.shift() ?? { ok: false, failure: 'unavailable' }),
    send: (submission) => {
      sent.push(submission);
      return Promise.resolve(send.shift() ?? { ok: false, failure: 'network' });
    },
    challenge: (renderToken) => {
      asked.push(renderToken);
      return Promise.resolve(challenges.shift() ?? { ok: false, failure: 'unavailable' });
    },
  };
  return { api, sent, asked };
}
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};
function running(
  load: Outcome<EmbedForm>[],
  send: Outcome<null>[],
  page?: string,
  around?: Surroundings,
  challenges?: Outcome<EmbedChallenge>[],
) {
  const { api, sent, asked } = standIn(load, send, challenges);
  const made: { submit?: () => void } = {};
  const view = createView(document, strings, () => made.submit?.());
  if (view === undefined) throw new Error('No view.');
  document.body.append(view.host);
  let ids = 0;
  made.submit = run(view, api, () => `id-${String((ids += 1))}`, page, around);
  return { view, sent, asked, ...tools(view) };
}
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });

describe('running a form', () => {
  it('says loading, shows the form, sends it once, and thanks the visitor', async () => {
    const r = running([ok(shown)], [ok(null)], 'https://www.example.com/contact?utm_source=x');
    expect(r.one('.status').textContent).toBe(strings.loading);
    await settle();
    r.type('Email', 'maya@example.test');
    r.tick('I accept the terms');
    r.tick('Email me news and offers.');
    r.send();
    // A second press while it is being sent does nothing.
    r.send();
    await settle();
    expect(r.sent).toEqual([
      {
        clientSubmissionId: 'id-1',
        renderToken: TOKEN,
        // A question left empty is left out; a box is always said.
        values: { email: 'maya@example.test', terms: true },
        consents: { news: true },
        trap: '',
        pageUrl: 'https://www.example.com/contact?utm_source=x',
      },
    ]);
    expect(r.one('.done')).toMatchObject({ hidden: false, textContent: shown.successMessage });
  });

  it('asks for what is required before sending anything', async () => {
    const r = running([ok(shown)], [ok(null)]);
    await settle();
    r.type('Email', '   ');
    r.send();
    await settle();
    expect(r.sent).toEqual([]);
    expect(
      [...r.view.root.querySelectorAll('.error:not([hidden])')].map((each) => each.textContent),
    ).toEqual([strings.answerNeeded, strings.tickNeeded]);
    expect(r.one('.notice').textContent).toBe(strings.checkAnswers);
    expect(r.view.root.activeElement).toBe(r.labelled('Email'));
    // A required consent box is asked for the same way.
    const strict = running(
      [
        ok({
          ...shown,
          fields: [],
          consents: [{ key: 'news', wording: 'Email me news.', required: true }],
        }),
      ],
      [],
    );
    await settle();
    strict.send();
    await settle();
    expect(strict.sent).toEqual([]);
    expect(strict.one('.error:not([hidden])').textContent).toBe(strings.tickNeeded);
  });

  it('shows what the CRM refused by its question, and sends again under the same id', async () => {
    const r = running(
      [ok(shown)],
      [
        {
          ok: false,
          failure: 'invalid',
          issues: [
            { on: 'values', key: 'phone', message: 'Enter a phone number, with its country code.' },
          ],
        },
        { ok: false, failure: 'invalid' },
        { ok: false, failure: 'limited', retryAfterSeconds: 2 },
        { ok: false, failure: 'network' },
        { ok: false, failure: 'unavailable' },
        ok(null),
      ],
    );
    await settle();
    r.type('Email', 'maya@example.test');
    r.type('Phone', '000');
    r.tick('I accept the terms');
    const notices: (string | null)[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      r.send();
      await settle();
      notices.push(r.one('.notice').textContent);
      expect(r.one('form').hidden).toBe(false);
      expect(r.one('button')).toHaveProperty('disabled', false);
      // What was typed is still there to be put right.
      expect(r.labelled('Email').value).toBe('maya@example.test');
    }
    expect(notices).toEqual([
      strings.checkAnswers,
      strings.refused,
      strings.slowDown,
      strings.offline,
      strings.unavailable,
    ]);
    r.send();
    await settle();
    expect(r.one('.done').hidden).toBe(false);
    // One filled-in form, one id, however many times it took.
    expect(new Set(r.sent.map((each) => each.clientSubmissionId))).toEqual(new Set(['id-1']));
    expect(r.sent).toHaveLength(6);
    expect(r.sent[0]).not.toHaveProperty('pageUrl');
  });

  it('loads a form that changed again, keeps the answers, and sends with the new proof', async () => {
    const newer = {
      ...shown,
      title: 'Plan your event with us',
      renderToken: `1790000009999.${'B'.repeat(43)}`,
    };
    const r = running([ok(shown), ok(newer)], [{ ok: false, failure: 'stale' }, ok(null)]);
    await settle();
    r.type('Email', 'maya@example.test');
    r.tick('I accept the terms');
    r.send();
    await settle();
    expect(r.one('h2').textContent).toBe('Plan your event with us');
    expect(r.one('.notice').textContent).toBe(strings.updated);
    expect(r.labelled('Email').value).toBe('maya@example.test');
    r.send();
    await settle();
    expect(r.sent.map((each) => [each.clientSubmissionId, each.renderToken])).toEqual([
      ['id-1', TOKEN],
      ['id-1', newer.renderToken],
    ]);
    expect(r.one('.done').hidden).toBe(false);
  });

  it('says the form is not available when it cannot be loaded, at first or again', async () => {
    const never = running([{ ok: false, failure: 'unavailable' }], []);
    await settle();
    expect(never.one('.status')).toMatchObject({ hidden: false, textContent: strings.unavailable });
    never.send();
    await settle();
    expect(never.sent).toEqual([]);
    const gone = running([ok(shown)], [{ ok: false, failure: 'stale' }]);
    await settle();
    gone.type('Email', 'maya@example.test');
    gone.tick('I accept the terms');
    gone.send();
    await settle();
    expect(gone.one('.status')).toMatchObject({ hidden: false, textContent: strings.unavailable });
    expect(gone.one('form').hidden).toBe(true);
  });
});

describe('the script tag', () => {
  const tag = (attributes: Record<string, string>, parent: Element = document.body) => {
    const script = document.createElement('script');
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    parent.append(script);
    return script;
  };
  const fetched: string[] = [];
  beforeEach(() => {
    fetched.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input) => {
        fetched.push(typeof input === 'string' ? input : 'not a string');
        return Promise.reject(new TypeError('offline'));
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts the form right after itself, and asks the CRM it was loaded from', async () => {
    const before = document.createElement('p');
    document.body.append(before);
    const script = tag({ src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY });
    const after = document.createElement('p');
    document.body.append(after);
    const view = boot(window, script);
    expect(view).toBeDefined();
    expect([...document.body.children]).toEqual([before, script, view?.host, after]);
    await settle();
    expect(fetched).toEqual([`https://crm.example.test/api/v1/public/forms/${KEY}`]);
    // Unreachable: a short notice where the form would be, and nothing thrown.
    expect(view?.root.querySelector('.status')?.textContent).toBe(strings.unavailable);
    // The same tag never makes a second form.
    expect(boot(window, script)).toBeUndefined();
    expect(document.querySelectorAll('[data-crm-form-root]')).toHaveLength(1);
    expect(Object.keys(window).filter((name) => /crm/i.test(name))).toEqual([]);
  });

  it('puts the form in the place the page marked for its key, wherever the script is', () => {
    const place = document.createElement('div');
    place.setAttribute('data-crm-form', KEY);
    const other = document.createElement('div');
    other.setAttribute('data-crm-form', 'z'.repeat(32));
    document.body.append(other, place);
    const script = tag(
      { src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY },
      document.head,
    );
    const view = boot(window, script);
    expect(place.firstElementChild).toBe(view?.host);
    expect(other.childElementCount).toBe(0);
    // A second tag for the same key finds the place taken, and has none of its own in the head.
    const again = tag(
      { src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY },
      document.head,
    );
    expect(boot(window, again)).toBeUndefined();
    // In the body it goes after itself.
    const third = tag({ src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY });
    expect(boot(window, third)?.host.previousElementSibling).toBe(third);
  });

  it.each([
    ['no key', { src: 'https://crm.example.test/forms/embed.js' }],
    [
      'a key that is not one',
      { src: 'https://crm.example.test/forms/embed.js', 'data-form-key': 'k k' },
    ],
    [
      'a key that is too short',
      { src: 'https://crm.example.test/forms/embed.js', 'data-form-key': 'short' },
    ],
    ['a script that is not from the web', { src: 'file:///tmp/embed.js', 'data-form-key': KEY }],
  ])('does nothing for %s', (_what, attributes) => {
    const script = tag(attributes);
    expect(boot(window, script)).toBeUndefined();
    expect(document.querySelectorAll('[data-crm-form-root]')).toHaveLength(0);
    expect(fetched).toEqual([]);
  });

  it('does nothing without a script tag, for one in the head with no place marked, or an SVG one', () => {
    expect(boot(window, null)).toBeUndefined();
    const inHead = tag(
      { src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY },
      document.head,
    );
    expect(boot(window, inHead)).toBeUndefined();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'script');
    svg.setAttribute('data-form-key', KEY);
    document.body.append(svg);
    expect(boot(window, svg)).toBeUndefined();
    expect(document.querySelectorAll('[data-crm-form-root]')).toHaveLength(0);
  });

  it('starts when the page is ready, and never lets a failure reach the page', () => {
    const script = tag({ src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY });
    install(window, script);
    expect(document.querySelectorAll('[data-crm-form-root]')).toHaveLength(1);
    // While the page is still loading it waits for it.
    const later = tag({ src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY });
    const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    install(window, later);
    expect(document.querySelectorAll('[data-crm-form-root]')).toHaveLength(1);
    state.mockRestore();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(document.querySelectorAll('[data-crm-form-root]')).toHaveLength(2);
    // Something in the page breaks what the form needs: no form, and nothing thrown.
    const broken = tag({ src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY });
    const create = vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('The page replaced createElement.');
    });
    expect(() => {
      install(window, broken);
    }).not.toThrow();
    create.mockRestore();
  });

  it('names the page without its fragment, drops a query too long to send, and no page that is not on the web', () => {
    const at = (search: string, pathname = '/contact', protocol = 'https:') =>
      pageUrl({ protocol, origin: 'https://www.example.com', pathname, search });
    expect(at('?utm_source=newsletter')).toBe(
      'https://www.example.com/contact?utm_source=newsletter',
    );
    expect(at('')).toBe('https://www.example.com/contact');
    expect(at(`?q=${'x'.repeat(2000)}`)).toBe('https://www.example.com/contact');
    expect(at('', `/${'p'.repeat(2000)}`)).toBeUndefined();
    expect(at('', '/C:/page.html', 'file:')).toBeUndefined();
    expect(at('', 'blank', 'about:')).toBeUndefined();
    expect(at('?a=1', '/', 'http:')).toBe('https://www.example.com/?a=1');
  });

  it('names the site a visitor came from by its origin alone, and not this same site', () => {
    const own = 'https://www.example.com';
    expect(referrerOrigin('https://www.google.com/search?q=venue+hire', own)).toBe(
      'https://www.google.com',
    );
    expect(referrerOrigin('http://partner.example:8080/a/b#c', own)).toBe(
      'http://partner.example:8080',
    );
    expect(referrerOrigin('https://www.example.com/pricing', own)).toBeUndefined();
    expect(referrerOrigin('', own)).toBeUndefined();
    expect(referrerOrigin('android-app://com.example/', own)).toBeUndefined();
    expect(referrerOrigin('not an address', own)).toBeUndefined();
  });

  it('sends the site the visitor came from with the form, when there is one', async () => {
    const r = running([ok(shown)], [ok(null)], 'https://www.example.com/contact', {
      referrer: 'https://www.google.com',
    });
    await settle();
    r.type('Email', 'maya@example.test');
    r.tick('I accept the terms');
    r.send();
    await settle();
    expect(r.sent[0]).toMatchObject({
      pageUrl: 'https://www.example.com/contact',
      referrer: 'https://www.google.com',
    });
  });

  it('makes an id for a submission where the browser has no randomUUID', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) => {
        calls.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(
          new Response(
            JSON.stringify(
              typeof input === 'string' && input.endsWith('/submissions')
                ? { status: 'received' }
                : { ...shown, fields: [] },
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }),
    );
    const original = Object.getOwnPropertyDescriptor(Crypto.prototype, 'randomUUID');
    Reflect.deleteProperty(Crypto.prototype, 'randomUUID');
    try {
      const script = tag({ src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY });
      const view = boot(window, script);
      if (view === undefined) throw new Error('No form.');
      await vi.waitFor(() => {
        expect(view.root.querySelector<HTMLFormElement>('form')?.hidden).toBe(false);
      });
      tools(view).send();
      await vi.waitFor(() => {
        expect(calls).toHaveLength(2);
      });
      const sent = JSON.parse(calls[1] ?? '{}') as {
        clientSubmissionId?: string;
        pageUrl?: string;
        referrer?: string;
      };
      // A version 4 UUID, made from the browser's random source.
      expect(sent.clientSubmissionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      // The page the form is on, as the test's browser names it.
      expect(sent.pageUrl).toBe(window.location.href);
      // The test's page was opened from nowhere: no site is named.
      expect(sent.referrer).toBeUndefined();
    } finally {
      if (original !== undefined) Object.defineProperty(Crypto.prototype, 'randomUUID', original);
    }
  });
});

// The kinds a form gained after the first eight: choices as buttons, several choices, a
// web address, a rating, a hidden question, a block of text and a terms box.
const wider: EmbedForm = {
  title: 'Tell us more',
  description: '',
  submitLabel: 'Send',
  successMessage: 'Thank you.',
  fields: [
    {
      key: 'email',
      type: 'email',
      label: 'Email',
      helpText: '',
      required: true,
      options: [],
      placeholder: 'you@example.com',
    },
    {
      key: 'about',
      type: 'content',
      label: '',
      helpText: '',
      required: false,
      options: [],
      text: 'About your event',
      heading: true,
    },
    {
      key: 'note',
      type: 'content',
      label: '',
      helpText: '',
      required: false,
      options: [],
      text: 'We answer\nwithin a day.',
    },
    {
      key: 'room',
      type: 'single_choice',
      label: 'Room',
      helpText: 'One of ours.',
      required: false,
      options: [
        { key: 'harbor', label: 'Harbor room' },
        { key: 'garden', label: 'Garden' },
      ],
      display: 'radio',
    },
    {
      key: 'interests',
      type: 'multi_choice',
      label: 'Interests',
      helpText: '',
      required: true,
      options: [
        { key: 'venue', label: 'Venue' },
        { key: 'food', label: 'Food' },
        { key: 'music', label: 'Music' },
      ],
      display: 'checkboxes',
    },
    {
      key: 'days',
      type: 'multi_choice',
      label: 'Days',
      helpText: '',
      required: false,
      options: [
        { key: 'sat', label: 'Saturday' },
        { key: 'sun', label: 'Sunday' },
      ],
      display: 'dropdown',
    },
    { key: 'site', type: 'url', label: 'Website', helpText: '', required: false, options: [] },
    {
      key: 'stars',
      type: 'rating',
      label: 'How was it?',
      helpText: '',
      required: false,
      options: [],
    },
    {
      key: 'campaign',
      type: 'hidden',
      label: 'Campaign',
      helpText: '',
      required: false,
      options: [],
      parameter: 'utm_campaign',
    },
    { key: 'fixed', type: 'hidden', label: 'Fixed', helpText: '', required: false, options: [] },
    {
      key: 'rules',
      type: 'terms',
      label: '',
      helpText: '',
      required: true,
      options: [],
      text: 'I accept the terms.',
      linkUrl: 'https://www.example.com/terms',
      linkLabel: 'Read them',
    },
    {
      key: 'age',
      type: 'terms',
      label: '',
      helpText: '',
      required: false,
      options: [],
      text: 'I am over 18.',
    },
  ],
  consents: [],
  renderToken: TOKEN,
  textLength: 500,
  longTextLength: 5000,
};

describe('the newer kinds of question', () => {
  const groupOf = (view: FormView, words: string): HTMLFieldSetElement => {
    for (const set of view.root.querySelectorAll('fieldset'))
      if (set.querySelector('legend span')?.firstChild?.textContent === words) return set;
    throw new Error(`No group is named ${words}`);
  };

  it('each have a control of their kind, and a hidden one is not on the page at all', () => {
    const { view, labelled, one } = mounted(wider);
    expect(labelled('Email')).toMatchObject({ type: 'email', placeholder: 'you@example.com' });
    expect(labelled('Website')).toMatchObject({ type: 'url', placeholder: '' });
    // One of several, as buttons: a group named by the question, each button by its choice.
    const room = groupOf(view, 'Room');
    expect([...room.querySelectorAll('input')].map((input) => [input.type, input.value])).toEqual([
      ['radio', 'harbor'],
      ['radio', 'garden'],
    ]);
    expect(new Set([...room.querySelectorAll('input')].map((input) => input.name)).size).toBe(1);
    expect(labelled('Harbor room')).toMatchObject({ type: 'radio', checked: false });
    expect(room.getAttribute('aria-describedby')).toBe(`${room.id}-hint`);
    expect(view.root.getElementById(`${room.id}-hint`)?.textContent).toBe('One of ours.');
    // Several of several: checkboxes, or a dropdown that takes several and offers no "Choose…".
    const interests = groupOf(view, 'Interests');
    expect([...interests.querySelectorAll('input')].map((input) => input.type)).toEqual([
      'checkbox',
      'checkbox',
      'checkbox',
    ]);
    expect(interests.querySelector('legend')?.textContent).toBe(`Interests ${strings.required}`);
    const days = labelled('Days');
    expect(days).toBeInstanceOf(HTMLSelectElement);
    expect(days).toMatchObject({ multiple: true });
    expect([...days.querySelectorAll('option')].map((option) => option.value)).toEqual([
      'sat',
      'sun',
    ]);
    // A rating: five buttons, one to five, of which one can be chosen.
    const stars = groupOf(view, 'How was it?');
    expect(stars.className).toBe('rating');
    expect([...stars.querySelectorAll('input')].map((input) => [input.type, input.value])).toEqual(
      ['1', '2', '3', '4', '5'].map((rating) => ['radio', rating]),
    );
    expect([...stars.querySelectorAll('label span')].map((span) => span.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    // A block of text is a heading or a paragraph, in its place among the questions.
    expect(one('h3').textContent).toBe('About your event');
    expect(one('p.content').textContent).toBe('We answer\nwithin a day.');
    const order = [...one('form').children].map(
      (node) => node.tagName + (node.className === '' ? '' : `.${node.className}`),
    );
    expect(order.slice(0, 4)).toEqual(['DIV.field', 'H3', 'P.content', 'DIV.field']);
    // Nothing of a hidden question is on the page: no control, no label, no name.
    expect(view.root.querySelectorAll('input[type=hidden]')).toHaveLength(0);
    expect(view.root.textContent).not.toContain('Campaign');
    expect(view.root.textContent).not.toContain('utm_campaign');
    expect(view.root.querySelectorAll('.field')).toHaveLength(8);
  });

  it('show a terms box as a box with its wording and a link that opens apart from the page', () => {
    const { labelled, view } = mounted(wider);
    const rules = labelled('I accept the terms.');
    expect(rules).toMatchObject({ type: 'checkbox', checked: false, required: true });
    const link = rules.closest('label')?.querySelector('a');
    expect(link).toMatchObject({
      textContent: 'Read them',
      href: 'https://www.example.com/terms',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    // One without a link has none, and one whose link has no words gets the embed's own.
    expect(labelled('I am over 18.').closest('label')?.querySelector('a')).toBeNull();
    expect(view.root.querySelectorAll('a')).toHaveLength(1);
    const bare = mounted({
      ...wider,
      fields: wider.fields.map((field) =>
        field.key === 'rules'
          ? { ...field, linkLabel: '', linkUrl: 'https://www.example.com/terms' }
          : field,
      ),
    });
    expect(bare.one('a').textContent).toBe(strings.termsLink);
  });

  it('show every word of them as text, whatever it contains', () => {
    const { view, one } = mounted({
      ...wider,
      fields: wider.fields.map((field) => ({
        ...field,
        ...(field.label === '' ? {} : { label: ATTACK }),
        ...(field.text === undefined ? {} : { text: ATTACK }),
        ...(field.linkLabel === undefined ? {} : { linkLabel: ATTACK }),
        ...(field.placeholder === undefined ? {} : { placeholder: ATTACK }),
        options: field.options.map((option) => ({ ...option, label: ATTACK })),
      })),
    });
    expect(view.root.querySelectorAll('img, script, b, iframe')).toHaveLength(0);
    expect(one('h3').textContent).toBe(ATTACK);
    expect(one('p.content').textContent).toBe(ATTACK);
    expect(one('a').textContent).toBe(ATTACK);
    expect(one('legend span').firstChild?.textContent).toBe(ATTACK);
    expect(one('input[type=email]').getAttribute('placeholder')).toBe(ATTACK);
    for (const node of view.root.querySelectorAll('*'))
      for (const attribute of node.getAttributeNames())
        expect(attribute.startsWith('on'), attribute).toBe(false);
  });

  it('are read as text, as a tick, or as the keys of what was chosen', () => {
    const { view, type, tick } = mounted(wider);
    type('Email', 'maya@example.test');
    tick('Garden');
    tick('Venue');
    tick('Music');
    tick('4');
    tick('I accept the terms.');
    type('Website', 'www.example.com');
    const days = view.root.querySelector<HTMLSelectElement>('select[multiple]');
    for (const option of days?.options ?? []) option.selected = true;
    expect(view.read()).toEqual({
      values: {
        email: 'maya@example.test',
        room: 'garden',
        interests: ['venue', 'music'],
        days: ['sat', 'sun'],
        site: 'www.example.com',
        stars: '4',
        rules: true,
        age: false,
      },
      consents: {},
      trap: '',
    });
    // Nothing chosen is nothing: an empty text for one of several, an empty list for several.
    const empty = mounted(wider).view.read().values;
    expect(empty).toMatchObject({ room: '', interests: [], days: [], stars: '' });
    // Neither a hidden question nor a block of text is the page's to answer.
    for (const key of ['campaign', 'fixed', 'about', 'note']) expect(empty).not.toHaveProperty(key);
  });

  it('keep what was chosen when the form is shown again, but never a tick beside the terms', () => {
    const { view, tick, labelled } = mounted(wider);
    tick('Garden');
    tick('Food');
    tick('5');
    tick('I accept the terms.');
    const days = view.root.querySelector<HTMLSelectElement>('select[multiple]');
    const [, sunday] = days?.options ?? [];
    if (sunday !== undefined) sunday.selected = true;
    view.showForm({
      ...wider,
      fields: wider.fields.map((field) =>
        field.key === 'rules' ? { ...field, text: 'I accept the new terms.' } : field,
      ),
    });
    expect(view.read().values).toMatchObject({
      room: 'garden',
      interests: ['food'],
      days: ['sun'],
      stars: '5',
      // Agreeing is to the words that are there, and they changed.
      rules: false,
    });
    expect(labelled('I accept the new terms.')).toMatchObject({ checked: false });
    // A question that became another kind keeps nothing that kind cannot hold.
    view.showForm({
      ...wider,
      fields: wider.fields.map((field) => {
        if (field.key !== 'interests') return field;
        const { display: _display, ...rest } = field;
        return { ...rest, type: 'text' as const, options: [] };
      }),
    });
    expect(view.read().values['interests']).toBe('');
  });

  it('mark the whole group when its answer has a problem, and take the focus to its first button', () => {
    const { view } = mounted(wider);
    view.showProblems(
      [
        { on: 'values', key: 'interests', message: 'Answer this question.' },
        { on: 'values', key: 'rules', message: 'Tick this box to continue.' },
      ],
      strings.checkAnswers,
    );
    const interests = groupOf(view, 'Interests');
    expect(interests.getAttribute('aria-invalid')).toBe('true');
    expect(interests.getAttribute('aria-describedby')).toBe(`${interests.id}-error`);
    expect(view.root.getElementById(`${interests.id}-error`)).toMatchObject({
      hidden: false,
      textContent: 'Answer this question.',
    });
    expect(view.root.activeElement).toBe(interests.querySelector('input'));
    view.setBusy(true);
    expect(interests.hasAttribute('aria-invalid')).toBe(false);
    expect(interests.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('running a form of the newer kinds', () => {
  function around(
    load: Outcome<EmbedForm>[],
    send: Outcome<null>[],
    surroundings: Surroundings = {},
  ) {
    const { api, sent } = standIn(load, send);
    const made: { submit?: () => void } = {};
    const view = createView(document, strings, () => made.submit?.());
    if (view === undefined) throw new Error('No view.');
    document.body.append(view.host);
    const went: string[] = [];
    made.submit = run(view, api, () => 'id-1', 'https://www.example.com/contact', {
      navigate: (url) => {
        went.push(url);
      },
      ...surroundings,
    });
    return { view, sent, went, ...tools(view) };
  }
  const fill = (r: ReturnType<typeof around>): void => {
    r.type('Email', 'maya@example.test');
    r.tick('Venue');
    r.tick('I accept the terms.');
  };

  it('reads a hidden answer from the query of the page, by the name the form gives, and nothing else of it', () => {
    expect(
      hiddenAnswers(wider, '?utm_campaign=Spring%20open%20day&utm_source=mail&email=x@y.test'),
    ).toEqual({ campaign: 'Spring open day' });
    // The first of a name given twice; one that is empty, missing or too long is left out,
    // and so is a hidden question that names no part of the address.
    expect(hiddenAnswers(wider, '?utm_campaign=first&utm_campaign=second')).toEqual({
      campaign: 'first',
    });
    for (const search of [
      '',
      '?',
      '?utm_campaign=',
      '?utm_campaign=%20%20',
      '?UTM_CAMPAIGN=upper',
      '?fixed=sneaked',
      `?utm_campaign=${'x'.repeat(501)}`,
    ])
      expect(hiddenAnswers(wider, search), search).toEqual({});
    expect(hiddenAnswers(wider, `?utm_campaign=${'x'.repeat(500)}`)).toEqual({
      campaign: 'x'.repeat(500),
    });
    // Markup in an address is text in an answer.
    expect(hiddenAnswers(wider, `?utm_campaign=${encodeURIComponent(ATTACK)}`)).toEqual({
      campaign: ATTACK,
    });
  });

  it('sends the hidden answer with the rest, and leaves out what was not answered', async () => {
    const r = around([ok(wider)], [ok(null)], { search: '?utm_campaign=Spring&ref=partner' });
    await settle();
    fill(r);
    r.send();
    await settle();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.values).toEqual({
      campaign: 'Spring',
      email: 'maya@example.test',
      interests: ['venue'],
      rules: true,
      age: false,
    });
    expect(r.one('.done').textContent).toBe('Thank you.');
    expect(r.went).toEqual([]);
  });

  it('asks for a required choice of several and a required terms box before sending', async () => {
    const r = around([ok(wider)], []);
    await settle();
    r.type('Email', 'maya@example.test');
    r.send();
    await settle();
    expect(r.sent).toEqual([]);
    const said = [...r.view.root.querySelectorAll<HTMLElement>('.error')]
      .filter((error) => !error.hidden)
      .map((error) => error.textContent);
    expect(said).toEqual([strings.answerNeeded, strings.tickNeeded]);
    expect(r.one('.notice').textContent).toBe(strings.checkAnswers);
  });

  it('sends the visitor on to the address the form names, once it was received', async () => {
    const onward = { ...wider, redirectUrl: 'https://www.example.com/thanks' };
    const r = around([ok(onward)], [{ ok: false, failure: 'network' }, ok(null)]);
    await settle();
    fill(r);
    r.send();
    await settle();
    // Not sent, so nobody is sent on.
    expect(r.went).toEqual([]);
    r.send();
    await settle();
    expect(r.went).toEqual(['https://www.example.com/thanks']);
    // Something to read while the next page loads, and if the browser does not go.
    expect(r.one('.done')).toMatchObject({ hidden: false, textContent: 'Thank you.' });
  });

  it('shows the message where the page gives it no way to send anyone on', async () => {
    const { api } = standIn(
      [ok({ ...wider, redirectUrl: 'https://www.example.com/thanks' })],
      [ok(null)],
    );
    const made: { submit?: () => void } = {};
    const view = createView(document, strings, () => made.submit?.());
    if (view === undefined) throw new Error('No view.');
    document.body.append(view.host);
    made.submit = run(view, api, () => 'id-1', undefined);
    const t = tools(view);
    await settle();
    t.type('Email', 'maya@example.test');
    t.tick('Venue');
    t.tick('I accept the terms.');
    t.send();
    await settle();
    expect(t.one('.done')).toMatchObject({ hidden: false, textContent: 'Thank you.' });
  });

  it('says a preview is one, saves nothing, and names where the published form would send people', async () => {
    const plain = around([ok(wider)], [ok(null)]);
    await settle();
    expect(plain.one('.preview').hidden).toBe(true);

    const onward = { ...wider, redirectUrl: 'https://www.example.com/thanks' };
    const r = around([ok(onward)], [ok(null)], { preview: true });
    expect(r.one('.preview')).toMatchObject({ hidden: false, textContent: strings.preview });
    await settle();
    fill(r);
    r.send();
    await settle();
    expect(r.went).toEqual([]);
    expect(r.one('.done').textContent).toBe(
      `${strings.previewRedirect} https://www.example.com/thanks`,
    );
    // The note stays while the thanks are shown.
    expect(r.one('.preview').hidden).toBe(false);
    // Without anywhere to be sent, a preview thanks the visitor as the form would.
    const stay = around([ok(wider)], [ok(null)], { preview: true });
    await settle();
    fill(stay);
    stay.send();
    await settle();
    expect(stay.one('.done').textContent).toBe('Thank you.');
  });

  it('tells the page the title of the form it loaded, when the page asks to be told', async () => {
    const titles: string[] = [];
    around([ok(wider)], [], { onTitle: (title) => titles.push(title) });
    around([ok({ ...wider, title: '' })], [], { onTitle: (title) => titles.push(title) });
    await settle();
    expect(titles).toEqual(['Tell us more']);
  });
});

describe('the script tag on the CRM’s own pages', () => {
  const PREVIEW = `${'P'.repeat(70)}.${'S'.repeat(22)}`;
  const tag = (attributes: Record<string, string>) => {
    const script = document.createElement('script');
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    document.body.append(script);
    return script;
  };
  const asked: { url: string; headers: Record<string, string> }[] = [];
  beforeEach(() => {
    asked.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) => {
        asked.push({
          url: typeof input === 'string' ? input : 'not a string',
          headers: { ...(init?.headers as Record<string, string> | undefined) },
        });
        return Promise.resolve(
          new Response(JSON.stringify(wider), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('data-crm-form-page');
    document.title = '';
  });
  const own = `${window.location.origin}/forms/embed.js`;

  it('says so with a header of its own, since a browser sends no Origin to the page’s own address', async () => {
    document.documentElement.setAttribute('data-crm-form-page', '');
    const view = boot(window, tag({ src: own, 'data-form-key': KEY }));
    if (view === undefined) throw new Error('No form.');
    await vi.waitFor(() => {
      expect(view.root.querySelector<HTMLFormElement>('form')?.hidden).toBe(false);
    });
    expect(asked).toEqual([
      {
        url: `${window.location.origin}/api/v1/public/forms/${KEY}`,
        headers: { accept: 'application/json', 'x-crm-form': '1' },
      },
    ]);
    // The CRM's page for a form is named after it.
    expect(document.title).toBe('Tell us more');
    expect(view.root.querySelector<HTMLElement>('.preview')?.hidden).toBe(true);
  });

  it('never sends that header from a website, and never renames a website’s tab', async () => {
    document.documentElement.setAttribute('data-crm-form-page', '');
    const view = boot(
      window,
      tag({ src: 'https://crm.example.test/forms/embed.js', 'data-form-key': KEY }),
    );
    if (view === undefined) throw new Error('No form.');
    await vi.waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    expect(asked[0]).toEqual({
      url: `https://crm.example.test/api/v1/public/forms/${KEY}`,
      headers: { accept: 'application/json' },
    });
    await settle();
    expect(document.title).toBe('');
    // A page of the CRM's address that is not its page for a form keeps its own name too.
    document.documentElement.removeAttribute('data-crm-form-page');
    const other = boot(window, tag({ src: own, 'data-form-key': KEY }));
    await vi.waitFor(() => {
      expect(other?.root.querySelector<HTMLFormElement>('form')?.hidden).toBe(false);
    });
    expect(document.title).toBe('');
  });

  it('shows a draft by its preview link, on the CRM’s own address only', async () => {
    const view = boot(window, tag({ src: own, 'data-form-preview': PREVIEW }));
    if (view === undefined) throw new Error('No form.');
    await vi.waitFor(() => {
      expect(view.root.querySelector<HTMLFormElement>('form')?.hidden).toBe(false);
    });
    expect(asked).toEqual([
      {
        url: `${window.location.origin}/api/v1/public/forms/preview/${PREVIEW}`,
        headers: { accept: 'application/json', 'x-crm-form': '1' },
      },
    ]);
    expect(view.root.querySelector<HTMLElement>('.preview')).toMatchObject({
      hidden: false,
      textContent: strings.preview,
    });
    // A website cannot show a draft, whatever link it holds; and what is not the shape of
    // a link is no link, and no key either.
    expect(
      boot(
        window,
        tag({ src: 'https://crm.example.test/forms/embed.js', 'data-form-preview': PREVIEW }),
      ),
    ).toBeUndefined();
    for (const bad of ['short', `${PREVIEW}x`, KEY])
      expect(boot(window, tag({ src: own, 'data-form-preview': bad }))).toBeUndefined();
    expect(asked).toHaveLength(1);
  });
});

// How a visit began, handed to the embed by the page it is on: on its own script tag by the
// CRM's page script, or in the address of the CRM's own form page.
describe('how the visit began', () => {
  const LANDING = 'https://www.example.com/s/site/offer?utm_source=google&gclid=abc';
  const element = (attributes: Record<string, string>): Element => {
    const script = document.createElement('script');
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    return script;
  };

  it('is read from the script’s own tag: the page, the origin before it, the moment', () => {
    expect(
      firstArrival(
        element({
          'data-arr': LANDING,
          'data-arr-ref': 'https://www.google.com/search?q=venue',
          'data-arr-at': '1791882000000',
        }),
      ),
    ).toEqual({ pageUrl: LANDING, referrer: 'https://www.google.com', at: 1_791_882_000_000 });
    // No site before it, and no moment: only the page.
    expect(firstArrival(element({ 'data-arr': LANDING, 'data-arr-ref': '' }))).toEqual({
      pageUrl: LANDING,
    });
    expect(firstArrival(element({}))).toBeUndefined();
  });

  it('is read from the address only when it is given one, and the tag comes first', () => {
    const search = `?plan=gold&arr=${encodeURIComponent(LANDING)}&arr_ref=${encodeURIComponent('https://l.facebook.com')}&arr_at=1791882000000`;
    expect(firstArrival(element({}), search)).toEqual({
      pageUrl: LANDING,
      referrer: 'https://l.facebook.com',
      at: 1_791_882_000_000,
    });
    expect(firstArrival(element({}), '?plan=gold')).toBeUndefined();
    expect(
      firstArrival(element({ 'data-arr': 'https://www.example.com/first' }), search)?.pageUrl,
    ).toBe('https://www.example.com/first');
  });

  it('passes on nothing the CRM would refuse, so a form can always be sent', () => {
    for (const bad of [
      '',
      'not an address',
      'javascript:alert(1)',
      'ftp://www.example.com/a',
      `https://www.example.com/${'a'.repeat(2000)}`,
    ])
      expect(firstArrival(element({ 'data-arr': bad })), bad).toBeUndefined();
    for (const at of ['', 'soon', '-5', '1.5', '1e400', '0'])
      expect(firstArrival(element({ 'data-arr': LANDING, 'data-arr-at': at })), at).toEqual({
        pageUrl: LANDING,
      });
    expect(
      firstArrival(element({ 'data-arr': LANDING, 'data-arr-ref': 'android-app://x' })),
    ).toEqual({ pageUrl: LANDING });
  });

  it('is sent beside the page’s own address, and the same again on another try', async () => {
    const first = { pageUrl: LANDING, referrer: 'https://www.google.com', at: 1_791_882_000_000 };
    const r = running(
      [ok(shown)],
      [{ ok: false, failure: 'limited' }, ok(null)],
      'https://www.example.com/s/site/details',
      { first: () => first },
    );
    await settle();
    r.type('Email', 'maya@example.test');
    r.tick('I accept the terms');
    r.send();
    await settle();
    r.send();
    await settle();
    expect(r.sent).toHaveLength(2);
    for (const sent of r.sent)
      expect(sent).toMatchObject({
        clientSubmissionId: 'id-1',
        pageUrl: 'https://www.example.com/s/site/details',
        first,
      });
    // With none handed over, nothing is said of it.
    const plain = running([ok(shown)], [ok(null)], 'https://www.example.com/contact', {
      first: () => undefined,
    });
    await settle();
    plain.type('Email', 'maya@example.test');
    plain.tick('I accept the terms');
    plain.send();
    await settle();
    expect(plain.sent[0]).not.toHaveProperty('first');
  });

  describe('from a script tag on a page', () => {
    const bodies: string[] = [];
    beforeEach(() => {
      bodies.length = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>((input, init) => {
          if (typeof init?.body === 'string') bodies.push(init.body);
          return Promise.resolve(
            new Response(
              JSON.stringify(
                typeof input === 'string' && input.endsWith('/submissions')
                  ? { status: 'received' }
                  : { ...shown, fields: [] },
              ),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }),
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      document.documentElement.removeAttribute('data-crm-form-page');
      window.history.replaceState(null, '', '/');
    });
    const sentFrom = async (script: HTMLScriptElement, before?: () => void) => {
      document.body.append(script);
      const view = boot(window, script);
      if (view === undefined) throw new Error('No form.');
      await vi.waitFor(() => {
        expect(view.root.querySelector<HTMLFormElement>('form')?.hidden).toBe(false);
      });
      before?.();
      tools(view).send();
      await vi.waitFor(() => {
        expect(bodies).toHaveLength(1);
      });
      return JSON.parse(bodies[0] ?? '{}') as { first?: unknown };
    };
    const scriptTag = (src: string): HTMLScriptElement => {
      const script = document.createElement('script');
      script.setAttribute('src', src);
      script.setAttribute('data-form-key', KEY);
      return script;
    };

    it('reads what the page’s script wrote on the tag, even after the form was shown', async () => {
      const script = scriptTag('https://crm.example.test/forms/embed.js');
      const sent = await sentFrom(script, () => {
        // The page's script ran after the embed did: the tag is read when the form is sent.
        script.setAttribute('data-arr', LANDING);
        script.setAttribute('data-arr-ref', 'https://www.google.com');
        script.setAttribute('data-arr-at', '1791882000000');
      });
      expect(sent.first).toEqual({
        pageUrl: LANDING,
        referrer: 'https://www.google.com',
        at: 1_791_882_000_000,
      });
    });

    it('reads the address on the CRM’s own page for a form, and on no other page', async () => {
      const search = `?arr=${encodeURIComponent(LANDING)}&arr_at=1791882000000`;
      window.history.replaceState(null, '', `/f/${KEY}${search}`);
      // A website's own address is the website's: nothing is read from it.
      const elsewhere = await sentFrom(scriptTag('https://crm.example.test/forms/embed.js'));
      expect(elsewhere.first).toBeUndefined();
      bodies.length = 0;
      document.documentElement.setAttribute('data-crm-form-page', '');
      const own = await sentFrom(scriptTag(`${window.location.origin}/forms/embed.js`));
      expect(own.first).toEqual({ pageUrl: LANDING, at: 1_791_882_000_000 });
    });
  });
});

describe('a form that asks for bot protection', () => {
  const guarded: EmbedForm = { ...shown, botProtection: 'altcha' };
  const challenge = (expiresAt = Math.floor(Date.now() / 1000) + 3600): EmbedChallenge => ({
    parameters: {
      algorithm: 'PBKDF2/SHA-256',
      nonce: 'ab'.repeat(16),
      salt: 'cd'.repeat(16),
      cost: 1000,
      keyLength: 32,
      keyPrefix: 'ef'.repeat(16),
      expiresAt,
      data: { render: TOKEN.slice(14) },
    },
    signature: '02'.repeat(32),
  });
  const proofOf = (given: EmbedChallenge): BotProof => ({
    kind: 'altcha',
    challenge: given,
    solution: { counter: 7, derivedKey: 'ef'.repeat(32) },
  });
  const fill = (r: ReturnType<typeof running>): void => {
    r.type('Email', 'maya@example.test');
    r.tick('I accept the terms');
  };

  it('solves the challenge for its showing while the visitor types, says so politely, and sends the proof', async () => {
    const given = challenge();
    const solve = vi.fn<NonNullable<Surroundings['solve']>>().mockResolvedValue(proofOf(given));
    const r = running([ok(guarded)], [ok(null)], undefined, { solve }, [ok(given)]);
    await settle();
    expect(r.asked).toEqual([TOKEN]);
    expect(solve).toHaveBeenCalledExactlyOnceWith(given);
    // A status, not an alert: nothing to see or do, and nothing that interrupts.
    expect(r.one('.botcheck')).toMatchObject({ hidden: false, textContent: strings.botChecked });
    expect(r.one('.botcheck').getAttribute('role')).toBe('status');
    fill(r);
    r.send();
    await settle();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.botProof).toEqual(proofOf(given));
  });

  it('says the check is working until it finishes', async () => {
    let finish: (proof: BotProof | undefined) => void = () => undefined;
    const solve = vi.fn<NonNullable<Surroundings['solve']>>().mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const r = running([ok(guarded)], [ok(null)], undefined, { solve }, [ok(challenge())]);
    await settle();
    expect(r.one('.botcheck').textContent).toBe(strings.botChecking);
    finish(undefined);
    await settle();
    expect(r.one('.botcheck').textContent).toBe(strings.botFailed);
  });

  it('sends nothing when the check did not finish, says so, and tries again', async () => {
    const given = challenge();
    const solve = vi
      .fn<NonNullable<Surroundings['solve']>>()
      .mockImplementation((challenged) => Promise.resolve(proofOf(challenged)));
    const r = running([ok(guarded)], [ok(null)], undefined, { solve }, [
      { ok: false, failure: 'network' },
      ok(given),
    ]);
    await settle();
    fill(r);
    r.send();
    await settle();
    expect(r.sent).toEqual([]);
    expect(r.one('.notice').textContent).toBe(strings.botFailed);
    // The next press sends, with the proof of the new attempt.
    r.send();
    await settle();
    expect(r.asked).toEqual([TOKEN, TOKEN]);
    expect(r.sent[0]?.botProof).toEqual(proofOf(given));
  });

  it('solves again a challenge about to expire before sending', async () => {
    const old = challenge(Math.floor(Date.now() / 1000) + 10);
    const fresh = challenge();
    const solve = vi
      .fn<NonNullable<Surroundings['solve']>>()
      .mockImplementation((given) => Promise.resolve(proofOf(given)));
    const r = running([ok(guarded)], [ok(null)], undefined, { solve }, [ok(old), ok(fresh)]);
    await settle();
    fill(r);
    r.send();
    await settle();
    expect(r.sent[0]?.botProof).toEqual(proofOf(fresh));
  });

  it('shows the form again with a new check when the proof is refused as stale', async () => {
    const first = challenge();
    const second = challenge();
    const solve = vi
      .fn<NonNullable<Surroundings['solve']>>()
      .mockImplementation((given) => Promise.resolve(proofOf(given)));
    const r = running(
      [ok(guarded), ok(guarded)],
      [{ ok: false, failure: 'stale' }, ok(null)],
      undefined,
      { solve },
      [ok(first), ok(second)],
    );
    await settle();
    fill(r);
    r.send();
    await settle();
    expect(r.asked).toHaveLength(2);
    expect(r.one('.notice').textContent).toBe(strings.updated);
  });

  it('asks for nothing on a form without it', async () => {
    const solve = vi.fn<NonNullable<Surroundings['solve']>>();
    const r = running([ok(shown)], [ok(null)], undefined, { solve });
    await settle();
    expect(r.asked).toEqual([]);
    expect(r.one('.botcheck').hidden).toBe(true);
    fill(r);
    r.send();
    await settle();
    expect(r.sent[0]).not.toHaveProperty('botProof');
    expect(solve).not.toHaveBeenCalled();
  });
});
