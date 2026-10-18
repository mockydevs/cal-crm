import { FORM_LIMITS, formDefinition, type FormDefinitionInput } from '@repo/contracts';
import { expect, it } from 'vitest';

import { readAnswers, readPage } from './answers.js';

const definition = formDefinition.parse({
  fields: [
    {
      key: 'first_name',
      type: 'text',
      label: 'First name',
      target: { kind: 'contact', attribute: 'firstName' },
    },
    {
      key: 'email',
      type: 'email',
      label: 'Email',
      required: true,
      target: { kind: 'contact', attribute: 'email' },
    },
    {
      key: 'phone',
      type: 'phone',
      label: 'Phone',
      target: { kind: 'contact', attribute: 'phone' },
    },
    { key: 'notes', type: 'long_text', label: 'Anything else?' },
    { key: 'guests', type: 'number', label: 'Guests' },
    { key: 'day', type: 'date', label: 'Event date' },
    {
      key: 'venue',
      type: 'single_choice',
      label: 'Venue',
      options: [
        { key: 'harbor', label: 'Harbor room' },
        { key: 'garden', label: 'Garden' },
      ],
    },
    { key: 'terms', type: 'checkbox', label: 'I accept the terms', required: true },
    { key: 'callback', type: 'checkbox', label: 'Call me back' },
  ],
  consents: [
    { key: 'news', channel: 'email', wording: 'Email me news and offers.' },
    { key: 'texts', channel: 'sms', wording: 'Text me offers.' },
  ],
} satisfies FormDefinitionInput);

const least = { email: 'maya@example.test', terms: true };
const read = (
  values: Readonly<Record<string, string | boolean>> = least,
  consents: Readonly<Record<string, boolean>> = {},
  form = definition,
) => readAnswers(form, { values, consents });
const issuesOf = (
  values: Readonly<Record<string, string | boolean>>,
  consents: Readonly<Record<string, boolean>> = {},
  form = definition,
) => {
  const result = read(values, consents, form);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path} ${issue.code}`);
};
const valueOf = (key: string, value: string | boolean) => {
  const result = read({ ...least, [key]: value });
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.issues)}`);
  return result.answers.find((answer) => answer.key === key)?.value;
};

it('gives every question an answer, in the order of the form, with where it goes', () => {
  const result = read({
    ...least,
    first_name: '  Maya ',
    venue: 'garden',
    guests: '120',
    day: '2027-06-12',
    notes: 'Line one\nLine two',
    phone: '+254 712 345678',
    callback: true,
  });
  if (!result.ok) throw new Error('A complete submission was refused.');
  expect(result.answers).toEqual([
    {
      key: 'first_name',
      label: 'First name',
      type: 'text',
      value: 'Maya',
      target: { kind: 'contact', attribute: 'firstName' },
    },
    {
      key: 'email',
      label: 'Email',
      type: 'email',
      value: 'maya@example.test',
      target: { kind: 'contact', attribute: 'email' },
    },
    {
      key: 'phone',
      label: 'Phone',
      type: 'phone',
      value: '+254 712 345678',
      target: { kind: 'contact', attribute: 'phone' },
    },
    {
      key: 'notes',
      label: 'Anything else?',
      type: 'long_text',
      value: 'Line one\nLine two',
      target: { kind: 'none' },
    },
    { key: 'guests', label: 'Guests', type: 'number', value: '120', target: { kind: 'none' } },
    {
      key: 'day',
      label: 'Event date',
      type: 'date',
      value: '2027-06-12',
      target: { kind: 'none' },
    },
    {
      key: 'venue',
      label: 'Venue',
      type: 'single_choice',
      value: 'garden',
      target: { kind: 'none' },
    },
    {
      key: 'terms',
      label: 'I accept the terms',
      type: 'checkbox',
      value: true,
      target: { kind: 'none' },
    },
    {
      key: 'callback',
      label: 'Call me back',
      type: 'checkbox',
      value: true,
      target: { kind: 'none' },
    },
  ]);
});

it('reads a question left out or left blank as unanswered, and an unsent box as unticked', () => {
  const result = read({ ...least, first_name: '   ', notes: '' });
  if (!result.ok) throw new Error('Optional questions were required.');
  expect(result.answers.map((answer) => [answer.key, answer.value])).toEqual([
    ['first_name', null],
    ['email', 'maya@example.test'],
    ['phone', null],
    ['notes', null],
    ['guests', null],
    ['day', null],
    ['venue', null],
    ['terms', true],
    ['callback', false],
  ]);
});

it('asks for every required answer, and a required box to be ticked', () => {
  expect(issuesOf({})).toEqual(['/values/email required', '/values/terms required']);
  expect(issuesOf({ email: '  ', terms: false })).toEqual([
    '/values/email required',
    '/values/terms required',
  ]);
  const result = read({});
  expect(result.ok ? [] : result.issues.map((issue) => issue.message)).toEqual([
    'Answer this question.',
    'Tick this box to continue.',
  ]);
});

it('takes nothing the form did not ask for', () => {
  expect(issuesOf({ ...least, is_admin: 'true', owner: 'usr_1' })).toEqual([
    '/values/is_admin unknown_question',
    '/values/owner unknown_question',
  ]);
  expect(issuesOf(least, { partners: true })).toEqual(['/consents/partners unknown_box']);
  // A key that names something on every object is still only a key nobody asked for.
  expect(issuesOf({ ...least, constructor: 'x', to_string: 'y' })).toEqual([
    '/values/constructor unknown_question',
    '/values/to_string unknown_question',
  ]);
});

it('checks each kind of answer for what it is', () => {
  expect(valueOf('email', '  Maya@Example.TEST ')).toBe('maya@example.test');
  for (const bad of [
    'maya',
    'maya@',
    '@example.test',
    'a b@example.test',
    `${'a'.repeat(320)}@e.test`,
  ])
    expect(issuesOf({ ...least, email: bad })).toEqual(['/values/email invalid_email']);

  for (const good of ['+254 712 345678', '(020) 123-4567', '0712.345.678'])
    expect(valueOf('phone', good)).toBe(good);
  for (const bad of ['call me', '+-()', '12', `+${'1'.repeat(40)}`, '0712 345 678 ext 9'])
    expect(issuesOf({ ...least, phone: bad })).toEqual(['/values/phone invalid_phone']);

  for (const good of ['0', '-3', '120', '12.5', '0.000001', '999999999999999'])
    expect(valueOf('guests', good)).toBe(good);
  for (const bad of [
    'twelve',
    '1e3',
    '1,000',
    '12.',
    '.5',
    '0x10',
    '1234567890123456',
    '1.0000001',
  ])
    expect(issuesOf({ ...least, guests: bad })).toEqual(['/values/guests invalid_number']);

  expect(valueOf('day', '2027-06-12')).toBe('2027-06-12');
  for (const bad of ['12/06/2027', '2027-02-30', '0000-01-01', '2027-6-1', 'tomorrow'])
    expect(issuesOf({ ...least, day: bad })).toEqual(['/values/day invalid_date']);

  expect(valueOf('venue', 'harbor')).toBe('harbor');
  for (const bad of ['Harbor room', 'cellar', 'harbor,garden'])
    expect(issuesOf({ ...least, venue: bad })).toEqual(['/values/venue invalid_choice']);

  expect(valueOf('callback', false)).toBe(false);
  // The wrong kind of value altogether: text for a box, a tick for a question.
  expect(issuesOf({ ...least, callback: 'true' })).toEqual(['/values/callback invalid']);
  expect(issuesOf({ ...least, first_name: true })).toEqual(['/values/first_name invalid']);
});

it('bounds text and keeps it plain: one line for a short answer, lines for a long one', () => {
  expect(valueOf('first_name', 'x'.repeat(FORM_LIMITS.textLength))).toHaveLength(
    FORM_LIMITS.textLength,
  );
  expect(issuesOf({ ...least, first_name: 'x'.repeat(FORM_LIMITS.textLength + 1) })).toEqual([
    '/values/first_name too_long',
  ]);
  expect(issuesOf({ ...least, first_name: 'Two\nlines' })).toEqual(['/values/first_name invalid']);
  expect(valueOf('notes', 'x'.repeat(FORM_LIMITS.longTextLength))).toHaveLength(
    FORM_LIMITS.longTextLength,
  );
  expect(issuesOf({ ...least, notes: 'x'.repeat(FORM_LIMITS.longTextLength + 1) })).toEqual([
    '/values/notes too_long',
  ]);
  expect(issuesOf({ ...least, notes: 'Bell\u0007' })).toEqual(['/values/notes invalid']);
  // Markup is text: kept as typed, for whoever shows it to show as characters.
  expect(valueOf('notes', '<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  expect(valueOf('first_name', '<b>Maya</b>')).toBe('<b>Maya</b>');
});

it('counts a consent box as ticked only when it was sent as true', () => {
  const ticked = (consents: Readonly<Record<string, boolean>>) => {
    const result = read(least, consents);
    if (!result.ok) throw new Error('Refused.');
    return result.consents.map((consent) => [consent.key, consent.ticked]);
  };
  expect(ticked({})).toEqual([
    ['news', false],
    ['texts', false],
  ]);
  expect(ticked({ news: true, texts: false })).toEqual([
    ['news', true],
    ['texts', false],
  ]);
  const result = read(least, { news: true });
  if (!result.ok) throw new Error('Refused.');
  // The words kept as proof are the form's own, never the visitor's.
  expect(result.consents[0]).toEqual({
    key: 'news',
    channel: 'email',
    wording: 'Email me news and offers.',
    ticked: true,
  });
});

it('asks for a required consent box, and reports every problem at once', () => {
  const strict = formDefinition.parse({
    fields: definition.fields,
    consents: [{ key: 'news', channel: 'email', wording: 'Email me news.', required: true }],
  });
  expect(issuesOf(least, {}, strict)).toEqual(['/consents/news required']);
  expect(issuesOf(least, { news: false }, strict)).toEqual(['/consents/news required']);
  expect(issuesOf(least, { news: true }, strict)).toEqual([]);
  expect(issuesOf({ email: 'nope', guests: 'many', extra: 'x' }, { other: true }, strict)).toEqual([
    '/values/extra unknown_question',
    '/consents/other unknown_box',
    '/values/email invalid_email',
    '/values/guests invalid_number',
    '/values/terms required',
    '/consents/news required',
  ]);
});

it('says nothing a visitor typed back to them', () => {
  const secret = 'S3cret-value-typed-by-the-visitor';
  const result = read({ email: secret, guests: secret, day: secret, venue: secret, terms: true });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(secret);
});

it('keeps the page a form was on only when it is on the admitted website, without its query', () => {
  const origin = 'https://www.example.com';
  expect(
    readPage(
      'https://www.example.com/weddings/enquire?utm_source=newsletter&utm_medium=email&utm_campaign=spring%20open%20day&email=maya@example.test#top',
      origin,
    ),
  ).toEqual({
    pageUrl: 'https://www.example.com/weddings/enquire',
    utm: { source: 'newsletter', medium: 'email', campaign: 'spring open day' },
  });
  expect(readPage('https://www.example.com/', origin)).toEqual({
    pageUrl: 'https://www.example.com/',
    utm: {},
  });
  expect(readPage(undefined, origin)).toEqual({ pageUrl: null, utm: {} });
  // Another website, or one that only looks like it, is not where the form was shown.
  for (const elsewhere of [
    'https://example.com/contact?utm_source=x',
    'https://www.example.com.attacker.test/?utm_source=x',
    'http://www.example.com/?utm_source=x',
    'https://www.example.com:8443/?utm_source=x',
    'not a url',
  ])
    expect(readPage(elsewhere, origin)).toEqual({ pageUrl: null, utm: {} });
});

it('bounds each campaign label and takes the five it knows', () => {
  const origin = 'https://www.example.com';
  const page = (query: string) => readPage(`https://www.example.com/?${query}`, origin).utm;
  expect(
    page('utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e&utm_id=f&ref=g'),
  ).toEqual({ source: 'a', medium: 'b', campaign: 'c', term: 'd', content: 'e' });
  expect(page(`utm_source=${'x'.repeat(200)}`)).toEqual({ source: 'x'.repeat(200) });
  expect(page(`utm_source=${'x'.repeat(201)}`)).toEqual({});
  expect(page('utm_source=%20%20&utm_medium=line%0Abreak')).toEqual({});
  expect(page('utm_source=first&utm_source=second')).toEqual({ source: 'first' });
  // A path too long to keep is dropped; the labels are still read.
  expect(
    readPage(
      `https://www.example.com/${'p'.repeat(FORM_LIMITS.pageUrlLength)}?utm_source=a`,
      origin,
    ),
  ).toEqual({ pageUrl: null, utm: { source: 'a' } });
});

// The kinds a form gained after the first eight: several choices, a web address, a rating,
// a hidden question, a block of text and a terms box.
const wider = formDefinition.parse({
  fields: [
    {
      key: 'email',
      type: 'email',
      label: 'Email',
      required: true,
      target: { kind: 'contact', attribute: 'email' },
    },
    { key: 'intro', type: 'content', label: 'Intro', text: 'Tell us about your event.' },
    {
      key: 'interests',
      type: 'multi_choice',
      label: 'Interests',
      display: 'checkboxes',
      options: [
        { key: 'venue', label: 'Venue' },
        { key: 'food', label: 'Food' },
        { key: 'music', label: 'Music' },
      ],
    },
    { key: 'site', type: 'url', label: 'Website' },
    { key: 'stars', type: 'rating', label: 'How was it?' },
    { key: 'campaign', type: 'hidden', label: 'Campaign', parameter: 'utm_campaign' },
    {
      key: 'ref',
      type: 'hidden',
      label: 'Referrer',
      parameter: 'ref',
      defaultValue: 'direct',
    },
    {
      key: 'born',
      type: 'date',
      label: 'Date of birth',
      target: { kind: 'contact', attribute: 'dateOfBirth' },
    },
    {
      key: 'rules',
      type: 'terms',
      label: 'Terms box',
      required: true,
      text: 'I accept the terms and conditions.',
      linkUrl: 'https://www.example.com/terms',
      linkLabel: 'Read them',
    },
    { key: 'age', type: 'terms', label: 'Age box', text: 'I am over 18.' },
  ],
} satisfies FormDefinitionInput);
const enough = { email: 'maya@example.test', rules: true };
type Sent = Readonly<Record<string, string | boolean | readonly string[]>>;
const wide = (values: Sent = enough) => readAnswers(wider, { values, consents: {} });
const wideIssues = (values: Sent) => {
  const result = wide(values);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path} ${issue.code}`);
};
const wideValue = (key: string, value: string | boolean | readonly string[]) => {
  const result = wide({ ...enough, [key]: value });
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.issues)}`);
  return result.answers.find((answer) => answer.key === key)?.value;
};

it('takes several of the listed choices, each once, in the order of the form', () => {
  expect(wideValue('interests', ['music', 'venue'])).toEqual(['venue', 'music']);
  expect(wideValue('interests', ['food'])).toEqual(['food']);
  // None chosen is a question left unanswered.
  expect(wideValue('interests', [])).toBeNull();
  expect(wideValue('email', 'maya@example.test')).toBe('maya@example.test');
  const unsent = wide();
  if (!unsent.ok) throw new Error('Refused.');
  expect(unsent.answers.find((answer) => answer.key === 'interests')?.value).toBeNull();
  for (const bad of [['cellar'], ['venue', 'venue'], ['venue', 'Venue'], ['']])
    expect(wideIssues({ ...enough, interests: bad })).toEqual(['/values/interests invalid_choice']);
  // One choice as text is not a list of them, and a list answers no other kind of question.
  expect(wideIssues({ ...enough, interests: 'venue' })).toEqual(['/values/interests invalid']);
  expect(wideIssues({ ...enough, interests: true })).toEqual(['/values/interests invalid']);
  expect(wideIssues({ ...enough, site: ['https://a.example'] })).toEqual(['/values/site invalid']);
  expect(wideIssues({ ...enough, rules: ['true'] })).toEqual(['/values/rules invalid']);
  const required = formDefinition.parse({
    fields: [
      {
        key: 'days',
        type: 'multi_choice',
        label: 'Days',
        required: true,
        options: [{ key: 'sat', label: 'Saturday' }],
      },
    ],
  });
  const none = readAnswers(required, { values: { days: [] }, consents: {} });
  expect(none.ok ? [] : none.issues).toEqual([
    { path: '/values/days', code: 'required', message: 'Answer this question.' },
  ]);
});

it('takes a web address, as people write one, and nothing that is not a website', () => {
  expect(wideValue('site', 'https://www.example.com/pricing?plan=1')).toBe(
    'https://www.example.com/pricing?plan=1',
  );
  expect(wideValue('site', 'http://example.com')).toBe('http://example.com');
  // Written without how to reach it: a secure address.
  expect(wideValue('site', ' www.example.com ')).toBe('https://www.example.com');
  expect(wideValue('site', 'example.co.ke/menu')).toBe('https://example.co.ke/menu');
  for (const bad of [
    'not a website',
    'example',
    'localhost',
    'https://',
    'mailto:maya@example.com',
    'javascript:alert(1)',
    'ftp://example.com/file',
    'https://exa mple.com',
    'https://127.0.0.1/admin',
    `https://example.com/${'p'.repeat(FORM_LIMITS.urlLength)}`,
  ])
    expect(wideIssues({ ...enough, site: bad }), bad).toEqual(['/values/site invalid_url']);
});

it('takes a rating from 1 to 5, as a whole number', () => {
  for (const good of ['1', '3', '5']) expect(wideValue('stars', good)).toBe(good);
  for (const bad of ['0', '6', '10', '3.5', '-1', '05', 'five', '1e0'])
    expect(wideIssues({ ...enough, stars: bad }), bad).toEqual(['/values/stars invalid_rating']);
  expect(wideIssues({ ...enough, stars: true })).toEqual(['/values/stars invalid']);
});

it('reads a hidden answer as untrusted text, and never lets it stop the form', () => {
  expect(wideValue('campaign', '  Spring open day ')).toBe('Spring open day');
  // Markup is text, kept as it came, for whoever shows it to show as characters.
  expect(wideValue('campaign', '<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  expect(wideValue('campaign', 'x'.repeat(FORM_LIMITS.textLength))).toHaveLength(
    FORM_LIMITS.textLength,
  );
  // What does not fit a short answer is left out, as if the address had none: the
  // visitor cannot see it, so they could not correct it.
  for (const unfit of ['x'.repeat(FORM_LIMITS.textLength + 1), 'two\nlines', 'bell\u0007', '  '])
    expect(wideValue('campaign', unfit)).toBeNull();
  expect(wideIssues({ ...enough, campaign: true })).toEqual([]);
  expect(wideIssues({ ...enough, campaign: ['a'] })).toEqual([]);
  expect(wideValue('campaign', true)).toBeNull();
  // The form's own fixed answer is used when the address gave none that fits.
  expect(wideValue('ref', 'partner-42')).toBe('partner-42');
  expect(wideValue('ref', '')).toBe('direct');
  expect(wideValue('ref', 'x'.repeat(FORM_LIMITS.textLength + 1))).toBe('direct');
  const unsent = wide();
  if (!unsent.ok) throw new Error('Refused.');
  expect(unsent.answers.find((answer) => answer.key === 'ref')?.value).toBe('direct');
  expect(unsent.answers.find((answer) => answer.key === 'campaign')?.value).toBeNull();
});

it('asks nothing of a block of text, and takes no answer under its key', () => {
  const result = wide();
  if (!result.ok) throw new Error('Refused.');
  expect(result.answers.map((answer) => answer.key)).toEqual([
    'email',
    'interests',
    'site',
    'stars',
    'campaign',
    'ref',
    'born',
  ]);
  expect(wideIssues({ ...enough, intro: 'anything' })).toEqual(['/values/intro unknown_question']);
});

it('keeps a terms box apart from the answers, with the wording and link it was shown with', () => {
  const result = wide({ ...enough, age: false });
  if (!result.ok) throw new Error('Refused.');
  expect(result.terms).toEqual([
    {
      key: 'rules',
      wording: 'I accept the terms and conditions.',
      linkUrl: 'https://www.example.com/terms',
      accepted: true,
    },
    { key: 'age', wording: 'I am over 18.', linkUrl: null, accepted: false },
  ]);
  // Not a consent to messages: that is a consent box, which this form has none of.
  expect(result.consents).toEqual([]);
  // A required one must be ticked, as a required checkbox must; text is not a tick.
  expect(wideIssues({ email: 'maya@example.test' })).toEqual(['/values/rules required']);
  expect(wideIssues({ email: 'maya@example.test', rules: false })).toEqual([
    '/values/rules required',
  ]);
  const refused = wide({ email: 'maya@example.test' });
  expect(refused.ok ? '' : refused.issues[0].message).toBe('Tick this box to continue.');
  expect(wideIssues({ ...enough, age: 'yes' })).toEqual(['/values/age invalid']);
  // The older kinds have no terms.
  const old = read();
  if (!old.ok) throw new Error('Refused.');
  expect(old.terms).toEqual([]);
});

it('fills the date of birth of the contact from a date question', () => {
  const result = wide({ ...enough, born: '1990-04-23' });
  if (!result.ok) throw new Error('Refused.');
  expect(result.answers.find((answer) => answer.key === 'born')).toEqual({
    key: 'born',
    label: 'Date of birth',
    type: 'date',
    value: '1990-04-23',
    target: { kind: 'contact', attribute: 'dateOfBirth' },
  });
});
