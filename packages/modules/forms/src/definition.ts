// What a form's definition means, with no database: reading a stored one, what a website is
// shown of it, and what stops a draft from being published.
import {
  choiceKeyOf,
  choiceKeysOf,
  FORM_LIMITS,
  formDefinition,
  formFieldValueTypes,
  type FormDefinition,
  type FormField,
  type FormProblem,
  type PublicForm,
} from '@repo/contracts';

/** A definition with no questions: what a stored one that cannot be read is edited as. */
export const EMPTY_FORM_DEFINITION: FormDefinition = formDefinition.parse({ fields: [] });

/**
 * A stored definition as the contract knows it, or undefined. Rows written before the
 * builder existed (0008 took any JSON object) may hold something else: such a form shows
 * as an empty draft and serves nothing until it is built and published again.
 */
export function storedDefinition(stored: unknown): FormDefinition | undefined {
  const parsed = formDefinition.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

/** Whether a question's answer is one or several of its listed choices. */
export const isChoice = (field: Pick<FormField, 'type'>): boolean =>
  field.type === 'single_choice' || field.type === 'multi_choice';

type PublicField = PublicForm['fields'][number];

/** What only some kinds of question show, each left out where the kind has none. */
function shownExtras(field: FormField): Partial<PublicField> {
  switch (field.type) {
    case 'single_choice':
    case 'multi_choice':
      return { display: field.display ?? 'dropdown' };
    case 'hidden':
      // The page's address is read by the embed. The fixed answer stays here.
      return field.parameter === undefined ? {} : { parameter: field.parameter };
    case 'content':
      return { text: field.text ?? '', style: field.style ?? 'paragraph' };
    case 'terms':
      return {
        text: field.text ?? '',
        ...(field.linkUrl === undefined
          ? {}
          : { linkUrl: field.linkUrl, linkLabel: field.linkLabel ?? '' }),
      };
    case 'checkbox':
    case 'date':
    case 'rating':
      return {};
    case 'text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'number':
    case 'url': {
      const placeholder = field.placeholder ?? '';
      return placeholder === '' ? {} : { placeholder };
    }
  }
}

/** What a website is shown: the questions and boxes, and never where an answer goes. */
export function publicView(definition: FormDefinition, renderToken: string): PublicForm {
  return {
    title: definition.title,
    description: definition.description,
    submitLabel: definition.submitLabel,
    successMessage: definition.successMessage,
    ...(definition.afterSubmit?.kind === 'redirect'
      ? { redirectUrl: definition.afterSubmit.url }
      : {}),
    fields: definition.fields.map((field) => ({
      key: field.key,
      type: field.type,
      // The label of a block of text or a terms box is the builder's name for it.
      label: field.type === 'content' || field.type === 'terms' ? '' : field.label,
      helpText: field.helpText,
      required: field.required,
      options: field.options.map((option) => ({ key: option.key, label: option.label })),
      ...shownExtras(field),
      // A visible question's query key: the embed fills the control from the page's address
      // when the form is shown, and the visitor may change it (a hidden question's is above).
      ...(field.type !== 'hidden' && field.parameter !== undefined
        ? { parameter: field.parameter }
        : {}),
    })),
    consents: definition.consents.map((consent) => ({
      key: consent.key,
      wording: consent.wording,
      required: consent.required,
    })),
    renderToken,
    // Only when it is on, so a form without it shows exactly what it showed before.
    ...(definition.botProtection === 'altcha' ? { botProtection: 'altcha' as const } : {}),
    textLength: FORM_LIMITS.textLength,
    longTextLength: FORM_LIMITS.longTextLength,
  };
}

/** A contact custom field of this business, as far as a form's mapping depends on it. */
export interface ContactFieldFacts {
  readonly valueType: string;
  readonly archived: boolean;
  /** The keys of its choices that can still be chosen; empty for other kinds. */
  readonly choices: readonly string[];
  /** Its choices with their labels, archived ones too; empty or left out for other kinds. */
  readonly options?: readonly { key: string; label: string; archived: boolean }[];
}

/**
 * The value a hidden question's text puts in a choice field: the choice it names by key
 * or by label, or for a field that takes several, the choices it names separated by
 * commas. Undefined when it names something that is not a choice, which is not written.
 */
export function hiddenChoiceValue(
  valueType: string,
  options: readonly { key: string; label: string; archived: boolean }[],
  text: string,
): string | string[] | undefined {
  if (valueType === 'multi_choice') return choiceKeysOf(options, text);
  return valueType === 'single_choice' ? choiceKeyOf(options, text) : undefined;
}

export interface PublishFacts {
  /** The business's contact custom fields, by public id (fld_…). */
  readonly fields: ReadonlyMap<string, ContactFieldFacts>;
  /** The business's tags, by public id (tag_…). */
  readonly tags: ReadonlySet<string>;
  /** The people a form may name to be told, by membership id (mem_…). */
  readonly members: ReadonlySet<string>;
}

const fills = (definition: FormDefinition, attribute: 'email' | 'phone') =>
  definition.fields.filter(
    (field) => field.target.kind === 'contact' && field.target.attribute === attribute,
  );

/**
 * Everything that stops this definition from being published, each pointing at the part to
 * change. Empty means it can go live. The contract already refused what the form alone
 * shows to be wrong; this adds what depends on the business and on being complete.
 *
 * A form needs no website listed: it always has a page of its own, served by the CRM.
 */
export function publishProblems(definition: FormDefinition, facts: PublishFacts): FormProblem[] {
  const problems: FormProblem[] = [];
  // A block of text asks nothing.
  const questions = definition.fields.filter((field) => field.type !== 'content');
  if (questions.length === 0)
    problems.push({ path: '/fields', code: 'no_questions', message: 'Add at least one question.' });
  const email = fills(definition, 'email');
  const phone = fills(definition, 'phone');
  // Without an address that is always given, every submission would be a new contact.
  if (questions.length > 0 && ![...email, ...phone].some((field) => field.required))
    problems.push({
      path: '/fields',
      code: 'no_identity',
      message:
        'Ask for an email address or a phone number, filling that part of the contact, and make it required.',
    });
  for (const [index, field] of definition.fields.entries()) {
    const at = `/fields/${String(index)}`;
    if (isChoice(field) && field.options.length === 0)
      problems.push({
        path: `${at}/options`,
        code: 'no_choices',
        message: 'Add at least one choice.',
      });
    if (field.target.kind !== 'field') continue;
    const target = facts.fields.get(field.target.fieldId);
    if (target === undefined) {
      problems.push({
        path: `${at}/target`,
        code: 'unknown_field',
        message: 'This contact field no longer exists. Choose another.',
      });
      continue;
    }
    if (target.archived) {
      problems.push({
        path: `${at}/target`,
        code: 'archived_field',
        message: 'This contact field is archived. Restore it or choose another.',
      });
      continue;
    }
    const accepted: readonly string[] = formFieldValueTypes[field.type];
    if (!accepted.includes(target.valueType)) {
      problems.push({
        path: `${at}/target`,
        code: 'incompatible_field',
        message: 'This kind of question cannot fill that contact field.',
      });
      continue;
    }
    // A hidden question's fixed answer must name a choice the field still offers.
    const fixed = field.type === 'hidden' ? (field.defaultValue ?? '') : '';
    if (
      fixed !== '' &&
      (target.valueType === 'single_choice' || target.valueType === 'multi_choice') &&
      hiddenChoiceValue(target.valueType, target.options ?? [], fixed) === undefined
    )
      problems.push({
        path: `${at}/defaultValue`,
        code: 'unknown_choice',
        message: `This fixed answer is not one of the contact field’s choices: ${(
          target.options ?? []
        )
          .filter((option) => !option.archived)
          .map((option) => option.label)
          .join(', ')}.`,
      });
    if (isChoice(field))
      for (const [place, option] of field.options.entries())
        if (!target.choices.includes(option.key))
          problems.push({
            path: `${at}/options/${String(place)}/key`,
            code: 'unknown_choice',
            message: "This is not one of the contact field's choices.",
          });
  }
  for (const [index, consent] of definition.consents.entries()) {
    const needs = consent.channel === 'email' ? email : phone;
    if (needs.length === 0)
      problems.push({
        path: `/consents/${String(index)}/channel`,
        code: 'no_address',
        message:
          consent.channel === 'email'
            ? "Ask for an email address, filling the contact's email, to offer this box."
            : "Ask for a phone number, filling the contact's phone, to offer this box.",
      });
  }
  for (const [index, tagId] of (definition.contactActions?.tagIds ?? []).entries())
    if (!facts.tags.has(tagId))
      problems.push({
        path: `/contactActions/tagIds/${String(index)}`,
        code: 'unknown_tag',
        message: 'This tag no longer exists. Remove it or choose another.',
      });
  if (definition.notify?.mode === 'members')
    for (const [index, memberId] of definition.notify.memberIds.entries())
      if (!facts.members.has(memberId))
        problems.push({
          path: `/notify/memberIds/${String(index)}`,
          code: 'unknown_member',
          message: 'This person is no longer on the team. Remove them or choose someone else.',
        });
  return problems;
}
