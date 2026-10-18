// What a run a form submission started can read of that submission, as fields a filter, a
// condition and a message choose from: each answer under its question's key
// (trigger.answers.<key>) and the page the form was sent from (trigger.pageUrl). Which
// answers there are comes from the forms the workflow's "Form submitted" triggers name, as
// the validator reads them (automations-validate.ts). Small and apart from the trigger
// panel's own rules (automation-trigger-filters.ts): every list of fields reads this.
//
// Its words are in the builder's own catalog (lingui.config.ts, automation-words.ts).
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  SUBMISSION_PAGE_PATH,
  submissionAnswerPath,
  type AutomationFieldType,
  type AutomationSetup,
} from '@repo/contracts';
import type { AnswerField } from './automation-answer-field';
import type { FilterRow } from './automation-filters';

export interface AnswerQuestion {
  readonly key: string;
  readonly label: string;
  readonly type: AutomationFieldType;
  readonly options: readonly { readonly key: string; readonly label: string }[];
}

/** What a run a form submission started can read of that submission. */
export interface SubmissionScope {
  /** The questions whose answers can be read, each once by its key. */
  readonly questions: readonly AnswerQuestion[];
  /** The name of the one form they are of, when the workflow starts from just one. */
  readonly form: string | undefined;
}

/** The setup the builder's panels are given: the business's, and what a submission holds. */
export type BuilderSetup = AutomationSetup & {
  /**
   * The answers of the submission that started the run, as fields to choose from
   * (`answerFields`): worked out once where a panel opens, so the lists of fields that
   * read them carry none of these rules.
   */
  readonly answers?: readonly AnswerField[] | undefined;
};

/**
 * The answers a workflow can read, from the form each of its "Form submitted" triggers
 * names (as the validator reads them, automations-validate.ts). When every such trigger
 * names a published form, an answer has its question's kind and choices; a key two forms
 * ask in two ways is read as text. When one of them starts for any form, or names a form
 * whose questions are not known, every published form's questions are offered and each is
 * read as text. Nothing when no trigger is a form submission: there is no submission to read.
 */
export function submissionScope(
  forms: AutomationSetup['forms'],
  named: readonly unknown[],
): SubmissionScope | undefined {
  if (named.length === 0) return undefined;
  const chosen = forms.filter((form) => named.includes(form.id) || named.includes(form.name));
  const exact =
    named.every((form) => typeof form === 'string') &&
    chosen.length >= new Set(named).size &&
    chosen.every((form) => form.questions !== undefined);
  const from = exact ? chosen : forms;
  const byKey = new Map<string, AnswerQuestion>();
  for (const form of from)
    for (const question of form.questions ?? []) {
      const held = byKey.get(question.key);
      if (held === undefined) {
        byKey.set(
          question.key,
          exact ? { ...question, options: [...question.options] } : asText(question),
        );
        continue;
      }
      if (held.type !== question.type) {
        byKey.set(question.key, asText(held));
        continue;
      }
      if (held.type === 'text' && held.options.length === 0) continue;
      const known = new Set(held.options.map((option) => option.key));
      byKey.set(question.key, {
        ...held,
        options: [...held.options, ...question.options.filter((option) => !known.has(option.key))],
      });
    }
  return {
    questions: [...byKey.values()],
    form: exact && chosen.length === 1 ? chosen[0]?.name : undefined,
  };
}

const asText = (question: AnswerQuestion): AnswerQuestion => ({
  key: question.key,
  label: question.label,
  type: 'text',
  options: [],
});

/** The forms a draft's "Form submitted" triggers name: one entry a trigger, as written. */
export function formsNamed(
  triggers: readonly {
    readonly type: string;
    readonly config: Readonly<Record<string, unknown>>;
  }[],
): unknown[] {
  return triggers
    .filter((trigger) => trigger.type === 'form.submitted')
    .map((trigger) => trigger.config['form']);
}

export type { AnswerField } from './automation-answer-field';

/** What the answers are listed under, wherever a field is chosen. */
export const answersHeading = (scope: SubmissionScope): string => {
  const { form } = scope;
  return form === undefined ? i18n._(msg`Form answers`) : i18n._(msg`Answers to ${form}`);
};

/** The answers and the page of the submission, as fields to choose from. */
export function answerFields(scope: SubmissionScope | undefined): AnswerField[] {
  if (scope === undefined) return [];
  const heading = answersHeading(scope);
  return [
    ...scope.questions.map((question) => ({
      path: submissionAnswerPath(question.key),
      label: question.label.trim() === '' ? question.key : question.label,
      type: question.type,
      options: question.options,
      heading,
    })),
    {
      path: SUBMISSION_PAGE_PATH,
      label: i18n._(msg`Page the form was sent from`),
      type: 'text' as const,
      options: [],
      heading,
    },
  ];
}

/**
 * A new filter row on an answer: the first comparison its kind takes, and no value yet.
 * (As automation-filters.ts orders them: a list "includes", a date is "before", the rest "is".)
 */
export function answerRow(field: Pick<AnswerField, 'path' | 'type'>): FilterRow {
  return {
    field: field.path,
    operator:
      field.type === 'multi_choice' ? 'includes' : field.type === 'date' ? 'before' : 'equals',
    value: undefined,
  };
}
