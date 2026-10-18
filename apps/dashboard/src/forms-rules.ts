// What the form builder does with a form apart from the screen: the draft its controls
// hold, the changes a button makes to it, where each question may save its answer, and
// where each of the API's problems belongs.
import {
  choiceKeysOf,
  formAttributeTypes,
  formContactAttributes,
  formFieldValueTypes,
  formPlaceholderTypes,
  formPrefillTypes,
  type FieldDefinition,
  type Form,
  type FormConsent,
  type FormContactAttribute,
  type FormDefinition,
  type FormField,
  type FormFieldTarget,
  type FormFieldType,
  type FormProblem,
  type UpdateFormInput,
} from '@repo/contracts';

/** The builder's values, as its controls hold them. */
export interface FormDraft {
  readonly name: string;
  /** One website a line, as typed. */
  readonly websites: string;
  readonly definition: FormDefinition;
}

export function draftOf(form: Pick<Form, 'name' | 'allowedOrigins' | 'definition'>): FormDraft {
  return {
    name: form.name,
    websites: form.allowedOrigins.join('\n'),
    definition: form.definition,
  };
}

/** The websites box as a list: one a line, without the spaces around each or empty lines. */
export function websiteLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** What the API takes for a draft. It is checked by the API's own schema before it is sent. */
export function inputOf(
  draft: FormDraft,
  revision: string,
): Record<keyof UpdateFormInput, unknown> {
  return {
    name: draft.name,
    definition: draft.definition,
    allowedOrigins: websiteLines(draft.websites),
    revision,
  };
}

/** Whether the builder holds anything the saved form does not. */
export function isChanged(draft: FormDraft, saved: FormDraft): boolean {
  return (
    draft.name.trim() !== saved.name ||
    JSON.stringify(websiteLines(draft.websites)) !== JSON.stringify(websiteLines(saved.websites)) ||
    JSON.stringify(draft.definition) !== JSON.stringify(saved.definition)
  );
}

/** A key no question or box of the form has yet: q1, q2 and so on. */
export function newKey(prefix: string, taken: readonly string[]): string {
  let number = 1;
  while (taken.includes(`${prefix}${String(number)}`)) number += 1;
  return `${prefix}${String(number)}`;
}

const keysOf = (definition: FormDefinition): string[] => [
  ...definition.fields.map((field) => field.key),
  ...definition.consents.map((consent) => consent.key),
];

/**
 * A choice's key, made from its label: lowercase letters, digits and underscores, starting
 * with a letter, and not one the question already has. A label with nothing to make a key
 * from gets a numbered one.
 */
export function choiceKey(label: string, taken: readonly string[]): string {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 36);
  const base = /^[a-z]/.test(slug) ? slug : '';
  if (base !== '' && !taken.includes(base)) return base;
  return newKey(base === '' ? 'choice' : `${base}_`, taken);
}

/** The same list with one item moved one place up (-1) or down (1). */
export function moved<Item>(items: readonly Item[], index: number, by: -1 | 1): Item[] {
  const to = index + by;
  const item = items[index];
  const other = items[to];
  if (item === undefined || other === undefined) return [...items];
  const next = [...items];
  next[index] = other;
  next[to] = item;
  return next;
}

/** The form with a new short-answer question at the end, kept with the submission only. */
export function withQuestion(definition: FormDefinition, label: string): FormDefinition {
  const field: FormField = {
    key: newKey('q', keysOf(definition)),
    type: 'text',
    label,
    helpText: '',
    required: false,
    options: [],
    target: { kind: 'none' },
  };
  return { ...definition, fields: [...definition.fields, field] };
}

/** The channels a form has no consent box for yet. */
export function freeChannels(definition: FormDefinition): FormConsent['channel'][] {
  const used = definition.consents.map((consent) => consent.channel);
  return (['email', 'sms'] as const).filter((channel) => !used.includes(channel));
}

/** The form with a consent box for the first channel that has none, or unchanged. */
export function withConsent(definition: FormDefinition, wording: string): FormDefinition {
  const [channel] = freeChannels(definition);
  if (channel === undefined) return definition;
  return {
    ...definition,
    consents: [
      ...definition.consents,
      { key: newKey('consent', keysOf(definition)), channel, wording, required: false },
    ],
  };
}

export function withField(
  definition: FormDefinition,
  index: number,
  change: Partial<FormField>,
): FormDefinition {
  return {
    ...definition,
    fields: definition.fields.map((field, place) =>
      place === index ? { ...field, ...change } : field,
    ),
  };
}

export function withConsentChange(
  definition: FormDefinition,
  index: number,
  change: Partial<FormConsent>,
): FormDefinition {
  return {
    ...definition,
    consents: definition.consents.map((consent, place) =>
      place === index ? { ...consent, ...change } : consent,
    ),
  };
}

/** A target as one value a select can hold, and back. */
export function targetValue(target: FormFieldTarget): string {
  if (target.kind === 'contact') return `contact:${target.attribute}`;
  return target.kind === 'field' ? `field:${target.fieldId}` : 'none';
}
export function targetOf(value: string): FormFieldTarget {
  const [kind, rest = ''] = value.split(':');
  const attribute = formContactAttributes.find((each) => each === rest);
  if (kind === 'contact' && attribute !== undefined) return { kind: 'contact', attribute };
  return kind === 'field' && rest !== '' ? { kind: 'field', fieldId: rest } : { kind: 'none' };
}

/** Whether a contact field can take this kind of question's answer. */
export function takes(field: Pick<FieldDefinition, 'valueType'>, type: FormFieldType): boolean {
  const accepted: readonly string[] = formFieldValueTypes[type];
  return accepted.includes(field.valueType);
}

export interface TargetChoices {
  /** The parts of a contact this kind of question can fill. */
  readonly attributes: readonly FormContactAttribute[];
  /** The contact's own fields it can fill: live ones, of a kind that fits. */
  readonly fields: readonly FieldDefinition[];
}

/**
 * Where a question of this kind may save its answer. What another question of the form
 * already fills is left out, and so is an archived field, unless it is this question's own
 * saved target, which stays listed so the select can show what is stored.
 */
export function targetChoices(
  definition: FormDefinition,
  index: number,
  contactFields: readonly FieldDefinition[],
): TargetChoices {
  const own = definition.fields[index];
  if (own === undefined) return { attributes: [], fields: [] };
  const current = targetValue(own.target);
  const taken = new Set(
    definition.fields
      .filter((_field, place) => place !== index)
      .map((field) => targetValue(field.target)),
  );
  return {
    attributes: formContactAttributes.filter(
      (attribute) =>
        formAttributeTypes[attribute] === own.type && !taken.has(`contact:${attribute}`),
    ),
    fields: contactFields.filter((field) => {
      const value = `field:${field.id}`;
      if (value === current) return true;
      return (
        field.objectKey === 'contact' &&
        !field.archived &&
        takes(field, own.type) &&
        !taken.has(value)
      );
    }),
  };
}

/**
 * The question with another kind of answer. Choices belong to a choice question only, and
 * a target that no longer fits is dropped: the answer is then kept with the submission.
 */
export function retyped(
  field: FormField,
  type: FormFieldType,
  contactFields: readonly FieldDefinition[],
): FormField {
  const target = field.target;
  const fits =
    target.kind === 'none' ||
    (target.kind === 'contact'
      ? formAttributeTypes[target.attribute] === type
      : contactFields.some((each) => each.id === target.fieldId && takes(each, type)));
  // Each kind keeps only the settings that mean something for it.
  return {
    key: field.key,
    type,
    label: field.label,
    helpText: unseen(type) ? '' : field.helpText,
    required: type === 'hidden' || type === 'content' ? false : field.required,
    options: isChoice(type) ? field.options : [],
    target: fits && !answerless(type) ? target : { kind: 'none' },
    ...(field.placeholder !== undefined && takesPlaceholder(type)
      ? { placeholder: field.placeholder }
      : {}),
    ...(type === 'hidden'
      ? {
          // A hidden question reads the campaign from the page's address until told otherwise.
          parameter: field.parameter ?? 'utm_campaign',
          ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
        }
      : // A query key someone gave a visible question stays with it while its new kind takes
        // one. What a hidden question read is not handed to a question people see.
        field.parameter !== undefined && field.type !== 'hidden' && takesQueryKey(type)
        ? { parameter: field.parameter }
        : {}),
    ...(answerless(type) ? { text: field.text ?? field.label } : {}),
    ...(type === 'content' && field.style !== undefined ? { style: field.style } : {}),
    ...(type === 'terms' && field.linkUrl !== undefined ? { linkUrl: field.linkUrl } : {}),
    ...(type === 'terms' && field.linkLabel !== undefined ? { linkLabel: field.linkLabel } : {}),
  };
}

/** A question whose answer is one or several of its listed choices. */
export const isChoice = (type: FormFieldType): boolean =>
  type === 'single_choice' || type === 'multi_choice';

/** Words on the form or a box to agree to: nothing is saved to the contact. */
export const answerless = (type: FormFieldType): boolean => type === 'content' || type === 'terms';

/** Never shown to a visitor as a question with a hint: a hidden field, or words on the form. */
export const unseen = (type: FormFieldType): boolean => type === 'hidden' || type === 'content';

/** Whether a question of this kind can show a placeholder in its box. */
/**
 * A visible question that can be filled from the address of the page the form is on (its
 * "query key"): the kinds the API takes one for.
 */
export const takesQueryKey = (type: FormFieldType): boolean =>
  (formPrefillTypes as readonly FormFieldType[]).includes(type);

export const takesPlaceholder = (type: FormFieldType): boolean =>
  (formPlaceholderTypes as readonly string[]).includes(type);

/** The optional settings of a question that are text: left out of the form when emptied. */
export type FormFieldExtra =
  'placeholder' | 'parameter' | 'defaultValue' | 'text' | 'linkUrl' | 'linkLabel';

/** The question with one of its optional text settings set, or removed when it is emptied. */
export function withExtra(field: FormField, key: FormFieldExtra, value: string): FormField {
  const { [key]: _removed, ...rest } = field;
  return value === '' ? rest : { ...rest, [key]: value };
}

/**
 * The question saving its answer somewhere else. A choice question that fills a contact
 * field takes that field's choices, the ones that can still be chosen: any other choice
 * could not be stored in it.
 */
/** Whether a contact field holds one or several of its choices. */
export const isChoiceField = (field: Pick<FieldDefinition, 'valueType'>): boolean =>
  field.valueType === 'single_choice' || field.valueType === 'multi_choice';

export function retargeted(
  field: FormField,
  target: FormFieldTarget,
  contactFields: readonly FieldDefinition[],
): FormField {
  const chosen =
    target.kind === 'field' ? contactFields.find((each) => each.id === target.fieldId) : undefined;
  // A hidden question's fixed answer for a choice field is the key of a choice it names.
  if (field.type === 'hidden' && chosen !== undefined && isChoiceField(chosen)) {
    const { defaultValue, ...rest } = field;
    const keys =
      defaultValue === undefined ? undefined : choiceKeysOf(chosen.options, defaultValue);
    const single = chosen.valueType === 'single_choice' && keys !== undefined && keys.length > 1;
    return keys === undefined || single
      ? { ...rest, target }
      : { ...rest, target, defaultValue: keys.join(', ') };
  }
  if (!isChoice(field.type) || target.kind !== 'field') return { ...field, target };
  return {
    ...field,
    target,
    options:
      chosen === undefined
        ? field.options
        : chosen.options
            .filter((option) => !option.archived)
            .map((option) => ({ key: option.key, label: option.label })),
  };
}

export interface PlacedProblems {
  /** About the form as a whole, or a part that has no place of its own. */
  readonly form: readonly string[];
  readonly name: readonly string[];
  readonly websites: readonly string[];
  /** By the question's place in the form. */
  readonly fields: ReadonlyMap<number, readonly string[]>;
  readonly consents: ReadonlyMap<number, readonly string[]>;
}

/** Each problem where the builder shows it: by its question, its box, or the websites. */
export function placed(problems: readonly Pick<FormProblem, 'path' | 'message'>[]): PlacedProblems {
  const form: string[] = [];
  const name: string[] = [];
  const websites: string[] = [];
  const fields = new Map<number, string[]>();
  const consents = new Map<number, string[]>();
  for (const problem of problems) {
    const [, section, place] =
      /^\/(?:definition\/)?([a-zA-Z]+)(?:\/(\d+))?/.exec(problem.path) ?? [];
    const index = place === undefined ? undefined : Number(place);
    if (section === 'allowedOrigins') websites.push(problem.message);
    else if (section === 'name') name.push(problem.message);
    else if (section === 'fields' && index !== undefined)
      fields.set(index, [...(fields.get(index) ?? []), problem.message]);
    else if (section === 'consents' && index !== undefined)
      consents.set(index, [...(consents.get(index) ?? []), problem.message]);
    else form.push(problem.message);
  }
  return { form, name, websites, fields, consents };
}
