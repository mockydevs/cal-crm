// Booking rules, as GoHighLevel's section in the owner's screenshot: how often a slot
// starts, how long a meeting is, how soon and how far ahead it can be booked, the buffers
// around it, the most bookings a day and a slot take, and "Look busy". Everything is saved
// in minutes (the date range in days); the units beside the numbers are the form's.
import { Trans, useLingui } from '@lingui/react/macro';
import { CALENDAR_LIMITS } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Plus, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  AmountField,
  Labeled,
  noteClassName,
  Problem,
  SectionCard,
  StepperField,
  SwitchRow,
  type SectionProps,
} from './calendar-settings-parts';
import { durationUnits, noticeUnits } from './calendar-settings-rules';
import { iconButtonClassName } from './settings-list';

export default function BookingSection({
  draft,
  change,
  problems,
  off,
}: SectionProps): ReactElement {
  const { t } = useLingui();
  const limit = CALENDAR_LIMITS.extraDurations;
  const full = draft.extraDurations.length >= limit;
  return (
    <SectionCard
      title={<Trans>Booking rules</Trans>}
      description={<Trans>Control how and when meetings can be booked.</Trans>}
    >
      <AmountField
        label={t`Meeting interval`}
        amount={draft.interval}
        offered={durationUnits}
        problem={problems['slotIntervalMinutes']}
        disabled={off}
        className="sm:max-w-xl"
        description={
          <Trans>
            How often a slot starts. Empty: one after another, each as long as a meeting.
          </Trans>
        }
        onChange={(interval) => {
          change({ interval });
        }}
      />
      <div className="flex min-w-0 flex-col gap-3">
        <AmountField
          label={t`Meeting duration`}
          amount={draft.duration}
          offered={durationUnits}
          problem={problems['slotMinutes']}
          disabled={off}
          className="sm:max-w-xl"
          onChange={(duration) => {
            change({ duration });
          }}
        />
        {draft.extraDurations.map((extra, index) => {
          const number = index + 2;
          return (
            <div key={extra.key} className="flex min-w-0 items-end gap-2 sm:max-w-xl">
              <AmountField
                label={t`Meeting duration ${number}`}
                amount={extra}
                offered={durationUnits}
                disabled={off}
                className="flex-1"
                onChange={(amount) => {
                  change({
                    extraDurations: draft.extraDurations.map((each) =>
                      each.key === extra.key ? { ...each, ...amount } : each,
                    ),
                  });
                }}
              />
              <button
                type="button"
                className={`${iconButtonClassName} border border-input bg-card`}
                aria-label={t`Remove meeting duration ${number}`}
                title={t`Remove duration`}
                disabled={off}
                onClick={() => {
                  change({
                    extraDurations: draft.extraDurations.filter((each) => each.key !== extra.key),
                  });
                }}
              >
                <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
              </button>
            </div>
          );
        })}
        {problems['extraDurationMinutes'] === undefined ? null : (
          <Problem>{problems['extraDurationMinutes']}</Problem>
        )}
        <Button
          variant="quiet"
          className="self-start px-1 font-medium text-link"
          disabled={off || full}
          onClick={() => {
            change({
              extraDurations: [
                ...draft.extraDurations,
                { key: crypto.randomUUID(), value: '', unit: 'minutes' },
              ],
            });
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
          <Trans>Add another duration</Trans>
        </Button>
      </div>
      <div className="grid min-w-0 items-start gap-x-6 gap-y-5 md:grid-cols-2">
        <AmountField
          label={t`Minimum scheduling notice`}
          amount={draft.notice}
          offered={noticeUnits}
          problem={problems['minNoticeMinutes']}
          disabled={off}
          description={<Trans>How soon before it starts a meeting can still be booked.</Trans>}
          onChange={(notice) => {
            change({ notice });
          }}
        />
        <div className="flex min-w-0 flex-col gap-2">
          <Labeled
            label={t`Date range`}
            problem={problems['maxDaysAhead']}
            description={<Trans>How many days ahead a meeting can be booked.</Trans>}
          >
            {(control) => (
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  {...control}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={3}
                  disabled={off}
                  className="min-w-0 flex-1"
                  value={draft.dateRange}
                  onChange={(event) => {
                    change({ dateRange: event.target.value });
                  }}
                />
                <span className="w-32 shrink-0 text-md text-body">
                  <Trans>Days</Trans>
                </span>
              </div>
            )}
          </Labeled>
          <SwitchRow
            label={<Trans>Count available days only</Trans>}
            description={<Trans>Days with no opening hours don't use up the range.</Trans>}
            checked={draft.countAvailableDaysOnly}
            disabled={off}
            onChange={(countAvailableDaysOnly) => {
              change({ countAvailableDaysOnly });
            }}
          />
        </div>
        <AmountField
          label={t`Pre buffer time`}
          amount={draft.bufferBefore}
          offered={durationUnits}
          problem={problems['bufferBeforeMinutes']}
          disabled={off}
          description={<Trans>Kept free before each meeting.</Trans>}
          onChange={(bufferBefore) => {
            change({ bufferBefore });
          }}
        />
        <AmountField
          label={t`Post buffer time`}
          amount={draft.bufferAfter}
          offered={durationUnits}
          problem={problems['bufferAfterMinutes']}
          disabled={off}
          description={<Trans>Kept free after each meeting.</Trans>}
          onChange={(bufferAfter) => {
            change({ bufferAfter });
          }}
        />
        <StepperField
          label={t`Maximum bookings per day`}
          value={draft.maxPerDay}
          min={1}
          problem={problems['maxPerDay']}
          disabled={off}
          description={<Trans>Empty: no limit.</Trans>}
          onChange={(maxPerDay) => {
            change({ maxPerDay });
          }}
        />
        <StepperField
          label={t`Maximum bookings per slot`}
          value={draft.maxPerSlot}
          min={1}
          problem={problems['maxPerSlot']}
          disabled={off}
          description={
            <Trans>
              Each booking at the same time gets its own free host. Empty: one for each.
            </Trans>
          }
          onChange={(maxPerSlot) => {
            change({ maxPerSlot });
          }}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-5 sm:max-w-xl">
        <SwitchRow
          label={<Trans>Look busy</Trans>}
          checked={draft.lookBusy}
          disabled={off}
          onChange={(lookBusy) => {
            change({ lookBusy });
          }}
        />
        <Labeled
          label={t`Look busy percentage`}
          problem={draft.lookBusy ? problems['lookBusyPercent'] : undefined}
          description={<Trans>Hide the number of available slots by x%.</Trans>}
        >
          {(control) => (
            <div className="flex min-w-0 items-center gap-2">
              <Input
                {...control}
                inputMode="numeric"
                autoComplete="off"
                maxLength={3}
                disabled={off || !draft.lookBusy}
                className="min-w-0 flex-1"
                value={draft.lookBusyPercent}
                onChange={(event) => {
                  change({ lookBusyPercent: event.target.value });
                }}
              />
              <span aria-hidden className="text-md text-body">
                %
              </span>
            </div>
          )}
        </Labeled>
        <p className={noteClassName}>
          <Trans>
            The same slots are hidden each time, and only from the public page. Your team still sees
            every free slot.
          </Trans>
        </p>
      </div>
    </SectionCard>
  );
}
