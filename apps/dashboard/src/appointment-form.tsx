// The panel that books an appointment for a contact, and moves one to another time: the
// fields `createAppointmentInput` and `rescheduleAppointmentInput` accept and no others.
// Fetched when the panel first opens. Times are typed in the business's zone; the server's
// refusals are shown in its own words beside the field they name.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createAppointment,
  getAppointment,
  getCalendar,
  listContacts,
  rescheduleAppointment,
  type AppointmentDetail,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { lazy, Suspense, useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  bookingOf,
  moveOf,
  nextHalfHour,
  NO_CHOICE,
  wallTime,
  type AppointmentDraft,
  type DraftFault,
  type DraftFaults,
} from './appointment-rules';
import { businessZone, useCalendarChoices, useEventTimes, useTeam } from './calendar-shared';
import {
  panelFormClassName,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './side-panel-classes';
import { noRejection, type Rejection } from './problems';
import {
  iconButtonClassName,
  isStale,
  ListProblem,
  retryFaults,
  savingProblem,
  useSettled,
} from './settings-list';
import { useBusiness } from './workspace';

// "Google not checked" is fetched on its own, once an owner is chosen.
const GoogleUncheckedNote = lazy(() => import('./google-status'));

/** The fields the form shows a refusal beside; any other is said above the buttons. */
const shown = new Set([
  'calendarId',
  'contactId',
  'startsAt',
  'endsAt',
  'assignee',
  'title',
  'location',
  'notes',
]);

const errorClassName = 'text-sm leading-normal font-medium text-destructive';

export function AppointmentForm({
  appointment,
  start,
  contact,
  onCancel,
  onSaved,
}: {
  /** The appointment to move, or undefined to book a new one. */
  readonly appointment: AppointmentDetail | undefined;
  /** Where a new appointment's time starts; the next half hour when left out. */
  readonly start: Date | undefined;
  /** Who a new appointment is for, already chosen, as when booking from a contact's page. */
  readonly contact?: { readonly id: string; readonly name: string } | undefined;
  readonly onCancel: () => void;
  readonly onSaved: (saved: AppointmentDetail, created: boolean) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  // Times are typed and shown in the business's zone, as the calendar draws them.
  const times = useEventTimes(businessZone(business));
  const zone = times.zone;
  // The version a move replaces: the one opened, or a newer one read after a refusal.
  const [base, setBase] = useState(appointment);
  const [draft, setDraft] = useState<AppointmentDraft>(() => ({
    calendarId: appointment?.calendar.id ?? '',
    contactId: appointment === undefined ? contact?.id : undefined,
    start:
      appointment === undefined
        ? start === undefined
          ? nextHalfHour(new Date(), zone)
          : wallTime(start, zone)
        : wallTime(appointment.startsAt, zone),
    end: appointment === undefined ? '' : wallTime(appointment.endsAt, zone),
    assignee: NO_CHOICE,
    title: '',
    status: 'confirmed',
    location: '',
    notes: '',
    ignoreAvailability: false,
  }));
  const [contactName, setContactName] = useState(contact?.name ?? '');
  const [contactSearch, setContactSearch] = useState('');
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const contactId = useId();
  const calendarErrorId = useId();
  const assigneeErrorId = useId();
  const ignoreHintId = useId();
  const change = (next: Partial<AppointmentDraft>): void => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const calendars = useCalendarChoices(business.id);
  const bookable = calendars.items.filter((each) => each.supported && each.isActive);
  const team = useTeam(business.id);
  const calendar = useQuery({
    queryKey: ['calendar', business.id, draft.calendarId],
    queryFn: () => api.request(getCalendar, { params: { id: draft.calendarId } }),
    enabled: draft.calendarId !== '',
    retry: retryFaults,
  });
  const hosts = (calendar.data?.members ?? []).flatMap((member) => {
    const person = team.data?.members.find((each) => each.id === member.membershipId);
    return person === undefined ? [] : [{ id: person.id, name: person.name || person.email }];
  });
  // Whose Google Calendar is no longer read: their conflicts are this CRM's alone. A time
  // set exactly sets every calendar aside anyway.
  const ownerId = draft.assignee === NO_CHOICE ? base?.assignee?.membershipId : draft.assignee;
  const owner = draft.ignoreAvailability ? undefined : hosts.find((host) => host.id === ownerId);

  const q = useSettled(contactSearch).trim();
  const found = useQuery({
    queryKey: ['b', business.id, 'appointment-contact-search', q],
    queryFn: () => api.request(listContacts, { query: { q, limit: 6 } }),
    enabled: appointment === undefined && draft.contactId === undefined && q !== '',
    retry: retryFaults,
  });

  const faultWords = (fault: DraftFault | undefined): string | undefined =>
    fault === undefined
      ? undefined
      : fault === 'missing'
        ? t`This is needed.`
        : fault === 'no_such_time'
          ? t`This time doesn't exist in ${zone}. Choose another time.`
          : t`End the appointment after it starts.`;
  const refuse = (faults: DraftFaults): void => {
    const fields: Record<string, string> = {};
    for (const [field, fault] of Object.entries(faults)) {
      const words = faultWords(fault);
      if (words !== undefined) fields[field] = words;
    }
    setProblem({ fields, form: undefined });
  };

  const save = useMutation({
    mutationFn: async (): Promise<AppointmentDetail | undefined> => {
      if (base === undefined) {
        // A new id for each try: the server answers a repeated id with the first booking.
        const booking = bookingOf(draft, crypto.randomUUID(), zone);
        if ('faults' in booking) {
          refuse(booking.faults);
          return undefined;
        }
        return api.request(createAppointment, { body: booking.body });
      }
      const move = moveOf(draft, base.revision, zone);
      if ('faults' in move) {
        refuse(move.faults);
        return undefined;
      }
      return api.request(rescheduleAppointment, { params: { id: base.id }, body: move.body });
    },
    onSuccess: (saved) => {
      if (saved !== undefined) onSaved(saved, base === undefined);
    },
    onError: async (error) => {
      const refused = savingProblem(
        error,
        t`The appointment wasn't saved. Check your connection and try again.`,
      );
      // A conflict is either a time that is taken, or (for a move) a change made since this
      // was opened. Reading the appointment again tells which.
      if (isStale(error) && base !== undefined) {
        const latest = await api
          .request(getAppointment, { params: { id: base.id } })
          .catch(() => undefined);
        if (latest !== undefined && latest.revision !== base.revision) {
          setBase(latest);
          setProblem({
            fields: {},
            form: t`This appointment changed while you were moving it. It has been read again: check the time below, then save.`,
          });
          return;
        }
      }
      if (isStale(error) && refused.form !== undefined) {
        setProblem({ fields: { startsAt: refused.form }, form: undefined });
        return;
      }
      const hidden = Object.entries(refused.fields)
        .filter(([field]) => !shown.has(field))
        .map(([, message]) => message);
      setProblem({
        fields: refused.fields,
        form: refused.form ?? (hidden.length === 0 ? undefined : hidden.join(' ')),
      });
    },
  });
  const pending = save.isPending;
  const movedTitle = base?.title ?? '';
  const movedCalendar = base?.calendar.name ?? '';
  const movedSpan = base === undefined ? '' : times.span(base);

  return (
    <Form<Record<string, unknown>>
      className={panelFormClassName}
      errors={problem.fields}
      onFormSubmit={() => {
        if (pending) return;
        setProblem(noRejection);
        save.mutate();
      }}
    >
      <div className={sidePanelBodyClassName}>
        {base === undefined ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                <Trans>Calendar</Trans>
                <Select
                  aria-label={t`Calendar`}
                  {...(problem.fields['calendarId'] === undefined
                    ? {}
                    : { 'aria-describedby': calendarErrorId })}
                  value={draft.calendarId}
                  onValueChange={(value) => {
                    change({ calendarId: value, assignee: NO_CHOICE });
                  }}
                >
                  <option value="">{t`Choose a calendar`}</option>
                  {bookable.map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name}
                    </option>
                  ))}
                </Select>
              </label>
              {calendars.isError ? (
                <ListProblem onRetry={calendars.retry}>
                  <Trans>Calendars couldn't be loaded.</Trans>
                </ListProblem>
              ) : null}
              {!calendars.isPending && !calendars.isError && bookable.length === 0 ? (
                <p className="text-sm leading-normal text-muted-foreground">
                  <Trans>
                    No calendar is active yet. Activate one in Settings, under Calendars, to book on
                    it.
                  </Trans>
                </p>
              ) : null}
              {problem.fields['calendarId'] === undefined ? null : (
                <p id={calendarErrorId} role="alert" className={errorClassName}>
                  {problem.fields['calendarId']}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              {draft.contactId === undefined ? (
                <>
                  <label htmlFor={contactId} className="text-sm font-medium">
                    <Trans>Contact</Trans>
                  </label>
                  <Input
                    id={contactId}
                    type="search"
                    autoComplete="off"
                    maxLength={200}
                    placeholder={t`Search contacts`}
                    value={contactSearch}
                    onChange={(event) => {
                      setContactSearch(event.target.value);
                    }}
                  />
                  {found.isError ? (
                    <ListProblem
                      onRetry={() => {
                        void found.refetch();
                      }}
                    >
                      <Trans>Contacts couldn't be searched.</Trans>
                    </ListProblem>
                  ) : null}
                  {found.data === undefined || q === '' ? null : found.data.items.length === 0 ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      <Trans>No contacts match.</Trans>
                    </p>
                  ) : (
                    <ul
                      aria-label={t`Matching contacts`}
                      className="flex flex-col rounded-lg border border-border"
                    >
                      {found.data.items.map((each) => {
                        const name = each.name ?? each.email ?? t`Unnamed`;
                        return (
                          <li key={each.id} className="border-t border-border first:border-t-0">
                            <button
                              type="button"
                              className="flex min-h-11 w-full flex-col items-start justify-center rounded-control px-3 py-1.5 text-left text-md -outline-offset-2 hover:bg-muted lg:min-h-9"
                              onClick={() => {
                                change({ contactId: each.id });
                                setContactName(name);
                                setContactSearch('');
                              }}
                            >
                              <span className="wrap-anywhere text-foreground">{name}</span>
                              {each.email === null || each.email === name ? null : (
                                <span className="text-xs wrap-anywhere text-muted-foreground">
                                  {each.email}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <span className="text-sm font-medium">
                    <Trans>Contact</Trans>
                  </span>
                  <div className="flex min-h-11 items-center justify-between gap-2 rounded-control border border-input bg-card pl-3 lg:min-h-9">
                    <span className="min-w-0 text-md wrap-anywhere text-foreground">
                      {contactName}
                    </span>
                    <button
                      type="button"
                      className={iconButtonClassName}
                      aria-label={t`Remove ${contactName}`}
                      onClick={() => {
                        change({ contactId: undefined });
                      }}
                    >
                      <X aria-hidden className="size-4" strokeWidth={1.8} />
                    </button>
                  </div>
                </>
              )}
              {problem.fields['contactId'] === undefined ? null : (
                <p role="alert" className={errorClassName}>
                  {problem.fields['contactId']}
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-body">
            <Trans>
              Moving {movedTitle} on {movedCalendar}, now at {movedSpan}.
            </Trans>
          </p>
        )}

        <Field name="startsAt">
          <FieldLabel>
            <Trans>Starts ({zone})</Trans>
          </FieldLabel>
          <Input
            type="datetime-local"
            required
            min="0001-01-01T00:00"
            max="9999-12-31T23:59"
            value={draft.start}
            onChange={(event) => {
              change({ start: event.target.value });
            }}
          />
          {draft.ignoreAvailability ? null : (
            <FieldDescription>
              <Trans>
                It must be a time the calendar offers; the calendar sets how long it lasts.
              </Trans>
            </FieldDescription>
          )}
          <FieldError />
        </Field>

        <div className="flex flex-col gap-1">
          <label className="flex min-h-11 items-center gap-2.5 text-sm font-medium lg:min-h-9">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-primary"
              aria-describedby={ignoreHintId}
              checked={draft.ignoreAvailability}
              onChange={(event) => {
                change({ ignoreAvailability: event.target.checked });
              }}
            />
            <Trans>Ignore availability</Trans>
          </label>
          <p id={ignoreHintId} className="text-sm leading-normal text-muted-foreground">
            <Trans>
              Books a time the calendar does not offer: outside its opening hours, its minimum
              notice and how far ahead it takes bookings, and in the person's blocked time. You then
              say when it ends. It never books a person twice at the same time.
            </Trans>
          </p>
        </div>

        {draft.ignoreAvailability ? (
          <Field name="endsAt">
            <FieldLabel>
              <Trans>Ends ({zone})</Trans>
            </FieldLabel>
            <Input
              type="datetime-local"
              required
              min="0001-01-01T00:00"
              max="9999-12-31T23:59"
              value={draft.end}
              onChange={(event) => {
                change({ end: event.target.value });
              }}
            />
            <FieldError />
          </Field>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <Trans>Appointment owner</Trans>
            <Select
              aria-label={t`Appointment owner`}
              {...(problem.fields['assignee'] === undefined
                ? {}
                : { 'aria-describedby': assigneeErrorId })}
              value={draft.assignee}
              onValueChange={(value) => {
                change({ assignee: value });
              }}
            >
              <option value={NO_CHOICE}>
                {base === undefined ? t`Let the calendar choose` : t`Keep the current owner`}
              </option>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </Select>
          </label>
          {calendar.isError || team.isError ? (
            <p className="text-sm leading-normal text-muted-foreground">
              <Trans>The people who take bookings on this calendar couldn't be loaded.</Trans>
            </p>
          ) : null}
          {owner === undefined ? null : (
            <Suspense fallback={null}>
              <GoogleUncheckedNote businessId={business.id} owner={owner} />
            </Suspense>
          )}
          {problem.fields['assignee'] === undefined ? null : (
            <p id={assigneeErrorId} role="alert" className={errorClassName}>
              {problem.fields['assignee']}
            </p>
          )}
        </div>

        {base === undefined ? (
          <>
            <Field name="title">
              <FieldLabel>
                <Trans>Title</Trans>
              </FieldLabel>
              <Input
                maxLength={200}
                value={draft.title}
                onChange={(event) => {
                  change({ title: event.target.value });
                }}
              />
              <FieldDescription>
                <Trans>Left empty, it takes the calendar's name.</Trans>
              </FieldDescription>
              <FieldError />
            </Field>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <Trans>Status</Trans>
              <Select
                aria-label={t`Status`}
                value={draft.status}
                onValueChange={(value) => {
                  if (value === 'booked' || value === 'confirmed') change({ status: value });
                }}
              >
                <option value="confirmed">{t`Confirmed`}</option>
                <option value="booked">{t`Booked`}</option>
              </Select>
            </label>
            <Field name="location">
              <FieldLabel>
                <Trans>Location</Trans>
              </FieldLabel>
              <Input
                maxLength={500}
                value={draft.location}
                onChange={(event) => {
                  change({ location: event.target.value });
                }}
              />
              <FieldError />
            </Field>
            <Field name="notes">
              <FieldLabel>
                <Trans>Notes</Trans>
              </FieldLabel>
              <Textarea
                maxLength={5000}
                value={draft.notes}
                onChange={(event) => {
                  change({ notes: event.target.value });
                }}
              />
              <FieldError />
            </Field>
          </>
        ) : null}

        {problem.form === undefined ? null : (
          <p role="alert" className={errorClassName}>
            {problem.form}
          </p>
        )}
      </div>
      <div className={sidePanelFooterClassName}>
        <Button
          variant="secondary"
          className="mr-auto"
          disabled={pending}
          onClick={() => {
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={pending}>
          {base === undefined ? <Trans>Book appointment</Trans> : <Trans>Move appointment</Trans>}
        </Button>
      </div>
    </Form>
  );
}
