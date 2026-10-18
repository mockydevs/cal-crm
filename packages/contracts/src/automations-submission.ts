// What a workflow can read of the form submission that started a run (AUTOMATIONS.md
// section 3): the answers that were sent, each under its question's key, and the page the
// form was on. One file, so the validator, the engine and the builder name the same paths.
//
//   trigger.answers.<questionKey>   an answer of the submission: a hidden question that read
//                                   a query parameter, a choice, a tick, anything asked
//   trigger.pageUrl                 the page the form was sent from, without its query
//
// Only a run a form submission started has them; any other run reads each as empty. They
// are read, never written, and like the touch of that submission (trigger.attribution.*)
// they are the same for the life of the run: a submission is never changed.
import type { FormFieldType } from './forms.js';

/** The page the form was sent from, without its query and fragment. */
export const SUBMISSION_PAGE_PATH = 'trigger.pageUrl';

const ANSWERS = 'trigger.answers.';

/** The triggers whose runs have a submission to read. */
export const submissionTriggers = ['form.submitted'] as const;

/** The path of an answer, by its question's key. */
export const submissionAnswerPath = (questionKey: string): string => `${ANSWERS}${questionKey}`;

/** The question's key a path reads the answer of, or nothing for any other path. */
export const submissionAnswerKey = (path: string): string | undefined =>
  path.startsWith(ANSWERS) ? path.slice(ANSWERS.length) : undefined;

/** Whether a path reads the submission that started the run. */
export const isSubmissionPath = (path: string): boolean =>
  path === SUBMISSION_PAGE_PATH || path.startsWith(ANSWERS);

/** A question's key as a form writes one (forms.ts, formKey). */
export const SUBMISSION_ANSWER_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** The kinds an answer is read as: each is one of the validator's field types. */
export const submissionAnswerKinds = [
  'text',
  'long_text',
  'number',
  'date',
  'boolean',
  'single_choice',
  'multi_choice',
  'email',
  'phone',
  'url',
] as const;
export type SubmissionAnswerType = (typeof submissionAnswerKinds)[number];

/**
 * What an answer to each kind of question is read as. A rating is its number; a hidden
 * question's answer is text, whatever the address carried. A block of text asks nothing,
 * and a terms box is kept apart from the answers, so neither has an answer to read.
 */
export const submissionAnswerTypes = {
  text: 'text',
  long_text: 'long_text',
  email: 'email',
  phone: 'phone',
  number: 'number',
  date: 'date',
  single_choice: 'single_choice',
  checkbox: 'boolean',
  multi_choice: 'multi_choice',
  url: 'url',
  rating: 'number',
  hidden: 'text',
  content: undefined,
  terms: undefined,
} as const satisfies Readonly<Record<FormFieldType, SubmissionAnswerType | undefined>>;

/** A question of a form, as a workflow reads its answer. */
export interface SubmissionQuestion {
  readonly key: string;
  /** What the form calls the question. */
  readonly label: string;
  readonly type: SubmissionAnswerType;
  /** The choices of a choice question, by key, each with what people read. */
  readonly options: readonly { readonly key: string; readonly label: string }[];
}

/** The questions of a form's fields that have an answer, as a workflow reads them. */
export function submissionQuestions(
  fields: readonly {
    readonly key: string;
    readonly type: FormFieldType;
    readonly label: string;
    readonly options?: readonly { readonly key: string; readonly label: string }[] | undefined;
  }[],
): SubmissionQuestion[] {
  return fields.flatMap((field) => {
    const type = submissionAnswerTypes[field.type];
    if (type === undefined) return [];
    const choices = type === 'single_choice' || type === 'multi_choice';
    return [
      {
        key: field.key,
        label: field.label,
        type,
        options: choices
          ? (field.options ?? []).map((option) => ({ key: option.key, label: option.label }))
          : [],
      },
    ];
  });
}
