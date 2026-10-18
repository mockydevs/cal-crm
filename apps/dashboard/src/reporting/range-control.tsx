// Reporting's date range control: a preset the server works out in the business's time
// zone, or "Custom range" with a first and a last day. Apart from the other shared parts
// because it brings the themed select with it.
import { Trans, useLingui } from '@lingui/react/macro';
import { REPORT_LIMITS, reportPresets } from '@repo/contracts';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useId, type ReactElement } from 'react';
import { rangePresetNames, type RangeChoice } from '../reporting-search';
import type { RangeState } from './query-rules';
import { useReportWords } from './words';

const isChoice = (value: string): value is RangeChoice =>
  value === 'custom' || (rangePresetNames as readonly string[]).includes(value);

/**
 * The date range: a preset, or "Custom range" with a first and a last day. The presets are
 * the catalogue's; until it arrives, the contract's own list.
 */
export function RangeControl({
  label,
  presets,
  state,
  days,
  onChoice,
  onDays,
}: {
  readonly label?: string;
  readonly presets: readonly string[] | undefined;
  readonly state: RangeState;
  /** The first and last day to show in the two fields of a custom range. */
  readonly days: { readonly from: string; readonly to: string };
  readonly onChoice: (choice: RangeChoice) => void;
  readonly onDays: (from: string, to: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const words = useReportWords();
  const fromId = useId();
  const toId = useId();
  const problemId = useId();
  const offered = (presets ?? reportPresets).filter(isChoice);
  const limit = REPORT_LIMITS.rangeDays;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="w-full sm:w-48">
          <Select
            aria-label={label ?? t`Date range`}
            value={state.choice}
            onValueChange={(value) => {
              if (isChoice(value)) onChoice(value);
            }}
          >
            {[...offered, 'custom' as const].map((choice) => (
              <option key={choice} value={choice}>
                {words.preset(choice)}
              </option>
            ))}
          </Select>
        </div>
        {state.choice === 'custom' ? (
          <>
            <div className="flex min-w-0 flex-1 flex-col gap-1 sm:w-40 sm:flex-none">
              <label className="text-xs text-muted-foreground" htmlFor={fromId}>
                <Trans>From</Trans>
              </label>
              <Input
                id={fromId}
                type="date"
                value={days.from}
                aria-invalid={!state.ok}
                aria-describedby={state.ok ? undefined : problemId}
                onChange={(event) => {
                  onDays(event.target.value, days.to);
                }}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1 sm:w-40 sm:flex-none">
              <label className="text-xs text-muted-foreground" htmlFor={toId}>
                <Trans>To</Trans>
              </label>
              <Input
                id={toId}
                type="date"
                value={days.to}
                aria-invalid={!state.ok}
                aria-describedby={state.ok ? undefined : problemId}
                onChange={(event) => {
                  onDays(days.from, event.target.value);
                }}
              />
            </div>
          </>
        ) : null}
      </div>
      {state.ok ? null : (
        <p id={problemId} role="alert" className="text-sm text-destructive">
          {state.reason === 'incomplete' ? (
            <Trans>Choose both days.</Trans>
          ) : state.reason === 'order' ? (
            <Trans>End the range on or after the day it starts.</Trans>
          ) : (
            <Trans>Ask for at most {limit} days at a time.</Trans>
          )}
        </p>
      )}
    </div>
  );
}
