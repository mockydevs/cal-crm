// Availability, as GoHighLevel's section in the owner's screenshot: when each person of
// the calendar can be booked. A person's own hours are theirs, set in Settings → Users;
// the calendar's weekly hours and the dates with hours of their own are edited here, as the
// page before this one edited them.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useId, type ReactElement, type ReactNode } from 'react';
import {
  labelClassName,
  MemberHoursList,
  noteClassName,
  Problem,
  SectionCard,
  useHoursWords,
  type SectionProps,
} from './calendar-settings-parts';
import { MIDNIGHT } from './calendar-settings-rules';

function Labeled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (id: string) => ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className={labelClassName} htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}

/** A start and an end. The end of the day has a box of its own: a time input can't hold it. */
function TimeRangeFields({
  range,
  startLabel,
  endLabel,
  midnightLabel,
  disabled,
  onChange,
}: {
  readonly range: { readonly startTime: string; readonly endTime: string };
  readonly startLabel: string;
  readonly endLabel: string;
  readonly midnightLabel: string;
  readonly disabled: boolean;
  readonly onChange: (change: { startTime: string; endTime: string }) => void;
}): ReactElement {
  const untilMidnight = range.endTime === MIDNIGHT;
  return (
    <>
      <Labeled label={startLabel}>
        {(id) => (
          <Input
            id={id}
            type="time"
            required
            disabled={disabled}
            value={range.startTime}
            onChange={(event) => {
              onChange({ startTime: event.target.value, endTime: range.endTime });
            }}
          />
        )}
      </Labeled>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Labeled label={endLabel}>
          {(id) => (
            <Input
              id={id}
              type="time"
              required={!untilMidnight}
              disabled={disabled || untilMidnight}
              value={untilMidnight ? '' : range.endTime}
              onChange={(event) => {
                onChange({ startTime: range.startTime, endTime: event.target.value });
              }}
            />
          )}
        </Labeled>
        <label className="flex min-h-11 items-center gap-2 text-sm lg:min-h-8">
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-primary"
            disabled={disabled}
            checked={untilMidnight}
            onChange={(event) => {
              onChange({
                startTime: range.startTime,
                // Unticked, the hours need an end again: the usual one when it still fits.
                endTime: event.target.checked
                  ? MIDNIGHT
                  : range.startTime < '17:00'
                    ? '17:00'
                    : '23:59',
              });
            }}
          />
          {midnightLabel}
        </label>
      </div>
    </>
  );
}

export default function AvailabilitySection({
  client,
  businessId,
  draft,
  change,
  problems,
  off,
  canManage,
  people,
}: SectionProps): ReactElement {
  const { t } = useLingui();
  const hoursWords = useHoursWords();
  const chosen = (people ?? []).filter((person) =>
    draft.members.some((member) => member.membershipId === person.membershipId),
  );
  const dayNames = [
    t`Sunday`,
    t`Monday`,
    t`Tuesday`,
    t`Wednesday`,
    t`Thursday`,
    t`Friday`,
    t`Saturday`,
  ];
  return (
    <SectionCard
      title={<Trans>Availability schedule</Trans>}
      description={<Trans>Set when meetings can be booked based on staff availability.</Trans>}
    >
      <section aria-label={t`Booking availability`} className="flex min-w-0 flex-col gap-2">
        <h3 className={labelClassName}>
          <Trans>Booking availability</Trans>
        </h3>
        {chosen.length === 0 ? (
          <p className={noteClassName}>
            <Trans>Nobody is on this calendar yet. Choose its staff under Staff & location.</Trans>
          </p>
        ) : (
          <MemberHoursList
            client={client}
            businessId={businessId}
            people={chosen}
            calendarHours={draft.weeklyHours}
            readSchedules={canManage}
          />
        )}
        <p className={noteClassName}>
          <Trans>
            A person with hours of their own is booked in those, set on their page in Settings,
            Users. Everyone else follows this calendar's hours below.
          </Trans>
        </p>
      </section>
      <section
        aria-label={t`Weekly opening hours`}
        className="flex min-w-0 flex-col gap-3 border-t border-border pt-5"
      >
        <h3 className="text-md font-medium">
          <Trans>Weekly opening hours</Trans>
        </h3>
        <p className={noteClassName}>{hoursWords(draft.weeklyHours)}</p>
        {draft.weeklyHours.map((hour, index) => (
          <div
            key={hour.key}
            role="group"
            aria-label={`${t`Opening hours`} ${String(index + 1)}`}
            className="grid min-w-0 items-start gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
          >
            <Labeled label={t`Day`}>
              {(id) => (
                <Select
                  id={id}
                  disabled={off}
                  value={String(hour.weekday)}
                  onValueChange={(value) => {
                    change({
                      weeklyHours: draft.weeklyHours.map((item) =>
                        item.key === hour.key ? { ...item, weekday: Number(value) } : item,
                      ),
                    });
                  }}
                >
                  {dayNames.map((name, day) => (
                    <option key={name} value={String(day)}>
                      {name}
                    </option>
                  ))}
                </Select>
              )}
            </Labeled>
            <TimeRangeFields
              range={hour}
              startLabel={t`Start time`}
              endLabel={t`End time`}
              midnightLabel={t`Open until midnight`}
              disabled={off}
              onChange={(range) => {
                change({
                  weeklyHours: draft.weeklyHours.map((item) =>
                    item.key === hour.key ? { ...item, ...range } : item,
                  ),
                });
              }}
            />
            <Button
              variant="quiet"
              className="sm:mt-[26px]"
              disabled={off}
              aria-label={`${t`Remove opening hours`} ${String(index + 1)}`}
              onClick={() => {
                change({ weeklyHours: draft.weeklyHours.filter((item) => item.key !== hour.key) });
              }}
            >
              <Trans>Remove</Trans>
            </Button>
          </div>
        ))}
        {problems['weeklyHours'] === undefined ? null : (
          <Problem>{problems['weeklyHours']}</Problem>
        )}
        <Button
          variant="secondary"
          className="self-start"
          disabled={off}
          onClick={() => {
            change({
              weeklyHours: [
                ...draft.weeklyHours,
                { key: crypto.randomUUID(), weekday: 1, startTime: '09:00', endTime: '17:00' },
              ],
            });
          }}
        >
          <Trans>Add opening hours</Trans>
        </Button>
      </section>
      <section
        aria-label={t`Date overrides`}
        className="flex min-w-0 flex-col gap-3 border-t border-border pt-5"
      >
        <h3 className="text-md font-medium">
          <Trans>Date overrides</Trans>
        </h3>
        <p className={noteClassName}>
          <Trans>
            An override replaces the day's weekly hours. Leave it closed to block bookings that day.
          </Trans>
        </p>
        {draft.dateOverrides.map((override) => {
          const setOverride = (changed: Partial<typeof override>): void => {
            change({
              dateOverrides: draft.dateOverrides.map((item) =>
                item.key === override.key ? { ...item, ...changed } : item,
              ),
            });
          };
          return (
            <div
              key={override.key}
              className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
            >
              <Labeled label={t`Override date`}>
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    required
                    disabled={off}
                    className="sm:max-w-56"
                    value={override.date}
                    onChange={(event) => {
                      setOverride({ date: event.target.value });
                    }}
                  />
                )}
              </Labeled>
              {override.ranges.length === 0 ? (
                <p className="text-sm">
                  <Trans>Closed all day</Trans>
                </p>
              ) : null}
              {override.ranges.map((range, rangeIndex) => (
                <div
                  key={range.key}
                  className="grid min-w-0 items-start gap-2 sm:grid-cols-[1fr_1fr_auto]"
                >
                  <TimeRangeFields
                    range={range}
                    startLabel={t`Override start time`}
                    endLabel={t`Override end time`}
                    midnightLabel={t`Override open until midnight`}
                    disabled={off}
                    onChange={(changed) => {
                      setOverride({
                        ranges: override.ranges.map((entry) =>
                          entry.key === range.key ? { ...entry, ...changed } : entry,
                        ),
                      });
                    }}
                  />
                  <Button
                    variant="quiet"
                    className="sm:mt-[26px]"
                    disabled={off}
                    aria-label={`${t`Remove override hours`} ${String(rangeIndex + 1)}`}
                    onClick={() => {
                      setOverride({
                        ranges: override.ranges.filter((entry) => entry.key !== range.key),
                      });
                    }}
                  >
                    <Trans>Remove hours</Trans>
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={off}
                  onClick={() => {
                    setOverride({
                      ranges: [
                        ...override.ranges,
                        { key: crypto.randomUUID(), startTime: '09:00', endTime: '17:00' },
                      ],
                    });
                  }}
                >
                  <Trans>Add override hours</Trans>
                </Button>
                <Button
                  variant="quiet"
                  disabled={off}
                  onClick={() => {
                    change({
                      dateOverrides: draft.dateOverrides.filter(
                        (item) => item.key !== override.key,
                      ),
                    });
                  }}
                >
                  <Trans>Remove override</Trans>
                </Button>
              </div>
            </div>
          );
        })}
        {problems['dateOverrides'] === undefined ? null : (
          <Problem>{problems['dateOverrides']}</Problem>
        )}
        <Button
          variant="secondary"
          className="self-start"
          disabled={off}
          onClick={() => {
            change({
              dateOverrides: [
                ...draft.dateOverrides,
                { key: crypto.randomUUID(), date: '', ranges: [] },
              ],
            });
          }}
        >
          <Trans>Add date override</Trans>
        </Button>
      </section>
    </SectionCard>
  );
}
