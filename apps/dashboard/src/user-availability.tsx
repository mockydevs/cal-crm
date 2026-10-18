// The User availability tab of Edit user: a person's own time zone and weekly hours in this
// business, or the choice to follow each calendar's hours, on the availability endpoints
// (calendar-user-availability.ts). They keep hours in minutes and refuse a save made on a
// schedule someone else has since changed (the revision). Reading needs the permission to
// manage calendars, as saving does. Dates with their own hours are listed and sent back as
// they were; they are not edited here. Time away is the person's blocked slots: each one is
// added, changed and removed on its own, by the clock of the business's zone, with the form
// the calendar's "+ New → Blocked slot" opens. The time fields are calendar-editor.tsx's
// TimeRangeFields in small: that one is not exported, and works on clock times of a
// calendar's draft.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getCalendarUserAvailability,
  listBlockedSlots,
  updateCalendarUserAvailability,
  type CalendarUserAvailability,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Switch } from './automation-switch';
import { blockedSlotsKey, businessZone } from './calendar-shared';
import { RightPanel } from './conversation-extras-panel';
import { ListProblem } from './list-table';
import { PanelContent } from './list-toolbar';
import { retryFaults } from './settings-list';
import { meQuery } from './workspace';

const BlockedSlotForm = lazy(async () => ({
  default: (await import('./blocked-slot-form')).BlockedSlotForm,
}));
import {
  availabilityDraft,
  availabilityProfile,
  clockOf,
  MIDNIGHT,
  usersKey,
  type AvailabilityDraft,
  type HoursDraft,
} from './users-rules';

/** A calendar date, such as 2026-12-25, as the start of that day in UTC. */
function dayOf(date: string): Date {
  const [year, month, dayOfMonth] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, dayOfMonth ?? 1));
}

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
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function AvailabilityForm({
  client,
  saved,
  onSaved,
  onReload,
}: {
  readonly client: Client;
  readonly saved: CalendarUserAvailability;
  readonly onSaved: (next: CalendarUserAvailability) => void;
  readonly onReload: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const [draft, setDraft] = useState<AvailabilityDraft>(() =>
    availabilityDraft(saved.profile, Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  const [problem, setProblem] = useState<string>();
  const zonesId = useId();
  const inheritId = useId();
  const save = useMutation({
    mutationFn: (profile: NonNullable<CalendarUserAvailability['profile']>) =>
      client.request(updateCalendarUserAvailability, {
        params: { membershipId: saved.membershipId },
        body: { revision: saved.revision, profile },
      }),
    onSuccess: onSaved,
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? (error.problem.errors?.[0]?.message ??
              error.problem.detail ??
              t`The availability wasn't saved. Try again.`)
          : t`The availability wasn't saved. Check your connection and try again.`,
      );
    },
  });
  const stale = save.error instanceof ApiError && save.error.status === 409;
  const busy = save.isPending;
  const dayNames = [
    t`Sunday`,
    t`Monday`,
    t`Tuesday`,
    t`Wednesday`,
    t`Thursday`,
    t`Friday`,
    t`Saturday`,
  ];
  const changeHours = (key: string, change: Partial<HoursDraft>) => {
    setDraft((current) => ({
      ...current,
      weeklyHours: current.weeklyHours.map((hours) =>
        hours.key === key ? { ...hours, ...change } : hours,
      ),
    }));
  };
  const day = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeZone: 'UTC' });
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
        <legend className="sr-only">
          <Trans>User availability</Trans>
        </legend>
        <Labeled label={t`Time zone`}>
          {(id) => (
            <Input
              id={id}
              required
              list={zonesId}
              autoComplete="off"
              className="sm:max-w-80"
              value={draft.timezone}
              onChange={(event) => {
                setDraft((current) => ({ ...current, timezone: event.target.value }));
              }}
            />
          )}
        </Labeled>
        <datalist id={zonesId}>
          <option value="UTC" />
          {Intl.supportedValuesOf('timeZone').map((each) => (
            <option key={each} value={each} />
          ))}
        </datalist>
        <div className="flex min-w-0 items-center gap-3">
          <Switch
            checked={draft.inheritCalendarHours}
            disabled={busy}
            aria-labelledby={inheritId}
            onChange={(checked) => {
              setDraft((current) => ({ ...current, inheritCalendarHours: checked }));
            }}
          />
          <span id={inheritId} className="text-sm font-medium">
            <Trans>Use each calendar's hours</Trans>
          </span>
        </div>
        {draft.inheritCalendarHours ? (
          <p className="text-sm text-muted-foreground">
            <Trans>
              This person can be booked whenever a calendar they are on is open. Turn this off to
              give them weekly hours of their own.
            </Trans>
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <h3 className="text-md font-semibold">
              <Trans>Weekly hours</Trans>
            </h3>
            {draft.weeklyHours.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No hours yet: this person can't be booked on any day.</Trans>
              </p>
            ) : null}
            {draft.weeklyHours.map((hours, index) => {
              const untilMidnight = hours.endTime === MIDNIGHT;
              const number = index + 1;
              return (
                <div
                  key={hours.key}
                  role="group"
                  aria-label={t`Hours ${number}`}
                  className="grid min-w-0 items-start gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
                >
                  <Labeled label={t`Day`}>
                    {(id) => (
                      <Select
                        id={id}
                        value={String(hours.weekday)}
                        onValueChange={(value) => {
                          changeHours(hours.key, { weekday: Number(value) });
                        }}
                      >
                        {dayNames.map((name, weekday) => (
                          <option key={name} value={String(weekday)}>
                            {name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Labeled>
                  <Labeled label={t`Start time`}>
                    {(id) => (
                      <Input
                        id={id}
                        type="time"
                        required
                        value={hours.startTime}
                        onChange={(event) => {
                          changeHours(hours.key, { startTime: event.target.value });
                        }}
                      />
                    )}
                  </Labeled>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Labeled label={t`End time`}>
                      {(id) => (
                        <Input
                          id={id}
                          type="time"
                          required={!untilMidnight}
                          disabled={untilMidnight}
                          value={untilMidnight ? '' : hours.endTime}
                          onChange={(event) => {
                            changeHours(hours.key, { endTime: event.target.value });
                          }}
                        />
                      )}
                    </Labeled>
                    <label className="flex min-h-11 items-center gap-2 text-sm lg:min-h-8">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary"
                        checked={untilMidnight}
                        onChange={(event) => {
                          changeHours(hours.key, {
                            // Unticked, the hours need an end again: the usual one when it still fits.
                            endTime: event.target.checked
                              ? MIDNIGHT
                              : hours.startTime < '17:00'
                                ? '17:00'
                                : '23:59',
                          });
                        }}
                      />
                      <Trans>Until midnight</Trans>
                    </label>
                  </div>
                  <Button
                    variant="quiet"
                    className="sm:mt-[26px]"
                    aria-label={t`Remove hours ${number}`}
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        weeklyHours: current.weeklyHours.filter((each) => each.key !== hours.key),
                      }));
                    }}
                  >
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              );
            })}
            <Button
              variant="secondary"
              className="self-start"
              onClick={() => {
                setDraft((current) => ({
                  ...current,
                  weeklyHours: [
                    ...current.weeklyHours,
                    { key: crypto.randomUUID(), weekday: 1, startTime: '09:00', endTime: '17:00' },
                  ],
                }));
              }}
            >
              <Trans>Add hours</Trans>
            </Button>
          </div>
        )}
      </fieldset>
      {draft.dateOverrides.length === 0 ? null : (
        <section aria-label={t`Dates with their own hours`} className="flex flex-col gap-1.5">
          <h3 className="text-md font-semibold">
            <Trans>Dates with their own hours</Trans>
          </h3>
          <ul className="text-sm text-body">
            {draft.dateOverrides.map((override) => (
              <li key={override.date}>
                {day.format(dayOf(override.date))}
                {': '}
                {override.ranges.length === 0 ? (
                  <Trans>Closed all day</Trans>
                ) : (
                  override.ranges
                    .map((each) => `${clockOf(each.startMinute)} - ${clockOf(each.endMinute)}`)
                    .join(', ')
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {draft.dateOverrides.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">
          <Trans>These are kept as they are when you save. They can't be changed here yet.</Trans>
        </p>
      )}
      {problem === undefined ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium text-destructive">{problem}</span>
          {stale ? (
            <Button variant="secondary" size="small" onClick={onReload}>
              <Trans>Reload saved availability</Trans>
            </Button>
          ) : null}
        </div>
      )}
      <Button
        variant="secondary"
        className="self-start"
        disabled={busy}
        onClick={() => {
          const checked = availabilityProfile(draft);
          if (!checked.ok) {
            setProblem(t`Give every row a start and an end, with the end after the start.`);
            return;
          }
          setProblem(undefined);
          save.mutate(checked.profile);
        }}
      >
        {busy ? <Trans>Saving…</Trans> : <Trans>Save availability</Trans>}
      </Button>
    </div>
  );
}

/**
 * A person's Time away: their blocked slots that have not ended, on every calendar or on
 * one, each opened in the blocked slot form.
 */
function TimeAway({
  client,
  businessId,
  membershipId,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly membershipId: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  // The business's zone, from what the shell already read; this machine's until then.
  const me = useQuery({ ...meQuery, enabled: false });
  const zone = businessZone(
    me.data?.businesses.find((business) => business.id === businessId) ?? {},
  );
  const [editing, setEditing] = useState<{ readonly slotId: string | undefined }>();
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const slots = useQuery({
    queryKey: [...blockedSlotsKey(businessId), membershipId],
    queryFn: () => client.request(listBlockedSlots, { params: { membershipId } }),
    retry: retryFaults,
  });
  const moment = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  });
  const items = slots.data?.items ?? [];
  return (
    <section aria-label={t`Time away`} className="flex flex-col gap-2">
      <h3 className="text-md font-semibold">
        <Trans>Time away</Trans>
      </h3>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Nobody can book this person in their time away. Times are in {zone}, the business's time
          zone.
        </Trans>
      </p>
      <p role="status" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {slots.isError ? (
        <ListProblem
          onRetry={() => {
            void slots.refetch();
          }}
        >
          <Trans>Time away couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {slots.data !== undefined && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No time away is coming up.</Trans>
        </p>
      ) : null}
      {items.length === 0 ? null : (
        <ul className="flex flex-col rounded-lg border border-border">
          {items.map((slot) => {
            const when = moment.formatRange(new Date(slot.startsAt), new Date(slot.endsAt));
            return (
              <li
                key={slot.id}
                className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2 first:border-t-0"
              >
                <span className="min-w-0 flex-1 text-sm wrap-anywhere text-body">
                  {when}
                  {slot.title === '' ? null : ` · ${slot.title}`}
                  {slot.calendar === null ? null : ` · ${slot.calendar.name}`}
                </span>
                <Button
                  variant="secondary"
                  size="small"
                  aria-label={t`Edit time away, ${when}`}
                  onClick={(event) => {
                    returnFocusRef.current = event.currentTarget;
                    setNotice('');
                    setEditing({ slotId: slot.id });
                  }}
                >
                  <Trans>Edit</Trans>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {slots.data?.truncated === true ? (
        <p className="text-sm text-body">
          <Trans>Only the earliest time away is listed.</Trans>
        </p>
      ) : null}
      <Button
        variant="secondary"
        className="self-start"
        onClick={(event) => {
          returnFocusRef.current = event.currentTarget;
          setNotice('');
          setEditing({ slotId: undefined });
        }}
      >
        <Trans>Add time away</Trans>
      </Button>
      <RightPanel
        open={editing !== undefined}
        onClose={() => {
          setEditing(undefined);
        }}
        returnFocus={returnFocusRef}
        title={
          editing?.slotId === undefined ? (
            <Trans>Add time away</Trans>
          ) : (
            <Trans>Edit time away</Trans>
          )
        }
      >
        {editing === undefined ? null : (
          <PanelContent>
            <BlockedSlotForm
              client={client}
              businessId={businessId}
              zone={zone}
              slotId={editing.slotId}
              member={membershipId}
              onDone={(words) => {
                setNotice(words);
                setEditing(undefined);
              }}
              onCancel={() => {
                setEditing(undefined);
              }}
            />
          </PanelContent>
        )}
      </RightPanel>
    </section>
  );
}

/** A member's availability in the business the client works in. */
export function UserAvailability({
  client,
  workspace,
  membershipId,
}: {
  readonly client: Client;
  readonly workspace: string;
  readonly membershipId: string;
}): ReactElement {
  const cache = useQueryClient();
  const [notice, setNotice] = useState('');
  const { t } = useLingui();
  const key = [...usersKey(workspace), 'availability', membershipId];
  const current = useQuery({
    queryKey: key,
    queryFn: () => client.request(getCalendarUserAvailability, { params: { membershipId } }),
    retry: retryFaults,
  });
  if (current.error instanceof ApiError && current.error.status === 403)
    return (
      <p className="text-md text-muted-foreground">
        <Trans>
          Seeing and changing a person's availability needs permission to manage calendars.
        </Trans>
      </p>
    );
  if (current.error instanceof ApiError && current.error.status === 404)
    return (
      <p className="text-md text-muted-foreground">
        <Trans>
          Availability is kept for the people of this business's own team. This person isn't one of
          them here.
        </Trans>
      </p>
    );
  return (
    <>
      {current.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading availability…</Trans>
        </p>
      ) : null}
      {current.isError ? (
        <ListProblem
          onRetry={() => {
            void current.refetch();
          }}
        >
          <Trans>The availability couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      <p role="status" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {current.data === undefined ? null : (
        <AvailabilityForm
          key={current.data.revision}
          client={client}
          saved={current.data}
          onSaved={(next) => {
            cache.setQueryData(key, next);
            setNotice(t`Availability saved.`);
          }}
          onReload={() => {
            setNotice('');
            void current.refetch();
          }}
        />
      )}
      {current.data === undefined ? null : (
        <TimeAway client={client} businessId={workspace} membershipId={membershipId} />
      )}
    </>
  );
}
