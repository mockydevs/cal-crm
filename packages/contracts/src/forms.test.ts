import { expect, it } from 'vitest';

import { endpoints } from './api.js';
import {
  DEFAULT_FORM_DEFINITION,
  FORM_LIMITS,
  formPrefillTypes,
  FORM_PAGE_PATH,
  FORM_PREVIEW_PAGE_PATH,
  form,
  formAdminEndpoints,
  formAnalytics,
  formAttributeTypes,
  formChoiceDisplays,
  formContactAttributes,
  formDefinition,
  formFieldDisplays,
  formFieldTypes,
  formFieldValueTypes,
  formPlaceholderTypes,
  formPreview,
  formPreviewToken,
  formSubmission,
  getFormAnalytics,
  getFormPreview,
  getPublicFormPreview,
  listFormSubmissions,
  listForms,
  publicForm,
  publicFormEndpoints,
  publicFormReceipt,
  publicFormSubmissionInput,
  updateFormInput,
} from './forms.js';
import { fieldValueTypes } from './fields.js';

const field = (change: Record<string, unknown> = {}) => ({
  key: 'company',
  type: 'text',
  label: 'Company',
  ...change,
});
const definition = (change: Record<string, unknown> = {}) => ({
  ...DEFAULT_FORM_DEFINITION,
  ...change,
});
const issuesOf = (value: unknown) => {
  const parsed = formDefinition.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('/')}: ${issue.message}`);
};
const fieldId = 'fld_01h455vb4pex5vsknk084sn02q';
const tagId = 'tag_01h455vb4pex5vsknk084sn02q';
const memberId = 'mem_01h455vb4pex5vsknk084sn02q';
const token = `1790000000000.${'A'.repeat(43)}`;
/** What a question of each kind needs before the contract takes it. */
const ofType = (type: (typeof formFieldTypes)[number]): Record<string, unknown> => ({
  type,
  ...(type === 'single_choice' || type === 'multi_choice'
    ? { options: [{ key: 'a', label: 'A' }] }
    : {}),
  ...(type === 'hidden' ? { parameter: 'ref' } : {}),
  ...(type === 'content' || type === 'terms' ? { text: 'Words of its own.' } : {}),
});
const submission = (change: Record<string, unknown> = {}) => ({
  clientSubmissionId: '0198de17-876e-7000-aac7-9bc8ac22900d',
  renderToken: token,
  values: { email: 'maya@example.test' },
  consents: {},
  ...change,
});

it('starts a form as something that can be published: a name and a required email address', () => {
  expect(formDefinition.parse(DEFAULT_FORM_DEFINITION)).toEqual(DEFAULT_FORM_DEFINITION);
  expect(DEFAULT_FORM_DEFINITION.fields.map((each) => [each.key, each.required])).toEqual([
    ['first_name', false],
    ['email', true],
  ]);
  // The least a definition needs is its questions; the words have defaults.
  expect(formDefinition.parse({ fields: [] })).toEqual({
    title: '',
    description: '',
    submitLabel: 'Send',
    successMessage: 'Thank you. We have your details.',
    fields: [],
    consents: [],
  });
  expect(formDefinition.parse({ fields: [field()] }).fields[0]).toEqual({
    key: 'company',
    type: 'text',
    label: 'Company',
    helpText: '',
    required: false,
    options: [],
    target: { kind: 'none' },
  });
});

it('keys every question and box once, in one namespace', () => {
  expect(issuesOf(definition({ fields: [field(), field()] }))).toEqual([
    'fields/1/key: This key is already used in this form.',
  ]);
  expect(
    issuesOf(
      definition({
        fields: [field({ key: 'news' })],
        consents: [{ key: 'news', channel: 'email', wording: 'Send me news.' }],
      }),
    ),
  ).toEqual(['consents/0/key: This key is already used in this form.']);
  for (const key of ['', 'Company', '1st', 'a-b', 'a b', 'a'.repeat(41), '__proto__'])
    expect(formDefinition.safeParse(definition({ fields: [field({ key })] })).success).toBe(false);
  expect(
    formDefinition.safeParse(definition({ fields: [field({ key: `a${'9'.repeat(39)}` })] }))
      .success,
  ).toBe(true);
});

it('lets each part of a contact and each custom field be filled by one question of the right kind', () => {
  const twice = [
    field({ key: 'a', type: 'email', target: { kind: 'contact', attribute: 'email' } }),
    field({ key: 'b', type: 'email', target: { kind: 'contact', attribute: 'email' } }),
  ];
  expect(issuesOf(definition({ fields: twice }))).toEqual([
    'fields/1/target: Another question already fills this.',
  ]);
  const sameField = [
    field({ key: 'a', target: { kind: 'field', fieldId } }),
    field({ key: 'b', target: { kind: 'field', fieldId } }),
  ];
  expect(issuesOf(definition({ fields: sameField }))).toEqual([
    'fields/1/target: Another question already fills this.',
  ]);
  // Any number of questions may be kept with the submission only.
  expect(issuesOf(definition({ fields: [field({ key: 'a' }), field({ key: 'b' })] }))).toEqual([]);

  expect(formContactAttributes).toEqual(['firstName', 'lastName', 'email', 'phone', 'dateOfBirth']);
  expect(formAttributeTypes.dateOfBirth).toBe('date');
  for (const attribute of formContactAttributes)
    for (const type of formFieldTypes) {
      const fits = formAttributeTypes[attribute] === type;
      const refusal =
        type === 'content'
          ? 'A block of text has no answer.'
          : type === 'terms'
            ? 'A terms box is kept with the submission only.'
            : 'This kind of question cannot fill that part of the contact.';
      expect(
        issuesOf(
          definition({
            fields: [field({ ...ofType(type), target: { kind: 'contact', attribute } })],
          }),
        ),
        `${type} into ${attribute}`,
      ).toEqual(fits ? [] : [`fields/0/target: ${refusal}`]);
    }
  for (const target of [
    { kind: 'contact', attribute: 'timezone' },
    { kind: 'field', fieldId: 'con_01h455vb4pex5vsknk084sn02q' },
    { kind: 'field' },
    { kind: 'deal' },
    { kind: 'none', fieldId },
  ])
    expect(formDefinition.safeParse(definition({ fields: [field({ target })] })).success).toBe(
      false,
    );
});

it('offers only custom field kinds that exist, and none a question could not fill', () => {
  for (const type of formFieldTypes)
    for (const valueType of formFieldValueTypes[type]) expect(fieldValueTypes).toContain(valueType);
  const offered = new Set<string>(Object.values(formFieldValueTypes).flat());
  // One answer cannot carry a currency or an instant; no question yet fills a text box
  // list's several boxes or uploads a file.
  const unanswered = ['money', 'datetime', 'text_list', 'file'];
  for (const valueType of unanswered) expect(offered.has(valueType), valueType).toBe(false);
  // Every other kind of custom field can be filled by some kind of question.
  for (const valueType of fieldValueTypes)
    if (!unanswered.includes(valueType)) expect(offered.has(valueType), valueType).toBe(true);
  // A block of text has no answer, and a terms box is kept with the submission only.
  expect(formFieldValueTypes.content).toEqual([]);
  expect(formFieldValueTypes.terms).toEqual([]);
});

it('gives choices to choice questions only, each once', () => {
  const options = [
    { key: 'small', label: 'Up to 50 guests' },
    { key: 'large', label: 'More than 50 guests' },
  ];
  expect(issuesOf(definition({ fields: [field({ type: 'single_choice', options })] }))).toEqual([]);
  // A choice question with no choices yet is a draft, not an error: publishing refuses it.
  expect(issuesOf(definition({ fields: [field({ type: 'single_choice' })] }))).toEqual([]);
  expect(issuesOf(definition({ fields: [field({ options })] }))).toEqual([
    'fields/0/options: Only a choice question has choices.',
  ]);
  expect(
    issuesOf(
      definition({
        fields: [field({ type: 'single_choice', options: [...options, options[0]] })],
      }),
    ),
  ).toEqual(['fields/0/options/2/key: This choice is already listed.']);
  const many = Array.from({ length: FORM_LIMITS.options + 1 }, (_, index) => ({
    key: `c${String(index)}`,
    label: `Choice ${String(index)}`,
  }));
  expect(
    formDefinition.safeParse(
      definition({ fields: [field({ type: 'single_choice', options: many })] }),
    ).success,
  ).toBe(false);
});

it('takes at most one marketing box for each channel, with its wording', () => {
  const email = { key: 'news', channel: 'email', wording: 'Email me news and offers.' };
  expect(formDefinition.parse(definition({ consents: [email] })).consents).toEqual([
    { ...email, required: false },
  ]);
  expect(issuesOf(definition({ consents: [email, { ...email, key: 'more' }] }))).toEqual([
    'consents/1/channel: There is already a box for this channel.',
  ]);
  expect(
    issuesOf(
      definition({ consents: [email, { key: 'texts', channel: 'sms', wording: 'Text me.' }] }),
    ),
  ).toEqual([]);
  for (const change of [
    { wording: '' },
    { wording: '   ' },
    { channel: 'whatsapp' },
    { purpose: 'transactional' },
  ])
    expect(
      formDefinition.safeParse(definition({ consents: [{ ...email, ...change }] })).success,
    ).toBe(false);
});

it('bounds a form: its questions, its words, and plain text only', () => {
  const many = Array.from({ length: FORM_LIMITS.fields + 1 }, (_, index) =>
    field({ key: `q${String(index)}` }),
  );
  expect(formDefinition.safeParse(definition({ fields: many })).success).toBe(false);
  expect(formDefinition.safeParse(definition({ fields: many.slice(1) })).success).toBe(true);
  for (const change of [
    { title: 'x'.repeat(FORM_LIMITS.titleLength + 1) },
    { title: 'Two\nlines' },
    { description: 'x'.repeat(FORM_LIMITS.descriptionLength + 1) },
    { description: 'Bell\u0007' },
    { submitLabel: '' },
    { submitLabel: 'x'.repeat(FORM_LIMITS.submitLabelLength + 1) },
    { successMessage: '' },
    { fields: [field({ label: '' })] },
    { fields: [field({ label: 'x'.repeat(FORM_LIMITS.labelLength + 1) })] },
    { fields: [field({ helpText: 'x'.repeat(FORM_LIMITS.helpLength + 1) })] },
    { fields: [field({ type: 'file' })] },
    { fields: [field({ html: '<b>bold</b>' })] },
    { theme: 'dark' },
  ])
    expect(formDefinition.safeParse(definition(change)).success).toBe(false);
  // Markup is text like any other: it is stored as typed and shown as characters.
  const marked = formDefinition.parse(
    definition({
      title: '<script>alert(1)</script>',
      description: 'Line one\nLine two <img src=x onerror=alert(1)>',
    }),
  );
  expect(marked.title).toBe('<script>alert(1)</script>');
  expect(marked.description).toBe('Line one\nLine two <img src=x onerror=alert(1)>');
});

it('saves a form with a name, its websites and the revision it was changed from', () => {
  const input = {
    name: ' Enquiry ',
    definition: DEFAULT_FORM_DEFINITION,
    allowedOrigins: ['https://www.example.com'],
    revision: 'a'.repeat(64),
  };
  expect(updateFormInput.parse(input).name).toBe('Enquiry');
  for (const change of [
    { name: '' },
    { name: 'x'.repeat(FORM_LIMITS.nameLength + 1) },
    { revision: 'short' },
    { allowedOrigins: ['https://www.example.com/path'] },
    { allowedOrigins: ['https://*.example.com'] },
    { allowedOrigins: ['javascript:alert(1)'] },
    {
      allowedOrigins: Array.from(
        { length: FORM_LIMITS.allowedOrigins + 1 },
        (_, index) => `https://site-${String(index)}.example.com`,
      ),
    },
    { status: 'published' },
    { publicKey: 'chosen-by-the-caller' },
  ])
    expect(updateFormInput.safeParse({ ...input, ...change }).success).toBe(false);
  const { revision: _revision, ...withoutRevision } = input;
  expect(updateFormInput.safeParse(withoutRevision).success).toBe(false);
});

it('lists forms and submissions in bounded pages', () => {
  expect(listForms.query.parse({})).toEqual({ limit: 25, archived: 'false' });
  expect(listFormSubmissions.query.parse({})).toEqual({ limit: 25 });
  for (const query of [{ limit: 0 }, { limit: 51 }, { after: 'con_01h455vb4pex5vsknk084sn02q' }]) {
    expect(listForms.query.safeParse(query).success).toBe(false);
    expect(listFormSubmissions.query.safeParse(query).success).toBe(false);
  }
  expect(listForms.query.safeParse({ archived: 'yes' }).success).toBe(false);
  // A form's submissions of one lead source: by the built-in rule's key, from the closed list.
  expect(listFormSubmissions.query.parse({ leadSourceRule: 'google_ads' })).toEqual({
    limit: 25,
    leadSourceRule: 'google_ads',
  });
  expect(listFormSubmissions.query.safeParse({ leadSourceRule: 'source_param' }).success).toBe(
    true,
  );
  for (const leadSourceRule of ['Google Ads', 'vip', ''])
    expect(listFormSubmissions.query.safeParse({ leadSourceRule }).success, leadSourceRule).toBe(
      false,
    );
});

it('describes a form and a submission strictly, so nothing extra can leave with them', () => {
  const stored = {
    id: 'form_01h455vb4pex5vsknk084sn02q',
    name: 'Enquiry',
    status: 'published',
    publicKey: 'k'.repeat(32),
    allowedOrigins: ['https://www.example.com'],
    definition: DEFAULT_FORM_DEFINITION,
    publishedDefinition: DEFAULT_FORM_DEFINITION,
    publishedAt: '2026-10-10T09:00:00.000Z',
    hasUnpublishedChanges: false,
    problems: [],
    embedSnippet: '<script async src="https://crm.example.test/forms/embed.js"></script>',
    hostedUrl: `https://crm.example.test/f/${'k'.repeat(32)}`,
    submissionCount: 3,
    revision: 'a'.repeat(64),
    canManage: true,
    createdAt: '2026-10-10T09:00:00.000Z',
    updatedAt: '2026-10-10T09:00:00.000Z',
  };
  expect(form.parse(stored)).toEqual(stored);
  expect(form.safeParse({ ...stored, businessId: 'biz_1' }).success).toBe(false);
  const received = {
    id: 'fsub_01h455vb4pex5vsknk084sn02q',
    submittedAt: '2026-10-10T09:00:00.000Z',
    contactId: 'con_01h455vb4pex5vsknk084sn02q',
    contactOutcome: 'created',
    answers: [
      { key: 'email', label: 'Email', value: 'maya@example.test' },
      { key: 'agree', label: 'Agree', value: true },
      { key: 'notes', label: 'Notes', value: null },
      // The keys of the choices of a question that takes several.
      { key: 'interests', label: 'Interests', value: ['venue', 'food'] },
    ],
    terms: [
      {
        key: 'rules',
        wording: 'I accept the terms.',
        linkUrl: 'https://www.example.com/terms',
        accepted: true,
      },
      { key: 'age', wording: 'I am over 18.', linkUrl: null, accepted: false },
    ],
    consents: [{ key: 'news', channel: 'email', wording: 'Email me news.', outcome: 'granted' }],
    skippedFields: [],
    origin: 'https://www.example.com',
    pageUrl: 'https://www.example.com/contact',
    ipAddress: '203.0.113.9',
    utm: { source: 'newsletter' },
    leadSource: 'Email',
    leadSourceRule: 'email',
  };
  expect(formSubmission.parse(received)).toEqual(received);
  expect(formSubmission.safeParse({ ...received, userAgent: 'Browser' }).success).toBe(false);
  expect(
    formSubmission.safeParse({ ...received, contactId: null, contactOutcome: 'unresolved' })
      .success,
  ).toBe(true);
});

it('shows a visitor the questions and never where the answers go', () => {
  const shown = {
    title: 'Ask us',
    description: '',
    submitLabel: 'Send',
    successMessage: 'Thank you.',
    fields: [
      { key: 'email', type: 'email', label: 'Email', helpText: '', required: true, options: [] },
    ],
    consents: [{ key: 'news', wording: 'Email me news.', required: false }],
    renderToken: token,
    textLength: FORM_LIMITS.textLength,
    longTextLength: FORM_LIMITS.longTextLength,
  };
  expect(publicForm.parse(shown)).toEqual(shown);
  const [first] = shown.fields;
  for (const extra of [
    { fields: [{ ...first, target: { kind: 'contact', attribute: 'email' } }] },
    { fields: [{ ...first, fieldId }] },
    { consents: [{ key: 'news', wording: 'Email me news.', required: false, channel: 'email' }] },
    { id: 'form_01h455vb4pex5vsknk084sn02q' },
    { allowedOrigins: ['https://www.example.com'] },
    { renderToken: 'not-a-token' },
  ])
    expect(publicForm.safeParse({ ...shown, ...extra }).success).toBe(false);
});

it('takes a submission as an id, the proof of when the form was shown, and bounded answers', () => {
  expect(publicFormSubmissionInput.parse(submission())).toEqual({
    ...submission(),
    trap: '',
  });
  expect(
    publicFormSubmissionInput.parse(
      submission({
        values: { agree: true, notes: 'x'.repeat(FORM_LIMITS.longTextLength) },
        consents: { news: true, texts: false },
        trap: 'https://spam.example',
        pageUrl: 'https://www.example.com/contact?utm_source=newsletter',
      }),
    ).trap,
  ).toBe('https://spam.example');
  for (const change of [
    { clientSubmissionId: 'not-a-uuid' },
    { renderToken: '1790000000000' },
    { renderToken: `179000000000.${'A'.repeat(43)}` },
    { renderToken: `1790000000000.${'A'.repeat(42)}` },
    { values: { notes: 'x'.repeat(FORM_LIMITS.longTextLength + 1) } },
    { values: { count: 3 } },
    // Several choices are a list of their keys: nothing but short text, and no more of
    // them than a question can list.
    { values: { tags: [1] } },
    { values: { tags: [['a']] } },
    { values: { tags: ['x'.repeat(41)] } },
    { values: { tags: Array.from({ length: FORM_LIMITS.options + 1 }, () => 'a') } },
    { values: { nested: { a: 'b' } } },
    { values: { 'Not-A-Key': 'x' } },
    { values: null },
    { consents: { news: 'yes' } },
    { consents: { 'Not-A-Key': true } },
    { trap: 'x'.repeat(201) },
    { pageUrl: 'javascript:alert(1)' },
    { pageUrl: `https://www.example.com/${'x'.repeat(FORM_LIMITS.pageUrlLength)}` },
    { contactId: 'con_01h455vb4pex5vsknk084sn02q' },
    { businessId: 'biz_01h455vb4pex5vsknk084sn02q' },
    { ipAddress: '203.0.113.9' },
  ])
    expect(publicFormSubmissionInput.safeParse(submission(change)).success).toBe(false);
  const { clientSubmissionId: _id, ...withoutId } = submission();
  expect(publicFormSubmissionInput.safeParse(withoutId).success).toBe(false);
  const tooMany = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${String(index)}`, 'x']));
  expect(
    publicFormSubmissionInput.safeParse(submission({ values: tooMany(FORM_LIMITS.fields) }))
      .success,
  ).toBe(true);
  expect(
    publicFormSubmissionInput.safeParse(submission({ values: tooMany(FORM_LIMITS.fields + 1) }))
      .success,
  ).toBe(false);
  expect(
    publicFormSubmissionInput.safeParse(
      submission({ consents: { a: true, b: true, c: true, d: true, e: true } }),
    ).success,
  ).toBe(false);
});

it('answers a submission with one word and nothing about the contact', () => {
  expect(publicFormReceipt.parse({ status: 'received' })).toEqual({ status: 'received' });
  for (const answer of [
    { status: 'received', contactId: 'con_01h455vb4pex5vsknk084sn02q' },
    { status: 'received', created: true },
    { status: 'duplicate' },
  ])
    expect(publicFormReceipt.safeParse(answer).success).toBe(false);
});

it('keeps the admin endpoints in the API and the public ones out of it', () => {
  for (const endpoint of formAdminEndpoints) {
    expect(endpoints).toContain(endpoint);
    expect(endpoint).not.toHaveProperty('audience');
    expect(endpoint.path.startsWith('/forms')).toBe(true);
  }
  for (const endpoint of publicFormEndpoints) {
    expect(endpoints).not.toContain(endpoint);
    expect(endpoint.audience).toBe('public');
  }
  // A published form is named by its key, a draft by a preview link's token.
  expect(publicFormEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
    'get /public/forms/{formKey}',
    'post /public/forms/{formKey}/submissions',
    'post /public/forms/{formKey}/challenge',
    'get /public/forms/preview/{previewToken}',
    'post /public/forms/preview/{previewToken}/submissions',
    'post /public/forms/preview/{previewToken}/challenge',
  ]);
  expect(formAdminEndpoints.map((endpoint) => endpoint.operationId)).toEqual([
    'listForms',
    'createForm',
    'getForm',
    'updateForm',
    'publishForm',
    'unpublishForm',
    'archiveForm',
    'restoreForm',
    'listFormSubmissions',
    'discardFormSubmission',
    'getFormPreview',
    'getFormAnalytics',
  ]);
  // The two that were added only read: neither changes a form.
  expect(getFormPreview.method).toBe('get');
  expect(getFormAnalytics.method).toBe('get');
  expect(FORM_PAGE_PATH).toBe('/f');
  expect(FORM_PREVIEW_PAGE_PATH).toBe('/f/preview');
});

// What forms gained after the first eight kinds of question ------------------------------

const only = (change: Record<string, unknown>) => issuesOf(definition({ fields: [field(change)] }));

it('reads a definition stored before the newer kinds as it was written', () => {
  // Nothing a question did not have is added to it: a stored form and what was published
  // of it go on comparing equal, and neither gains a setting nobody chose.
  const stored = {
    title: 'Ask us',
    description: '',
    submitLabel: 'Send',
    successMessage: 'Thank you.',
    fields: [
      {
        key: 'venue',
        type: 'single_choice',
        label: 'Venue',
        helpText: '',
        required: false,
        options: [{ key: 'harbor', label: 'Harbor room' }],
        target: { kind: 'none' },
      },
    ],
    consents: [],
  };
  expect(formDefinition.parse(stored)).toEqual(stored);
  expect(JSON.stringify(formDefinition.parse(stored))).toBe(JSON.stringify(stored));
  // A new form says what a submission does to its contact; an old one says nothing.
  expect(DEFAULT_FORM_DEFINITION.contactActions).toEqual({
    tagIds: [],
    source: { kind: 'arrived' },
    tagBySource: true,
  });
  expect(formDefinition.parse(DEFAULT_FORM_DEFINITION)).toEqual(DEFAULT_FORM_DEFINITION);
});

it('shows a choice question as a dropdown, radio buttons or checkboxes, as its kind allows', () => {
  expect(formChoiceDisplays).toEqual({
    single_choice: ['dropdown', 'radio'],
    multi_choice: ['dropdown', 'checkboxes'],
  });
  for (const type of ['single_choice', 'multi_choice'] as const)
    for (const display of formFieldDisplays) {
      const allowed: readonly string[] = formChoiceDisplays[type];
      expect(only({ ...ofType(type), display }), `${type} as ${display}`).toEqual(
        allowed.includes(display)
          ? []
          : ['fields/0/display: This kind of choice question cannot be shown that way.'],
      );
    }
  expect(only({ display: 'radio' })).toEqual([
    'fields/0/display: Only a choice question has a way of showing its choices.',
  ]);
  expect(
    formDefinition.safeParse(definition({ fields: [field({ display: 'grid' })] })).success,
  ).toBe(false);
  // Several of several: choices like any other, each once.
  expect(
    only({
      type: 'multi_choice',
      options: [
        { key: 'a', label: 'A' },
        { key: 'a', label: 'Again' },
      ],
    }),
  ).toEqual(['fields/0/options/1/key: This choice is already listed.']);
});

it('lets a question that is typed into show an example, and no other', () => {
  for (const type of formFieldTypes) {
    const typed: readonly string[] = formPlaceholderTypes;
    expect(only({ ...ofType(type), placeholder: 'For example' }), type).toEqual(
      typed.includes(type)
        ? []
        : ['fields/0/placeholder: Only a question a visitor types into has an example.'],
    );
    // An empty example is no example, whatever the kind.
    expect(only({ ...ofType(type), placeholder: '' }), type).toEqual([]);
  }
  for (const placeholder of ['x'.repeat(FORM_LIMITS.placeholderLength + 1), 'Two\nlines'])
    expect(formDefinition.safeParse(definition({ fields: [field({ placeholder })] })).success).toBe(
      false,
    );
});

it('fills a hidden question from a named part of the page address, or a fixed answer', () => {
  const hidden = (change: Record<string, unknown>) => only({ type: 'hidden', ...change });
  expect(hidden({ parameter: 'utm_campaign' })).toEqual([]);
  expect(hidden({ parameter: 'ref', defaultValue: 'direct' })).toEqual([]);
  expect(hidden({ defaultValue: 'Summer fair' })).toEqual([]);
  expect(hidden({})).toEqual([
    'fields/0/parameter: Name the part of the page address to read, or give a fixed answer.',
  ]);
  expect(hidden({ defaultValue: '' })).toEqual([
    'fields/0/parameter: Name the part of the page address to read, or give a fixed answer.',
  ]);
  // A visitor cannot answer what they are not shown.
  expect(hidden({ parameter: 'ref', required: true })).toEqual([
    'fields/0/required: This cannot be required: a visitor cannot answer it.',
  ]);
  // It fills a custom field or is kept with the submission; no part of the contact is "hidden".
  expect(hidden({ parameter: 'ref', target: { kind: 'field', fieldId } })).toEqual([]);
  for (const parameter of ['', '1st', 'a b', 'utm[campaign]', 'a'.repeat(61), 'x&y=1', 'ref#top'])
    expect(
      formDefinition.safeParse(definition({ fields: [field({ type: 'hidden', parameter })] }))
        .success,
      parameter,
    ).toBe(false);
  for (const parameter of ['ref', 'utm_campaign', 'gclid', 'a.b-c_d', 'A1'])
    expect(hidden({ parameter }), parameter).toEqual([]);
  expect(
    formDefinition.safeParse(
      definition({
        fields: [
          field({
            type: 'hidden',
            parameter: 'ref',
            defaultValue: 'x'.repeat(FORM_LIMITS.textLength + 1),
          }),
        ],
      }),
    ).success,
  ).toBe(false);
  // A question a visitor types into, or picks one choice of, may name a parameter too: its
  // "query key", which fills the control when the form is shown.
  for (const type of formPrefillTypes)
    expect(
      only({
        type,
        parameter: 'ref',
        ...(type === 'single_choice' ? { options: [{ key: 'a', label: 'A' }] } : {}),
      }),
      type,
    ).toEqual([]);
  expect(formPrefillTypes).toEqual([
    'text',
    'long_text',
    'email',
    'phone',
    'number',
    'date',
    'url',
    'single_choice',
  ]);
  // No other kind reads the address, and only a hidden question has a fixed answer.
  for (const type of ['checkbox', 'rating', 'terms', 'content'] as const)
    expect(
      only({
        type,
        parameter: 'ref',
        ...(type === 'terms' || type === 'content' ? { text: 'Words' } : {}),
      }),
      type,
    ).toEqual([
      'fields/0/parameter: This kind of question cannot be filled from the page address.',
    ]);
  expect(
    only({
      type: 'multi_choice',
      parameter: 'ref',
      options: [{ key: 'a', label: 'A' }],
    }),
  ).toEqual(['fields/0/parameter: This kind of question cannot be filled from the page address.']);
  expect(only({ defaultValue: 'x' })).toEqual([
    'fields/0/defaultValue: Only a hidden question has a fixed answer.',
  ]);
});

it('shows a block of plain text between questions, which asks nothing', () => {
  const content = (change: Record<string, unknown>) => only({ type: 'content', ...change });
  expect(content({ text: 'About you' })).toEqual([]);
  expect(content({ text: 'Line one\nLine two', style: 'paragraph' })).toEqual([]);
  expect(content({ text: 'About you', style: 'heading' })).toEqual([]);
  expect(content({})).toEqual(['fields/0/text: Enter the text to show.']);
  expect(content({ text: '   ' })).toEqual(['fields/0/text: Enter the text to show.']);
  expect(content({ text: 'About you', required: true })).toEqual([
    'fields/0/required: This cannot be required: a visitor cannot answer it.',
  ]);
  expect(content({ text: 'About you', target: { kind: 'field', fieldId } })).toEqual([
    'fields/0/target: A block of text has no answer.',
  ]);
  // Markup is text: stored as typed, for the embed to show as the characters it is made of.
  const marked = formDefinition.parse(
    definition({ fields: [field({ type: 'content', text: '<b>Bold</b> <script>x</script>' })] }),
  );
  expect(marked.fields[0]?.text).toBe('<b>Bold</b> <script>x</script>');
  for (const change of [
    { text: 'x'.repeat(FORM_LIMITS.contentLength + 1) },
    { text: 'Bell\u0007' },
    { text: 'About you', style: 'banner' },
    { text: 'About you', html: '<b>bold</b>' },
  ])
    expect(
      formDefinition.safeParse(definition({ fields: [field({ type: 'content', ...change })] }))
        .success,
    ).toBe(false);
  expect(only({ text: 'Words' })).toEqual([
    'fields/0/text: Only a block of text or a terms box has words of its own.',
  ]);
  expect(only({ style: 'heading' })).toEqual(['fields/0/style: Only a block of text has a style.']);
});

it('offers a terms box with its own wording and a secure link, kept with the submission', () => {
  const terms = (change: Record<string, unknown>) => only({ type: 'terms', ...change });
  expect(terms({ text: 'I accept the terms.' })).toEqual([]);
  expect(terms({ text: 'I accept the terms.', required: true })).toEqual([]);
  expect(
    terms({
      text: 'I accept the terms.',
      linkUrl: 'https://www.example.com/terms',
      linkLabel: 'Read them',
    }),
  ).toEqual([]);
  expect(terms({ text: 'I accept the terms.', linkUrl: 'https://www.example.com/terms' })).toEqual(
    [],
  );
  expect(terms({})).toEqual(['fields/0/text: Enter the wording of the box.']);
  expect(terms({ text: 'I accept.', linkLabel: 'Read them' })).toEqual([
    'fields/0/linkLabel: Give the address the link opens.',
  ]);
  expect(terms({ text: 'I accept.', target: { kind: 'field', fieldId } })).toEqual([
    'fields/0/target: A terms box is kept with the submission only.',
  ]);
  for (const linkUrl of [
    'http://www.example.com/terms',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/terms',
    'www.example.com/terms',
    `https://www.example.com/${'t'.repeat(FORM_LIMITS.urlLength)}`,
  ])
    expect(
      formDefinition.safeParse(
        definition({ fields: [field({ type: 'terms', text: 'I accept.', linkUrl })] }),
      ).success,
      linkUrl,
    ).toBe(false);
  expect(only({ linkUrl: 'https://www.example.com/terms' })).toEqual([
    'fields/0/linkUrl: Only a terms box has a link.',
  ]);
  expect(only({ linkLabel: 'Read them' })).toEqual([
    'fields/0/linkLabel: Only a terms box has a link.',
  ]);
  // It shares the form's one namespace of keys with the questions and the consent boxes.
  expect(
    issuesOf(
      definition({
        fields: [field({ key: 'news', type: 'terms', text: 'I accept.' })],
        consents: [{ key: 'news', channel: 'email', wording: 'Send me news.' }],
      }),
    ),
  ).toEqual(['consents/0/key: This key is already used in this form.']);
});

it('shows the success message once a form is sent, or sends the visitor to a secure address', () => {
  expect(formDefinition.parse(definition()).afterSubmit).toBeUndefined();
  for (const afterSubmit of [
    { kind: 'message' },
    { kind: 'redirect', url: 'https://www.example.com/thanks?from=form' },
  ])
    expect(formDefinition.parse(definition({ afterSubmit })).afterSubmit).toEqual(afterSubmit);
  for (const afterSubmit of [
    { kind: 'redirect' },
    { kind: 'redirect', url: 'http://www.example.com/thanks' },
    { kind: 'redirect', url: 'javascript:alert(1)' },
    { kind: 'redirect', url: '//www.example.com/thanks' },
    { kind: 'redirect', url: '/thanks' },
    { kind: 'redirect', url: `https://www.example.com/${'t'.repeat(FORM_LIMITS.urlLength)}` },
    { kind: 'message', url: 'https://www.example.com/thanks' },
    { kind: 'close' },
  ])
    expect(
      formDefinition.safeParse(definition({ afterSubmit })).success,
      JSON.stringify(afterSubmit),
    ).toBe(false);
});

it('says what a submission does to its contact: tags to add, and a source if it has none', () => {
  // Naming nothing: the source is how they arrived, and no tag is added for it.
  expect(formDefinition.parse(definition({ contactActions: {} })).contactActions).toEqual({
    tagIds: [],
    source: { kind: 'arrived' },
    tagBySource: false,
  });
  const actions = {
    tagIds: [tagId, 'tag_01h455vb4pex5vsknk084sn02r'],
    source: { kind: 'text', text: ' Trade fair 2026 ' },
  };
  expect(formDefinition.parse(definition({ contactActions: actions })).contactActions).toEqual({
    tagIds: actions.tagIds,
    source: { kind: 'text', text: 'Trade fair 2026' },
    tagBySource: false,
  });
  // The four sources, and the tag of the lead source beside any of them.
  for (const source of [
    { kind: 'arrived' },
    { kind: 'form_name' },
    { kind: 'none' },
    { kind: 'text', text: 'Fair' },
  ])
    expect(
      formDefinition.parse(definition({ contactActions: { source, tagBySource: true } }))
        .contactActions,
    ).toEqual({ tagIds: [], source, tagBySource: true });
  // What migration 0091 writes into a form that was on "the name of this form".
  expect(
    formDefinition.parse(
      definition({
        contactActions: { tagIds: [tagId], source: { kind: 'arrived' }, tagBySource: true },
      }),
    ).contactActions,
  ).toEqual({ tagIds: [tagId], source: { kind: 'arrived' }, tagBySource: true });
  for (const contactActions of [
    { source: { kind: 'arrived', text: 'x' } },
    { source: { kind: 'arrival' } },
    { tagBySource: 'yes' },
    { tagBySource: null },
  ])
    expect(
      formDefinition.safeParse(definition({ contactActions })).success,
      JSON.stringify(contactActions),
    ).toBe(false);
  expect(
    formDefinition.parse(definition({ contactActions: { source: { kind: 'none' } } }))
      .contactActions?.source,
  ).toEqual({ kind: 'none' });
  expect(issuesOf(definition({ contactActions: { tagIds: [tagId, tagId] } }))).toEqual([
    'contactActions/tagIds/1: This tag is already listed.',
  ]);
  for (const contactActions of [
    { tagIds: ['VIP'] },
    { tagIds: [fieldId] },
    {
      tagIds: Array.from({ length: FORM_LIMITS.tags + 1 }, (_, index) =>
        tagId.replace(/q$/, 'abcdefghjkmn'.charAt(index)),
      ),
    },
    { source: { kind: 'text' } },
    { source: { kind: 'text', text: '  ' } },
    { source: { kind: 'text', text: 'x'.repeat(201) } },
    { source: { kind: 'form_name', text: 'x' } },
    { source: 'Website' },
    { ownerId: memberId },
    { createTags: ['VIP'] },
  ])
    expect(
      formDefinition.safeParse(definition({ contactActions })).success,
      JSON.stringify(contactActions).slice(0, 60),
    ).toBe(false);
});

it('says who is told of a submission: the managers, nobody, the contact’s owner or listed people', () => {
  expect(formDefinition.parse(definition()).notify).toBeUndefined();
  for (const notify of [
    { mode: 'managers' },
    { mode: 'nobody' },
    { mode: 'contact_owner' },
    { mode: 'members', memberIds: [memberId] },
  ])
    expect(formDefinition.parse(definition({ notify })).notify).toEqual(notify);
  expect(
    issuesOf(definition({ notify: { mode: 'members', memberIds: [memberId, memberId] } })),
  ).toEqual(['notify/memberIds/1: This person is already listed.']);
  for (const notify of [
    { mode: 'members' },
    { mode: 'members', memberIds: [] },
    { mode: 'members', memberIds: ['maya@example.test'] },
    { mode: 'members', memberIds: [tagId] },
    { mode: 'nobody', memberIds: [memberId] },
    { mode: 'everyone' },
    { mode: 'managers', email: 'maya@example.test' },
  ])
    expect(formDefinition.safeParse(definition({ notify })).success, JSON.stringify(notify)).toBe(
      false,
    );
});

it('gives a preview as a link and the time it runs out, and names a draft by a token', () => {
  const preview = {
    url: `https://crm.example.test/f/preview/${'A'.repeat(70)}.${'B'.repeat(22)}`,
    expiresAt: '2026-10-12T10:30:00.000Z',
  };
  expect(formPreview.parse(preview)).toEqual(preview);
  expect(formPreview.safeParse({ ...preview, token: 'x' }).success).toBe(false);
  expect(getFormPreview.path).toBe('/forms/{id}/preview');
  expect(formPreviewToken.safeParse(`${'A'.repeat(70)}.${'B'.repeat(22)}`).success).toBe(true);
  for (const bad of [
    token,
    'k'.repeat(32),
    `${'A'.repeat(69)}.${'B'.repeat(22)}`,
    `${'A'.repeat(70)}.${'B'.repeat(23)}`,
    `${'A'.repeat(70)}/${'B'.repeat(22)}`,
    `${'A'.repeat(70)}x${'B'.repeat(22)}`,
    `${'A'.repeat(69)}+.${'B'.repeat(22)}`,
  ]) {
    expect(formPreviewToken.safeParse(bad).success, bad).toBe(false);
    expect(getPublicFormPreview.params.safeParse({ previewToken: bad }).success).toBe(false);
  }
});

it('reads a form’s numbers over a bounded range of days', () => {
  const query = getFormAnalytics.query;
  expect(query.parse({})).toEqual({});
  expect(query.parse({ from: '2026-10-01', to: '2026-10-12' })).toEqual({
    from: '2026-10-01',
    to: '2026-10-12',
  });
  expect(query.safeParse({ from: '2026-10-12', to: '2026-10-12' }).success).toBe(true);
  // 366 days, both ends counted, and no more.
  expect(query.safeParse({ from: '2025-10-12', to: '2026-10-12' }).success).toBe(true);
  const refused = (value: unknown) => {
    const parsed = query.safeParse(value);
    return parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('/')}: ${issue.message}`);
  };
  expect(refused({ from: '2025-10-11', to: '2026-10-12' })).toEqual([
    'to: Ask for at most 366 days at a time.',
  ]);
  expect(refused({ from: '2026-10-12', to: '2026-10-11' })).toEqual([
    'to: End the range on or after the day it starts.',
  ]);
  for (const bad of [
    { from: '12/10/2026' },
    { to: '2026-02-30' },
    { from: '2026-10-01T00:00:00Z' },
    { from: '2026-10-01', to: '2026-10-12', timeZone: 'UTC' },
  ])
    expect(query.safeParse(bad).success, JSON.stringify(bad)).toBe(false);

  const numbers = {
    from: '2026-10-11',
    to: '2026-10-12',
    timeZone: 'Africa/Nairobi',
    totals: { views: 10, responses: 4, completionRate: 0.4, averageSeconds: 41.5 },
    days: [
      { date: '2026-10-11', views: 10, responses: 4, completionRate: 0.4, averageSeconds: 41.5 },
      { date: '2026-10-12', views: 0, responses: 0, completionRate: null, averageSeconds: null },
    ],
  };
  expect(formAnalytics.parse(numbers)).toEqual(numbers);
  for (const totals of [
    { ...numbers.totals, completionRate: 1.2 },
    { ...numbers.totals, views: -1 },
    { ...numbers.totals, responses: 1.5 },
    { ...numbers.totals, averageSeconds: -3 },
    { ...numbers.totals, visitors: 7 },
  ])
    expect(formAnalytics.safeParse({ ...numbers, totals }).success).toBe(false);
});

it('shows a visitor what each newer kind needs, and still never where an answer goes', () => {
  const shown = {
    title: '',
    description: '',
    submitLabel: 'Send',
    successMessage: 'Thank you.',
    redirectUrl: 'https://www.example.com/thanks',
    fields: [
      {
        key: 'room',
        type: 'single_choice',
        label: 'Room',
        helpText: '',
        required: false,
        options: [{ key: 'harbor', label: 'Harbor' }],
        display: 'radio',
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
      // The label of a block of text and a terms box is not shown, and is not sent.
      {
        key: 'intro',
        type: 'content',
        label: '',
        helpText: '',
        required: false,
        options: [],
        text: 'About you',
        style: 'heading',
      },
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
        key: 'site',
        type: 'url',
        label: 'Website',
        helpText: '',
        required: false,
        options: [],
        placeholder: 'https://',
      },
    ],
    consents: [],
    renderToken: token,
    textLength: FORM_LIMITS.textLength,
    longTextLength: FORM_LIMITS.longTextLength,
  };
  expect(publicForm.parse(shown)).toEqual(shown);
  const [first] = shown.fields;
  for (const extra of [
    { fields: [{ ...first, defaultValue: 'Fixed' }] },
    { fields: [{ ...first, display: 'grid' }] },
    { fields: [{ ...first, parameter: 'not a parameter' }] },
    { afterSubmit: { kind: 'redirect', url: 'https://www.example.com/thanks' } },
    { contactActions: { tagIds: [tagId] } },
    { notify: { mode: 'nobody' } },
  ])
    expect(
      publicForm.safeParse({ ...shown, ...extra }).success,
      JSON.stringify(extra).slice(0, 50),
    ).toBe(false);
});
