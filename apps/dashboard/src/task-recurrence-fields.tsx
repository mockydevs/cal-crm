// The task panel's "Recurring Task" section, in GoHighLevel's words: the switch, "Repeats
// every" a number of hours, days, weeks, months or years, "Ends on" never, a custom date or
// after a number of tasks, and whether a new task is made while the one before is overdue.
// A task of a series first asks whether a change is for "This task only" or "This and all
// future tasks". Loaded with its own words when a task form opens (task-recurrence-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import type { TaskFrequency } from '@repo/contracts';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useId, type ReactElement } from 'react';
import type { RecurrenceDraft, RecurrenceEnd } from './task-recurrence-rules';

const checkboxClassName = 'size-4 shrink-0 accent-primary';
const checkLabelClassName = 'flex min-h-11 items-center gap-2.5 text-sm lg:min-h-8';

/** What the form found wrong before sending: a field of the rule, or a missing due date. */
export type RecurrenceProblem = 'every' | 'endsOn' | 'occurrences' | 'due';

export function RecurrenceSection({
  inSeries,
  applyTo,
  onApplyTo,
  draft,
  onChange,
  problem,
  serverProblems,
  disabled = false,
}: {
  /** The task is one of a series. */
  readonly inSeries: boolean;
  readonly applyTo: 'this' | 'series';
  readonly onApplyTo: (next: 'this' | 'series') => void;
  readonly draft: RecurrenceDraft;
  readonly onChange: (next: RecurrenceDraft) => void;
  readonly problem: RecurrenceProblem | undefined;
  /** What the server said, by field: a refusal of the rule is under `recurrence`. */
  readonly serverProblems?: Readonly<Record<string, string | undefined>>;
  readonly disabled?: boolean;
}): ReactElement {
  const { t } = useLingui();
  const applyGroupId = useId();
  const words: Record<RecurrenceProblem, string> = {
    every: t`Use a whole number from 1 to 999.`,
    endsOn: t`Choose the last day.`,
    occurrences: t`Use a whole number from 1 to 1000.`,
    due: t`Give a recurring task a due date and time.`,
  };
  const problems = {
    ...serverProblems,
    ...(problem === undefined
      ? {}
      : { [problem === 'due' ? 'recurrence' : problem]: words[problem] }),
  };
  const choice = (value: 'this' | 'series', label: string) => (
    <label className={checkLabelClassName}>
      <input
        type="radio"
        name={applyGroupId}
        className={checkboxClassName}
        checked={applyTo === value}
        disabled={disabled}
        onChange={() => {
          onApplyTo(value);
        }}
      />
      {label}
    </label>
  );
  return (
    <>
      {inSeries ? (
        <div role="radiogroup" aria-label={t`Apply changes to`} className="flex flex-col gap-1">
          <span className="text-sm font-medium">
            <Trans>Apply changes to</Trans>
          </span>
          {choice('this', t`This task only`)}
          {choice('series', t`This and all future tasks`)}
        </div>
      ) : null}
      {!inSeries || applyTo === 'series' ? (
        <RecurrenceFields
          draft={draft}
          onChange={onChange}
          problems={problems}
          label={inSeries ? t`Keep repeating` : t`Recurring Task`}
          disabled={disabled}
        />
      ) : null}
    </>
  );
}

function RecurrenceFields({
  draft,
  onChange,
  problems,
  label,
  disabled,
}: {
  readonly draft: RecurrenceDraft;
  readonly onChange: (next: RecurrenceDraft) => void;
  readonly problems: Readonly<Record<string, string | undefined>>;
  readonly label: string;
  readonly disabled: boolean;
}): ReactElement {
  const { t } = useLingui();
  const endsGroupId = useId();
  const units: Record<TaskFrequency, string> = {
    hourly: t`Hours`,
    daily: t`Days`,
    weekly: t`Weeks`,
    monthly: t`Months`,
    yearly: t`Years`,
  };
  const ends: { readonly value: RecurrenceEnd; readonly label: string }[] = [
    { value: 'never', label: t`Never` },
    { value: 'on', label: t`Custom Date` },
    { value: 'after', label: t`After a set number of occurrences` },
  ];
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="sr-only">
        <Trans>Recurring Task</Trans>
      </legend>
      <label className={checkLabelClassName}>
        <input
          type="checkbox"
          className={checkboxClassName}
          checked={draft.on}
          onChange={(event) => {
            onChange({ ...draft, on: event.target.checked });
          }}
        />
        <span className="font-medium">{label}</span>
      </label>
      {draft.on ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <Field name="every" invalid={problems['every'] !== undefined}>
            <FieldLabel>
              <Trans>Repeats every</Trans>
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                className="w-24"
                inputMode="numeric"
                aria-label={t`Repeats every`}
                value={draft.every}
                onChange={(event) => {
                  onChange({ ...draft, every: event.target.value });
                }}
              />
              <Select
                aria-label={t`Unit`}
                value={draft.frequency}
                onValueChange={(next) => {
                  const frequency = (Object.keys(units) as TaskFrequency[]).find(
                    (each) => each === next,
                  );
                  if (frequency !== undefined) onChange({ ...draft, frequency });
                }}
              >
                {(Object.keys(units) as TaskFrequency[]).map((frequency) => (
                  <option key={frequency} value={frequency}>
                    {units[frequency]}
                  </option>
                ))}
              </Select>
            </div>
            <FieldDescription>
              <Trans>
                Each next task is made on schedule, as long before it is due as this one is, whether
                or not the last one was completed.
              </Trans>
            </FieldDescription>
            {problems['every'] === undefined ? null : (
              <FieldError match>{problems['every']}</FieldError>
            )}
          </Field>
          <div role="radiogroup" aria-label={t`Ends on`} className="flex flex-col gap-1">
            <span className="text-sm font-medium">
              <Trans>Ends on</Trans>
            </span>
            {ends.map((end) => (
              <label key={end.value} className={checkLabelClassName}>
                <input
                  type="radio"
                  name={endsGroupId}
                  className={checkboxClassName}
                  checked={draft.ends === end.value}
                  onChange={() => {
                    onChange({ ...draft, ends: end.value });
                  }}
                />
                {end.label}
              </label>
            ))}
          </div>
          {draft.ends === 'on' ? (
            <Field name="endsOn" invalid={problems['endsOn'] !== undefined}>
              <FieldLabel>
                <Trans>End date</Trans>
              </FieldLabel>
              <Input
                type="date"
                value={draft.endsOn}
                onChange={(event) => {
                  onChange({ ...draft, endsOn: event.target.value });
                }}
              />
              {problems['endsOn'] === undefined ? null : (
                <FieldError match>{problems['endsOn']}</FieldError>
              )}
            </Field>
          ) : null}
          {draft.ends === 'after' ? (
            <Field name="occurrences" invalid={problems['occurrences'] !== undefined}>
              <FieldLabel>
                <Trans>Occurrences</Trans>
              </FieldLabel>
              <Input
                className="w-24"
                inputMode="numeric"
                value={draft.occurrences}
                onChange={(event) => {
                  onChange({ ...draft, occurrences: event.target.value });
                }}
              />
              <FieldDescription>
                <Trans>
                  Every scheduled task counts, one not made because the task before it was overdue
                  included, so the series always ends.
                </Trans>
              </FieldDescription>
              {problems['occurrences'] === undefined ? null : (
                <FieldError match>{problems['occurrences']}</FieldError>
              )}
            </Field>
          ) : null}
          <label className={checkLabelClassName}>
            <input
              type="checkbox"
              className={checkboxClassName}
              checked={draft.createIfOverdue}
              onChange={(event) => {
                onChange({ ...draft, createIfOverdue: event.target.checked });
              }}
            />
            <Trans>Create a new task even if the previous one is overdue</Trans>
          </label>
        </div>
      ) : null}
      {problems['recurrence'] === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problems['recurrence']}
        </p>
      )}
    </fieldset>
  );
}
