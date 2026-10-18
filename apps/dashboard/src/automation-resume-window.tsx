// "Only go on during": the weekdays and hours when a run may go on from a wait
// (the contract's `resumeWindow`). A switch, seven day buttons and two times, in place of
// writing the object in the JSON view. Switched off, the setting is left out.
import { Trans, useLingui } from '@lingui/react/macro';
import { Input } from '@repo/ui/components/input';
import type { ReactElement } from 'react';
import {
  DEFAULT_RESUME_WINDOW,
  resumeWindowParts,
  WINDOW_DAYS,
  type WindowDay,
} from './automation-fields';
import { Switch } from './automation-switch';

export interface ResumeWindowProps {
  readonly id: string;
  readonly value: unknown;
  readonly describedBy: string | undefined;
  readonly onChange: (next: unknown) => void;
}

export function ResumeWindow({
  id,
  value,
  describedBy,
  onChange,
}: ResumeWindowProps): ReactElement {
  const { t } = useLingui();
  const parts = resumeWindowParts(value);
  const names: Readonly<Record<WindowDay, readonly [short: string, long: string]>> = {
    monday: [t`Mon`, t`Monday`],
    tuesday: [t`Tue`, t`Tuesday`],
    wednesday: [t`Wed`, t`Wednesday`],
    thursday: [t`Thu`, t`Thursday`],
    friday: [t`Fri`, t`Friday`],
    saturday: [t`Sat`, t`Saturday`],
    sunday: [t`Sun`, t`Sunday`],
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Switch
          id={id}
          aria-label={t`Only go on during certain hours`}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
          checked={parts !== undefined}
          onChange={(on) => {
            onChange(on ? DEFAULT_RESUME_WINDOW : undefined);
          }}
        />
        <span aria-hidden className="text-sm">
          <Trans>Only go on during certain hours</Trans>
        </span>
      </div>
      {parts === undefined ? null : (
        <>
          <div role="group" aria-label={t`Days`} className="flex min-w-0 flex-wrap gap-1.5">
            {WINDOW_DAYS.map((day) => {
              const on = parts.days.includes(day);
              const [short, long] = names[day];
              return (
                <button
                  key={day}
                  type="button"
                  aria-label={long}
                  aria-pressed={on}
                  // A window needs a day: the last one stays.
                  disabled={on && parts.days.length === 1}
                  className="min-h-11 min-w-11 rounded-control border border-input px-2 text-sm font-medium text-body hover:bg-muted aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-link disabled:cursor-not-allowed lg:min-h-9"
                  onClick={() => {
                    onChange({
                      ...parts,
                      // In the order of the week, whatever order they were pressed in.
                      days: WINDOW_DAYS.filter((each) =>
                        each === day ? !on : parts.days.includes(each),
                      ),
                    });
                  }}
                >
                  {short}
                </button>
              );
            })}
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <label className="text-sm font-medium" htmlFor={`${id}-from`}>
                <Trans>From</Trans>
              </label>
              <Input
                id={`${id}-from`}
                type="time"
                required
                value={parts.start}
                onChange={(event) => {
                  if (event.target.value !== '') onChange({ ...parts, start: event.target.value });
                }}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label className="text-sm font-medium" htmlFor={`${id}-to`}>
                <Trans>To</Trans>
              </label>
              <Input
                id={`${id}-to`}
                type="time"
                required
                value={parts.end}
                onChange={(event) => {
                  if (event.target.value !== '') onChange({ ...parts, end: event.target.value });
                }}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Times are in the workflow's time zone. A “To” time earlier than the “From” time runs
              past midnight.
            </Trans>
          </p>
        </>
      )}
    </div>
  );
}
