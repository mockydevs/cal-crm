// The Manage view panel of the Calendar view, as GoHighLevel's: view by type, then the
// users and the calendars to show. Each choice is one `listCalendarEvents` takes, and it
// applies as it is made. With nobody ticked the calendar shows everyone; the same for
// calendars.
import { Trans, useLingui } from '@lingui/react/macro';
import { CALENDAR_EVENTS_FILTER_LIMIT } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import type { ReactElement, ReactNode } from 'react';
import { filterCount, noFilters, toggled, type CalendarFilters } from './calendar-rules';
import { useCalendarChoices, useTeam } from './calendar-shared';
import { sidePanelBodyClassName } from './conversation-extras-panel';
import { ListProblem } from './settings-list';
import { useBusiness } from './workspace';

const rowClassName =
  'flex min-h-11 min-w-0 items-center gap-2.5 text-sm text-foreground lg:min-h-9';
const legendClassName = 'mb-1 text-sm font-medium text-foreground';

function Tick({
  checked,
  disabled,
  onChange,
  children,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <label className={rowClassName}>
      <input
        type="checkbox"
        className="size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </label>
  );
}

export function ManageView({
  filters,
  onChange,
}: {
  readonly filters: CalendarFilters;
  readonly onChange: (filters: CalendarFilters) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const team = useTeam(business.id);
  const calendars = useCalendarChoices(business.id);
  const types = [
    { value: 'all', label: t`All` },
    { value: 'appointments', label: t`Appointments` },
    { value: 'blocked', label: t`Blocked slots` },
  ] as const;
  const full = (ids: readonly string[]): boolean => ids.length >= CALENDAR_EVENTS_FILTER_LIMIT;

  return (
    <div className={sidePanelBodyClassName}>
      <fieldset>
        <legend className={legendClassName}>
          <Trans>View by type</Trans>
        </legend>
        {types.map((type) => (
          <label key={type.value} className={rowClassName}>
            <input
              type="radio"
              name="calendar-view-type"
              className="size-4 shrink-0 accent-primary"
              checked={filters.type === type.value}
              onChange={() => {
                onChange({ ...filters, type: type.value });
              }}
            />
            {type.label}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend className={legendClassName}>
          <Trans>Users</Trans>
        </legend>
        {team.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading the team…</Trans>
          </p>
        ) : null}
        {team.isError ? (
          <ListProblem
            onRetry={() => {
              void team.refetch();
            }}
          >
            <Trans>The team couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {team.data?.members.map((member) => {
          const checked = filters.users.includes(member.id);
          return (
            <Tick
              key={member.id}
              checked={checked}
              disabled={!checked && full(filters.users)}
              onChange={(on) => {
                onChange({ ...filters, users: toggled(filters.users, member.id, on) });
              }}
            >
              {member.name || member.email}
              {member.isSelf ? ' ' : null}
              {member.isSelf ? (
                <span className="text-muted-foreground">
                  <Trans>(you)</Trans>
                </span>
              ) : null}
            </Tick>
          );
        })}
      </fieldset>

      <fieldset>
        <legend className={legendClassName}>
          <Trans>Calendars</Trans>
        </legend>
        {calendars.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading calendars…</Trans>
          </p>
        ) : null}
        {calendars.isError ? (
          <ListProblem onRetry={calendars.retry}>
            <Trans>Calendars couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {!calendars.isPending && !calendars.isError && calendars.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>There are no calendars yet.</Trans>
          </p>
        ) : null}
        {calendars.items.map((calendar) => {
          const checked = filters.calendars.includes(calendar.id);
          return (
            <Tick
              key={calendar.id}
              checked={checked}
              disabled={!checked && full(filters.calendars)}
              onChange={(on) => {
                onChange({ ...filters, calendars: toggled(filters.calendars, calendar.id, on) });
              }}
            >
              {calendar.name}
            </Tick>
          );
        })}
      </fieldset>

      {filterCount(filters) === 0 ? null : (
        <div>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              onChange(noFilters);
            }}
          >
            <Trans>Show everything</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
