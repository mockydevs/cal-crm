// One appointment in the panel at the right, as `getAppointment` answers it: everything it
// keeps, its history, and for someone who may change appointments the four things done to
// one here: set its status, write its notes, cancel it (with a reason, after asking), and
// move it, which opens the form. A change is sent with the revision read; when someone
// else changed the appointment first, it is read again and the panel says so. Notes being
// written stay as typed then, with the notes as they now read shown above them.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  appointmentStatuses,
  APPOINTMENT_NOTES_MAX,
  cancelAppointment,
  getAppointment,
  setAppointmentNotes,
  setAppointmentStatus,
  type AppointmentDetail,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import {
  appointmentKey,
  AppointmentStatusPill,
  businessZone,
  useEventTimes,
  useStatusName,
  type AppointmentStatus,
} from './calendar-shared';
import {
  ContactName,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './conversation-extras-panel';
import { isStale, ListProblem, retryFaults } from './settings-list';
import { useBusiness } from './workspace';

function Fact({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm wrap-anywhere whitespace-pre-wrap text-foreground">
        {children}
      </dd>
    </div>
  );
}

type Change =
  | { readonly kind: 'status'; readonly status: AppointmentStatus }
  | { readonly kind: 'cancel'; readonly reason: string }
  | { readonly kind: 'notes'; readonly notes: string };

/** The notes being written: what they said when writing began, and the draft. */
interface NotesDraft {
  readonly from: string;
  readonly text: string;
}

export function AppointmentDetails({
  id,
  onMove,
  onChanged,
}: {
  readonly id: string;
  /** Open the form that moves it. */
  readonly onMove: (appointment: AppointmentDetail) => void;
  /** Something about it changed: the lists that show it are read again. */
  readonly onChanged: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const cache = useQueryClient();
  const times = useEventTimes(businessZone(business));
  const statusName = useStatusName();
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState<NotesDraft>();
  const reasonId = useId();
  const notesId = useId();
  const notesHintId = useId();
  // The notes box takes the place of the button that opens it, and the button comes back
  // when it closes: the keyboard is put on whichever has just appeared.
  const backToNotesButtonRef = useRef(false);
  const focusOnArrival = useCallback((element: HTMLElement | null) => {
    element?.focus();
  }, []);
  const focusWhenBack = useCallback((element: HTMLElement | null) => {
    if (element === null || !backToNotesButtonRef.current) return;
    backToNotesButtonRef.current = false;
    element.focus();
  }, []);
  const key = appointmentKey(business.id, id);
  const appointment = useQuery({
    queryKey: key,
    queryFn: () => api.request(getAppointment, { params: { id } }),
    retry: retryFaults,
  });

  const change = useMutation({
    mutationFn: ({ change: wanted, revision }: { change: Change; revision: string }) =>
      wanted.kind === 'status'
        ? api.request(setAppointmentStatus, {
            params: { id },
            body: { revision, status: wanted.status },
          })
        : wanted.kind === 'notes'
          ? api.request(setAppointmentNotes, {
              params: { id },
              body: { revision, notes: wanted.notes },
            })
          : api.request(cancelAppointment, {
              params: { id },
              body: {
                revision,
                ...(wanted.reason.trim() === '' ? {} : { reason: wanted.reason.trim() }),
              },
            }),
    onMutate: () => {
      setSaid('');
      setProblem(undefined);
    },
    onSuccess: (saved, { change: wanted }) => {
      cache.setQueryData(key, saved);
      if (wanted.kind === 'notes') {
        backToNotesButtonRef.current = true;
        setNotes(undefined);
        setSaid(t`Notes saved.`);
      } else {
        setCancelling(false);
        setReason('');
        setSaid(wanted.kind === 'cancel' ? t`Appointment cancelled.` : t`Status changed.`);
      }
      onChanged();
    },
    onError: async (error, { revision }) => {
      // A conflict is a change made since this was read, or a time that is now taken:
      // reading the appointment again tells which.
      if (isStale(error)) {
        const latest = await appointment.refetch();
        if (latest.data !== undefined && latest.data.revision !== revision) {
          setProblem(
            t`Someone changed this appointment first. It has been read again: check it, then try again.`,
          );
          onChanged();
          return;
        }
      }
      setProblem(
        error instanceof ApiError
          ? (error.problem.detail ?? t`The appointment wasn't changed. Try again.`)
          : t`The appointment wasn't changed. Check your connection and try again.`,
      );
    },
  });

  if (appointment.isPending)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        <Trans>Loading the appointment…</Trans>
      </p>
    );
  if (appointment.isError)
    return (
      <div className="p-4">
        <ListProblem
          onRetry={() => {
            void appointment.refetch();
          }}
        >
          {appointment.error instanceof ApiError && appointment.error.status === 404 ? (
            <Trans>This appointment is no longer there.</Trans>
          ) : (
            <Trans>The appointment couldn't be loaded.</Trans>
          )}
        </ListProblem>
      </div>
    );

  const detail = appointment.data;
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const there = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: detail.timezone,
  });
  const elsewhere = detail.timezone !== times.zone;
  const thereSpan = there.formatRange(new Date(detail.startsAt), new Date(detail.endsAt));
  const theirZone = detail.timezone;
  const owner =
    detail.assignee === null
      ? undefined
      : detail.assignee.you
        ? t`You`
        : detail.assignee.name === ''
          ? t`Former team member`
          : detail.assignee.name;
  const bookedBy =
    detail.source === 'booking_page'
      ? t`The booking page`
      : detail.source === 'ai_agent'
        ? t`An AI agent`
        : detail.source === 'automation'
          ? t`A workflow`
          : detail.source === 'api'
            ? t`The API`
            : detail.source === 'import'
              ? t`An import`
              : detail.createdBy === null || detail.createdBy.name === ''
                ? t`A team member`
                : detail.createdBy.name;
  const movable = detail.status === 'booked' || detail.status === 'confirmed';
  const busy = change.isPending;

  return (
    <>
      <div className={sidePanelBodyClassName}>
        <p role="status" className={said === '' ? 'sr-only' : 'text-sm text-success'}>
          {said}
        </p>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        <dl className="flex flex-col gap-4">
          <Fact label={<Trans>Title</Trans>}>{detail.title}</Fact>
          <Fact label={<Trans>Status</Trans>}>
            {detail.canManage ? (
              <Select
                aria-label={t`Status`}
                className="w-auto min-w-40"
                disabled={busy}
                value={detail.status}
                onValueChange={(value) => {
                  const status = appointmentStatuses.find((each) => each === value);
                  if (status !== undefined && status !== detail.status)
                    change.mutate({
                      change: { kind: 'status', status },
                      revision: detail.revision,
                    });
                }}
              >
                {appointmentStatuses.map((status) => (
                  <option key={status} value={status}>
                    {statusName(status)}
                  </option>
                ))}
              </Select>
            ) : (
              <AppointmentStatusPill status={detail.status} />
            )}
          </Fact>
          <Fact label={<Trans>When</Trans>}>
            <time dateTime={detail.startsAt}>{times.span(detail)}</time>{' '}
            <span className="text-muted-foreground">({times.zone})</span>
            {elsewhere ? (
              <span className="block text-muted-foreground">
                <Trans>
                  {thereSpan} on the calendar ({theirZone})
                </Trans>
              </span>
            ) : null}
          </Fact>
          <Fact label={<Trans>Contact</Trans>}>
            <ContactName contact={detail.contact} />
          </Fact>
          <Fact label={<Trans>Calendar</Trans>}>{detail.calendar.name}</Fact>
          <Fact label={<Trans>Appointment owner</Trans>}>
            {owner ?? (
              <span className="text-muted-foreground">
                <Trans>Unassigned</Trans>
              </span>
            )}
          </Fact>
          {detail.location === null || detail.location === '' ? null : (
            <Fact label={<Trans>Location</Trans>}>{detail.location}</Fact>
          )}
          {detail.canManage && notes !== undefined ? (
            <div className="flex min-w-0 flex-col gap-2">
              <dt>
                <label htmlFor={notesId} className="text-xs font-medium text-muted-foreground">
                  <Trans>Notes</Trans>
                </label>
              </dt>
              <dd className="flex min-w-0 flex-col gap-2">
                {detail.notes === notes.from ? null : (
                  // Saved by someone else while these were being written: shown, so the
                  // two can be put together before saving again.
                  <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border p-2.5 text-sm">
                    <span className="font-medium text-foreground">
                      <Trans>The notes now read:</Trans>
                    </span>
                    <span className="wrap-anywhere whitespace-pre-wrap text-body">
                      {detail.notes === '' ? t`Nothing: they were cleared.` : detail.notes}
                    </span>
                  </div>
                )}
                <Textarea
                  ref={focusOnArrival}
                  id={notesId}
                  aria-describedby={notesHintId}
                  maxLength={APPOINTMENT_NOTES_MAX}
                  rows={5}
                  disabled={busy}
                  value={notes.text}
                  onChange={(event) => {
                    setNotes({ ...notes, text: event.target.value });
                  }}
                />
                <p id={notesHintId} className="text-xs text-muted-foreground">
                  <Trans>For the team only: the contact never sees them.</Trans>
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setProblem(undefined);
                      backToNotesButtonRef.current = true;
                      setNotes(undefined);
                    }}
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      change.mutate({
                        change: { kind: 'notes', notes: notes.text },
                        revision: detail.revision,
                      });
                    }}
                  >
                    <Trans>Save notes</Trans>
                  </Button>
                </div>
              </dd>
            </div>
          ) : detail.canManage ? (
            <Fact label={<Trans>Notes</Trans>}>
              {detail.notes === '' ? (
                <span className="block text-muted-foreground">
                  <Trans>No notes yet.</Trans>
                </span>
              ) : (
                <span className="block">{detail.notes}</span>
              )}
              <Button
                ref={focusWhenBack}
                variant="quiet"
                size="small"
                className="mt-1"
                disabled={busy || cancelling}
                onClick={() => {
                  setSaid('');
                  setProblem(undefined);
                  setNotes({ from: detail.notes, text: detail.notes });
                }}
              >
                {detail.notes === '' ? <Trans>Add notes</Trans> : <Trans>Edit notes</Trans>}
              </Button>
            </Fact>
          ) : detail.notes === '' ? null : (
            <Fact label={<Trans>Notes</Trans>}>{detail.notes}</Fact>
          )}
          <Fact label={<Trans>Booked by</Trans>}>
            {bookedBy}{' '}
            <span className="text-muted-foreground">
              <time dateTime={detail.createdAt}>{moment.format(new Date(detail.createdAt))}</time>
            </span>
          </Fact>
          {detail.cancelledAt === null ? null : (
            <Fact label={<Trans>Cancelled</Trans>}>
              <time dateTime={detail.cancelledAt}>
                {moment.format(new Date(detail.cancelledAt))}
              </time>
              {detail.cancelReason === null || detail.cancelReason === '' ? null : (
                <span className="block">{detail.cancelReason}</span>
              )}
            </Fact>
          )}
        </dl>

        {detail.history.length === 0 ? null : (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              <Trans>History</Trans>
            </h3>
            <ol className="flex flex-col gap-2">
              {detail.history.map((entry, index) => {
                const actor =
                  entry.actor.name ??
                  (entry.actor.kind === 'contact'
                    ? t`The contact`
                    : entry.actor.kind === 'user'
                      ? t`A team member`
                      : t`The system`);
                const status = entry.status === undefined ? '' : statusName(entry.status);
                const span =
                  entry.startsAt === undefined || entry.endsAt === undefined
                    ? ''
                    : times.span({ startsAt: entry.startsAt, endsAt: entry.endsAt });
                return (
                  <li key={`${entry.at}:${String(index)}`} className="text-sm text-body">
                    <span className="wrap-anywhere text-foreground">
                      {entry.type === 'booked'
                        ? t`${actor} booked it`
                        : entry.type === 'rescheduled'
                          ? span === ''
                            ? t`${actor} moved it`
                            : t`${actor} moved it to ${span}`
                          : entry.type === 'cancelled'
                            ? t`${actor} cancelled it`
                            : status === ''
                              ? t`${actor} changed its status`
                              : t`${actor} set it to ${status}`}
                    </span>{' '}
                    <time dateTime={entry.at} className="text-xs text-muted-foreground">
                      {moment.format(new Date(entry.at))}
                    </time>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {cancelling ? (
          <section
            aria-label={t`Cancel this appointment`}
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
          >
            <p className="text-sm font-medium text-foreground">
              <Trans>Cancel this appointment?</Trans>
            </p>
            <p className="text-sm text-muted-foreground">
              <Trans>
                Its time becomes free again. The appointment stays in the Cancelled list.
              </Trans>
            </p>
            <label htmlFor={reasonId} className="text-sm font-medium">
              <Trans>Reason (optional)</Trans>
            </label>
            <Textarea
              id={reasonId}
              maxLength={500}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setCancelling(false);
                }}
              >
                <Trans>Keep it</Trans>
              </Button>
              <Button
                variant="secondary"
                className="border-destructive text-destructive"
                disabled={busy}
                onClick={() => {
                  change.mutate({ change: { kind: 'cancel', reason }, revision: detail.revision });
                }}
              >
                <Trans>Cancel appointment</Trans>
              </Button>
            </div>
          </section>
        ) : null}
      </div>
      {detail.canManage && !cancelling && (movable || detail.status !== 'cancelled') ? (
        <div className={sidePanelFooterClassName}>
          {detail.status === 'cancelled' ? null : (
            <Button
              variant="secondary"
              className="mr-auto border-destructive text-destructive"
              disabled={busy}
              onClick={() => {
                setProblem(undefined);
                setSaid('');
                setCancelling(true);
              }}
            >
              <Trans>Cancel appointment</Trans>
            </Button>
          )}
          {movable ? (
            <Button
              disabled={busy}
              onClick={() => {
                onMove(detail);
              }}
            >
              <Trans>Reschedule</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
