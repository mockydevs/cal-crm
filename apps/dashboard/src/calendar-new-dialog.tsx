// The "New calendar" modal, as GoHighLevel's in the owner's screenshot: a name, an optional
// description, the team member, the link, the meeting's length and when it can be booked,
// with "Advanced settings" for the rest. Confirm creates the calendar as a draft. Two
// things differ on purpose: the link is this app's own public address, not the vendor's
// widget path, and only people of this business's team are offered (decision 2).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createCalendar,
  type BusinessSummary,
  type CalendarConfiguration,
  type CalendarKind,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { Plus, Settings, X } from 'lucide-react';
import { useState, type ReactElement, type RefObject } from 'react';
import { useBusinessTimeZone, usePeople } from './calendar-settings-data';
import {
  AmountField,
  Labeled,
  labelClassName,
  MemberHoursList,
  noteClassName,
  PeoplePicker,
  Problem,
  useHoursWords,
  useProblemWords,
} from './calendar-settings-parts';
import {
  bookingPrefix,
  checkCreate,
  durationUnits,
  newDraft,
  problemsAfter,
  slugFromName,
  type CalendarDraft,
} from './calendar-settings-rules';
import { kindNames } from './calendar-settings-words';
import { rejection } from './problems';
import { returnTo } from './settings-list';

/** The fields this modal shows: a refusal that names another is said above the buttons. */
const shown: readonly string[] = ['name', 'description', 'members', 'bookingSlug', 'slotMinutes'];

export default function NewCalendarDialog({
  kind,
  client,
  business,
  agencySlug,
  readSchedules,
  returnFocus,
  onClose,
  onCreated,
  onAdvanced,
}: {
  /** The type chosen; the modal is closed while there is none. */
  readonly kind: CalendarKind | undefined;
  readonly client: Client;
  readonly business: BusinessSummary;
  readonly agencySlug: string;
  /** Whether the person may read other people's schedules (calendars.manage). */
  readonly readSchedules: boolean;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onCreated: (configuration: CalendarConfiguration) => void;
  /** "Advanced settings": the full editor takes over what was typed, unsaved. */
  readonly onAdvanced: (draft: CalendarDraft) => void;
}): ReactElement {
  return (
    <Dialog.Root
      open={kind !== undefined}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        <Dialog.Popup
          className="fixed top-1/2 left-1/2 z-[65] flex max-h-[calc(100dvh-32px)] w-[min(680px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-card bg-card p-5 text-card-foreground shadow-xl outline-none"
          finalFocus={returnTo(returnFocus)}
        >
          {kind === undefined ? null : (
            <NewCalendarForm
              key={kind}
              kind={kind}
              client={client}
              business={business}
              agencySlug={agencySlug}
              readSchedules={readSchedules}
              onClose={onClose}
              onCreated={onCreated}
              onAdvanced={onAdvanced}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NewCalendarForm({
  kind,
  client,
  business,
  agencySlug,
  readSchedules,
  onClose,
  onCreated,
  onAdvanced,
}: {
  readonly kind: CalendarKind;
  readonly client: Client;
  readonly business: BusinessSummary;
  readonly agencySlug: string;
  readonly readSchedules: boolean;
  readonly onClose: () => void;
  readonly onCreated: (configuration: CalendarConfiguration) => void;
  readonly onAdvanced: (draft: CalendarDraft) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const zone = useBusinessTimeZone(client, business.id);
  const people = usePeople(client, business.id);
  const problemWords = useProblemWords();
  const hoursWords = useHoursWords();
  const [draft, setDraft] = useState(() => newDraft(kind, zone.timezone));
  // The link follows the name until it is typed itself.
  const [ownSlug, setOwnSlug] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [formProblem, setFormProblem] = useState<string>();
  const change = (changed: Partial<CalendarDraft>): void => {
    setDraft((current) => ({ ...current, ...changed }));
    setProblems((current) => problemsAfter(current, changed));
  };
  // The calendar is written in the business's time zone, read by the time it is saved.
  const whole = (): CalendarDraft => ({ ...draft, timezone: zone.timezone });
  const show = (fields: Record<string, string>, fallback?: string): void => {
    setProblems(fields);
    const stray = Object.entries(fields).find(([field]) => !shown.includes(field))?.[1];
    setFormProblem(stray ?? (Object.keys(fields).length === 0 ? fallback : undefined));
  };
  const create = useMutation({
    mutationFn: (body: Extract<ReturnType<typeof checkCreate>, { ok: true }>['body']) =>
      client.request(createCalendar, { body }),
    onSuccess: onCreated,
    onError: (error) => {
      if (error instanceof ApiError && error.problem.errors !== undefined) {
        const refused = rejection(error.problem.errors);
        show(refused.fields, refused.form ?? error.problem.detail);
        if (refused.form !== undefined) setFormProblem(refused.form);
        return;
      }
      setProblems({});
      setFormProblem(
        error instanceof ApiError
          ? (error.problem.detail ?? t`The calendar wasn't created. Try again.`)
          : t`The calendar wasn't created. Check your connection and try again.`,
      );
    },
  });
  const busy = create.isPending;
  const chosen = draft.members.map((member) => member.membershipId);
  const chosenPeople = (people.data ?? []).filter((person) => chosen.includes(person.membershipId));
  const prefix = bookingPrefix(agencySlug, business.slug);
  const kindName = i18n._(kindNames[kind]);

  return (
    <form
      noValidate
      className="flex min-w-0 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setFormProblem(undefined);
        const checked = checkCreate(whole());
        if (!checked.ok) {
          show(problemWords(checked.fields));
          return;
        }
        setProblems({});
        create.mutate(checked.body);
      }}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Dialog.Title className="text-lg font-medium">
            <Trans>New calendar</Trans>
          </Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            <Trans>Type: {kindName}</Trans>
          </Dialog.Description>
        </div>
        <Dialog.Close
          render={<Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />}
        >
          <X aria-hidden className="size-5" strokeWidth={1.8} />
        </Dialog.Close>
      </div>
      <Labeled label={t`Calendar name`} problem={problems['name']}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={120}
            autoComplete="off"
            placeholder={t`(eg) Outbound reach`}
            disabled={busy}
            value={draft.name}
            onChange={(event) => {
              const name = event.target.value;
              change(ownSlug ? { name } : { name, bookingSlug: slugFromName(name) });
            }}
          />
        )}
      </Labeled>
      {describing ? (
        <Labeled label={t`Description`} problem={problems['description']}>
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              maxLength={4000}
              disabled={busy}
              placeholder={t`Write description`}
              value={draft.description}
              onChange={(event) => {
                change({ description: event.target.value });
              }}
            />
          )}
        </Labeled>
      ) : (
        <Button
          variant="quiet"
          className="self-start px-1 font-medium text-link"
          onClick={() => {
            setDescribing(true);
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
          <Trans>Add description</Trans>
        </Button>
      )}
      <div className="flex min-w-0 flex-col gap-1.5 border-b border-border pb-5">
        <PeoplePicker
          label={kind === 'personal' ? t`Select team member` : t`Select team members`}
          people={people.data ?? []}
          chosen={chosen}
          single={kind === 'personal'}
          problem={problems['members']}
          disabled={busy || people.data === undefined}
          description={
            <Trans>
              Only people on this account's own team can be chosen. Add someone in Settings, Users
              first.
            </Trans>
          }
          onChange={(ids) => {
            change({
              members: ids.map(
                (membershipId) =>
                  draft.members.find((member) => member.membershipId === membershipId) ?? {
                    membershipId,
                    weight: '1',
                    locations: [],
                  },
              ),
            });
          }}
        />
        {people.isPending ? (
          <p role="status" className={noteClassName}>
            <Trans>Loading team members…</Trans>
          </p>
        ) : null}
        {people.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-destructive">
              <Trans>The team couldn't be loaded.</Trans>
            </span>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void people.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : null}
        {people.data?.length === 0 ? (
          <p className={noteClassName}>
            <Trans>Nobody has joined this account's team yet.</Trans>
          </p>
        ) : null}
      </div>
      <div className="border-b border-border pb-5">
        <Labeled
          label={t`Custom URL`}
          problem={problems['bookingSlug']}
          description={<Trans>The public address people book at.</Trans>}
        >
          {(control) => (
            <div className="flex min-w-0 flex-col sm:flex-row">
              <span className="flex min-h-11 min-w-0 items-center rounded-t-control border border-input bg-muted px-3 text-md break-all text-body sm:max-w-[60%] sm:rounded-l-control sm:rounded-tr-none sm:border-r-0 lg:min-h-9">
                {prefix}
              </span>
              <Input
                {...control}
                required
                maxLength={63}
                autoComplete="off"
                spellCheck={false}
                placeholder={t`my-calendar`}
                disabled={busy}
                className="rounded-t-none sm:flex-1 sm:rounded-l-none sm:rounded-tr-control"
                value={draft.bookingSlug}
                onChange={(event) => {
                  setOwnSlug(true);
                  change({ bookingSlug: event.target.value });
                }}
              />
            </div>
          )}
        </Labeled>
      </div>
      <div className="border-b border-border pb-5">
        <AmountField
          label={t`Meeting duration`}
          amount={draft.duration}
          offered={durationUnits}
          problem={problems['slotMinutes']}
          disabled={busy}
          className="sm:max-w-md"
          onChange={(duration) => {
            change({ duration });
          }}
        />
      </div>
      <section aria-label={t`Booking availability`} className="flex min-w-0 flex-col gap-2">
        <h3 className={labelClassName}>
          <Trans>Booking availability</Trans>
        </h3>
        {chosenPeople.length === 0 ? (
          <p className={noteClassName}>{hoursWords(draft.weeklyHours)}</p>
        ) : (
          <MemberHoursList
            client={client}
            businessId={business.id}
            people={chosenPeople}
            calendarHours={draft.weeklyHours}
            readSchedules={readSchedules}
          />
        )}
        <p className={noteClassName}>
          <Trans>
            To further customize your business hours, please head to the advanced settings.
          </Trans>
        </p>
      </section>
      {formProblem === undefined ? null : <Problem>{formProblem}</Problem>}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <Button
          variant="quiet"
          className="mr-auto px-1 font-medium text-link"
          disabled={busy}
          onClick={() => {
            onAdvanced(whole());
          }}
        >
          <Settings aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Advanced settings</Trans>
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Trans>Creating…</Trans> : <Trans>Confirm</Trans>}
        </Button>
      </div>
    </form>
  );
}
