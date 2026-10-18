// The form submission that started a run, as conditions and merge fields read it
// (AUTOMATIONS.md section 3): its answers under trigger.answers.<questionKey>, and the page
// it was sent from under trigger.pageUrl. A submission is stored once and never changed, so
// a run reads the same answers for as long as it lives, whatever the contact sends later.
//
// The event carries ids only: the submission is read here, by the event's subject. Only
// what the form stored is read: the answers a visitor gave (a hidden question's among
// them), and the page without its query. Nothing of the address's query is here, so no
// click id is either.
import {
  formDefinition,
  SUBMISSION_PAGE_PATH,
  submissionAnswerPath,
  submissionQuestions,
  submissionTriggers,
  type ConditionValue,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import * as z from 'zod';

/** Whether an event of this type is a form submission, with answers to read. */
export const hasSubmission = (eventType: string): boolean =>
  (submissionTriggers as readonly string[]).includes(eventType);

/** What a run no submission started reads: no page, and no answer under any key. */
export const NO_SUBMISSION: Readonly<Record<string, ConditionValue>> = {
  [SUBMISSION_PAGE_PATH]: null,
};

// What a submission keeps of its answers (forms: submissions.ts, StoredAnswers).
const stored = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      value: z.union([z.string(), z.boolean(), z.array(z.string())]).nullable(),
    }),
  ),
});

/**
 * An answer as a condition compares it. A number and a rating are kept as the text the
 * visitor typed, exact; a condition compares numbers, so each is read as one where the
 * form asks that question as a number today.
 */
function answerValue(
  value: string | boolean | readonly string[] | null,
  numeric: boolean,
): ConditionValue {
  if (typeof value !== 'string' || !numeric) return value;
  const number = Number(value);
  return value.trim() !== '' && Number.isFinite(number) ? number : value;
}

/**
 * The values of the submission an event is about: the page, and each answer by its key.
 * An event that is no submission, or whose submission is gone (discarded, or erased with
 * its contact), gives the page as empty and no answers.
 */
export async function readSubmissionValues(
  trx: DatabaseTransaction,
  event: { readonly type: string; readonly subject_kind: string; readonly subject_id: string },
): Promise<Record<string, ConditionValue>> {
  if (!hasSubmission(event.type) || event.subject_kind !== 'form_submission')
    return { ...NO_SUBMISSION };
  const row = await trx
    .selectFrom('forms.submissions as submission')
    .innerJoin('forms.forms as form', 'form.id', 'submission.form_id')
    .select(['submission.page_url', 'submission.data', 'form.published_definition'])
    .where('submission.id', '=', event.subject_id)
    .executeTakeFirst();
  if (row === undefined) return { ...NO_SUBMISSION };
  const values: Record<string, ConditionValue> = { [SUBMISSION_PAGE_PATH]: row.page_url };
  const answers = stored.safeParse(row.data);
  if (!answers.success) return values;
  const definition = formDefinition.safeParse(row.published_definition);
  const numeric = new Set(
    definition.success
      ? submissionQuestions(definition.data.fields)
          .filter((question) => question.type === 'number')
          .map((question) => question.key)
      : [],
  );
  for (const answer of answers.data.answers)
    values[submissionAnswerPath(answer.key)] = answerValue(answer.value, numeric.has(answer.key));
  return values;
}
