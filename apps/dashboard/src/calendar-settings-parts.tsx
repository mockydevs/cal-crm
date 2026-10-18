// The pieces the "New calendar" modal and the calendar editor's sections share: a labelled
// field with its error, a switch with its sentence, a number with its unit, a stepper and a
// member's hours in a line. The logo and cover drop zone is calendar-settings-image.tsx.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getCalendarUserAvailability,
  type CalendarConfiguration,
  type CalendarUserAvailabilityProfile,
} from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { Avatar } from '@repo/ui/components/avatar';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { Info, Minus, Plus, X } from 'lucide-react';
import { useId, type ReactElement, type ReactNode } from 'react';
import { Switch } from './automation-switch';
import { tintOf } from './avatar-tint';
import {
  clockWords,
  hoursOfMember,
  hoursSummary,
  isNumberField,
  numberRanges,
  wholeOf,
  type Amount,
  type CalendarDraft,
  type FieldIssue,
  type Hours,
  type Person,
  type Unit,
} from './calendar-settings-rules';
import { unitNames } from './calendar-settings-words';
import { initialsOf } from './workspace';

export const labelClassName = 'text-sm font-medium';
export const noteClassName = 'text-sm text-muted-foreground';
export const problemClassName = 'text-sm font-medium text-destructive';

/** What is wrong with the field above it, said as it appears. */
export function Problem({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p id={id} role="alert" className={problemClassName}>
      {children}
    </p>
  );
}

/** A plain line that says what a setting does not do yet, so nothing is promised falsely. */
export function NotYet({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <p className="flex min-w-0 items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-body">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export interface ControlProps {
  readonly id: string;
  readonly 'aria-invalid': boolean;
  readonly 'aria-describedby'?: string;
}

/** A label over a control, with its hint and what is wrong with it. */
export function Labeled({
  label,
  description,
  problem,
  className = '',
  children,
}: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly problem?: string | undefined;
  readonly className?: string;
  readonly children: (control: ControlProps) => ReactNode;
}): ReactElement {
  const id = useId();
  const described = [
    description === undefined ? undefined : `${id}-hint`,
    problem === undefined ? undefined : `${id}-problem`,
  ].filter((each) => each !== undefined);
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <label className={labelClassName} htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        'aria-invalid': problem !== undefined,
        ...(described.length === 0 ? {} : { 'aria-describedby': described.join(' ') }),
      })}
      {description === undefined ? null : (
        <p id={`${id}-hint`} className={noteClassName}>
          {description}
        </p>
      )}
      {problem === undefined ? null : <Problem id={`${id}-problem`}>{problem}</Problem>}
    </div>
  );
}

/** A switch with what it switches beside it, and a sentence under that when there is one. */
export function SwitchRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex min-w-0 items-start gap-3">
      <Switch
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        {...(description === undefined ? {} : { 'aria-describedby': `${id}-hint` })}
        onChange={onChange}
      />
      <div className="flex min-h-11 min-w-0 flex-col justify-center gap-0.5 lg:min-h-9">
        <span id={`${id}-label`} className={labelClassName}>
          {label}
        </span>
        {description === undefined ? null : (
          <span id={`${id}-hint`} className={noteClassName}>
            {description}
          </span>
        )}
      </div>
    </div>
  );
}

/** A whole number with the unit it is in: the select converts nothing, saving does. */
export function AmountField({
  label,
  amount,
  offered,
  description,
  problem,
  disabled = false,
  placeholder,
  className = '',
  onChange,
}: {
  readonly label: string;
  readonly amount: Amount;
  readonly offered: readonly Unit[];
  readonly description?: ReactNode;
  readonly problem?: string | undefined;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
  readonly onChange: (amount: Amount) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  return (
    <Labeled label={label} description={description} problem={problem} className={className}>
      {(control) => (
        <div className="flex min-w-0 gap-2">
          <Input
            {...control}
            inputMode="numeric"
            autoComplete="off"
            maxLength={10}
            disabled={disabled}
            placeholder={placeholder}
            className="min-w-0 flex-1"
            value={amount.value}
            onChange={(event) => {
              onChange({ ...amount, value: event.target.value });
            }}
          />
          <Select
            aria-label={t`Unit of ${label}`}
            className="w-32 shrink-0"
            disabled={disabled}
            value={amount.unit}
            onValueChange={(value) => {
              const unit = offered.find((each) => each === value);
              if (unit !== undefined) onChange({ ...amount, unit });
            }}
          >
            {offered.map((unit) => (
              <option key={unit} value={unit}>
                {i18n._(unitNames[unit])}
              </option>
            ))}
          </Select>
        </div>
      )}
    </Labeled>
  );
}

/** A whole number with a button either side of it to take one off or add one. */
export function StepperField({
  label,
  value,
  min,
  description,
  problem,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly min: number;
  readonly description?: ReactNode;
  readonly problem?: string | undefined;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const whole = wholeOf(value);
  const number = whole === null || Number.isNaN(whole) ? undefined : whole;
  const stepClassName =
    'inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-input bg-card text-body -outline-offset-2 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 lg:size-9';
  return (
    <Labeled label={label} description={description} problem={problem}>
      {(control) => (
        <div className="flex min-w-0 gap-2">
          <Input
            {...control}
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            disabled={disabled}
            className="min-w-0 flex-1"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          <button
            type="button"
            className={stepClassName}
            aria-label={t`Decrease ${label}`}
            disabled={disabled || number === undefined || number <= min}
            onClick={() => {
              if (number !== undefined) onChange(String(number - 1));
            }}
          >
            <Minus aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={stepClassName}
            aria-label={t`Increase ${label}`}
            disabled={disabled}
            onClick={() => {
              onChange(String(number === undefined ? min : number + 1));
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
        </div>
      )}
    </Labeled>
  );
}

/** Says a week's hours in a line, such as "Weekdays, 8:00 AM to 5:00 PM". */
export function useHoursWords(): (hours: readonly Hours[]) => string {
  const { t, i18n } = useLingui();
  return (hours) => {
    const summary = hoursSummary(hours);
    if (summary.kind === 'none') return t`No hours set`;
    if (summary.kind === 'varied') return t`Hours differ from day to day`;
    const dayName = new Intl.DateTimeFormat(i18n.locale, { weekday: 'short', timeZone: 'UTC' });
    const days =
      summary.days === 'weekdays'
        ? t`Weekdays`
        : summary.days === 'every_day'
          ? t`Every day`
          : summary.days
              // 4 January 1970 was a Sunday.
              .map((weekday) => dayName.format(new Date(Date.UTC(1970, 0, 4 + weekday))))
              .join(', ');
    const from = clockWords(summary.startTime, i18n.locale);
    const to = clockWords(summary.endTime, i18n.locale);
    return t`${days}, ${from} to ${to}`;
  };
}

/** A person of the calendar with the hours they can be booked in. */
export function MemberHoursCard({
  person,
  hours,
  own,
}: {
  readonly person: Person;
  readonly hours: string;
  /** True when the hours are the person's own schedule, not the calendar's. */
  readonly own: boolean;
}): ReactElement {
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 sm:max-w-md">
      <Avatar
        size="medium"
        tint={tintOf(person.membershipId)}
        fallback={initialsOf(person.name, person.email)}
      />
      <span className="flex min-w-0 flex-col">
        <span className="min-w-0 text-sm font-medium wrap-anywhere">
          {person.name === '' ? person.email : person.name}
        </span>
        <span className="text-xs text-body">
          {hours}
          {own ? (
            <>
              {' · '}
              <Trans>their own hours</Trans>
            </>
          ) : null}
        </span>
      </span>
    </li>
  );
}

/**
 * The hours of each person chosen: their own when they keep a schedule (read with the
 * permission to manage calendars), else the calendar's weekly hours.
 */
export function MemberHoursList({
  client,
  businessId,
  people,
  calendarHours,
  readSchedules,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly people: readonly Person[];
  readonly calendarHours: readonly Hours[];
  /** False for someone who may not read schedules: the calendar's hours are shown. */
  readonly readSchedules: boolean;
}): ReactElement {
  return (
    <ul className="flex min-w-0 flex-col gap-2">
      {people.map((person) => (
        <MemberHours
          key={person.membershipId}
          client={client}
          businessId={businessId}
          person={person}
          calendarHours={calendarHours}
          readSchedules={readSchedules}
        />
      ))}
    </ul>
  );
}

function MemberHours({
  client,
  businessId,
  person,
  calendarHours,
  readSchedules,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly person: Person;
  readonly calendarHours: readonly Hours[];
  readonly readSchedules: boolean;
}): ReactElement {
  const words = useHoursWords();
  const schedule = useQuery({
    queryKey: ['calendar-member-hours', businessId, person.membershipId],
    queryFn: () =>
      client.request(getCalendarUserAvailability, {
        params: { membershipId: person.membershipId },
      }),
    enabled: readSchedules,
    retry: false,
    staleTime: 60_000,
  });
  const profile: CalendarUserAvailabilityProfile | null = schedule.data?.profile ?? null;
  const own = profile !== null && !profile.inheritCalendarHours;
  return (
    <MemberHoursCard
      person={person}
      hours={words(hoursOfMember(profile, calendarHours))}
      own={own}
    />
  );
}

/** The people of a calendar: one for a personal calendar, any number for the others. */
export function PeoplePicker({
  label,
  people,
  chosen,
  single,
  description,
  problem,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  /** Who can be chosen: the people of this business's own team. */
  readonly people: readonly Person[];
  readonly chosen: readonly string[];
  readonly single: boolean;
  readonly description?: ReactNode;
  readonly problem?: string | undefined;
  readonly disabled?: boolean;
  readonly onChange: (membershipIds: string[]) => void;
}): ReactElement {
  const { t } = useLingui();
  const nameOf = (person: Person): string => (person.name === '' ? person.email : person.name);
  // Someone chosen earlier who can no longer be: shown, so they can be taken off.
  const gone = chosen.filter((id) => !people.some((person) => person.membershipId === id));
  return (
    <Labeled label={label} description={description} problem={problem}>
      {(control) => (
        <>
          {single ? (
            <Select
              {...control}
              disabled={disabled}
              value={chosen[0] ?? ''}
              onValueChange={(value) => {
                onChange(value === '' ? [] : [value]);
              }}
            >
              <option value="">{t`Select a team member`}</option>
              {gone.map((id) => (
                <option key={id} value={id} disabled>
                  {t`Unavailable member`}
                </option>
              ))}
              {people.map((person) => (
                <option key={person.membershipId} value={person.membershipId}>
                  {nameOf(person)}
                </option>
              ))}
            </Select>
          ) : (
            <Select
              {...control}
              multiple
              disabled={disabled}
              value={chosen}
              onValueChange={onChange}
            >
              {gone.map((id) => (
                <option key={id} value={id} disabled>
                  {t`Unavailable member`}
                </option>
              ))}
              {people.map((person) => (
                <option key={person.membershipId} value={person.membershipId}>
                  {nameOf(person)}
                </option>
              ))}
            </Select>
          )}
          {single || chosen.length === 0 ? null : (
            <ul aria-label={t`Chosen team members`} className="flex min-w-0 flex-wrap gap-1.5">
              {chosen.map((id) => {
                const person = people.find((each) => each.membershipId === id);
                const name = person === undefined ? t`Unavailable member` : nameOf(person);
                return (
                  <li
                    key={id}
                    className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-control border border-border bg-muted py-0.5 pr-0.5 pl-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{name}</span>
                    <button
                      type="button"
                      className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-secondary hover:text-foreground disabled:opacity-50 lg:size-7"
                      aria-label={t`Remove ${name}`}
                      disabled={disabled}
                      onClick={() => {
                        onChange(chosen.filter((each) => each !== id));
                      }}
                    >
                      <X aria-hidden className="size-3.5" strokeWidth={2} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Labeled>
  );
}

/**
 * The words under a field the contract refused. The contract's own sentence where it has
 * one; ours for a number out of its range, a name or a link not filled in, and a row of
 * hours left half empty, which the schema reports only as a failed pattern.
 */
export function useProblemWords(): (fields: Record<string, FieldIssue>) => Record<string, string> {
  const { t } = useLingui();
  const words = (field: string, issue: FieldIssue): string => {
    if (issue.code === 'custom') return issue.message;
    if (field === 'name')
      return issue.code === 'too_big'
        ? t`Use at most 120 characters.`
        : t`Give the calendar a name.`;
    if (field === 'bookingSlug')
      return t`Use lowercase letters, numbers and hyphens, such as my-calendar.`;
    if (field === 'members' && issue.path.includes('weight'))
      return t`Give each person a weight from 1 to 100.`;
    if ((field === 'weeklyHours' || field === 'dateOverrides') && issue.code === 'invalid_format')
      return t`Give every row of hours a start and an end, and every override a date.`;
    if (isNumberField(field)) {
      const { min, max, unit } = numberRanges[field];
      if (unit === 'minutes') return t`Enter a whole number, from ${min} to ${max} minutes.`;
      if (unit === 'days') return t`Enter a whole number of days, from ${min} to ${max}.`;
      return t`Enter a whole number from ${min} to ${max}.`;
    }
    return issue.message;
  };
  return (fields) =>
    Object.fromEntries(
      Object.entries(fields).map(([field, issue]) => [field, words(field, issue)]),
    );
}

/** What every section of the calendar editor is given. */
export interface SectionProps {
  readonly client: Client;
  readonly businessId: string;
  readonly businessSlug: string;
  readonly agencySlug: string;
  readonly draft: CalendarDraft;
  /** Changes parts of the form, and forgets what was wrong with them. */
  readonly change: (changed: Partial<CalendarDraft>) => void;
  /** What is wrong, by the contract's field names. */
  readonly problems: Readonly<Record<string, string>>;
  /** True while nothing may be changed: saving, or no permission to manage calendars. */
  readonly off: boolean;
  readonly canManage: boolean;
  /** The people who can be on the calendar; none while they are being read. */
  readonly people: readonly Person[] | undefined;
  /** The calendar as it was last saved; none for a new one. */
  readonly saved: CalendarConfiguration | undefined;
}

/** A section of the editor: its title and sentence over a line, then its fields. */
export function SectionCard({
  title,
  description,
  children,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-5 rounded-card border border-border bg-card p-4 sm:p-5"
    >
      <header className="flex min-w-0 flex-col gap-1 border-b border-border pb-4">
        <h2 id={id} className="text-lg font-medium">
          {title}
        </h2>
        <p className="text-md text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}
