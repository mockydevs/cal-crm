// The mark beside a recurring task's title in a list: a repeat icon that says how the task
// repeats and when the series' next task is due, or that the series has ended.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { TaskRecurrence } from '@repo/contracts';
import { Repeat } from 'lucide-react';
import type { ReactElement } from 'react';

export function RecurrenceMark({
  recurrence,
  format,
}: {
  readonly recurrence: TaskRecurrence;
  /** How the list writes a due time. */
  readonly format: (date: Date) => string;
}): ReactElement {
  const { t } = useLingui();
  const every = recurrence.every;
  const rule = {
    hourly: plural(every, { one: 'Repeats every hour', other: 'Repeats every # hours' }),
    daily: plural(every, { one: 'Repeats every day', other: 'Repeats every # days' }),
    weekly: plural(every, { one: 'Repeats every week', other: 'Repeats every # weeks' }),
    monthly: plural(every, { one: 'Repeats every month', other: 'Repeats every # months' }),
    yearly: plural(every, { one: 'Repeats every year', other: 'Repeats every # years' }),
  }[recurrence.frequency];
  const next =
    recurrence.active && recurrence.nextDueAt !== null
      ? format(new Date(recurrence.nextDueAt))
      : undefined;
  const words =
    next === undefined ? t`${rule}. The series has ended.` : t`${rule}. Next due ${next}.`;
  return (
    <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-xs font-normal text-muted-foreground">
      <Repeat aria-hidden className="size-3.5" strokeWidth={2} />
      <span className="sr-only">{words}</span>
      <span aria-hidden title={words}>
        {next === undefined ? t`Ended` : t`Next ${next}`}
      </span>
    </span>
  );
}

/** The choice a deletion of a task of a series offers: that task, or its upcoming ones too. */
export function SeriesDeleteChoice({
  checked,
  disabled = false,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <label className="mt-3 flex min-h-11 items-center gap-2.5 text-sm text-foreground lg:min-h-8">
      <input
        type="checkbox"
        className="size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <Trans>Also delete all upcoming tasks in this series</Trans>
    </label>
  );
}
