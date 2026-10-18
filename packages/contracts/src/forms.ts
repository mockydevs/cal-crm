// Forms: a business builds a form, lists the websites that may show it, publishes it, and
// embeds it with one script tag. A submission makes or updates a contact. The admin
// endpoints manage forms and read submissions; the public ones are called by the embed from
// an allowed website, with no sign-in, and have their own transport. Every limit of the
// public surface is here.
//
// A form can also be opened as a page of its own, served by the CRM (`/f/{formKey}`), and
// its draft previewed there by the team. A question has more kinds than an answer box: a
// hidden one filled from the page's address, a block of text, and a terms box. What a
// submission does besides making the contact (tags, the contact's source, who is told) and
// what the visitor sees afterwards are part of the definition, and are published with it.
import * as z from 'zod';

import { botChallenge, botChallengeRequest, botProof, botProtection } from './bot-protection.js';
import { calendarDate, contactSourceText } from './contact-attributes.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { leadSourceKeys } from './lead-sources.js';
import { publicArrival } from './reporting-attribution.js';
import { timestamp } from './timestamps.js';
import { WEB_ORIGIN_INPUT } from './webchat.js';

/** The limits of a form and of its public surface. A request past one is refused, never cut short. */
export const FORM_LIMITS = {
  fields: 30,
  consents: 4,
  options: 50,
  nameLength: 120,
  titleLength: 120,
  descriptionLength: 1000,
  labelLength: 120,
  helpLength: 300,
  optionLabelLength: 80,
  wordingLength: 500,
  submitLabelLength: 40,
  successLength: 500,
  /** Characters a visitor may type into one field of each kind. */
  textLength: 500,
  longTextLength: 5000,
  placeholderLength: 120,
  /** A block of text between questions, and the wording of a terms box. */
  contentLength: 2000,
  linkLabelLength: 80,
  /** A web address: one a visitor answers with, a terms link, or where a form sends people on. */
  urlLength: 2000,
  /** The highest rating a visitor can give; the lowest is 1. */
  ratingMax: 5,
  /** Tags a submission adds to its contact. */
  tags: 10,
  /** Team members a form names to be told of a submission. */
  notifyMembers: 20,
  /** Minutes a link to preview a draft works for. */
  previewMinutes: 30,
  /** The longest range of days a form's numbers are read over. */
  analyticsDays: 366,
  allowedOrigins: 20,
  originLength: 255,
  pageUrlLength: 2000,
  /**
   * What one form takes (packages/modules/forms/src/policy.ts). Past `busyPerHour` in an
   * hour a form is busy: it still takes every source's first submission of the hour, after
   * `busyMinFillSeconds` on the page. Only past the ceilings is it refused for everyone.
   */
  busyPerHour: 240,
  ceilingPerHour: 2400,
  ceilingPerDay: 20_000,
  /** Submissions one source (an IPv4 address, or an IPv6 /64) may send one form. */
  sourcePerHour: 10,
  busySourcePerHour: 1,
  sourcePerDay: 30,
  /** Seconds a form must have been on the page before it is accepted, quiet or busy. */
  minFillSeconds: 2,
  busyMinFillSeconds: 8,
  /** How long a shown form may wait before it is sent. */
  renderHours: 24,
  /** Submissions in one page of a form's list. */
  pageSize: 50,
} as const;

/**
 * What a question collects. Each kind has one control and one kind of answer, except:
 * - `hidden` is never shown: its answer is read from a query parameter of the page;
 * - `content` is a block of text between questions, and has no answer;
 * - `terms` is a box with its own wording and an optional link. It is kept with the
 *   submission and is not consent to messages (that is a consent box).
 */
export const formFieldTypes = [
  'text',
  'long_text',
  'email',
  'phone',
  'number',
  'date',
  'single_choice',
  'checkbox',
  'multi_choice',
  'url',
  'rating',
  'hidden',
  'content',
  'terms',
] as const;
export type FormFieldType = (typeof formFieldTypes)[number];

/** The parts of a contact a question can fill directly. */
export const formContactAttributes = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'dateOfBirth',
] as const;
export type FormContactAttribute = (typeof formContactAttributes)[number];

/** The kind of question each part of a contact takes. */
export const formAttributeTypes = {
  firstName: 'text',
  lastName: 'text',
  email: 'email',
  phone: 'phone',
  dateOfBirth: 'date',
} as const satisfies Record<FormContactAttribute, FormFieldType>;

/**
 * The kinds of visible question that may name a query key (`parameter`): the ones a
 * visitor types into or picks one choice of. A hidden question always may.
 */
export const formPrefillTypes = [
  'text',
  'long_text',
  'email',
  'phone',
  'number',
  'date',
  'url',
  'single_choice',
] as const satisfies readonly FormFieldType[];

/**
 * The kinds of custom field (packages/contracts/src/fields.ts) each kind of question can
 * fill. Money needs a currency, so it is not offered. A rating is a whole number from 1 to
 * 5. A block of text has no answer, and a terms box is kept with the submission only. A
 * hidden question's text fills a choice field when it names one of its choices, by key or
 * by label (several separated by commas for a field that takes several).
 */
export const formFieldValueTypes = {
  text: ['text', 'long_text'],
  long_text: ['long_text'],
  email: ['email', 'text'],
  phone: ['phone', 'text'],
  number: ['number'],
  date: ['date'],
  single_choice: ['single_choice'],
  checkbox: ['boolean'],
  multi_choice: ['multi_choice'],
  url: ['url', 'text'],
  rating: ['number'],
  hidden: ['text', 'long_text', 'single_choice', 'multi_choice'],
  content: [],
  terms: [],
} as const satisfies Record<FormFieldType, readonly string[]>;

/**
 * How a choice question shows its choices. One of several: a dropdown or radio buttons.
 * Several of several: a dropdown that takes several, or a list of checkboxes. A question
 * that names none is a dropdown, as every choice question was before there was a choice.
 */
export const formChoiceDisplays = {
  single_choice: ['dropdown', 'radio'],
  multi_choice: ['dropdown', 'checkboxes'],
} as const;
export const formFieldDisplays = ['dropdown', 'radio', 'checkboxes'] as const;
export type FormFieldDisplay = (typeof formFieldDisplays)[number];

/** The kinds of question a visitor types into, which can show an example in the empty box. */
export const formPlaceholderTypes = [
  'text',
  'long_text',
  'email',
  'phone',
  'number',
  'url',
] as const satisfies readonly FormFieldType[];

/** How a block of text is shown. */
export const formContentStyles = ['heading', 'paragraph'] as const;

// Text people read: one line, no control characters (Unicode category Cc: C0, DEL and C1).
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Use at most ${String(max)} characters.` })
    .regex(/^\P{Cc}*$/u, { error: 'Use one line of plain text.' });
// Several lines of plain text: a tab or a line break is kept, other controls are refused.
const paragraph = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Use at most ${String(max)} characters.` })
    .regex(/^[\P{Cc}\t\n\r]*$/u, { error: 'Use plain text.' });

/** Names a question or a box inside one form. It is what a submission's answers are keyed by. */
export const formKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, {
  error: 'Use a lowercase letter, then lowercase letters, numbers or underscores.',
});

/** Where an answer goes: a part of the contact, one of its custom fields, or nowhere else. */
export const formFieldTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('contact'), attribute: z.enum(formContactAttributes) }),
  z.strictObject({ kind: z.literal('field'), fieldId: publicId('field') }),
  // Kept with the submission only.
  z.strictObject({ kind: z.literal('none') }),
]);
export type FormFieldTarget = z.output<typeof formFieldTarget>;

export const formOption = z.strictObject({
  key: formKey,
  label: line(FORM_LIMITS.optionLabelLength).min(1, { error: 'Give the choice a name.' }),
});

/** A secure web address, as a link a visitor follows. */
const secureUrl = z
  .url({ protocol: /^https$/, error: 'Enter an address that starts with https://.' })
  .max(FORM_LIMITS.urlLength, { error: 'Use at most 2000 characters.' })
  .meta({ examples: ['https://www.example.com/thanks'] });

/** The name of a query parameter, as it is written in a page's address. */
export const formParameter = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,59}$/, {
  error: 'Use a letter, then up to 59 letters, numbers, dots, dashes or underscores.',
});

/**
 * One question, block or box of a form. What only some kinds have is optional, and left
 * out of a stored definition that does not use it, so a form saved before a kind existed
 * reads as it was written.
 */
export const formField = z
  .strictObject({
    key: formKey,
    type: z.enum(formFieldTypes),
    /**
     * What the question is called: shown above its control, and beside its answer in a
     * submission. For a block of text and a terms box it is the name the builder lists it
     * by, and is not shown to visitors.
     */
    label: line(FORM_LIMITS.labelLength).min(1, { error: 'Give the question a label.' }),
    helpText: line(FORM_LIMITS.helpLength).default(''),
    required: z.boolean().default(false),
    /** The choices of a choice question; empty for every other kind. */
    options: z
      .array(formOption)
      .max(FORM_LIMITS.options, { error: 'Add at most 50 choices.' })
      .default([]),
    target: formFieldTarget.default({ kind: 'none' }),
    /** An example shown in the empty box of a question a visitor types into. */
    placeholder: line(FORM_LIMITS.placeholderLength).optional(),
    /** How a choice question shows its choices (formChoiceDisplays). A dropdown when left out. */
    display: z.enum(formFieldDisplays).optional(),
    /**
     * The query parameter of the page this question is filled from ("query key"). For a
     * hidden question it is the answer; for a question a visitor types into or chooses
     * from (formPrefillTypes) it fills the control when the form is shown, and the visitor
     * may change it. The answer is checked as a typed one is.
     */
    parameter: formParameter.optional(),
    /** For a hidden question: its answer when the page's address has no such parameter. */
    defaultValue: line(FORM_LIMITS.textLength).optional(),
    /** The words of a block of text, or the wording beside a terms box. Plain text. */
    text: paragraph(FORM_LIMITS.contentLength).optional(),
    /** How a block of text is shown. A paragraph when left out. */
    style: z.enum(formContentStyles).optional(),
    /** For a terms box: where the terms can be read, and the words of that link. */
    linkUrl: secureUrl.optional(),
    linkLabel: line(FORM_LIMITS.linkLabelLength).optional(),
  })
  .meta({ id: 'FormField' });
export type FormField = z.output<typeof formField>;

/** What a visitor sees once a form is sent: the form's success message, or another page. */
export const formAfterSubmit = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message') }),
  z.strictObject({ kind: z.literal('redirect'), url: secureUrl }),
]);
export type FormAfterSubmit = z.output<typeof formAfterSubmit>;

/**
 * The Source a submission gives a contact that has none:
 * - `arrived`: from how they arrived, by the lead source rules ("Google Ads", "Facebook",
 *   "Organic Search"…). What a new form does.
 * - `text`: a name the business wrote, the same for every visitor. It beats the rules.
 * - `form_name`: the name of the form.
 * - `none`: nothing is written.
 * Whatever is chosen, the touch a submission records carries the lead source.
 */
export const formContactSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('arrived') }),
  z.strictObject({ kind: z.literal('form_name') }),
  z.strictObject({ kind: z.literal('text'), text: contactSourceText }),
  z.strictObject({ kind: z.literal('none') }),
]);
export type FormContactSource = z.output<typeof formContactSource>;

/**
 * What a submission does to the contact it reaches, besides filling it in.
 * - `tagIds`: tags the business already has, added to the contact. One it already carries
 *   is left as it is; one deleted since the form was published is skipped.
 * - `source`: written to the contact's source only when the contact has none. A contact
 *   keeps the source it has.
 * - `tagBySource`: also adds one tag named after the lead source ("Source: Google Ads"),
 *   on every submission, whatever `source` is. The system makes the tags of its own
 *   built-in names the first time each is needed, in the "Lead source" tag group; a name
 *   an address chose (`source=`) gets a tag only when someone has made that tag. A
 *   submission adds at most 10 tags: the form's own first, then this one.
 */
export const formContactActions = z.strictObject({
  tagIds: z
    .array(publicId('tag'))
    .max(FORM_LIMITS.tags, { error: 'Add at most 10 tags.' })
    .default([]),
  source: formContactSource.default({ kind: 'arrived' }),
  /** Left out, false: a definition stored before this was offered reads as it was written. */
  tagBySource: z.boolean().default(false),
});
export type FormContactActions = z.output<typeof formContactActions>;

/**
 * Who is told when a submission arrives, as a notification.
 * - `managers`: everyone who may manage forms. What a form does when it names nothing.
 * - `nobody`.
 * - `contact_owner`: the owner of the contact the submission reached. When it reached no
 *   contact, or the contact has no owner, the managers are told instead.
 * - `members`: the listed people, as long as they are still on the team.
 */
export const formNotify = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('managers') }),
  z.strictObject({ mode: z.literal('nobody') }),
  z.strictObject({ mode: z.literal('contact_owner') }),
  z.strictObject({
    mode: z.literal('members'),
    memberIds: z
      .array(publicId('membership'))
      .min(1, { error: 'Choose at least one person.' })
      .max(FORM_LIMITS.notifyMembers, { error: 'Choose at most 20 people.' }),
  }),
]);
export type FormNotify = z.output<typeof formNotify>;

/**
 * A box a visitor may tick to agree to marketing messages on one channel. It is never
 * ticked for them. The wording shown is what is kept as proof.
 */
export const formConsent = z
  .strictObject({
    key: formKey,
    channel: z.enum(['email', 'sms']),
    wording: line(FORM_LIMITS.wordingLength).min(1, { error: 'Enter the wording of the box.' }),
    /** Whether the form can be sent without the box ticked. */
    required: z.boolean().default(false),
  })
  .meta({ id: 'FormConsent' });
export type FormConsent = z.output<typeof formConsent>;

function repeated(values: readonly string[]): number[] {
  const seen = new Set<string>();
  const places: number[] = [];
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) places.push(index);
    seen.add(value);
  }
  return places;
}

/**
 * A form as it is built: its words, its questions and its consent boxes. This checks what
 * the form itself can show to be wrong. What depends on the business (a custom field that
 * was archived, no website listed) is reported by the server as `problems`, and stops
 * publishing, not saving.
 */
export const formDefinition = z
  .strictObject({
    title: line(FORM_LIMITS.titleLength).default(''),
    description: paragraph(FORM_LIMITS.descriptionLength).default(''),
    submitLabel: line(FORM_LIMITS.submitLabelLength)
      .min(1, { error: 'Give the button a label.' })
      .default('Send'),
    successMessage: paragraph(FORM_LIMITS.successLength)
      .min(1, { error: 'Say what people see after sending.' })
      .default('Thank you. We have your details.'),
    fields: z.array(formField).max(FORM_LIMITS.fields, { error: 'Add at most 30 questions.' }),
    consents: z
      .array(formConsent)
      .max(FORM_LIMITS.consents, { error: 'Add at most 4 consent boxes.' })
      .default([]),
    /** Left out, the success message is shown. */
    afterSubmit: formAfterSubmit.optional(),
    /** Left out, a submission adds no tag and writes no source. A new form reads how they arrived. */
    contactActions: formContactActions.optional(),
    /** Left out, the people who manage forms are told. */
    notify: formNotify.optional(),
    /** Left out, off: no proof of work is asked of the visitor's browser. */
    botProtection: botProtection.optional(),
  })
  .superRefine((definition, context) => {
    // One namespace for questions and boxes: a submission is keyed by them.
    const keys = [
      ...definition.fields.map((field) => field.key),
      ...definition.consents.map((consent) => consent.key),
    ];
    for (const index of repeated(keys)) {
      const inFields = index < definition.fields.length;
      context.addIssue({
        code: 'custom',
        path: inFields
          ? ['fields', index, 'key']
          : ['consents', index - definition.fields.length, 'key'],
        message: 'This key is already used in this form.',
        params: { code: 'repeated' },
      });
    }
    // Any number of questions may go nowhere else, so each of those is its own target.
    const targets = definition.fields.map((field, index) =>
      field.target.kind === 'contact'
        ? `contact:${field.target.attribute}`
        : field.target.kind === 'field'
          ? `field:${field.target.fieldId}`
          : `none:${String(index)}`,
    );
    for (const index of repeated(targets))
      context.addIssue({
        code: 'custom',
        path: ['fields', index, 'target'],
        message: 'Another question already fills this.',
        params: { code: 'repeated_target' },
      });
    for (const [index, field] of definition.fields.entries()) {
      const refuse = (part: string, message: string, code: string): void => {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, part],
          message,
          params: { code },
        });
      };
      const displays: readonly string[] =
        field.type === 'single_choice' || field.type === 'multi_choice'
          ? formChoiceDisplays[field.type]
          : [];
      const choice = displays.length > 0;
      if (!choice && field.options.length > 0)
        refuse('options', 'Only a choice question has choices.', 'unexpected_options');
      if (field.display !== undefined && !displays.includes(field.display))
        refuse(
          'display',
          choice
            ? 'This kind of choice question cannot be shown that way.'
            : 'Only a choice question has a way of showing its choices.',
          'incompatible_display',
        );
      const typed: readonly FormFieldType[] = formPlaceholderTypes;
      if ((field.placeholder ?? '') !== '' && !typed.includes(field.type))
        refuse(
          'placeholder',
          'Only a question a visitor types into has an example.',
          'unexpected_placeholder',
        );
      const hidden = field.type === 'hidden';
      const prefilled: readonly FormFieldType[] = formPrefillTypes;
      if (!hidden && field.parameter !== undefined && !prefilled.includes(field.type))
        refuse(
          'parameter',
          'This kind of question cannot be filled from the page address.',
          'unexpected_parameter',
        );
      if (!hidden && field.defaultValue !== undefined)
        refuse('defaultValue', 'Only a hidden question has a fixed answer.', 'unexpected_default');
      if (hidden && field.parameter === undefined && (field.defaultValue ?? '') === '')
        refuse(
          'parameter',
          'Name the part of the page address to read, or give a fixed answer.',
          'no_value_source',
        );
      // Nobody can answer what they are not shown, and a block of text has no answer.
      if ((hidden || field.type === 'content') && field.required)
        refuse('required', 'This cannot be required: a visitor cannot answer it.', 'unanswerable');
      const worded = field.type === 'content' || field.type === 'terms';
      if (!worded && field.text !== undefined)
        refuse(
          'text',
          'Only a block of text or a terms box has words of its own.',
          'unexpected_text',
        );
      if (worded && (field.text ?? '') === '')
        refuse(
          'text',
          field.type === 'terms' ? 'Enter the wording of the box.' : 'Enter the text to show.',
          'no_text',
        );
      if (field.type !== 'content' && field.style !== undefined)
        refuse('style', 'Only a block of text has a style.', 'unexpected_style');
      if (field.type !== 'terms' && (field.linkUrl !== undefined || field.linkLabel !== undefined))
        refuse(
          field.linkUrl === undefined ? 'linkLabel' : 'linkUrl',
          'Only a terms box has a link.',
          'unexpected_link',
        );
      if (field.type === 'terms' && field.linkUrl === undefined && (field.linkLabel ?? '') !== '')
        refuse('linkLabel', 'Give the address the link opens.', 'no_link');
      if (worded && field.target.kind !== 'none')
        refuse(
          'target',
          field.type === 'terms'
            ? 'A terms box is kept with the submission only.'
            : 'A block of text has no answer.',
          'incompatible_target',
        );
      for (const place of repeated(field.options.map((option) => option.key)))
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'options', place, 'key'],
          message: 'This choice is already listed.',
          params: { code: 'repeated' },
        });
      if (
        !worded &&
        field.target.kind === 'contact' &&
        formAttributeTypes[field.target.attribute] !== field.type
      )
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'target'],
          message: 'This kind of question cannot fill that part of the contact.',
          params: { code: 'incompatible_target' },
        });
    }
    for (const place of repeated(definition.consents.map((consent) => consent.channel)))
      context.addIssue({
        code: 'custom',
        path: ['consents', place, 'channel'],
        message: 'There is already a box for this channel.',
        params: { code: 'repeated' },
      });
    for (const place of repeated(definition.contactActions?.tagIds ?? []))
      context.addIssue({
        code: 'custom',
        path: ['contactActions', 'tagIds', place],
        message: 'This tag is already listed.',
        params: { code: 'repeated' },
      });
    const told = definition.notify?.mode === 'members' ? definition.notify.memberIds : [];
    for (const place of repeated(told))
      context.addIssue({
        code: 'custom',
        path: ['notify', 'memberIds', place],
        message: 'This person is already listed.',
        params: { code: 'repeated' },
      });
  })
  .meta({ id: 'FormDefinition' });
export type FormDefinition = z.output<typeof formDefinition>;
export type FormDefinitionInput = z.input<typeof formDefinition>;

/**
 * What a new form starts as: a name and an email address, which is enough to publish. A
 * contact it reaches that has no source gets how they arrived as its source ("Google Ads"),
 * and every contact it reaches gets the tag of it.
 */
export const DEFAULT_FORM_DEFINITION: FormDefinition = {
  title: '',
  description: '',
  submitLabel: 'Send',
  successMessage: 'Thank you. We have your details.',
  fields: [
    {
      key: 'first_name',
      type: 'text',
      label: 'First name',
      helpText: '',
      required: false,
      options: [],
      target: { kind: 'contact', attribute: 'firstName' },
    },
    {
      key: 'email',
      type: 'email',
      label: 'Email',
      helpText: '',
      required: true,
      options: [],
      target: { kind: 'contact', attribute: 'email' },
    },
  ],
  consents: [],
  contactActions: { tagIds: [], source: { kind: 'arrived' }, tagBySource: true },
};

const formId = publicId('form');
const formName = z
  .string()
  .trim()
  .min(1, { error: 'Enter a name.' })
  .max(FORM_LIMITS.nameLength, { error: 'Use at most 120 characters.' });
const revision = z.string().regex(/^[0-9a-f]{64}$/);

const webOrigin = z
  .string()
  .max(FORM_LIMITS.originLength, { error: 'Use at most 255 characters.' })
  .regex(WEB_ORIGIN_INPUT, {
    error: 'Enter a website address with nothing after the host, such as https://www.example.com.',
  })
  .meta({ examples: ['https://www.example.com'] });

export const createFormInput = z.strictObject({ name: formName }).meta({ id: 'CreateFormInput' });
export type CreateFormInput = z.output<typeof createFormInput>;

export const updateFormInput = z
  .strictObject({
    name: formName,
    definition: formDefinition,
    /** The websites that may show this form. The server stores each once, canonically. */
    allowedOrigins: z
      .array(webOrigin)
      .max(FORM_LIMITS.allowedOrigins, { error: 'Add at most 20 websites.' }),
    /** The revision this change was made from. A form changed since is not overwritten. */
    revision,
  })
  .meta({ id: 'UpdateFormInput' });
export type UpdateFormInput = z.output<typeof updateFormInput>;

export const formRevisionInput = z.strictObject({ revision }).meta({ id: 'FormRevisionInput' });

export const formStatuses = ['draft', 'published', 'archived'] as const;

/** 16 to 64 characters of base64url. Public: it is in the page source of every site. */
export const formPublicKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

/** Why a form cannot be published as it stands, pointing at the part to change. */
export const formProblem = z.strictObject({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});
export type FormProblem = z.output<typeof formProblem>;

export const form = z
  .strictObject({
    id: formId,
    name: z.string(),
    status: z.enum(formStatuses),
    publicKey: formPublicKey,
    allowedOrigins: z.array(z.string()),
    /** What the builder edits. */
    definition: formDefinition,
    /** What websites are served: the definition as it was when last published. */
    publishedDefinition: formDefinition.nullable(),
    publishedAt: timestamp.nullable(),
    hasUnpublishedChanges: z.boolean(),
    /** Empty when the draft can be published. */
    problems: z.array(formProblem),
    /** The one line a website needs. */
    embedSnippet: z.string(),
    /**
     * The form as a page of its own, served by the CRM: a link to share where there is no
     * website to put the form on. It is always the same for a form, and shows the form
     * only while it is published.
     */
    hostedUrl: z.string(),
    submissionCount: z.int().min(0),
    revision,
    canManage: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'Form' });
export type Form = z.output<typeof form>;

export const formSummary = z
  .strictObject({
    id: formId,
    name: z.string(),
    status: z.enum(formStatuses),
    hasUnpublishedChanges: z.boolean(),
    submissionCount: z.int().min(0),
    lastSubmissionAt: timestamp.nullable(),
    updatedAt: timestamp,
  })
  .meta({ id: 'FormSummary' });
export type FormSummary = z.output<typeof formSummary>;

export const formList = z.strictObject({
  items: z.array(formSummary),
  nextCursor: formId.nullable(),
  canManage: z.boolean(),
});
export type FormList = z.output<typeof formList>;

/** What happened to a consent box of one submission. */
export const formConsentOutcomes = [
  /** Ticked, and recorded in the contact's consent ledger with its proof. */
  'granted',
  /** Not ticked: nothing was recorded. */
  'not_ticked',
  /** Ticked, but the contact had withdrawn this consent, and a form does not undo that. */
  'withdrawn_kept',
  /** Ticked, but the submission gave no address for this channel, or reached no contact. */
  'no_address',
] as const;

export const formSubmissionId = publicId('form_submission');

export const formSubmission = z
  .strictObject({
    id: formSubmissionId,
    submittedAt: timestamp,
    /** Null when the details matched no single contact: see contactOutcome. */
    contactId: publicId('contact').nullable(),
    contactOutcome: z.enum(['created', 'updated', 'unresolved']).nullable(),
    /**
     * Each answer with the label it was asked under, so it reads the same after the form
     * changes. Text for most kinds, true or false for a checkbox, and the keys of the
     * chosen choices for a question that takes several.
     */
    answers: z.array(
      z.strictObject({
        key: z.string(),
        label: z.string(),
        value: z.union([z.string(), z.boolean(), z.array(z.string())]).nullable(),
      }),
    ),
    /**
     * Each terms box with the wording and the link that were shown, and whether it was
     * ticked. Not consent to messages: that is `consents`.
     */
    terms: z.array(
      z.strictObject({
        key: z.string(),
        wording: z.string(),
        linkUrl: z.string().nullable(),
        accepted: z.boolean(),
      }),
    ),
    consents: z.array(
      z.strictObject({
        key: z.string(),
        channel: z.string(),
        wording: z.string(),
        outcome: z.enum(formConsentOutcomes),
      }),
    ),
    /** Questions whose answer could not be written to the contact's custom field. */
    skippedFields: z.array(z.string()),
    origin: z.string().nullable(),
    pageUrl: z.string().nullable(),
    ipAddress: z.string().nullable(),
    utm: z.record(z.string(), z.string()),
    /**
     * The lead source of the visit ("Google Ads"), and the built-in rule that decided it.
     * Both null for a submission stored before lead sources were kept.
     */
    leadSource: z.string().nullable(),
    leadSourceRule: z.string().nullable(),
  })
  .meta({ id: 'FormSubmission' });
export type FormSubmission = z.output<typeof formSubmission>;

export const formSubmissionList = z.strictObject({
  items: z.array(formSubmission),
  nextCursor: formSubmissionId.nullable(),
  canManage: z.boolean(),
});
export type FormSubmissionList = z.output<typeof formSubmissionList>;

const formParams = z.strictObject({ id: formId });

export const listForms = defineEndpoint({
  operationId: 'listForms',
  method: 'get',
  path: '/forms',
  summary: "List the business's forms",
  group: 'Forms',
  query: z.strictObject({
    after: formId.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    archived: z.enum(['true', 'false']).default('false').meta({
      description: 'Whether to list archived forms instead of the others.',
    }),
  }),
  response: { status: 200, description: 'Forms in creation order.', schema: formList },
});
export const createForm = defineEndpoint({
  operationId: 'createForm',
  method: 'post',
  path: '/forms',
  summary: 'Create a draft form',
  group: 'Forms',
  body: createFormInput,
  response: {
    status: 201,
    description: 'The new draft, asking for a first name and an email address.',
    schema: form,
  },
});
export const getForm = defineEndpoint({
  operationId: 'getForm',
  method: 'get',
  path: '/forms/{id}',
  summary: 'Read a form, with what stops it being published',
  group: 'Forms',
  params: formParams,
  response: { status: 200, description: 'The form and its revision.', schema: form },
});
export const updateForm = defineEndpoint({
  operationId: 'updateForm',
  method: 'put',
  path: '/forms/{id}',
  summary: "Save a form's draft and the websites that may show it",
  group: 'Forms',
  params: formParams,
  body: updateFormInput,
  response: {
    status: 200,
    description:
      'The saved form. The websites apply at once; the questions reach websites when published.',
    schema: form,
  },
});
export const publishForm = defineEndpoint({
  operationId: 'publishForm',
  method: 'post',
  path: '/forms/{id}/publish',
  summary: 'Publish the draft, so websites show it and it accepts submissions',
  group: 'Forms',
  params: formParams,
  body: formRevisionInput,
  response: { status: 200, description: 'The published form.', schema: form },
});
export const unpublishForm = defineEndpoint({
  operationId: 'unpublishForm',
  method: 'post',
  path: '/forms/{id}/unpublish',
  summary: 'Stop a form accepting submissions; its draft is kept',
  group: 'Forms',
  params: formParams,
  body: formRevisionInput,
  response: { status: 200, description: 'The form as a draft.', schema: form },
});
export const archiveForm = defineEndpoint({
  operationId: 'archiveForm',
  method: 'post',
  path: '/forms/{id}/archive',
  summary: 'Archive a form; it stops accepting submissions and keeps the ones it has',
  group: 'Forms',
  params: formParams,
  body: formRevisionInput,
  response: { status: 200, description: 'The archived form.', schema: form },
});
export const restoreForm = defineEndpoint({
  operationId: 'restoreForm',
  method: 'post',
  path: '/forms/{id}/restore',
  summary: 'Bring an archived form back as a draft',
  group: 'Forms',
  params: formParams,
  body: formRevisionInput,
  response: { status: 200, description: 'The form as a draft.', schema: form },
});
export const listFormSubmissions = defineEndpoint({
  operationId: 'listFormSubmissions',
  method: 'get',
  path: '/forms/{id}/submissions',
  summary: "List a form's submissions, newest first",
  group: 'Forms',
  params: formParams,
  query: z.strictObject({
    after: formSubmissionId.optional(),
    limit: z.coerce.number().int().min(1).max(FORM_LIMITS.pageSize).default(25),
    leadSourceRule: z
      .enum(leadSourceKeys)
      .optional()
      .meta({
        description:
          'Only the submissions whose lead source this built-in rule decided (what each has as `leadSourceRule`): `google_ads` for the leads of Google ads, `source_param` for those a link named with source=. A submission stored before lead sources were kept has none and matches no value.',
        examples: ['google_ads'],
      }),
  }),
  response: {
    status: 200,
    description: 'Submissions with their answers, consent and where they came from.',
    schema: formSubmissionList,
  },
});
export const discardFormSubmission = defineEndpoint({
  operationId: 'discardFormSubmission',
  method: 'delete',
  path: '/forms/{id}/submissions/{submissionId}',
  summary: 'Delete a submission that was not attached to a contact',
  group: 'Forms',
  params: z.strictObject({ id: formId, submissionId: formSubmissionId }),
  response: {
    status: 204,
    description:
      'Deleted. A submission attached to a contact is refused: it is erased with the contact.',
  },
});

/** A link that shows a form's draft, for a short while, to whoever holds it. */
export const formPreview = z
  .strictObject({
    /**
     * A page served by the CRM that shows the draft as a visitor would see it. Sending it
     * checks the answers and stores nothing: no submission, no contact, no notification.
     */
    url: z.string(),
    expiresAt: timestamp,
  })
  .meta({ id: 'FormPreview' });
export type FormPreview = z.output<typeof formPreview>;

export const getFormPreview = defineEndpoint({
  operationId: 'getFormPreview',
  method: 'get',
  path: '/forms/{id}/preview',
  summary: "Get a short-lived link that shows a form's draft",
  group: 'Forms',
  params: formParams,
  response: {
    status: 200,
    description: `A link that works for ${String(FORM_LIMITS.previewMinutes)} minutes. Each request gives a new one.`,
    schema: formPreview,
  },
});

const analyticsDay = calendarDate.meta({ examples: ['2026-10-07'] });
const count = z.int().min(0);
const formNumbers = {
  views: count.meta({
    description:
      'Times the published form was shown: each time a browser loaded its questions, on a website or on its own page. A preview is not counted. Counted since analytics were added.',
  }),
  responses: count.meta({
    description: 'Submissions stored, on the day they were sent. One deleted since is not counted.',
  }),
  completionRate: z.number().min(0).max(1).nullable().meta({
    description:
      'Responses divided by views, at most 1. Null when there were no views to compare with.',
  }),
  averageSeconds: z.number().min(0).nullable().meta({
    description:
      'The average time from a form being shown to it being sent, in seconds. Null when no submission was timed.',
  }),
};

export const formAnalyticsQuery = z
  .strictObject({
    from: analyticsDay.optional().meta({
      description: 'The first day, as YYYY-MM-DD. Left out, 29 days before the last.',
    }),
    to: analyticsDay.optional().meta({
      description: "The last day, as YYYY-MM-DD. Left out, today in the business's time zone.",
    }),
  })
  .superRefine((query, context) => {
    if (query.from === undefined || query.to === undefined) return;
    const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
    if (days < 0)
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'End the range on or after the day it starts.',
        params: { code: 'range_order' },
      });
    else if (days >= FORM_LIMITS.analyticsDays)
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: `Ask for at most ${String(FORM_LIMITS.analyticsDays)} days at a time.`,
        params: { code: 'range_too_long' },
      });
  })
  .meta({ id: 'FormAnalyticsQuery' });

export const formAnalytics = z
  .strictObject({
    from: analyticsDay,
    to: analyticsDay,
    timeZone: z.string().meta({
      description: "The business's time zone, by its IANA name. Days are calendar days there.",
      examples: ['Africa/Nairobi'],
    }),
    totals: z.strictObject(formNumbers),
    days: z.array(z.strictObject({ date: analyticsDay, ...formNumbers })).meta({
      description: 'One row for each day of the range, in order, with zeros on a quiet day.',
    }),
  })
  .meta({ id: 'FormAnalytics' });
export type FormAnalytics = z.output<typeof formAnalytics>;

export const getFormAnalytics = defineEndpoint({
  operationId: 'getFormAnalytics',
  method: 'get',
  path: '/forms/{id}/analytics',
  summary: "Read a form's views, responses, completion rate and time to complete",
  group: 'Forms',
  params: formParams,
  query: formAnalyticsQuery,
  response: {
    status: 200,
    description: 'Totals for the range and one row for each of its days.',
    schema: formAnalytics,
  },
});

export const formAdminEndpoints = [
  listForms,
  createForm,
  getForm,
  updateForm,
  publishForm,
  unpublishForm,
  archiveForm,
  restoreForm,
  listFormSubmissions,
  discardFormSubmission,
  getFormPreview,
  getFormAnalytics,
] as const;

// The public surface -----------------------------------------------------------------

/**
 * Proof of when a form was shown: the moment in milliseconds and a keyed digest of it and
 * the form, made by the server. It carries nothing about the visitor.
 */
export const formRenderToken = z.string().regex(/^[0-9]{13}\.[A-Za-z0-9_-]{43}$/);

const publicParams = z.strictObject({ formKey: formPublicKey });

/**
 * Proof that someone signed in asked to see a form's draft: which form, until when, and a
 * keyed digest of both, made by the server. It is in the address of the preview page.
 */
export const formPreviewToken = z.string().regex(/^[A-Za-z0-9_-]{70}\.[A-Za-z0-9_-]{22}$/);

/**
 * What the embed shows. Where an answer goes is not part of it, and neither is the fixed
 * answer of a hidden question: the server fills that in.
 */
export const publicForm = z.strictObject({
  title: z.string().max(FORM_LIMITS.titleLength),
  description: z.string().max(FORM_LIMITS.descriptionLength),
  submitLabel: z.string().min(1).max(FORM_LIMITS.submitLabelLength),
  successMessage: z.string().min(1).max(FORM_LIMITS.successLength),
  /** Where the visitor is sent once the form is sent, instead of the success message. */
  redirectUrl: z.string().max(FORM_LIMITS.urlLength).optional(),
  fields: z
    .array(
      z.strictObject({
        key: formKey,
        type: z.enum(formFieldTypes),
        /** Empty for a block of text and a terms box: their label is the builder's own. */
        label: z.string().max(FORM_LIMITS.labelLength),
        helpText: z.string().max(FORM_LIMITS.helpLength),
        required: z.boolean(),
        options: z.array(formOption).max(FORM_LIMITS.options),
        placeholder: z.string().max(FORM_LIMITS.placeholderLength).optional(),
        display: z.enum(formFieldDisplays).optional(),
        parameter: formParameter.optional(),
        text: z.string().max(FORM_LIMITS.contentLength).optional(),
        style: z.enum(formContentStyles).optional(),
        linkUrl: z.string().max(FORM_LIMITS.urlLength).optional(),
        linkLabel: z.string().max(FORM_LIMITS.linkLabelLength).optional(),
      }),
    )
    .max(FORM_LIMITS.fields),
  consents: z
    .array(
      z.strictObject({
        key: formKey,
        wording: z.string().min(1).max(FORM_LIMITS.wordingLength),
        required: z.boolean(),
      }),
    )
    .max(FORM_LIMITS.consents),
  renderToken: formRenderToken,
  /** Left out, off. Otherwise the embed asks for a challenge and solves it before sending. */
  botProtection: botProtection.optional(),
  /** The longest answers the server takes, so the embed can stop a visitor early. */
  textLength: z.literal(FORM_LIMITS.textLength),
  longTextLength: z.literal(FORM_LIMITS.longTextLength),
});
export type PublicForm = z.output<typeof publicForm>;

const answers = <Value extends z.ZodType>(value: Value, most: number) =>
  z
    .record(formKey, value)
    .refine((entries) => Object.keys(entries).length <= most, { error: 'Too many answers.' });

export const publicFormSubmissionInput = z.strictObject({
  /** Chosen by the embed for each filled-in form, so a request sent twice is stored once. */
  clientSubmissionId: z.uuid(),
  renderToken: formRenderToken,
  /**
   * Text for most kinds of question; true or false for a checkbox and a terms box; the
   * keys of the chosen choices for a question that takes several. A block of text has none.
   */
  values: answers(
    z.union([
      z.string().max(FORM_LIMITS.longTextLength),
      z.boolean(),
      z.array(z.string().max(40)).max(FORM_LIMITS.options),
    ]),
    FORM_LIMITS.fields,
  ),
  /** True only for a box the visitor ticked. A box left out is not ticked. */
  consents: answers(z.boolean(), FORM_LIMITS.consents),
  /** A field people cannot see. Anything in it means a program filled the form. */
  trap: z.string().max(200).default(''),
  /** The solved challenge, when the form asks for one (botProtection). */
  botProof: botProof.optional(),
  /** The page the form was on, as the embed read it. */
  pageUrl: z
    .url({ protocol: /^https?$/ })
    .max(FORM_LIMITS.pageUrlLength)
    .optional(),
  /**
   * Where the visitor came from, as the embed read it: the origin of the page before this
   * website. The server keeps its host, for the contact's attribution.
   */
  referrer: z
    .url({ protocol: /^https?$/ })
    .max(FORM_LIMITS.pageUrlLength)
    .optional(),
  /**
   * How the visit began, when it began on another page of the same website: handed to the
   * embed by the CRM's own page script, or read from the address of the CRM's own page for
   * a form. The server uses it when the page's own address says nothing of the arrival.
   */
  first: publicArrival.optional(),
});
export type PublicFormSubmissionInput = z.output<typeof publicFormSubmissionInput>;

/** The whole answer to a submission: nothing about the contact it reached. */
export const publicFormReceipt = z.strictObject({ status: z.literal('received') });
export type PublicFormReceipt = z.output<typeof publicFormReceipt>;

const publicPath = '/public/forms/{formKey}';

export const getPublicForm = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicForm',
  method: 'get',
  path: publicPath,
  summary: 'Read what a published form shows',
  group: 'Public forms',
  params: publicParams,
  response: { status: 200, description: 'The questions and consent boxes.', schema: publicForm },
});
export const submitPublicForm = defineEndpoint({
  audience: 'public',
  operationId: 'submitPublicForm',
  method: 'post',
  path: `${publicPath}/submissions`,
  summary: 'Send a filled-in form',
  group: 'Public forms',
  params: publicParams,
  body: publicFormSubmissionInput,
  response: {
    status: 201,
    description: 'Received. The same answer when the same request is sent again.',
    schema: publicFormReceipt,
  },
});

/**
 * A challenge for one showing of a form that asks for bot protection, bound to the render
 * token the form was shown with. A form that asks for none answers 403.
 */
export const getPublicFormChallenge = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicFormChallenge',
  method: 'post',
  path: `${publicPath}/challenge`,
  summary: 'Get the proof-of-work challenge for a shown form',
  group: 'Public forms',
  params: publicParams,
  body: botChallengeRequest,
  response: { status: 200, description: 'The challenge to solve.', schema: botChallenge },
});

const previewParams = z.strictObject({ previewToken: formPreviewToken });
const previewPath = '/public/forms/preview/{previewToken}';

/** The draft, for the preview page the CRM serves. No other website is answered. */
export const getPublicFormPreview = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicFormPreview',
  method: 'get',
  path: previewPath,
  summary: "Read what a form's draft would show",
  group: 'Public forms',
  params: previewParams,
  response: {
    status: 200,
    description: 'The questions and boxes of the draft.',
    schema: publicForm,
  },
});
/** Checks the answers against the draft and stores nothing. */
export const submitPublicFormPreview = defineEndpoint({
  audience: 'public',
  operationId: 'submitPublicFormPreview',
  method: 'post',
  path: `${previewPath}/submissions`,
  summary: "Try a form's draft: the answers are checked and nothing is stored",
  group: 'Public forms',
  params: previewParams,
  body: publicFormSubmissionInput,
  response: {
    status: 201,
    description: 'The answers fit the draft. No submission and no contact was made.',
    schema: publicFormReceipt,
  },
});
/** The same for a draft, so the team can see the check work before publishing. */
export const getPublicFormPreviewChallenge = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicFormPreviewChallenge',
  method: 'post',
  path: `${previewPath}/challenge`,
  summary: "Get the proof-of-work challenge for a form's draft",
  group: 'Public forms',
  params: previewParams,
  body: botChallengeRequest,
  response: { status: 200, description: 'The challenge to solve.', schema: botChallenge },
});
export const publicFormEndpoints = [
  getPublicForm,
  submitPublicForm,
  getPublicFormChallenge,
  getPublicFormPreview,
  submitPublicFormPreview,
  getPublicFormPreviewChallenge,
] as const;

/** Where the CRM serves a form as a page of its own, and the preview of a draft. */
export const FORM_PAGE_PATH = '/f';
export const FORM_PREVIEW_PAGE_PATH = '/f/preview';
