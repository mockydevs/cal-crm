import { Trans, useLingui } from '@lingui/react/macro';
import {
  bookPublicAppointment,
  getPublicCalendar,
  getPublicCalendarSlots,
  getPublicAppointment,
  getPublicAppointmentSlots,
  cancelPublicAppointment,
  reschedulePublicAppointment,
  publicBookingInput,
  type PublicBookingInput,
  type PublicCalendarPage,
  type PublicCalendarParams,
  type PublicAppointmentPage as AppointmentDetails,
  type PublicCancellationInput,
  type PublicRescheduleInput,
  type PublicVisit,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { api } from './api';
import { useBotProof } from './public-booking-bot';
import { againWhenBusy, BusyError, requestOrBusy } from './public-booking-busy';
import { isFramed, isInsecure } from './public-booking-embed';
import { bookingLook } from './public-booking-theme';
import { visitOf } from './public-booking-visit';

/**
 * Said while a request that was told to wait is on its way again: the server is busy with
 * this business's bookings, and nothing is wrong with the calendar or the link.
 */
function BusyNotice(): ReactElement {
  return (
    <p role="status" data-testid="booking-busy">
      <Trans>This page is busy. Trying again…</Trans>
    </p>
  );
}

function PublicLayout({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    // In a frame on a website the page is as tall as what it shows (public-booking-embed.ts).
    <main className="mx-auto flex min-h-screen w-full max-w-[960px] flex-col gap-6 px-4 py-8 sm:px-8 sm:py-14 [html[data-framed]_&]:min-h-0">
      {children}
    </main>
  );
}

function localDate(timezone: string, instant = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((item) => item.type === type)?.value;
    if (value === undefined) throw new Error('The appointment date could not be formatted.');
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function timeLabel(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

export function PublicBookingPage({
  params,
}: {
  readonly params: PublicCalendarParams;
}): ReactElement {
  const { t } = useLingui();
  // How the visitor arrived, read once as the page opens and held only while it is open
  // (public-booking-visit.ts): it goes with the booking and nowhere else.
  const [visit] = useState(() => visitOf(window.location, document.referrer));
  const [waiting, setWaiting] = useState(false);
  const calendar = useQuery({
    queryKey: ['public-calendar', params.agencySlug, params.businessSlug, params.calendarSlug],
    queryFn: ({ signal }) =>
      againWhenBusy(() => requestOrBusy(getPublicCalendar, { params }), {
        signal,
        onWaiting: setWaiting,
      }),
    retry: false,
  });
  // In a frame on a website that is not secure (http), the page cannot book.
  if (isInsecure(window))
    return (
      <PublicLayout>
        <h1 className="text-2xl font-semibold">
          <Trans>Booking page unavailable here</Trans>
        </h1>
        <p role="alert">
          <Trans>This website isn't secure (https), so bookings can't be made on it.</Trans>
        </p>
        <a
          className="font-medium text-link underline underline-offset-4"
          href={window.location.href}
          target="_blank"
          rel="noopener"
        >
          <Trans>Open the booking page</Trans>
        </a>
      </PublicLayout>
    );
  if (calendar.isFetching && calendar.data === undefined)
    return (
      <PublicLayout>
        {waiting ? (
          <BusyNotice />
        ) : (
          <p role="status">
            <Trans>Loading booking page…</Trans>
          </p>
        )}
      </PublicLayout>
    );
  if (calendar.isError || calendar.data === undefined)
    return (
      <PublicLayout>
        {calendar.error instanceof BusyError ? (
          // The calendar is there and the link is right: only the answer did not come.
          <>
            <h1 className="text-2xl font-semibold">
              <Trans>Book an appointment</Trans>
            </h1>
            <p role="alert">
              <Trans>This page is still busy. Try again in a moment.</Trans>
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">
              <Trans>Booking page unavailable</Trans>
            </h1>
            <p role="alert">
              <Trans>This calendar is unavailable. Check the link or try again.</Trans>
            </p>
          </>
        )}
        <Button onClick={() => void calendar.refetch()}>{t`Try again`}</Button>
      </PublicLayout>
    );
  const page = calendar.data;
  const look = bookingLook(page.appearance);
  const { coverUrl } = page.appearance;
  const form = (
    <BookingForm params={params} calendar={page} visit={visit} buttonText={look.buttonText} />
  );
  if (look.theme === undefined)
    // Classic: GoHighLevel's standard widget, in the page's own colours.
    return (
      <PublicLayout>
        {coverUrl === null ? null : <Cover url={coverUrl} className="rounded-card" />}
        <CalendarHeading calendar={page} />
        {form}
      </PublicLayout>
    );
  // Neo: one widget in the calendar's colours, which apply to everything inside it.
  return (
    <PublicLayout>
      <div
        data-testid="booking-widget"
        style={{ ...look.theme, colorScheme: look.scheme }}
        className="flex min-w-0 flex-col overflow-hidden rounded-card border bg-card text-foreground shadow-sm [&_:focus-visible]:outline-link"
      >
        {coverUrl === null ? null : <Cover url={coverUrl} />}
        <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
          <CalendarHeading calendar={page} />
          {form}
        </div>
      </div>
    </PublicLayout>
  );
}

/** The calendar's cover picture: a band across the top, there only to look at. */
function Cover({
  url,
  className = '',
}: {
  readonly url: string;
  readonly className?: string;
}): ReactElement {
  return (
    <img
      src={url}
      alt=""
      referrerPolicy="no-referrer"
      data-testid="booking-cover"
      className={`h-36 w-full object-cover sm:h-48 ${className}`}
    />
  );
}

/** The calendar's logo, name and description. The logo sits beside the name it stands for. */
function CalendarHeading({ calendar }: { readonly calendar: PublicCalendarPage }): ReactElement {
  const { logoUrl } = calendar.appearance;
  return (
    <header className="flex min-w-0 items-start gap-4">
      {logoUrl === null ? null : (
        <img
          src={logoUrl}
          alt=""
          referrerPolicy="no-referrer"
          data-testid="booking-logo"
          className="size-16 shrink-0 rounded-lg object-contain"
        />
      )}
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">
          <Trans>Book an appointment</Trans>
        </p>
        <h1 className="text-[30px] leading-tight font-semibold wrap-anywhere">{calendar.name}</h1>
        {calendar.description === '' ? null : (
          <p className="max-w-prose whitespace-pre-wrap text-muted-foreground">
            {calendar.description}
          </p>
        )}
      </div>
    </header>
  );
}

function BookingForm({
  params,
  calendar,
  visit,
  buttonText,
}: {
  readonly params: PublicCalendarParams;
  readonly calendar: PublicCalendarPage;
  /** The visit that led here, sent with the booking; undefined when the page can say nothing. */
  readonly visit: PublicVisit | undefined;
  /** The booking button's words, when the calendar has its own. */
  readonly buttonText: string | undefined;
}): ReactElement {
  const { t, i18n } = useLingui();
  const id = useId();
  const appointmentTimezone = calendar.timezone;
  const [date, setDate] = useState(() => localDate(calendar.timezone));
  const [startsAt, setStartsAt] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [consent, setConsent] = useState(false);
  // "Text me reminders": never ticked for the visitor, and only for the number they give.
  const [texts, setTexts] = useState(false);
  const textsOffered = calendar.textWording !== undefined && phone.trim() !== '';
  // The length the visitor chose, when the calendar offers more than one.
  const [minutes, setMinutes] = useState(calendar.durations[0] ?? calendar.slotMinutes);
  const choosesLength = calendar.durations.length > 1;
  // A field people cannot see: anything typed into it means a program filled the page.
  const [trap, setTrap] = useState('');
  const queryClient = useQueryClient();
  const [validationError, setValidationError] = useState<string>();
  const attemptRef = useRef<{ readonly signature: string; readonly requestId: string } | null>(
    null,
  );
  const timezoneOptions = [
    ...new Set([timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')]),
  ].sort();
  const [slotsWaiting, setSlotsWaiting] = useState(false);
  const [bookingWaiting, setBookingWaiting] = useState(false);
  // The calendar's bot check, when it asks for one: solved while the visitor fills the page.
  const bot = useBotProof(params, calendar);
  const [proving, setProving] = useState(false);
  const slots = useQuery({
    queryKey: [
      'public-slots',
      params.agencySlug,
      params.businessSlug,
      params.calendarSlug,
      date,
      minutes,
    ],
    queryFn: ({ signal }) =>
      againWhenBusy(
        () =>
          requestOrBusy(getPublicCalendarSlots, {
            params,
            query: choosesLength ? { date, minutes } : { date },
          }),
        { signal, onWaiting: setSlotsWaiting },
      ),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
    retry: false,
  });
  const booking = useMutation({
    // Sent again as it is, request id and all, while the server says it is busy: a booking
    // that did arrive is known by that id and stored once.
    mutationFn: (body: PublicBookingInput) =>
      againWhenBusy(() => requestOrBusy(bookPublicAppointment, { params, body }), {
        onWaiting: setBookingWaiting,
      }),
    // Someone else took the time first, or the page was shown too long ago: read the list
    // and the page again, so the time is no longer offered and the page has a new proof.
    onError: (failure) => {
      if (failure instanceof ApiError && failure.status === 409) {
        void slots.refetch();
        void queryClient.invalidateQueries({
          queryKey: [
            'public-calendar',
            params.agencySlug,
            params.businessSlug,
            params.calendarSlug,
          ],
        });
      }
    },
  });
  if (booking.isSuccess)
    return (
      <section
        aria-label={t`Booking receipt`}
        className="flex flex-col gap-4 rounded-card border bg-card p-6"
      >
        <h2 className="text-2xl font-semibold">
          <Trans>Appointment booked</Trans>
        </h2>
        <p>
          {new Intl.DateTimeFormat(i18n.locale, {
            timeZone: calendar.timezone,
            dateStyle: 'full',
          }).format(new Date(booking.data.startsAt))}
        </p>
        <p>
          {timeLabel(booking.data.startsAt, calendar.timezone)} –{' '}
          {timeLabel(booking.data.endsAt, calendar.timezone)} · {calendar.timezone}
        </p>
        {booking.data.emailed === false ? (
          <p>
            <Trans>
              No confirmation email is sent for this booking. Keep the link below to change or
              cancel it.
            </Trans>
          </p>
        ) : (
          <p>
            <Trans>A confirmation is on its way to your email, with a calendar invite.</Trans>
          </p>
        )}
        {booking.data.managementUrl === undefined ? (
          <p>
            <Trans>Use the management link in your confirmation to make changes.</Trans>
          </p>
        ) : (
          <a
            className="font-medium text-link underline underline-offset-4"
            href={booking.data.managementUrl}
            referrerPolicy="no-referrer"
            // That page is never shown in a website's frame: it opens on its own.
            target={isFramed(window) ? '_blank' : undefined}
          >
            <Trans>Manage appointment</Trans>
          </a>
        )}
      </section>
    );
  const selectable = slots.data?.slots.some((slot) => slot.startsAt === startsAt) === true;
  const error =
    validationError ??
    (booking.isError
      ? booking.error instanceof BusyError
        ? t`This page is still busy, so your booking is not recorded yet. Your details are kept: book again in a moment.`
        : booking.error instanceof ApiError
          ? booking.error.message
          : t`The booking could not be recorded. Try again.`
      : undefined);
  return (
    <form
      className="grid items-start gap-6 md:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        setValidationError(undefined);
        const input = publicBookingInput.safeParse({
          bookingRequestId: crypto.randomUUID(),
          startsAt,
          contact: {
            email,
            ...(firstName.trim() === '' ? {} : { firstName }),
            ...(lastName.trim() === '' ? {} : { lastName }),
            ...(phone.trim() === '' ? {} : { phone }),
          },
          contactTimezone: timezone,
          // Asked only when the calendar has a box to tick; with none, no email is sent.
          ...(calendar.notificationWording === null ? {} : { notificationConsent: consent }),
          ...(textsOffered && texts ? { textConsent: true } : {}),
          ...(choosesLength ? { minutes } : {}),
          renderToken: calendar.renderToken,
          trap,
          // The same visit on every try: a booking sent again is the same request.
          ...(visit === undefined ? {} : { visit }),
        });
        if (!input.success) {
          setValidationError(
            t`Check your contact details, appointment time and notification consent.`,
          );
          return;
        }
        // The page's proof is not part of what was asked: a page shown again sends the same
        // booking under the same request id.
        const signature = JSON.stringify({
          ...input.data,
          bookingRequestId: undefined,
          renderToken: undefined,
        });
        if (attemptRef.current?.signature !== signature)
          attemptRef.current = { signature, requestId: input.data.bookingRequestId };
        const requestId = attemptRef.current.requestId;
        if (bot.check === 'off') {
          booking.mutate({ ...input.data, bookingRequestId: requestId });
          return;
        }
        // The proof for this showing of the page, found by now or as soon as it is.
        setProving(true);
        void bot.proof().then((botProof) => {
          setProving(false);
          if (botProof === undefined) {
            setValidationError(
              t`We couldn't finish checking that you're a person. Book again to retry.`,
            );
            return;
          }
          booking.mutate({ ...input.data, bookingRequestId: requestId, botProof });
        });
      }}
    >
      <section
        className="flex flex-col gap-5 rounded-card border bg-card p-5 sm:p-6"
        aria-labelledby={`${id}-time`}
      >
        <h2 id={`${id}-time`} className="text-xl font-semibold">
          <Trans>Choose a time</Trans>
        </h2>
        <p className="text-sm text-muted-foreground">
          <Trans>Appointment times in {appointmentTimezone}</Trans>
        </p>
        {choosesLength ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-length`} className="text-sm font-medium">
              <Trans>Length</Trans>
            </label>
            <Select
              id={`${id}-length`}
              value={String(minutes)}
              onValueChange={(value) => {
                setMinutes(Number(value));
                setStartsAt('');
              }}
            >
              {calendar.durations.map((length) => (
                <option key={length} value={String(length)}>
                  {t`${length} minutes`}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-date`} className="text-sm font-medium">
            <Trans>Appointment date</Trans>
          </label>
          <Input
            id={`${id}-date`}
            type="date"
            value={date}
            required
            onChange={(event) => {
              setDate(event.target.value);
              setStartsAt('');
            }}
          />
        </div>
        {slots.isFetching && slots.data === undefined ? (
          slotsWaiting ? (
            <BusyNotice />
          ) : (
            <p role="status">
              <Trans>Loading available times…</Trans>
            </p>
          )
        ) : slots.isError || slots.data === undefined ? (
          <div className="flex flex-col gap-3">
            <p role="alert">
              {slots.error instanceof BusyError ? (
                <Trans>This page is still busy. Try again in a moment.</Trans>
              ) : (
                <Trans>Available times could not be loaded.</Trans>
              )}
            </p>
            <Button type="button" onClick={() => void slots.refetch()}>
              <Trans>Reload times</Trans>
            </Button>
          </div>
        ) : slots.data.slots.length === 0 ? (
          <p>
            <Trans>No times available. Choose another date.</Trans>
          </p>
        ) : (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-medium">
              <Trans>Available times</Trans>
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {slots.data.slots.map((slot) => (
                <label
                  key={slot.startsAt}
                  className="flex cursor-pointer items-center gap-2 rounded-control border border-input p-3 text-sm hover:bg-muted has-[:checked]:border-primary has-[:checked]:font-medium"
                >
                  <input
                    type="radio"
                    className="accent-primary"
                    name="appointment-time"
                    value={slot.startsAt}
                    checked={startsAt === slot.startsAt}
                    onChange={() => {
                      setStartsAt(slot.startsAt);
                    }}
                  />
                  <span>
                    {timeLabel(slot.startsAt, calendar.timezone)} –{' '}
                    {timeLabel(slot.endsAt, calendar.timezone)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </section>
      <section
        className="flex flex-col gap-5 rounded-card border bg-card p-5 sm:p-6"
        aria-labelledby={`${id}-details`}
      >
        <h2 id={`${id}-details`} className="text-xl font-semibold">
          <Trans>Your details</Trans>
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-first`} className="text-sm font-medium">
              <Trans>First name</Trans>
            </label>
            <Input
              id={`${id}-first`}
              value={firstName}
              autoComplete="given-name"
              maxLength={120}
              onChange={(event) => {
                setFirstName(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-last`} className="text-sm font-medium">
              <Trans>Last name</Trans>
            </label>
            <Input
              id={`${id}-last`}
              value={lastName}
              autoComplete="family-name"
              maxLength={120}
              onChange={(event) => {
                setLastName(event.target.value);
              }}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-email`} className="text-sm font-medium">
            <Trans>Email</Trans>
          </label>
          <Input
            id={`${id}-email`}
            type="email"
            required
            value={email}
            autoComplete="email"
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-phone`} className="text-sm font-medium">
            <Trans>Phone (optional)</Trans>
          </label>
          <Input
            id={`${id}-phone`}
            type="tel"
            value={phone}
            autoComplete="tel"
            onChange={(event) => {
              setPhone(event.target.value);
            }}
          />
          {textsOffered ? (
            <label className="mt-1 flex items-start gap-3 text-sm">
              <input
                className="mt-1"
                type="checkbox"
                checked={texts}
                onChange={(event) => {
                  setTexts(event.target.checked);
                }}
              />
              <span>{calendar.textWording}</span>
            </label>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-timezone`} className="text-sm font-medium">
            <Trans>Your time zone</Trans>
          </label>
          <Select id={`${id}-timezone`} value={timezone} onValueChange={setTimezone}>
            {timezoneOptions.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
          <p className="text-sm text-muted-foreground">
            <Trans>Used for the timing of appointment notifications.</Trans>
          </p>
        </div>
        {calendar.notificationWording === null ? null : (
          <label className="flex items-start gap-3 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={consent}
              onChange={(event) => {
                setConsent(event.target.checked);
              }}
            />
            <span>{calendar.notificationWording}</span>
          </label>
        )}
        {/* Out of sight and out of the tab order: a person never reaches it, a program that
            fills every field does. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>
            <Trans>Leave this empty</Trans>
            <input
              type="text"
              name="company_website"
              tabIndex={-1}
              autoComplete="off"
              value={trap}
              onChange={(event) => {
                setTrap(event.target.value);
              }}
            />
          </label>
        </div>
        {bot.check === 'off' ? null : (
          // Polite, and nothing to see or do: the browser does the work.
          <p role="status" className="text-sm text-muted-foreground" data-testid="booking-check">
            {bot.check === 'working'
              ? t`Checking that you're a person…`
              : bot.check === 'done'
                ? t`Check complete.`
                : t`We couldn't finish checking that you're a person. Book again to retry.`}
          </p>
        )}
        {bookingWaiting ? <BusyNotice /> : null}
        {error === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          type="submit"
          disabled={
            (calendar.notificationWording !== null && !consent) ||
            !selectable ||
            booking.isPending ||
            proving
          }
        >
          {booking.isPending || proving ? t`Booking…` : (buttonText ?? t`Book appointment`)}
        </Button>
      </section>
    </form>
  );
}

export function PublicAppointmentPage({ token }: { readonly token: string }): ReactElement {
  const appointment = useQuery({
    queryKey: ['public-appointment', token],
    queryFn: () => api.request(getPublicAppointment, { params: { token } }),
    retry: false,
    gcTime: 0,
    // Not asked again on its own: a cancelled appointment's reminder link opens nothing.
    refetchOnWindowFocus: false,
  });
  if (appointment.isPending)
    return (
      <PublicLayout>
        <p role="status">
          <Trans>Loading appointment…</Trans>
        </p>
      </PublicLayout>
    );
  if (appointment.isError)
    return (
      <PublicLayout>
        <h1 className="text-2xl font-semibold">
          <Trans>Appointment unavailable</Trans>
        </h1>
        <p role="alert">
          <Trans>
            This management link is invalid or expired. Check the original confirmation.
          </Trans>
        </p>
      </PublicLayout>
    );
  return (
    <PublicLayout>
      <AppointmentManagement
        key={token}
        token={token}
        appointment={appointment.data}
        reloading={appointment.isFetching}
        reload={() => appointment.refetch()}
      />
    </PublicLayout>
  );
}

function AppointmentManagement({
  token,
  appointment,
  reloading,
  reload,
}: {
  readonly token: string;
  readonly appointment: AppointmentDetails;
  readonly reloading: boolean;
  readonly reload: () => Promise<unknown>;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(() =>
    localDate(appointment.timezone, new Date(appointment.startsAt)),
  );
  const [startsAt, setStartsAt] = useState('');
  const operationRef = useRef<{ readonly signature: string; readonly requestId: string } | null>(
    null,
  );
  const canChange = appointment.status === 'booked' || appointment.status === 'confirmed';
  const appointmentTimezone = appointment.timezone;
  const slots = useQuery({
    queryKey: ['public-appointment-slots', token, date, appointment.revision],
    queryFn: () => api.request(getPublicAppointmentSlots, { params: { token }, query: { date } }),
    enabled: canChange && /^\d{4}-\d{2}-\d{2}$/.test(date),
    retry: false,
    gcTime: 0,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['public-appointment', token], exact: true });
  const cancellation = useMutation({
    mutationFn: (body: PublicCancellationInput) =>
      api.request(cancelPublicAppointment, { params: { token }, body }),
    // The receipt is what stands. A reminder's link opens nothing once the appointment is
    // cancelled, so the page keeps the receipt rather than ask again.
    onSuccess: (receipt) => {
      queryClient.setQueryData(['public-appointment', token], { ...appointment, ...receipt });
    },
  });
  const reschedule = useMutation({
    mutationFn: (body: PublicRescheduleInput) =>
      api.request(reschedulePublicAppointment, { params: { token }, body }),
    onSuccess: refresh,
  });
  const operationId = (operation: 'cancel' | 'reschedule') => {
    const signature = JSON.stringify({
      operation,
      revision: appointment.revision,
      ...(operation === 'reschedule' ? { startsAt } : {}),
    });
    if (operationRef.current?.signature !== signature)
      operationRef.current = { signature, requestId: crypto.randomUUID() };
    return operationRef.current.requestId;
  };
  const busy = reloading || cancellation.isPending || reschedule.isPending;
  const failure = cancellation.isError
    ? cancellation.error
    : reschedule.isError
      ? reschedule.error
      : undefined;
  const message =
    failure === undefined
      ? undefined
      : failure instanceof ApiError
        ? failure.message
        : t`This change could not be recorded. Try again.`;
  const cancelled = appointment.status === 'cancelled' || cancellation.isSuccess;
  const title = cancelled
    ? t`Appointment cancelled`
    : reschedule.isSuccess
      ? t`Appointment rescheduled`
      : t`Manage appointment`;
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-[30px] leading-tight font-semibold">{title}</h1>
        <h2 className="text-xl font-semibold">{appointment.calendarName}</h2>
      </header>
      <section
        className="flex flex-col gap-3 rounded-card border bg-card p-5 sm:p-6"
        aria-label={t`Appointment details`}
      >
        <p>
          {new Intl.DateTimeFormat('en', {
            timeZone: appointmentTimezone,
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }).format(new Date(appointment.startsAt))}
        </p>
        <p>
          {timeLabel(appointment.startsAt, appointmentTimezone)} –{' '}
          {timeLabel(appointment.endsAt, appointmentTimezone)} · {appointmentTimezone}
        </p>
        {cancelled ? (
          <p role="status">
            <Trans>Cancellation recorded.</Trans>
          </p>
        ) : reschedule.isSuccess ? (
          <p role="status">
            <Trans>Email delivery may be deferred.</Trans>
          </p>
        ) : null}
      </section>
      {message === undefined ? null : (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              cancellation.reset();
              reschedule.reset();
              void reload();
            }}
          >
            <Trans>Reload appointment</Trans>
          </Button>
        </div>
      )}
      {!canChange || cancelled ? null : (
        <div className="grid items-start gap-6 md:grid-cols-2">
          <section
            className="flex flex-col gap-5 rounded-card border bg-card p-5 sm:p-6"
            aria-labelledby={`${id}-reschedule`}
          >
            <h2 id={`${id}-reschedule`} className="text-xl font-semibold">
              <Trans>Choose another time</Trans>
            </h2>
            <p className="text-sm text-muted-foreground">
              <Trans>Appointment times in {appointmentTimezone}</Trans>
            </p>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor={`${id}-date`}>
                <Trans>Appointment date</Trans>
              </label>
              <Input
                id={`${id}-date`}
                type="date"
                value={date}
                disabled={busy}
                onChange={(event) => {
                  setDate(event.target.value);
                  setStartsAt('');
                  reschedule.reset();
                }}
              />
            </div>
            {slots.isPending ? (
              <p role="status">
                <Trans>Loading available times…</Trans>
              </p>
            ) : slots.isError ? (
              <p>
                <Trans>Rescheduling times are unavailable.</Trans>
              </p>
            ) : slots.data.slots.length === 0 ? (
              <p>
                <Trans>No times available. Choose another date.</Trans>
              </p>
            ) : (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">
                  <Trans>Available times</Trans>
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {slots.data.slots.map((slot) => (
                    <label
                      className="flex cursor-pointer items-center gap-2 border border-input p-3 text-sm"
                      key={slot.startsAt}
                    >
                      <input
                        type="radio"
                        name="reschedule-time"
                        value={slot.startsAt}
                        checked={startsAt === slot.startsAt}
                        disabled={busy}
                        onChange={() => {
                          setStartsAt(slot.startsAt);
                          reschedule.reset();
                        }}
                      />
                      <span>
                        {timeLabel(slot.startsAt, appointmentTimezone)} –{' '}
                        {timeLabel(slot.endsAt, appointmentTimezone)}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <Button
              type="button"
              disabled={
                busy || slots.data?.slots.some((slot) => slot.startsAt === startsAt) !== true
              }
              onClick={() => {
                reschedule.mutate({
                  operationRequestId: operationId('reschedule'),
                  revision: appointment.revision,
                  startsAt,
                });
              }}
            >
              <Trans>Reschedule appointment</Trans>
            </Button>
          </section>
          <section
            className="flex flex-col gap-5 rounded-card border bg-card p-5 sm:p-6"
            aria-labelledby={`${id}-cancel`}
          >
            <h2 id={`${id}-cancel`} className="text-xl font-semibold">
              <Trans>Cancel this appointment</Trans>
            </h2>
            <p className="text-sm text-muted-foreground">
              <Trans>
                Cancellation releases your reserved time. Your cancellation can be recorded even
                when a confirmation cannot be delivered.
              </Trans>
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                cancellation.mutate({
                  operationRequestId: operationId('cancel'),
                  revision: appointment.revision,
                });
              }}
            >
              <Trans>Cancel appointment</Trans>
            </Button>
          </section>
        </div>
      )}
    </>
  );
}
