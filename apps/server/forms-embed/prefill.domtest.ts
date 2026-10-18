// @vitest-environment jsdom
// A visible question's query key: the embed fills the
// control from the page's address when the form is shown, the visitor may change it, and
// what is sent is what the control holds.
import { afterEach, describe, expect, it } from 'vitest';

import type { EmbedForm, FormApi, Submission } from '../src/forms-embed/api.js';
import { strings } from '../src/forms-embed/strings.js';
import { prefillAnswers, run } from './entry.js';
import { createView } from './view.js';

const field = (key: string, type: EmbedForm['fields'][number]['type'], parameter?: string) => ({
  key,
  type,
  label: key,
  helpText: '',
  required: false,
  options:
    type === 'single_choice'
      ? [
          { key: 'harbor', label: 'Harbor room' },
          { key: 'garden', label: 'Garden' },
        ]
      : [],
  ...(parameter === undefined ? {} : { parameter }),
});

const form: EmbedForm = {
  title: 'Enquiry',
  description: '',
  submitLabel: 'Send',
  successMessage: 'Thank you.',
  fields: [
    field('first_name', 'text', 'full_name'),
    field('email', 'email', 'email'),
    field('guests', 'number', 'guests'),
    field('day', 'date', 'day'),
    field('venue', 'single_choice', 'venue'),
    field('notes', 'long_text'),
    field('campaign', 'hidden', 'utm_campaign'),
  ],
  consents: [],
  renderToken: 'token',
  textLength: 500,
  longTextLength: 5000,
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('a visible question’s query key', () => {
  it('reads the page’s address for the visible questions that name a parameter, and not the hidden ones', () => {
    expect(
      prefillAnswers(
        form,
        '?full_name=Maya%20Lopez&email=maya@example.test&guests=40&venue=garden&utm_campaign=spring&notes=x',
      ),
    ).toEqual({
      first_name: 'Maya Lopez',
      email: 'maya@example.test',
      guests: '40',
      venue: 'garden',
    });
    for (const search of ['', '?', '?full_name=', '?FULL_NAME=x', `?full_name=${'x'.repeat(501)}`])
      expect(prefillAnswers(form, search), search).toEqual({});
  });

  it('fills the controls when the form is shown, keeps what the visitor then types, and sends what the controls hold', async () => {
    const sent: Submission[] = [];
    const api: FormApi = {
      load: () => Promise.resolve({ ok: true, value: form }),
      send: (body) => {
        sent.push(body);
        return Promise.resolve({ ok: true, value: null });
      },
      challenge: () => Promise.resolve({ ok: false, failure: 'unavailable' }),
    };
    const made: { submit?: () => void } = {};
    const view = createView(document, strings, () => made.submit?.());
    if (view === undefined) throw new Error('No view.');
    document.body.append(view.host);
    made.submit = run(view, api, () => 'id-1', 'https://www.example.com/contact', {
      search:
        '?full_name=Maya&email=maya@example.test&venue=garden&day=not-a-date&utm_campaign=spring',
    });
    await settle();
    expect(view.read().values).toMatchObject({
      first_name: 'Maya',
      email: 'maya@example.test',
      venue: 'garden',
      // A date control takes only a date: anything else leaves it empty.
      day: '',
      notes: '',
    });
    // The visitor changes one answer; a form shown again keeps it, and fills nothing over it.
    view.prefill({ first_name: 'Someone else', notes: 'Filled later' });
    expect(view.read().values).toMatchObject({ first_name: 'Maya', notes: 'Filled later' });
    // A choice the form does not have is not chosen, and a question that is gone is skipped.
    view.prefill({ venue: 'rooftop', gone: 'x' });
    expect(view.read().values['venue']).toBe('garden');
    made.submit();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.values).toEqual({
      campaign: 'spring',
      first_name: 'Maya',
      email: 'maya@example.test',
      venue: 'garden',
      notes: 'Filled later',
    });
  });
});
