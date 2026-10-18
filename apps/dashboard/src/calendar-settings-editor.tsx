// The full calendar editor, as GoHighLevel's in the owner's screenshots: "Back to calendars
// list", the calendar's name ("Create" for a new one), share once it is saved, and "Save
// changes" across the top; the sections down the left, three of them under "Advanced
// settings", with a "Quick tip"; and the section showing in a card at the right. GoHighLevel's
// Integrations button, Payments and Booking channels have nothing behind them here, so they
// are not drawn.
//
// One form holds every section, so nothing typed is lost between them. A new calendar is
// one createCalendar. A saved one is two saves under the revision it was read at: the team,
// meeting places and hours first when they changed (updateCalendarAvailability), then the
// settings (updateCalendar), so that a calendar switched on in the same save already has
// its team. A calendar someone else changed meanwhile is not overwritten: the form keeps
// what was typed and offers the saved version.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createCalendar,
  getCalendar,
  listCalendarGroups,
  updateCalendar,
  updateCalendarAvailability,
  type BusinessSummary,
  type CalendarConfiguration,
  type CalendarGroupList,
  type CalendarKind,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronRight, Lightbulb, Share2 } from 'lucide-react';
import {
  lazy,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
} from 'react';
import { useBusinessTimeZone, usePeople } from './calendar-settings-data';
import { CalendarsLink, useCalendarNavigation } from './calendar-settings-links';
import { useProblemWords, type SectionProps } from './calendar-settings-parts';
import {
  availabilityChanged,
  bookingAddress,
  calendarCarryKey,
  calendarGroupsKey,
  calendarKey,
  calendarNoticeKey,
  calendarsKey,
  checkAvailability,
  checkCreate,
  checkSettings,
  draftOf,
  newDraft,
  problemsAfter,
  sectionByKey,
  sectionOfField,
  sections,
  type CalendarDraft,
  type Section,
} from './calendar-settings-rules';
import { quickTips, sectionNames } from './calendar-settings-words';
import { ListProblem } from './list-table';
import { PanelContent } from './list-toolbar';
import { rejection } from './problems';
import { iconButtonClassName, isStale, retryFaults } from './settings-list';
import { usePageTitle } from './shell/page';

// Each section is fetched as it is first opened: no one of them is needed to open another.
const BasicSection = lazy(() => import('./calendar-settings-basic'));
const sectionViews: Readonly<Record<Exclude<Section, 'basic'>, ComponentType<SectionProps>>> = {
  staff: lazy(() => import('./calendar-settings-staff')),
  availability: lazy(() => import('./calendar-settings-availability')),
  booking: lazy(() => import('./calendar-settings-booking')),
  forms: lazy(() => import('./calendar-settings-forms')),
  policies: lazy(() => import('./calendar-settings-policies')),
  appearance: lazy(() => import('./calendar-settings-appearance')),
};

const mainSections: readonly Section[] = sections
  .filter((each) => !each.advanced)
  .map((each) => each.key);
const advancedSections: readonly Section[] = sections
  .filter((each) => each.advanced)
  .map((each) => each.key);
const isAdvanced = (section: Section): boolean => advancedSections.includes(section);

/** The first field marked wrong on the section showing. */
const FIRST_PROBLEM = '[role="tabpanel"]:not([hidden]) [aria-invalid="true"]';

const tabClassName =
  'inline-flex min-h-11 w-full min-w-0 items-center rounded-control px-4 text-left text-md text-body -outline-offset-2 hover:bg-muted hover:text-foreground aria-selected:bg-accent aria-selected:font-medium aria-selected:text-link lg:min-h-10';

/** The body a check hands over once the contract accepts the form. */
type Body<Result> = Result extends { readonly ok: true; readonly body: infer Sent } ? Sent : never;

/** What a save sends: checked by the contract's schemas before any of it goes. */
type Saving =
  | { readonly mode: 'create'; readonly body: Body<ReturnType<typeof checkCreate>> }
  | {
      readonly mode: 'update';
      readonly id: string;
      readonly settings: Body<ReturnType<typeof checkSettings>>;
      /** The team, meeting places and hours, when they changed. */
      readonly availability: Body<ReturnType<typeof checkAvailability>> | undefined;
    };
function EditorForm({
  client,
  business,
  agencySlug,
  start,
  initial,
  canManage,
  groups,
  said,
}: {
  readonly client: Client;
  readonly business: BusinessSummary;
  readonly agencySlug: string;
  /** What the form opens on. */
  readonly start: CalendarDraft;
  /** The saved calendar; none for a new one. */
  readonly initial: CalendarConfiguration | undefined;
  readonly canManage: boolean;
  readonly groups: CalendarGroupList['items'] | undefined;
  /** What the page before this one left to say, such as "Calendar created." */
  readonly said: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  const cache = useQueryClient();
  const navigation = useCalendarNavigation(business.slug);
  const problemWords = useProblemWords();
  const people = usePeople(client, business.id);
  const baseId = useId();
  const [draft, setDraft] = useState(start);
  const [saved, setSaved] = useState(initial);
  const [section, setSection] = useState<Section>('basic');
  const [visited, setVisited] = useState<readonly Section[]>(['basic']);
  const [advanced, setAdvanced] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [formProblem, setFormProblem] = useState<string>();
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState(said);
  // Counts the times the keyboard is sent to what is wrong, so each one moves it again.
  const [sentToProblem, setSentToProblem] = useState(0);
  const formRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(new Map<Section, HTMLButtonElement>());

  useEffect(() => {
    if (sentToProblem === 0) return;
    formRef.current?.querySelector<HTMLElement>(FIRST_PROBLEM)?.focus();
  }, [sentToProblem]);

  const change = (changed: Partial<CalendarDraft>): void => {
    setDraft((current) => ({ ...current, ...changed }));
    setProblems((current) => problemsAfter(current, changed));
  };
  const open = (next: Section): void => {
    setSection(next);
    setVisited((current) => (current.includes(next) ? current : [...current, next]));
    if (isAdvanced(next)) setAdvanced(true);
  };
  /** Shows what is wrong, on the section that holds the first of it. */
  const show = (fields: Record<string, string>, fallback?: string): void => {
    setProblems(fields);
    const names = Object.keys(fields);
    const first = names.map(sectionOfField).find((each) => each !== undefined);
    if (first !== undefined && !names.some((field) => sectionOfField(field) === section))
      open(first);
    // A refusal that names something no section shows is said beside the title.
    const stray = names.find((field) => sectionOfField(field) === undefined);
    setFormProblem(
      stray === undefined
        ? (fallback ??
            (names.length === 0 ? undefined : t`Check the marked fields, then save again.`))
        : fields[stray],
    );
    setSentToProblem((count) => count + 1);
  };
  const refresh = (): void => {
    void cache.invalidateQueries({ queryKey: calendarsKey(business.id) });
    void cache.invalidateQueries({ queryKey: calendarGroupsKey(business.id) });
  };

  const save = useMutation({
    mutationFn: async (saving: Saving): Promise<CalendarConfiguration> => {
      if (saving.mode === 'create') return client.request(createCalendar, { body: saving.body });
      const { id } = saving;
      let revision = saving.settings.revision;
      if (saving.availability !== undefined) {
        const current = await client.request(updateCalendarAvailability, {
          params: { id },
          body: saving.availability,
        });
        // Kept at once: if the settings are then refused, only they are sent again.
        setSaved(current);
        cache.setQueryData(calendarKey(business.id, id), current);
        revision = current.revision;
      }
      return client.request(updateCalendar, {
        params: { id },
        body: { ...saving.settings, revision },
      });
    },
    onSuccess: (configuration, saving) => {
      const id = configuration.calendar.id;
      cache.setQueryData(calendarKey(business.id, id), configuration);
      refresh();
      setProblems({});
      setFormProblem(undefined);
      setStale(false);
      if (saving.mode === 'create') {
        cache.setQueryData(calendarNoticeKey(business.id), t`Calendar created.`);
        navigation.toCalendar(id);
        return;
      }
      setSaved(configuration);
      setNotice(t`Changes saved.`);
    },
    onError: (error) => {
      setStale(isStale(error));
      if (error instanceof ApiError && error.problem.errors !== undefined) {
        const refused = rejection(error.problem.errors);
        show(
          refused.fields,
          refused.form ??
            (Object.keys(refused.fields).length === 0
              ? (error.problem.detail ?? t`The calendar wasn't saved. Try again.`)
              : undefined),
        );
        return;
      }
      setProblems({});
      setFormProblem(
        error instanceof ApiError
          ? (error.problem.detail ?? t`The calendar wasn't saved. Try again.`)
          : t`The calendar wasn't saved. Check your connection and try again.`,
      );
    },
  });
  const reload = useMutation({
    mutationFn: () => client.request(getCalendar, { params: { id: saved?.calendar.id ?? '' } }),
    onSuccess: (configuration) => {
      cache.setQueryData(calendarKey(business.id, configuration.calendar.id), configuration);
      setSaved(configuration);
      setDraft(draftOf(configuration));
      setProblems({});
      setFormProblem(undefined);
      setStale(false);
      setNotice(t`Calendar reloaded.`);
    },
    onError: () => {
      setFormProblem(t`We couldn't reload the calendar. Try again.`);
    },
  });

  /** Checks the whole form, both saves of it, before either is sent: a form that is wrong changes nothing. */
  const submit = (): void => {
    setNotice('');
    setFormProblem(undefined);
    setStale(false);
    if (saved === undefined) {
      const checked = checkCreate(draft);
      if (checked.ok) save.mutate({ mode: 'create', body: checked.body });
      else show(problemWords(checked.fields));
      return;
    }
    const settings = checkSettings(draft, saved.revision);
    if (!settings.ok) {
      show(problemWords(settings.fields));
      return;
    }
    const availability = availabilityChanged(draft, saved)
      ? checkAvailability(draft, saved.revision)
      : undefined;
    if (availability?.ok === false) {
      show(problemWords(availability.fields));
      return;
    }
    save.mutate({
      mode: 'update',
      id: saved.calendar.id,
      settings: settings.body,
      availability: availability?.body,
    });
  };
  const busy = save.isPending || reload.isPending;
  const off = !canManage || busy;
  const shownSections: readonly Section[] = advanced
    ? [...mainSections, ...advancedSections]
    : mainSections;
  const title = saved === undefined ? t`Create` : saved.calendar.name;
  const address =
    saved === undefined
      ? undefined
      : bookingAddress(
          window.location.origin,
          agencySlug,
          business.slug,
          saved.calendar.bookingSlug,
        );
  const sectionProps: SectionProps = {
    client,
    businessId: business.id,
    businessSlug: business.slug,
    agencySlug,
    draft,
    change,
    problems,
    off,
    canManage,
    people: people.data,
    saved,
  };
  const tab = (each: Section): ReactElement => (
    <button
      key={each}
      ref={(button) => {
        if (button === null) tabsRef.current.delete(each);
        else tabsRef.current.set(each, button);
      }}
      type="button"
      role="tab"
      id={`${baseId}-tab-${each}`}
      aria-selected={each === section}
      aria-controls={`${baseId}-panel-${each}`}
      tabIndex={each === section ? 0 : -1}
      className={tabClassName}
      onClick={() => {
        open(each);
      }}
      onKeyDown={(event) => {
        const next = sectionByKey(shownSections, each, event.key);
        if (next === undefined) return;
        event.preventDefault();
        open(next);
        tabsRef.current.get(next)?.focus();
      }}
    >
      {i18n._(sectionNames[each])}
    </button>
  );

  return (
    <div ref={formRef} className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-3">
        <CalendarsLink
          slug={business.slug}
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-control text-md text-body -outline-offset-2 hover:text-foreground lg:min-h-9"
        >
          <ArrowLeft aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Back to calendars list</Trans>
        </CalendarsLink>
        <h1 className="min-w-0 flex-1 text-lg font-medium wrap-anywhere sm:text-center">{title}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {/* A calendar has its link once it is saved: before then there is nothing to copy. */}
          {address === undefined ? null : (
            <button
              type="button"
              className={`${iconButtonClassName} border border-input bg-card`}
              aria-label={t`Copy the booking link`}
              title={t`Copy booking link`}
              onClick={() => {
                void navigator.clipboard.writeText(address).then(
                  () => {
                    setNotice(t`Booking link copied.`);
                  },
                  () => undefined,
                );
              }}
            >
              <Share2 aria-hidden className="size-4" strokeWidth={1.8} />
            </button>
          )}
          <Button disabled={off} onClick={submit}>
            {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
          </Button>
        </div>
      </div>
      {canManage ? null : (
        <p className="text-sm text-muted-foreground">
          <Trans>
            You can look at this calendar. Changing it needs permission to manage calendars.
          </Trans>
        </p>
      )}
      <p role="status" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {formProblem === undefined ? null : (
        <div role="alert" className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
          <span className="font-medium text-destructive">{formProblem}</span>
          {stale && saved !== undefined ? (
            <Button
              variant="secondary"
              size="small"
              disabled={busy}
              onClick={() => {
                reload.mutate();
              }}
            >
              <Trans>Reload saved calendar</Trans>
            </Button>
          ) : null}
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
        <div className="flex min-w-0 shrink-0 flex-col gap-1 lg:w-60">
          <div
            role="tablist"
            aria-label={t`Calendar sections`}
            aria-orientation="vertical"
            className="flex min-w-0 flex-col gap-1"
          >
            {mainSections.map(tab)}
          </div>
          <button
            type="button"
            aria-expanded={advanced}
            aria-controls={`${baseId}-advanced`}
            className="inline-flex min-h-11 w-full min-w-0 items-center gap-2 rounded-control px-1 text-left text-md text-body -outline-offset-2 hover:bg-muted hover:text-foreground lg:min-h-10"
            onClick={() => {
              // Closing it while one of its sections shows goes back to the first section.
              if (advanced && isAdvanced(section)) open('basic');
              setAdvanced(!advanced);
            }}
          >
            {advanced ? (
              <ChevronDown aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
            ) : (
              <ChevronRight aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
            )}
            <Trans>Advanced settings</Trans>
          </button>
          <div
            id={`${baseId}-advanced`}
            role="tablist"
            aria-label={t`Advanced settings sections`}
            aria-orientation="vertical"
            hidden={!advanced}
            className="flex min-w-0 flex-col gap-1"
          >
            {advanced ? advancedSections.map(tab) : null}
          </div>
          <aside
            aria-label={t`Quick tip`}
            className="mt-3 flex min-w-0 flex-col gap-1.5 px-4 text-sm text-body"
          >
            <p className="flex items-center gap-2 font-medium">
              <Lightbulb aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
              <Trans>Quick tip</Trans>
            </p>
            <p>{i18n._(quickTips[section])}</p>
          </aside>
        </div>
        <div className="min-w-0 flex-1">
          {sections.map(({ key }) => {
            const View = key === 'basic' ? undefined : sectionViews[key];
            return (
              <div
                key={key}
                role="tabpanel"
                id={`${baseId}-panel-${key}`}
                aria-labelledby={`${baseId}-tab-${key}`}
                hidden={key !== section}
              >
                {!visited.includes(key) ? null : (
                  <PanelContent>
                    {View === undefined ? (
                      <BasicSection {...sectionProps} groups={groups} />
                    ) : (
                      <View {...sectionProps} />
                    )}
                  </PanelContent>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The editor of a new calendar of a type, or of the calendar with the id given. */
export function CalendarEditorPage({
  client,
  business,
  agencySlug,
  kind = 'personal',
  calendarId,
}: {
  readonly client: Client;
  readonly business: BusinessSummary;
  /** The agency's slug: the first part of every public booking address. */
  readonly agencySlug: string;
  /** The type of a new calendar. */
  readonly kind?: CalendarKind;
  /** The calendar edited; none for a new one. */
  readonly calendarId?: string;
}): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const zone = useBusinessTimeZone(client, business.id);
  // What the "New calendar" modal typed, or the page before left to say: read once.
  const [carried] = useState(() =>
    calendarId === undefined
      ? cache.getQueryData<CalendarDraft>(calendarCarryKey(business.id))
      : undefined,
  );
  const [said] = useState(() => cache.getQueryData<string>(calendarNoticeKey(business.id)) ?? '');
  useEffect(() => {
    cache.removeQueries({ queryKey: calendarCarryKey(business.id) });
    cache.removeQueries({ queryKey: calendarNoticeKey(business.id) });
  }, [cache, business.id]);
  // The groups a calendar can be put in, and whether this person may manage calendars.
  const groups = useQuery({
    queryKey: calendarGroupsKey(business.id),
    queryFn: () => client.request(listCalendarGroups, {}),
    retry: retryFaults,
  });
  const current = useQuery({
    queryKey: calendarKey(business.id, calendarId ?? ''),
    queryFn: () => client.request(getCalendar, { params: { id: calendarId ?? '' } }),
    enabled: calendarId !== undefined,
    retry: retryFaults,
    // A form being filled in is not replaced under the person filling it.
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  usePageTitle(
    calendarId === undefined ? t`New calendar` : (current.data?.calendar.name ?? t`Calendar`),
  );
  const gone = current.error instanceof ApiError && current.error.status === 404;
  const adding = calendarId === undefined;
  const loading = adding
    ? groups.isPending || (carried === undefined && !zone.settled)
    : current.isPending;
  const failed = adding ? groups.isError : current.isError;
  const back = (
    <CalendarsLink
      slug={business.slug}
      className="inline-flex min-h-11 items-center gap-2 self-start rounded-control text-md text-body -outline-offset-2 hover:text-foreground lg:min-h-9"
    >
      <ArrowLeft aria-hidden className="size-4" strokeWidth={1.8} />
      <Trans>Back to calendars list</Trans>
    </CalendarsLink>
  );
  if (loading && !failed)
    return (
      <>
        {back}
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading calendar…</Trans>
        </p>
      </>
    );
  if (gone)
    return (
      <>
        {back}
        <p role="alert" className="text-md">
          <Trans>This calendar isn't here any more.</Trans>
        </p>
      </>
    );
  if (failed)
    return (
      <>
        {back}
        <ListProblem
          onRetry={() => {
            void (adding ? groups.refetch() : current.refetch());
          }}
        >
          <Trans>We couldn't load this calendar.</Trans>
        </ListProblem>
      </>
    );
  if (adding)
    return (
      <EditorForm
        client={client}
        business={business}
        agencySlug={agencySlug}
        start={carried ?? newDraft(kind, zone.timezone)}
        initial={undefined}
        canManage={groups.data?.canManage === true}
        groups={groups.data?.items}
        said={said}
      />
    );
  if (current.data === undefined) return back;
  return (
    <EditorForm
      key={current.data.calendar.id}
      client={client}
      business={business}
      agencySlug={agencySlug}
      start={draftOf(current.data)}
      initial={current.data}
      canManage={current.data.canManage}
      groups={groups.data?.items}
      said={said}
    />
  );
}
