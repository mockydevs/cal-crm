import {
  DEFAULT_FORM_DEFINITION,
  formDefinition,
  formFieldTypes,
  formFieldValueTypes,
  formPrefillTypes,
  updateFormInput,
  type FieldDefinition,
  type FormDefinition,
  type FormField,
} from '@repo/contracts';
import { expect, it } from 'vitest';

import {
  choiceKey,
  draftOf,
  freeChannels,
  inputOf,
  isChanged,
  moved,
  newKey,
  placed,
  retargeted,
  retyped,
  takes,
  takesQueryKey,
  targetChoices,
  targetOf,
  targetValue,
  withExtra,
  websiteLines,
  withConsent,
  withConsentChange,
  withField,
  withQuestion,
} from './forms-rules';

const contactField = (
  id: string,
  valueType: FieldDefinition['valueType'],
  change: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  id,
  objectKey: 'contact',
  key: id.slice(-6),
  label: `Field ${id.slice(-2)}`,
  description: '',
  valueType,
  currency: null,
  options: [],
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived: false,
  revision: 'a'.repeat(64),
  ...change,
});
const budget = contactField('fld_01h455vb4pex5vsknk084sn02q', 'number');
const venue = contactField('fld_01h455vb4pex5vsknk084sn02r', 'single_choice', {
  options: [
    { key: 'harbor', label: 'Harbor room', description: '', archived: false },
    { key: 'cellar', label: 'Cellar', description: '', archived: true },
    { key: 'garden', label: 'Garden', description: '', archived: false },
  ],
});
const notes = contactField('fld_01h455vb4pex5vsknk084sn02s', 'long_text');
const old = contactField('fld_01h455vb4pex5vsknk084sn02t', 'text', { archived: true });
const dealField = contactField('fld_01h455vb4pex5vsknk084sn02v', 'text', { objectKey: 'deal' });
const fields = [budget, venue, notes, old, dealField];
const form = {
  name: 'Enquiry',
  allowedOrigins: ['https://www.example.com', 'https://shop.example.com'],
  definition: DEFAULT_FORM_DEFINITION,
};
const question = (change: Partial<FormField> = {}): FormField => ({
  key: 'q1',
  type: 'text',
  label: 'Question',
  helpText: '',
  required: false,
  options: [],
  target: { kind: 'none' },
  ...change,
});
const withFields = (...added: FormField[]): FormDefinition => ({
  ...DEFAULT_FORM_DEFINITION,
  fields: [...DEFAULT_FORM_DEFINITION.fields, ...added],
});

it('holds a form as the builder shows it, and gives it back as the API takes it', () => {
  const draft = draftOf(form);
  expect(draft).toEqual({
    name: 'Enquiry',
    websites: 'https://www.example.com\nhttps://shop.example.com',
    definition: DEFAULT_FORM_DEFINITION,
  });
  const input = inputOf(
    { ...draft, websites: '  https://www.example.com \r\n\n https://shop.example.com\n' },
    'a'.repeat(64),
  );
  expect(input).toEqual({
    name: 'Enquiry',
    definition: DEFAULT_FORM_DEFINITION,
    allowedOrigins: ['https://www.example.com', 'https://shop.example.com'],
    revision: 'a'.repeat(64),
  });
  // Exactly what the API's schema takes.
  expect(updateFormInput.safeParse(input).success).toBe(true);
  expect(websiteLines('')).toEqual([]);
  expect(websiteLines(' \n\t\n')).toEqual([]);
});

it('knows when the builder holds something the saved form does not', () => {
  const saved = draftOf(form);
  expect(isChanged(saved, saved)).toBe(false);
  // The same websites typed with other spacing, and a name with spaces around it, are no change.
  expect(
    isChanged(
      {
        ...saved,
        name: ' Enquiry ',
        websites: ' https://www.example.com\n\nhttps://shop.example.com ',
      },
      saved,
    ),
  ).toBe(false);
  expect(isChanged({ ...saved, name: 'Enquiries' }, saved)).toBe(true);
  expect(isChanged({ ...saved, websites: 'https://www.example.com' }, saved)).toBe(true);
  expect(isChanged({ ...saved, definition: { ...saved.definition, title: 'Ask us' } }, saved)).toBe(
    true,
  );
});

it('gives every new question and box a key the form does not have yet', () => {
  expect(newKey('q', [])).toBe('q1');
  expect(newKey('q', ['q1', 'q2', 'q4'])).toBe('q3');
  const one = withQuestion(DEFAULT_FORM_DEFINITION, 'New question');
  const two = withQuestion(one, 'New question');
  expect(two.fields.map((field) => field.key)).toEqual(['first_name', 'email', 'q1', 'q2']);
  expect(two.fields.at(-1)).toEqual({
    key: 'q2',
    type: 'text',
    label: 'New question',
    helpText: '',
    required: false,
    options: [],
    target: { kind: 'none' },
  });
  // A key a consent box has is taken too: questions and boxes share one namespace.
  const boxed = withConsent(
    {
      ...DEFAULT_FORM_DEFINITION,
      consents: [{ key: 'q1', channel: 'sms', wording: 'Texts.', required: false }],
    },
    'Email me news.',
  );
  expect(withQuestion(boxed, 'New question').fields.at(-1)?.key).toBe('q2');
  // Whatever the builder makes, the API's schema takes.
  expect(formDefinition.safeParse(two).success).toBe(true);
  expect(formDefinition.safeParse(boxed).success).toBe(true);
});

it('adds a consent box for each channel once, and none after that', () => {
  expect(freeChannels(DEFAULT_FORM_DEFINITION)).toEqual(['email', 'sms']);
  const one = withConsent(DEFAULT_FORM_DEFINITION, 'Email me news.');
  expect(one.consents).toEqual([
    { key: 'consent1', channel: 'email', wording: 'Email me news.', required: false },
  ]);
  const two = withConsent(one, 'Text me offers.');
  expect(two.consents.map((consent) => [consent.key, consent.channel])).toEqual([
    ['consent1', 'email'],
    ['consent2', 'sms'],
  ]);
  expect(freeChannels(two)).toEqual([]);
  expect(withConsent(two, 'More')).toBe(two);
  // The first box moved to texts leaves email free again.
  const moved = withConsentChange(one, 0, { channel: 'sms', required: true });
  expect(moved.consents[0]).toMatchObject({
    channel: 'sms',
    required: true,
    wording: 'Email me news.',
  });
  expect(freeChannels(moved)).toEqual(['email']);
  expect(withConsentChange(one, 5, { required: true })).toEqual(one);
});

it('makes a choice key from its label, and a numbered one when the label gives none', () => {
  expect(choiceKey('Harbor room', [])).toBe('harbor_room');
  expect(choiceKey('  More than 50 guests!  ', [])).toBe('more_than_50_guests');
  expect(choiceKey('Café Zoë', [])).toBe('cafe_zoe');
  expect(choiceKey('Harbor room', ['harbor_room'])).toBe('harbor_room_1');
  expect(choiceKey('Harbor room', ['harbor_room', 'harbor_room_1'])).toBe('harbor_room_2');
  // Nothing to start a key with: digits first, symbols only, another script.
  expect(choiceKey('50+', [])).toBe('choice1');
  expect(choiceKey('!!!', ['choice1'])).toBe('choice2');
  expect(choiceKey('花園', [])).toBe('choice1');
  expect(choiceKey('', [])).toBe('choice1');
  const long = choiceKey('a'.repeat(80), []);
  expect(long).toHaveLength(36);
  // Every key it makes is one the API takes.
  for (const label of ['Harbor room', '50+', 'Café Zoë', 'a'.repeat(80), 'New choice'])
    expect(choiceKey(label, [])).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
});

it('moves one item a place up or down, and leaves the ends where they are', () => {
  expect(moved(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  expect(moved(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
  expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  expect(moved(['a'], 3, 1)).toEqual(['a']);
  const items = ['a', 'b'];
  expect(moved(items, 0, 1)).not.toBe(items);
  expect(items).toEqual(['a', 'b']);
});

it('changes one question and leaves the others as they are', () => {
  const changed = withField(DEFAULT_FORM_DEFINITION, 1, { label: 'Your email', required: false });
  expect(changed.fields[0]).toBe(DEFAULT_FORM_DEFINITION.fields[0]);
  expect(changed.fields[1]).toMatchObject({ key: 'email', label: 'Your email', required: false });
  expect(withField(DEFAULT_FORM_DEFINITION, 9, { label: 'x' })).toEqual(DEFAULT_FORM_DEFINITION);
});

it('writes a target as one value and reads it back, and reads nonsense as nowhere', () => {
  for (const target of [
    { kind: 'none' },
    { kind: 'contact', attribute: 'firstName' },
    { kind: 'contact', attribute: 'phone' },
    { kind: 'field', fieldId: budget.id },
  ] as const)
    expect(targetOf(targetValue(target))).toEqual(target);
  expect(targetValue({ kind: 'contact', attribute: 'email' })).toBe('contact:email');
  expect(targetValue({ kind: 'field', fieldId: budget.id })).toBe(`field:${budget.id}`);
  for (const value of ['', 'none', 'contact:timezone', 'contact', 'field:', 'deal:1'])
    expect(targetOf(value)).toEqual({ kind: 'none' });
});

it('offers a question the parts of a contact and the contact fields that take its kind of answer', () => {
  for (const type of formFieldTypes)
    for (const each of fields)
      expect(takes(each, type)).toBe(
        (formFieldValueTypes[type] as readonly string[]).includes(each.valueType),
      );
  const offered = (definition: FormDefinition, index: number) => {
    const choices = targetChoices(definition, index, fields);
    return { attributes: choices.attributes, fields: choices.fields.map((each) => each.id) };
  };
  // A short answer: first or last name, but the first name is another question's already.
  // Text fields of the contact only: not the archived one, and not a deal's.
  expect(offered(withFields(question()), 2)).toEqual({
    attributes: ['lastName'],
    fields: [notes.id],
  });
  expect(offered(withFields(question({ type: 'number' })), 2)).toEqual({
    attributes: [],
    fields: [budget.id],
  });
  expect(offered(withFields(question({ type: 'single_choice' })), 2)).toEqual({
    attributes: [],
    fields: [venue.id],
  });
  expect(offered(withFields(question({ type: 'phone' })), 2)).toEqual({
    attributes: ['phone'],
    fields: [],
  });
  // The email question keeps its own target on offer.
  expect(offered(DEFAULT_FORM_DEFINITION, 1)).toEqual({ attributes: ['email'], fields: [] });
  // A field another question fills is not offered twice.
  const both = withFields(
    question({ key: 'a', type: 'long_text', target: { kind: 'field', fieldId: notes.id } }),
    question({ key: 'b', type: 'long_text' }),
  );
  expect(offered(both, 2).fields).toEqual([notes.id]);
  expect(offered(both, 3).fields).toEqual([]);
  // A question's own saved target stays listed even when it no longer fits: an archived
  // field, so the select shows what is stored.
  const stale = withFields(question({ target: { kind: 'field', fieldId: old.id } }));
  expect(offered(stale, 2).fields).toEqual([notes.id, old.id]);
  expect(offered(DEFAULT_FORM_DEFINITION, 7)).toEqual({ attributes: [], fields: [] });
});

it('keeps a target only while the kind of answer still fits it, and choices only on a choice question', () => {
  const named = question({ target: { kind: 'contact', attribute: 'lastName' } });
  expect(retyped(named, 'text', fields).target).toEqual({ kind: 'contact', attribute: 'lastName' });
  expect(retyped(named, 'email', fields).target).toEqual({ kind: 'none' });
  const noted = question({ type: 'long_text', target: { kind: 'field', fieldId: notes.id } });
  // A short answer fits a long text field too; a number does not.
  expect(retyped(noted, 'text', fields).target).toEqual({ kind: 'field', fieldId: notes.id });
  expect(retyped(noted, 'number', fields).target).toEqual({ kind: 'none' });
  // A field that no longer exists fits nothing.
  const gone = question({ target: { kind: 'field', fieldId: 'fld_01h455vb4pex5vsknk084sn0zz' } });
  expect(retyped(gone, 'text', fields).target).toEqual({ kind: 'none' });
  const choice = question({
    type: 'single_choice',
    options: [{ key: 'a', label: 'A' }],
  });
  expect(retyped(choice, 'single_choice', fields).options).toEqual([{ key: 'a', label: 'A' }]);
  expect(retyped(choice, 'text', fields)).toMatchObject({
    type: 'text',
    options: [],
    target: { kind: 'none' },
  });
});

it('lets a visible question be filled from the page address, for the kinds the API takes it on', () => {
  // The same list as the contract's: a kind it refuses is never offered the box.
  for (const type of formFieldTypes)
    expect(takesQueryKey(type), type).toBe((formPrefillTypes as readonly string[]).includes(type));
  expect(takesQueryKey('text')).toBe(true);
  expect(takesQueryKey('multi_choice')).toBe(false);
  expect(takesQueryKey('hidden')).toBe(false);
  const keyed = question({ type: 'text', parameter: 'promo' });
  // The key stays while the new kind takes one, and goes when it does not.
  expect(retyped(keyed, 'email', fields).parameter).toBe('promo');
  expect(retyped(keyed, 'single_choice', fields).parameter).toBe('promo');
  expect(retyped(keyed, 'multi_choice', fields).parameter).toBeUndefined();
  expect(retyped(keyed, 'terms', fields).parameter).toBeUndefined();
  expect(retyped(question({ type: 'text' }), 'email', fields).parameter).toBeUndefined();
  // A hidden question keeps what it read, and hands it to no question people see.
  expect(retyped(keyed, 'hidden', fields).parameter).toBe('promo');
  expect(
    retyped(question({ type: 'hidden', parameter: 'utm_campaign' }), 'text', fields).parameter,
  ).toBeUndefined();
  // What the editor makes is what the API takes.
  expect(
    formDefinition.safeParse({
      ...DEFAULT_FORM_DEFINITION,
      fields: [question({ type: 'text', parameter: 'promo' })],
    }).success,
  ).toBe(true);
});

it('gives a choice question the choices of the contact field it fills, the ones still on offer', () => {
  const choice = question({ type: 'single_choice', options: [{ key: 'mine', label: 'Mine' }] });
  const filled = retargeted(choice, { kind: 'field', fieldId: venue.id }, fields);
  expect(filled.target).toEqual({ kind: 'field', fieldId: venue.id });
  expect(filled.options).toEqual([
    { key: 'harbor', label: 'Harbor room' },
    { key: 'garden', label: 'Garden' },
  ]);
  // Back to the submission only: the choices stay, to be edited freely again.
  expect(retargeted(filled, { kind: 'none' }, fields)).toMatchObject({
    target: { kind: 'none' },
    options: filled.options,
  });
  // A field that is not in the list changes nothing but the target.
  expect(
    retargeted(choice, { kind: 'field', fieldId: 'fld_01h455vb4pex5vsknk084sn0zz' }, fields)
      .options,
  ).toEqual(choice.options);
  // Any other kind of question just gets its target.
  expect(
    retargeted(question({ type: 'number' }), { kind: 'field', fieldId: budget.id }, fields),
  ).toMatchObject({
    target: { kind: 'field', fieldId: budget.id },
    options: [],
  });
});

it('puts each problem by the part of the form it is about', () => {
  const sorted = placed([
    { path: '/allowedOrigins', message: 'Add the website that will show this form.' },
    { path: '/allowedOrigins/1', message: 'Enter a secure website address.' },
    { path: '/name', message: 'Enter a name.' },
    { path: '/fields', message: 'Add at least one question.' },
    { path: '/fields/2/target', message: 'This contact field is archived.' },
    { path: '/fields/2/options/0/key', message: "This is not one of the contact field's choices." },
    { path: '/consents/0/channel', message: 'Ask for a phone number to offer this box.' },
    // As the API's schema reports them when the builder checks a draft before sending it.
    { path: '/definition/fields/0/label', message: 'Give the question a label.' },
    { path: '/definition/consents/1/wording', message: 'Enter the wording of the box.' },
    { path: '/definition/submitLabel', message: 'Give the button a label.' },
    { path: '', message: 'This form changed since you opened it.' },
  ]);
  expect(sorted.websites).toEqual([
    'Add the website that will show this form.',
    'Enter a secure website address.',
  ]);
  expect(sorted.name).toEqual(['Enter a name.']);
  expect([...sorted.fields]).toEqual([
    [2, ['This contact field is archived.', "This is not one of the contact field's choices."]],
    [0, ['Give the question a label.']],
  ]);
  expect([...sorted.consents]).toEqual([
    [0, ['Ask for a phone number to offer this box.']],
    [1, ['Enter the wording of the box.']],
  ]);
  expect(sorted.form).toEqual([
    'Add at least one question.',
    'Give the button a label.',
    'This form changed since you opened it.',
  ]);
  expect(placed([])).toEqual({
    form: [],
    name: [],
    websites: [],
    fields: new Map(),
    consents: new Map(),
  });
});

it('gives each kind of question only the settings that mean something for it', () => {
  const asked = question({
    type: 'text',
    label: 'Campaign',
    helpText: 'A hint.',
    required: true,
    placeholder: 'Type here',
  });
  // A hidden field reads the campaign from the page until told otherwise, shows no hint and
  // cannot be required.
  const hidden = retyped(asked, 'hidden', []);
  expect(hidden).toMatchObject({
    type: 'hidden',
    parameter: 'utm_campaign',
    required: false,
    helpText: '',
  });
  expect(hidden).not.toHaveProperty('placeholder');
  // Back to a question: the hidden field's own settings go.
  expect(retyped({ ...hidden, defaultValue: 'none' }, 'email', [])).not.toHaveProperty('parameter');
  expect(retyped({ ...hidden, defaultValue: 'none' }, 'email', [])).not.toHaveProperty(
    'defaultValue',
  );
  // Words on the form and terms start from the question's name, and save nothing to the contact.
  const targeted = question({
    label: 'Our terms',
    target: { kind: 'contact', attribute: 'lastName' },
  });
  expect(retyped(targeted, 'content', [])).toMatchObject({
    text: 'Our terms',
    required: false,
    target: { kind: 'none' },
  });
  expect(retyped({ ...targeted, required: true }, 'terms', [])).toMatchObject({
    text: 'Our terms',
    required: true,
    target: { kind: 'none' },
  });
  // Several choices keep their list; a rating has none.
  const listed = question({
    type: 'single_choice',
    options: [{ key: 'a', label: 'A' }],
    display: 'radio',
  });
  expect(retyped(listed, 'multi_choice', []).options).toEqual([{ key: 'a', label: 'A' }]);
  expect(retyped(listed, 'multi_choice', [])).not.toHaveProperty('display');
  expect(retyped(listed, 'rating', []).options).toEqual([]);
  // Every kind the contract has still parses after any change of kind.
  for (const from of formFieldTypes)
    for (const to of formFieldTypes) {
      const made = retyped(retyped(question({ label: 'Asked' }), from, []), to, []);
      const options =
        made.options.length === 0 && (to === 'single_choice' || to === 'multi_choice')
          ? [{ key: 'one', label: 'One' }]
          : made.options;
      expect(
        formDefinition.safeParse({ ...DEFAULT_FORM_DEFINITION, fields: [{ ...made, options }] })
          .success,
        `${from} to ${to}`,
      ).toBe(true);
    }
});

it('sets an optional text setting, and leaves it out of the form when it is emptied', () => {
  const asked = question({ type: 'text' });
  const hinted = withExtra(asked, 'placeholder', 'Your name');
  expect(hinted.placeholder).toBe('Your name');
  expect(withExtra(hinted, 'placeholder', '')).not.toHaveProperty('placeholder');
  expect(withExtra(hinted, 'placeholder', '')).toEqual(asked);
});

it('lets a hidden question fill a choice field, keeping its fixed answer only when it names a choice', () => {
  const hidden = question({ type: 'hidden', parameter: 'venue', defaultValue: 'harbor room' });
  // A choice field is offered for a hidden question.
  expect(takes(venue, 'hidden')).toBe(true);
  // Its fixed answer, by label, becomes the choice's key; one no longer offered is dropped.
  expect(retargeted(hidden, { kind: 'field', fieldId: venue.id }, fields)).toMatchObject({
    defaultValue: 'harbor',
  });
  const archived = retargeted(
    { ...hidden, defaultValue: 'Cellar' },
    { kind: 'field', fieldId: venue.id },
    fields,
  );
  expect(archived.defaultValue).toBeUndefined();
  expect(archived.parameter).toBe('venue');
  // Filling text, it keeps the words as they are.
  expect(retargeted(hidden, { kind: 'field', fieldId: notes.id }, fields).defaultValue).toBe(
    'harbor room',
  );
});
