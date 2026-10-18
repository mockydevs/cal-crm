import {
  DEFAULT_FORM_DEFINITION,
  FORM_LIMITS,
  formDefinition,
  formFieldTypes,
  formFieldValueTypes,
  publicForm,
  type FormDefinitionInput,
} from '@repo/contracts';
import { expect, it } from 'vitest';

import {
  EMPTY_FORM_DEFINITION,
  publicView,
  publishProblems,
  storedDefinition,
  type ContactFieldFacts,
  type PublishFacts,
} from './definition.js';

const budget = 'fld_01h455vb4pex5vsknk084sn02q';
const size = 'fld_01h455vb4pex5vsknk084sn02r';
const vip = 'tag_01h455vb4pex5vsknk084sn02q';
const lead = 'tag_01h455vb4pex5vsknk084sn02r';
const sam = 'mem_01h455vb4pex5vsknk084sn02q';
const dana = 'mem_01h455vb4pex5vsknk084sn02r';
const fields = (entries: Readonly<Record<string, Partial<ContactFieldFacts>>> = {}) =>
  new Map(
    Object.entries(entries).map(([id, facts]) => [
      id,
      { valueType: 'text', archived: false, choices: [], ...facts },
    ]),
  );
const facts = (
  known = fields(),
  more: { readonly tags?: readonly string[]; readonly members?: readonly string[] } = {},
): PublishFacts => ({
  fields: known,
  tags: new Set(more.tags ?? []),
  members: new Set(more.members ?? []),
});
const define = (change: Partial<FormDefinitionInput> = {}) =>
  formDefinition.parse({ ...DEFAULT_FORM_DEFINITION, ...change });
const problemsOf = (
  change: Partial<FormDefinitionInput> = {},
  known = fields(),
  more: Parameters<typeof facts>[1] = {},
) =>
  publishProblems(define(change), facts(known, more)).map(
    (problem) => `${problem.path} ${problem.code}`,
  );
const email = DEFAULT_FORM_DEFINITION.fields[1];
if (email === undefined) throw new Error('The default form asks for an email address.');

it('reads a stored definition the builder wrote, and nothing else', () => {
  expect(storedDefinition(DEFAULT_FORM_DEFINITION)).toEqual(DEFAULT_FORM_DEFINITION);
  // What 0008 allowed before there was a builder: any JSON object.
  for (const legacy of [{}, { fields: [{ key: 'email' }] }, { questions: [] }, null, 'form', []])
    expect(storedDefinition(legacy)).toBeUndefined();
  expect(EMPTY_FORM_DEFINITION.fields).toEqual([]);
  expect(formDefinition.parse(EMPTY_FORM_DEFINITION)).toEqual(EMPTY_FORM_DEFINITION);
});

it('shows a website the questions and boxes, and never where an answer goes', () => {
  const definition = define({
    title: 'Ask us',
    fields: [
      ...DEFAULT_FORM_DEFINITION.fields,
      {
        key: 'guests',
        type: 'single_choice',
        label: 'Guests',
        options: [{ key: 'small', label: 'Up to 50' }],
        target: { kind: 'field', fieldId: size },
      },
    ],
    consents: [{ key: 'news', channel: 'email', wording: 'Email me news.' }],
  });
  const token = `1790000000000.${'A'.repeat(43)}`;
  const view = publicView(definition, token);
  // The public contract is strict: a view that held anything more would not parse.
  expect(publicForm.parse(view)).toEqual(view);
  expect(view).toMatchObject({
    title: 'Ask us',
    renderToken: token,
    textLength: FORM_LIMITS.textLength,
    longTextLength: FORM_LIMITS.longTextLength,
    consents: [{ key: 'news', wording: 'Email me news.', required: false }],
  });
  expect(view.fields.at(-1)).toEqual({
    key: 'guests',
    type: 'single_choice',
    label: 'Guests',
    helpText: '',
    required: false,
    options: [{ key: 'small', label: 'Up to 50' }],
    // A choice question that names no way of showing its choices is a dropdown.
    display: 'dropdown',
  });
  // An answer box says nothing of the kinds it is not.
  expect(view.fields[0]).toEqual({
    key: 'first_name',
    type: 'text',
    label: 'First name',
    helpText: '',
    required: false,
    options: [],
  });
  expect(view).not.toHaveProperty('redirectUrl');
  const text = JSON.stringify(view);
  for (const hidden of [
    'target',
    'fieldId',
    size,
    'channel',
    'attribute',
    'firstName',
    'contactActions',
    'form_name',
    'arrived',
    'tagBySource',
    'notify',
  ])
    expect(text).not.toContain(hidden);
});

it('shows each newer kind what it needs and no more', () => {
  const definition = define({
    afterSubmit: { kind: 'redirect', url: 'https://www.example.com/thanks' },
    contactActions: { tagIds: [vip], source: { kind: 'text', text: 'Trade fair 2026' } },
    notify: { mode: 'members', memberIds: [sam] },
    fields: [
      { ...email, placeholder: 'you@example.com' },
      { key: 'about', type: 'content', label: 'Intro', text: 'About you', style: 'heading' },
      { key: 'note', type: 'content', label: 'Small print', text: 'We answer\nwithin a day.' },
      {
        key: 'interests',
        type: 'multi_choice',
        label: 'Interests',
        display: 'checkboxes',
        options: [
          { key: 'venue', label: 'Venue' },
          { key: 'food', label: 'Food' },
        ],
        target: { kind: 'field', fieldId: size },
      },
      {
        key: 'room',
        type: 'single_choice',
        label: 'Room',
        display: 'radio',
        options: [{ key: 'harbor', label: 'Harbor' }],
      },
      { key: 'site', type: 'url', label: 'Website', placeholder: '' },
      { key: 'stars', type: 'rating', label: 'How was it?' },
      {
        key: 'campaign',
        type: 'hidden',
        label: 'Campaign',
        parameter: 'utm_campaign',
        defaultValue: 'Internal default',
        target: { kind: 'field', fieldId: budget },
      },
      { key: 'fixed', type: 'hidden', label: 'Fixed', defaultValue: 'Always this' },
      {
        key: 'rules',
        type: 'terms',
        label: 'Terms box',
        required: true,
        text: 'I accept the terms.',
        linkUrl: 'https://www.example.com/terms',
        linkLabel: 'Read them',
      },
      { key: 'age', type: 'terms', label: 'Age box', text: 'I am over 18.' },
    ],
  });
  const view = publicView(definition, `1790000000000.${'A'.repeat(43)}`);
  expect(publicForm.parse(view)).toEqual(view);
  expect(view.redirectUrl).toBe('https://www.example.com/thanks');
  const shown = Object.fromEntries(
    view.fields.map(({ key, type, helpText, required, options, ...rest }) => [key, rest]),
  );
  expect(shown).toEqual({
    email: { label: 'Email', placeholder: 'you@example.com' },
    // The label of a block of text or a terms box is the builder's own name for it.
    about: { label: '', text: 'About you', style: 'heading' },
    note: { label: '', text: 'We answer\nwithin a day.', style: 'paragraph' },
    interests: { label: 'Interests', display: 'checkboxes' },
    room: { label: 'Room', display: 'radio' },
    // An empty example is no example.
    site: { label: 'Website' },
    stars: { label: 'How was it?' },
    campaign: { label: 'Campaign', parameter: 'utm_campaign' },
    fixed: { label: 'Fixed' },
    rules: {
      label: '',
      text: 'I accept the terms.',
      linkUrl: 'https://www.example.com/terms',
      linkLabel: 'Read them',
    },
    age: { label: '', text: 'I am over 18.' },
  });
  const text = JSON.stringify(view);
  // A hidden question's fixed answer is the server's to fill in, and what a submission
  // does is nobody's to see: neither leaves.
  for (const kept of [
    'Internal default',
    'Always this',
    'defaultValue',
    'Intro',
    'Small print',
    'Terms box',
    'Age box',
    vip,
    sam,
    'Trade fair',
    budget,
    size,
  ])
    expect(text).not.toContain(kept);
});

it('lets the form a business starts with be published, with no website listed', () => {
  // A form always has a page of its own, served by the CRM: it needs no website.
  expect(problemsOf()).toEqual([]);
  expect(DEFAULT_FORM_DEFINITION.contactActions).toEqual({
    tagIds: [],
    source: { kind: 'arrived' },
    tagBySource: true,
  });
});

it('needs a question, and an email address or phone number that is always given', () => {
  expect(problemsOf({ fields: [] })).toEqual(['/fields no_questions']);
  // A block of text asks nothing.
  expect(
    problemsOf({ fields: [{ key: 'intro', type: 'content', label: 'Intro', text: 'Hello.' }] }),
  ).toEqual(['/fields no_questions']);
  const optional = { ...email, required: false };
  expect(problemsOf({ fields: [optional] })).toEqual(['/fields no_identity']);
  // An email question kept with the submission only fills no contact.
  expect(problemsOf({ fields: [{ ...email, target: { kind: 'none' } }] })).toEqual([
    '/fields no_identity',
  ]);
  const phone = {
    key: 'phone',
    type: 'phone' as const,
    label: 'Phone',
    required: true,
    target: { kind: 'contact' as const, attribute: 'phone' as const },
  };
  // Either address will do, as long as one of them is required.
  expect(problemsOf({ fields: [optional, phone] })).toEqual([]);
  expect(problemsOf({ fields: [phone] })).toEqual([]);
  expect(problemsOf({ fields: [optional, { ...phone, required: false }] })).toEqual([
    '/fields no_identity',
  ]);
});

it('needs a choice question to have choices', () => {
  expect(
    problemsOf({
      fields: [email, { key: 'guests', type: 'single_choice', label: 'Guests' }],
    }),
  ).toEqual(['/fields/1/options no_choices']);
  expect(
    problemsOf({
      fields: [email, { key: 'interests', type: 'multi_choice', label: 'Interests' }],
    }),
  ).toEqual(['/fields/1/options no_choices']);
});

it('fills a contact field only while it exists, is live and takes that kind of answer', () => {
  // A block of text has no answer and a terms box is kept with the submission only: the
  // contract refuses either a contact field, so there is nothing for publishing to check.
  const answered = formFieldTypes.filter((type) => type !== 'content' && type !== 'terms');
  expect(formFieldValueTypes.content).toEqual([]);
  expect(formFieldValueTypes.terms).toEqual([]);
  const asks = (type: (typeof answered)[number], fieldId = budget) => ({
    fields: [
      email,
      {
        key: 'extra',
        type,
        label: 'Extra',
        options:
          type === 'single_choice' || type === 'multi_choice'
            ? [{ key: 'small', label: 'Small' }]
            : [],
        ...(type === 'hidden' ? { parameter: 'ref' } : {}),
        target: { kind: 'field' as const, fieldId },
      },
    ],
  });
  expect(problemsOf(asks('text'))).toEqual(['/fields/1/target unknown_field']);
  expect(problemsOf(asks('text'), fields({ [budget]: { archived: true } }))).toEqual([
    '/fields/1/target archived_field',
  ]);
  const kinds = [
    'text',
    'long_text',
    'number',
    'money',
    'date',
    'datetime',
    'boolean',
    'single_choice',
    'multi_choice',
    'email',
    'phone',
    'url',
  ];
  for (const type of answered)
    for (const valueType of kinds) {
      const accepted: readonly string[] = formFieldValueTypes[type];
      expect(
        problemsOf(asks(type), fields({ [budget]: { valueType, choices: ['small'] } })),
        `${type} into ${valueType}`,
      ).toEqual(accepted.includes(valueType) ? [] : ['/fields/1/target incompatible_field']);
    }
  // A choice the contact field does not have, or no longer offers, cannot be stored in it.
  expect(
    problemsOf(asks('single_choice'), fields({ [budget]: { valueType: 'single_choice' } })),
  ).toEqual(['/fields/1/options/0/key unknown_choice']);
  expect(
    problemsOf(asks('multi_choice'), fields({ [budget]: { valueType: 'multi_choice' } })),
  ).toEqual(['/fields/1/options/0/key unknown_choice']);
  // What each newer kind fills: several choices, a web address, a number, a line of text.
  expect(formFieldValueTypes.multi_choice).toEqual(['multi_choice']);
  expect(formFieldValueTypes.url).toEqual(['url', 'text']);
  expect(formFieldValueTypes.rating).toEqual(['number']);
  expect(formFieldValueTypes.hidden).toEqual([
    'text',
    'long_text',
    'single_choice',
    'multi_choice',
  ]);
});

it('adds only tags the business has, and tells only people on its team', () => {
  const tagged = { contactActions: { tagIds: [vip, lead], source: { kind: 'none' as const } } };
  expect(problemsOf(tagged, fields(), { tags: [vip, lead] })).toEqual([]);
  expect(problemsOf(tagged, fields(), { tags: [lead] })).toEqual([
    '/contactActions/tagIds/0 unknown_tag',
  ]);
  expect(problemsOf(tagged)).toEqual([
    '/contactActions/tagIds/0 unknown_tag',
    '/contactActions/tagIds/1 unknown_tag',
  ]);
  const told = { notify: { mode: 'members' as const, memberIds: [sam, dana] } };
  expect(problemsOf(told, fields(), { members: [sam, dana] })).toEqual([]);
  expect(problemsOf(told, fields(), { members: [sam] })).toEqual([
    '/notify/memberIds/1 unknown_member',
  ]);
  // The other ways of telling name nobody, so nobody can be missing.
  for (const mode of ['managers', 'nobody', 'contact_owner'] as const)
    expect(problemsOf({ notify: { mode } })).toEqual([]);
  expect(publishProblems(define(tagged), facts()).map((problem) => problem.message)[0]).toBe(
    'This tag no longer exists. Remove it or choose another.',
  );
});

it('offers a consent box only with the address it is for', () => {
  const news = { key: 'news', channel: 'email' as const, wording: 'Email me news.' };
  const texts = { key: 'texts', channel: 'sms' as const, wording: 'Text me offers.' };
  expect(problemsOf({ consents: [news] })).toEqual([]);
  expect(problemsOf({ consents: [news, texts] })).toEqual(['/consents/1/channel no_address']);
  const phone = {
    key: 'phone',
    type: 'phone' as const,
    label: 'Phone',
    required: true,
    target: { kind: 'contact' as const, attribute: 'phone' as const },
  };
  expect(problemsOf({ fields: [phone], consents: [news, texts] })).toEqual([
    '/consents/0/channel no_address',
  ]);
  expect(problemsOf({ fields: [email, phone], consents: [news, texts] })).toEqual([]);
  const said = publishProblems(define({ fields: [phone], consents: [news] }), facts());
  expect(said[0]?.message).toBe(
    "Ask for an email address, filling the contact's email, to offer this box.",
  );
  expect(publishProblems(define({ consents: [texts] }), facts())[0]?.message).toBe(
    "Ask for a phone number, filling the contact's phone, to offer this box.",
  );
});

it('reports every problem at once, in the order of the form', () => {
  expect(
    problemsOf(
      {
        fields: [
          { ...email, required: false },
          { key: 'guests', type: 'single_choice', label: 'Guests' },
          {
            key: 'notes',
            type: 'text',
            label: 'Notes',
            target: { kind: 'field', fieldId: budget },
          },
        ],
        consents: [{ key: 'texts', channel: 'sms', wording: 'Text me.' }],
        contactActions: { tagIds: [vip] },
        notify: { mode: 'members', memberIds: [sam] },
      },
      fields(),
    ),
  ).toEqual([
    '/fields no_identity',
    '/fields/1/options no_choices',
    '/fields/2/target unknown_field',
    '/consents/0/channel no_address',
    '/contactActions/tagIds/0 unknown_tag',
    '/notify/memberIds/0 unknown_member',
  ]);
});

it('shows a visible question its query key, so the embed can fill it from the page address', () => {
  const definition = formDefinition.parse({
    ...DEFAULT_FORM_DEFINITION,
    fields: [
      {
        key: 'email',
        type: 'email',
        label: 'Email',
        required: true,
        target: { kind: 'contact', attribute: 'email' },
        parameter: 'email',
      },
      { key: 'first_name', type: 'text', label: 'First name', parameter: 'full_name' },
      { key: 'notes', type: 'long_text', label: 'Notes' },
      { key: 'campaign', type: 'hidden', label: 'Campaign', parameter: 'utm_campaign' },
    ],
  });
  const shown = publicView(definition, 'token');
  expect(shown.fields.map((field) => [field.key, field.parameter])).toEqual([
    ['email', 'email'],
    ['first_name', 'full_name'],
    ['notes', undefined],
    ['campaign', 'utm_campaign'],
  ]);
});

it('lets a hidden question fill a choice field, and checks its fixed answer against the choices', () => {
  const choices = [
    { key: 'dj', label: 'DJ', archived: false },
    { key: 'dj_photo_video', label: 'DJ-Photo-Video', archived: false },
    { key: 'band', label: 'Live band', archived: true },
  ];
  const hidden = (defaultValue: string | undefined, valueType = 'single_choice') =>
    problemsOf(
      {
        fields: [
          email,
          {
            key: 'service_interest',
            type: 'hidden',
            label: 'Service interest',
            ...(defaultValue === undefined ? { parameter: 'service' } : { defaultValue }),
            target: { kind: 'field', fieldId: budget },
          },
        ],
      },
      fields({ [budget]: { valueType, choices: ['dj', 'dj_photo_video'], options: choices } }),
    );
  // By key or by label, capitals aside; a page's address is read when the form is sent.
  expect(hidden(undefined)).toEqual([]);
  expect(hidden('dj')).toEqual([]);
  expect(hidden('dj-photo-video')).toEqual([]);
  expect(hidden('DJ, DJ-Photo-Video', 'multi_choice')).toEqual([]);
  // Not a choice, or one no longer offered.
  expect(hidden('Photo booth')).toEqual(['/fields/1/defaultValue unknown_choice']);
  expect(hidden('Live band')).toEqual(['/fields/1/defaultValue unknown_choice']);
  expect(hidden('DJ, Photo booth', 'multi_choice')).toEqual([
    '/fields/1/defaultValue unknown_choice',
  ]);
  // A field that takes one choice takes one.
  expect(hidden('DJ, DJ-Photo-Video')).toEqual(['/fields/1/defaultValue unknown_choice']);
  const [problem] = publishProblems(
    define({
      fields: [
        email,
        {
          key: 'service_interest',
          type: 'hidden',
          label: 'Service interest',
          defaultValue: 'Photo booth',
          target: { kind: 'field', fieldId: budget },
        },
      ],
    }),
    facts(fields({ [budget]: { valueType: 'single_choice', options: choices } })),
  );
  expect(problem?.message).toBe(
    'This fixed answer is not one of the contact field’s choices: DJ, DJ-Photo-Video.',
  );
});
