// The automation builder (docs/AUTOMATIONS.md section 9): one draft, shown as Steps, on the
// Canvas or as JSON. Every view edits the same document held here, so a change in one is
// what the others show, and none keeps anything the document doesn't. The automation's runs
// are shown here too. Saving sends the draft with the draft version it started from; if someone else
// saved meanwhile the server refuses (409), and the person is told and chooses what to do:
// nothing is overwritten without their say. Its own chunk, loaded when an automation opens.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getAutomation,
  getAutomationCatalog,
  getAutomationStats,
  pauseAutomation,
  publishAutomation,
  replaceAutomationDraft,
  resumeAutomation,
  validateAutomation,
  type Automation,
  type AutomationValidationResponse,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { ArrowLeft, History, Pencil } from 'lucide-react';
import { useCallback, useId, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { AutomationDialog } from './automation-dialog';
import {
  formatDraft,
  isRecord,
  nameOf,
  readDraft,
  renameAutomation,
  sameJson,
  stepsOf,
  subjectOf,
  triggersOf,
  type Draft,
} from './automation-document';
import { IssueList, issuesOf, type ShownIssue } from './automation-issues';
import { spanOf } from './automation-json';
import { JsonView, type JsonSelection } from './automation-json-view';
import {
  SearchLink,
  type AutomationsNavigation,
  type AutomationView,
} from './automation-navigation';
import { automationAccess, setupOf, type AutomationAccess } from './automation-rules';
import { stepElementId, triggerElementId } from './automation-element-ids';
import type { AutomationCatalogData } from './automation-step-dialog';
import { inFlow, placeInDocument } from './automation-step-problems';
import { useStepEditing } from './automation-step-editing';
import { stepName, triggerLabel, triggerSummary } from './automation-summary';
import { Switch } from './automation-switch';
import {
  CanvasLoader,
  LogsLoader,
  PublishLoader,
  RunsLoader,
  SettingsLoader,
  StepsLoader,
  TestLoader,
  VersionsLoader,
} from './automation-view-loader';
import { usePageTitle } from './shell/page';
import { useBusiness } from './workspace';

export interface AutomationBuilderProps {
  readonly automationId: string;
  readonly view: AutomationView;
  /** The run the address names, in the runs view. */
  readonly runId?: string | undefined;
  readonly navigation: AutomationsNavigation;
}

const automationKey = (businessId: string, id: string): readonly string[] => [
  'b',
  businessId,
  'automation',
  id,
];

const retryRead = (failures: number, error: unknown): boolean =>
  !(error instanceof ApiError && (error.status === 404 || error.status === 403)) && failures < 2;

/** What the whole window shows while the workflow is on its way, or when it can't be had. */
function Alone({ children }: { readonly children: ReactNode }): ReactElement {
  const { t } = useLingui();
  usePageTitle(t`Automation`);
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <h1 className="text-[24px] leading-8 font-medium">
        <Trans>Automation</Trans>
      </h1>
      {children}
    </div>
  );
}

export default function AutomationBuilder({
  automationId,
  view,
  runId,
  navigation,
}: AutomationBuilderProps): ReactElement {
  const business = useBusiness();
  const client = apiIn(business.id);
  const automation = useQuery({
    queryKey: automationKey(business.id, automationId),
    queryFn: () => client.request(getAutomation, { params: { id: automationId } }),
    retry: retryRead,
    // What's open is the person's own draft: a refetch must never replace it under them.
    // And opening it again reads it again, never an earlier visit's copy: the draft version
    // a save starts from has to be the server's current one.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const catalog = useQuery({
    queryKey: ['b', business.id, 'automation-catalog'],
    queryFn: () => client.request(getAutomationCatalog, {}),
    retry: retryRead,
    staleTime: 60_000,
  });
  const back = (
    <SearchLink
      to={{}}
      navigation={navigation}
      className="py-2 text-link underline-offset-2 hover:underline"
    >
      <Trans>Workflows list</Trans>
    </SearchLink>
  );

  if (automation.isPending || catalog.isPending)
    return (
      <Alone>
        <p role="status">
          <Trans>Loading the workflow…</Trans>
        </p>
      </Alone>
    );
  if (automation.isError || catalog.isError) {
    const missing = automation.error instanceof ApiError && automation.error.status === 404;
    return (
      <Alone>
        <div role="alert" className="flex min-w-0 flex-col items-start gap-2 text-md">
          <p>
            {missing ? (
              <Trans>This workflow doesn't exist, or it belongs to another business.</Trans>
            ) : (
              <Trans>We couldn't load this workflow.</Trans>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {missing ? null : (
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void automation.refetch();
                  void catalog.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            )}
            {back}
          </div>
        </div>
      </Alone>
    );
  }
  return (
    <Editor
      initial={automation.data}
      catalog={catalog.data}
      view={view}
      runId={runId}
      navigation={navigation}
    />
  );
}

/** What a refusal names as wrong, each at its place in the document. */
function refusedAt(error: unknown): ShownIssue[] {
  if (!(error instanceof ApiError)) return [];
  return (error.problem.errors ?? []).map((issue) => ({
    ...issue,
    path: placeInDocument(issue.path),
    level: 'error' as const,
  }));
}

/** What went wrong with a request, in the server's words when it gave any. */
function refusalOf(error: unknown, fallback: string, forbidden: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 403) return forbidden;
  return error.problem.errors?.[0]?.message ?? error.problem.detail ?? fallback;
}

function Editor({
  initial,
  catalog,
  view,
  runId,
  navigation,
}: {
  readonly initial: Automation;
  readonly catalog: AutomationCatalogData;
  readonly view: AutomationView;
  readonly runId: string | undefined;
  readonly navigation: AutomationsNavigation;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const cache = useQueryClient();
  const renameId = useId();
  const headingId = useId();
  const setup = useMemo(() => setupOf(catalog.setup), [catalog.setup]);

  // The automation as the server last gave it, and the draft being edited in both views.
  const [saved, setSaved] = useState(initial);
  const [access, setAccess] = useState<AutomationAccess>(() => automationAccess(initial));
  const [draft, setDraft] = useState<Draft>(initial.draft);
  const [text, setText] = useState(() => formatDraft(initial.draft));
  const [checked, setChecked] = useState<{
    readonly draftVersion: number;
    readonly validation: AutomationValidationResponse;
  }>();
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [problem, setProblem] = useState<string>();
  // What the server refused the last save or publish for, by place in the document: kept
  // until the draft changes or is sent again, so each is shown where it is, not only above.
  const [refused, setRefused] = useState<readonly ShownIssue[]>([]);
  const [selection, setSelection] = useState<JsonSelection>();
  const [publishOpen, setPublishOpen] = useState(false);
  // The publish dialog's code is fetched when publishing is first asked for, and then stays.
  const [publishWanted, setPublishWanted] = useState(false);
  if (publishOpen && !publishWanted) setPublishWanted(true);
  const [publishRefusal, setPublishRefusal] = useState<ReactNode>();
  const [renaming, setRenaming] = useState<string>();
  // The test's code is fetched when a test is first asked for, and its dialog then stays.
  const [testing, setTesting] = useState(false);
  const [testWanted, setTestWanted] = useState(false);
  // The version history, fetched the same way.
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionsWanted, setVersionsWanted] = useState(false);
  // The Builder tab comes back to the view it was last left in.
  const [lastBuilt, setLastBuilt] = useState<'canvas' | 'steps' | 'json'>('canvas');
  if ((view === 'canvas' || view === 'steps' || view === 'json') && view !== lastBuilt)
    setLastBuilt(view);
  // The numbers a trigger's Stats shows, read when one is first asked for.
  const [statsWanted, setStatsWanted] = useState(false);
  const stats = useQuery({
    queryKey: ['b', business.id, 'automations', 'stats', initial.id],
    queryFn: () => client.request(getAutomationStats, { params: { id: initial.id } }),
    enabled: statsWanted,
  });

  // The person just asked to rename: the keyboard starts in the name.
  const focusOnMount = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
  }, []);

  const read = useMemo(() => readDraft(text), [text]);
  const unsaved = !read.ok || !sameJson(draft, saved.draft);
  // Checked as the server checks it: as this automation, so a start that loops back is seen.
  const local = useMemo(
    () => validateAutomation(draft, setup, { automationId: saved.id }),
    [draft, setup, saved.id],
  );
  const fromServer = !unsaved && checked?.draftVersion === saved.draftVersion;
  const found = issuesOf(fromServer ? checked.validation : local);
  const issues = [
    ...found,
    // What is refused elsewhere than in the flow is said once, above.
    ...refused.filter(
      (each) =>
        inFlow(each.path) &&
        !found.some((seen) => seen.path === each.path && seen.code === each.code),
    ),
  ];
  const errors = issues.filter((issue) => issue.level === 'error');
  // Actions and no trigger: allowed, for a workflow another one starts. No card can say so
  // on the canvas, so the page does, as a note. An empty workflow has the card that adds one.
  const untriggered =
    stepsOf(draft).length > 0 && issues.some((issue) => issue.code === 'no_trigger');
  const editable = access.canManage && read.ok;
  const name = nameOf(draft) || t`Untitled workflow`;
  usePageTitle(name);
  const here = { automation: saved.id };

  const blocker = useBlocker({
    // Changing view stays on this automation; anything else would drop unsaved changes.
    shouldBlockFn: ({ current, next }) => {
      const search: unknown = next.search;
      const staying =
        next.pathname === current.pathname && isRecord(search) && search['automation'] === saved.id;
      return unsaved && access.canManage && !staying;
    },
    enableBeforeUnload: () => unsaved && access.canManage,
    withResolver: true,
  });

  const changeDraft = (next: Draft): void => {
    setDraft(next);
    setText(formatDraft(next));
    setNotice(undefined);
    setProblem(undefined);
    setRefused([]);
  };
  const changeText = (next: string): void => {
    setText(next);
    setNotice(undefined);
    setProblem(undefined);
    setRefused([]);
    const reading = readDraft(next);
    if (reading.ok) setDraft(reading.draft);
  };
  /** Takes the server's automation as the new starting point, in both views. */
  const adopt = (automation: Automation): void => {
    setSaved(automation);
    setDraft(automation.draft);
    setText(formatDraft(automation.draft));
    cache.setQueryData(automationKey(business.id, automation.id), automation);
    void cache.invalidateQueries({ queryKey: ['b', business.id, 'automations'] });
  };
  /**
   * Takes only what publishing, pausing or resuming changed. The draft and its version stay
   * as they were loaded, so a later save is still checked against the draft it started from.
   */
  const adoptStatus = (automation: Automation): void => {
    setSaved((current) => ({
      ...current,
      status: automation.status,
      live: automation.live,
      liveVersion: automation.liveVersion,
      updatedAt: automation.updatedAt,
    }));
    void cache.invalidateQueries({ queryKey: ['b', business.id, 'automations'] });
  };

  const save = useMutation({
    mutationFn: () =>
      client.request(replaceAutomationDraft, {
        params: { id: saved.id },
        body: { baseDraftVersion: saved.draftVersion, document: { ...draft } },
      }),
    // Sent again, the draft is asked about anew: what was refused before isn't held to.
    onMutate: () => {
      setRefused([]);
    },
    onSuccess: ({ automation, validation }) => {
      adopt(automation);
      setChecked({ draftVersion: automation.draftVersion, validation });
      setProblem(undefined);
      setNotice(
        validation.valid
          ? t`Draft saved.`
          : t`Draft saved. It has problems to fix before it can be published.`,
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        return;
      }
      setRefused(refusedAt(error));
      setProblem(
        refusalOf(
          error,
          t`We couldn't save the draft. Check your connection and try again.`,
          t`You don't have permission to change workflows.`,
        ),
      );
    },
  });

  const reload = useMutation({
    mutationFn: () => client.request(getAutomation, { params: { id: saved.id } }),
    onSuccess: (automation) => {
      adopt(automation);
      setAccess(automationAccess(automation));
      setChecked(undefined);
      setConflict(false);
      setProblem(undefined);
      setNotice(t`Loaded the latest saved version.`);
    },
    onError: () => {
      setProblem(t`We couldn't load the latest version. Try again.`);
    },
  });

  const publish = useMutation({
    mutationFn: (note: string) =>
      client.request(publishAutomation, {
        params: { id: saved.id },
        body: { baseDraftVersion: saved.draftVersion, changeSummary: note },
      }),
    onSuccess: (automation) => {
      const version = automation.liveVersion ?? 0;
      adoptStatus(automation);
      setPublishOpen(false);
      setPublishRefusal(undefined);
      setNotice(
        t`Published. New contacts start version ${version}; contacts already in it finish the version they started.`,
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setPublishOpen(false);
        setConflict(true);
        return;
      }
      const reasons = refusedAt(error);
      setRefused(reasons);
      setPublishRefusal(
        reasons.length > 0 ? (
          <IssueList label={t`Why it wasn't published`} issues={reasons} />
        ) : (
          refusalOf(
            error,
            t`We couldn't publish. Check your connection and try again.`,
            t`You don't have permission to publish workflows.`,
          )
        ),
      );
    },
  });

  const setLive = useMutation({
    mutationFn: (to: 'pause' | 'resume') =>
      client.request(to === 'pause' ? pauseAutomation : resumeAutomation, {
        params: { id: saved.id },
      }),
    onSuccess: (automation, to) => {
      adoptStatus(automation);
      setProblem(undefined);
      setNotice(
        to === 'pause'
          ? t`Switched to draft. Nobody new starts; contacts already in it carry on.`
          : t`Published again. New contacts can start.`,
      );
    },
    onError: (error) => {
      setProblem(
        refusalOf(
          error,
          t`We couldn't change that. Check your connection and try again.`,
          t`You don't have permission to publish or unpublish workflows.`,
        ),
      );
    },
  });

  /** Opens the JSON view with a place in the document selected. */
  const showInJson = (pointer: string): void => {
    if (read.ok) {
      const span = spanOf(read.spans, pointer);
      if (span !== undefined) setSelection({ span });
    }
    if (view !== 'json') navigation.go({ ...here, view: 'json' });
  };
  const stepEditing = useStepEditing({
    draft,
    setup,
    catalog,
    client,
    automationId: saved.id,
    issues,
    onChange: changeDraft,
    onEmailCommand: async (command) => {
      const { runEmailCommand } = await import('./automation-email-copy');
      const answer = await runEmailCommand(
        client,
        { automationId: saved.id, baseDraftVersion: saved.draftVersion },
        command,
      );
      adopt(answer.saved.automation);
      setChecked({
        draftVersion: answer.saved.automation.draftVersion,
        validation: answer.saved.validation,
      });
      setProblem(undefined);
      return answer.template;
    },
    onEditInJson: showInJson,
  });
  const locate = (issue: ShownIssue): void => {
    const subject = subjectOf(issue.path);
    const element =
      (view !== 'canvas' && view !== 'steps') || subject.kind === 'automation'
        ? null
        : document.getElementById(
            subject.kind === 'step' ? stepElementId(subject.id) : triggerElementId(subject.index),
          );
    if (element === null) showInJson(issue.path);
    else {
      element.focus();
      element.scrollIntoView({ block: 'center' });
    }
  };

  const busy = save.isPending || reload.isPending || publish.isPending || setLive.isPending;
  const liveVersion = saved.live?.version;
  const draftVersion = saved.draftVersion;
  const building = view === 'canvas' || view === 'steps' || view === 'json';
  // What publishing would change, so the way to publish it is offered only when it would.
  const liveDocument = saved.live?.document;
  // The wording of changes is a chunk of its own, shared with the publish dialog: it is
  // fetched for a workflow that has a live version, and asked again when either side changes.
  const savedDraft = saved.draft;
  const differs = useQuery({
    queryKey: ['b', business.id, 'automation-pending', saved.id, liveVersion, draftVersion],
    queryFn: async () => {
      const { publishChanges } = await import('./automation-changes');
      return (
        liveDocument !== undefined && publishChanges(liveDocument, savedDraft, setup).length > 0
      );
    },
    enabled: liveDocument !== undefined,
    staleTime: Infinity,
  });
  const pending = differs.data === true;
  // The actions the logs can be narrowed to: the live version's, then any only the draft has.
  const actions = useMemo(() => {
    const named = new Map<string, string>();
    for (const document of [liveDocument, saved.draft])
      if (isRecord(document))
        for (const step of stepsOf(document))
          if (!named.has(step.id)) named.set(step.id, stepName(step, setup));
    return [...named].map(([id, label]) => ({ id, name: label }));
  }, [liveDocument, saved.draft, setup]);
  const triggerNames = useMemo(() => {
    const named = new Map<string, string>();
    for (const document of [liveDocument, saved.draft])
      if (isRecord(document))
        for (const trigger of triggersOf(document))
          if (!named.has(trigger.id))
            named.set(
              trigger.id,
              triggerSummary(trigger, setup) ?? triggerLabel(trigger.type) ?? trigger.id,
            );
    return [...named].map(([id, label]) => ({ id, name: label }));
  }, [liveDocument, saved.draft, setup]);
  const viewLink = (to: 'canvas' | 'steps' | 'json', label: string): ReactElement => (
    <SearchLink
      to={to === 'canvas' ? here : { ...here, view: to }}
      navigation={navigation}
      className="inline-flex min-h-11 items-center rounded-control px-3 text-[13px] font-medium text-body -outline-offset-2 hover:text-foreground aria-[current=page]:bg-card aria-[current=page]:text-link aria-[current=page]:shadow-[0_1px_2px_rgb(16_24_40/0.05)] lg:min-h-7"
      {...(view === to ? { 'aria-current': 'page' as const } : {})}
    >
      {label}
    </SearchLink>
  );
  const tabLink = (
    to: 'canvas' | 'settings' | 'runs' | 'logs',
    label: string,
    current: boolean,
  ): ReactElement => (
    <SearchLink
      to={
        to === 'canvas'
          ? lastBuilt === 'canvas'
            ? here
            : { ...here, view: lastBuilt }
          : { ...here, view: to }
      }
      navigation={navigation}
      className="flex min-h-11 items-center border-b-2 border-transparent px-2 text-sm font-medium whitespace-nowrap text-body hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-link lg:min-h-9"
      {...(current ? { 'aria-current': 'page' as const } : {})}
    >
      {label}
    </SearchLink>
  );

  return (
    <div className="flex min-h-dvh min-w-0 flex-col bg-background">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border bg-card px-4 py-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)]">
        <SearchLink
          to={{}}
          navigation={navigation}
          className="inline-flex min-h-11 items-center gap-1.5 justify-self-start text-sm font-medium text-body underline-offset-2 hover:text-foreground hover:underline lg:min-h-9"
        >
          <ArrowLeft aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
          <Trans>Workflows list</Trans>
        </SearchLink>
        <div className="col-span-2 row-start-2 flex min-w-0 items-center justify-center gap-1 lg:col-span-1 lg:col-start-2 lg:row-start-1">
          {renaming === undefined ? (
            <>
              <h1 className="min-w-0 truncate text-base leading-6 font-medium" title={name}>
                {name}
              </h1>
              {editable ? (
                <button
                  type="button"
                  aria-label={t`Rename workflow`}
                  className="flex size-11 shrink-0 items-center justify-center rounded-control text-body hover:bg-secondary hover:text-foreground lg:size-8"
                  onClick={() => {
                    setRenaming(nameOf(draft));
                  }}
                >
                  <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
                </button>
              ) : null}
            </>
          ) : (
            <form
              aria-labelledby={headingId}
              className="flex min-w-0 flex-wrap items-center justify-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const next = renaming.trim();
                if (next === '') return;
                changeDraft(renameAutomation(draft, next));
                setRenaming(undefined);
              }}
            >
              <h1 id={headingId} className="sr-only">
                {name}
              </h1>
              <label className="sr-only" htmlFor={renameId}>
                <Trans>Workflow name</Trans>
              </label>
              {/* A plain box with the kit's looks: the kit's own input brings the code that
                  wires a field to its label and errors, which this one box has no use for,
                  and the builder's code is at its budget (scripts/check-budget.mjs). */}
              <input
                id={renameId}
                ref={focusOnMount}
                required
                maxLength={120}
                data-slot="input"
                className="min-h-11 w-64 max-w-full min-w-0 rounded-control border border-input bg-card px-3 text-md text-foreground transition-colors placeholder:text-muted-foreground lg:min-h-9"
                value={renaming}
                onChange={(event) => {
                  setRenaming(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(undefined);
                }}
              />
              <Button type="submit" variant="secondary" size="small">
                <Trans>Use this name</Trans>
              </Button>
              <Button
                type="button"
                variant="quiet"
                size="small"
                onClick={() => {
                  setRenaming(undefined);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            </form>
          )}
        </div>
        <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-2 lg:col-start-3">
          {unsaved && access.canManage ? (
            <Badge variant="attention" className="max-sm:hidden" data-testid="automation-unsaved">
              <Trans>Unsaved changes</Trans>
            </Badge>
          ) : null}
          {/* Beside Save, where GoHighLevel has its history button, and small enough to stay
              on the first bar of a phone. */}
          <button
            type="button"
            aria-label={t`Versions`}
            title={t`Versions`}
            className="flex size-11 shrink-0 items-center justify-center rounded-control text-body hover:bg-secondary hover:text-foreground lg:size-9"
            onClick={() => {
              setVersionsWanted(true);
              setVersionsOpen(true);
            }}
          >
            <History aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
          {access.canManage ? (
            <Button
              variant={unsaved ? 'primary' : 'secondary'}
              disabled={!unsaved || !read.ok || busy}
              onClick={() => {
                save.mutate();
              }}
            >
              {unsaved ? <Trans>Save</Trans> : <Trans>Saved</Trans>}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border bg-card px-4 py-1.5">
        <nav aria-label={t`Automation views`} className="inline-flex rounded-lg bg-muted p-1">
          {viewLink('canvas', t`Canvas`)}
          {viewLink('steps', t`Steps`)}
          {viewLink('json', t`JSON`)}
        </nav>
        <nav aria-label={t`Workflow`} className="flex min-w-0 flex-wrap gap-x-1">
          {tabLink('canvas', t`Builder`, building)}
          {tabLink('settings', t`Settings`, view === 'settings')}
          {tabLink('runs', t`Enrollment history`, view === 'runs')}
          {tabLink('logs', t`Execution logs`, view === 'logs')}
        </nav>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {access.canManage ? (
            <Button
              variant="secondary"
              onClick={() => {
                setTestWanted(true);
                setTesting(true);
              }}
            >
              <Trans>Test workflow</Trans>
            </Button>
          ) : null}
          {access.canPublish && saved.live !== null && (unsaved || pending) ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setPublishRefusal(undefined);
                setPublishOpen(true);
              }}
            >
              <Trans>Publish changes</Trans>
            </Button>
          ) : null}
          {access.canPublish ? (
            <div className="flex items-center gap-2 text-sm font-medium">
              <span
                aria-hidden
                className={saved.status === 'active' ? 'text-body' : 'text-foreground'}
              >
                <Trans>Draft</Trans>
              </span>
              <Switch
                aria-label={t`Published`}
                checked={saved.status === 'active'}
                disabled={busy}
                onChange={(on) => {
                  setProblem(undefined);
                  if (!on) setLive.mutate('pause');
                  else if (saved.live === null) {
                    setPublishRefusal(undefined);
                    setPublishOpen(true);
                  } else setLive.mutate('resume');
                }}
              />
              <span
                aria-hidden
                className={saved.status === 'active' ? 'text-foreground' : 'text-body'}
              >
                <Trans>Publish</Trans>
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <Badge>
            <Trans>Draft · version {draftVersion}</Trans>
          </Badge>
          <Badge variant={liveVersion === undefined ? 'neutral' : 'assistant'}>
            {liveVersion === undefined ? (
              <Trans>Not published yet</Trans>
            ) : (
              <Trans>Live · version {liveVersion}</Trans>
            )}
          </Badge>
          {saved.status === 'paused' ? (
            <Badge variant="attention">
              <Trans>Paused</Trans>
            </Badge>
          ) : null}
          <p role="status" className="min-w-0 flex-1 basis-60 text-sm wrap-anywhere text-body">
            {notice ?? ''}
          </p>
        </div>

        {access.canManage ? null : (
          <p className="rounded-xl border border-border bg-card px-4 py-3 text-md">
            <Trans>
              You can look at this workflow, but you don't have permission to change it.
            </Trans>
          </p>
        )}
        {problem === undefined ? null : (
          <p role="alert" className="text-md font-medium text-destructive wrap-anywhere">
            {problem}
          </p>
        )}
        {conflict ? (
          <div
            role="alert"
            className="flex min-w-0 flex-col items-start gap-3 rounded-card border border-destructive bg-card p-5 text-md"
          >
            <p className="font-semibold">
              <Trans>Someone else saved this workflow while you were editing.</Trans>
            </p>
            <p>
              <Trans>
                Your changes weren't saved, and theirs weren't overwritten. Your version is still
                here: copy it from the JSON view if you want to keep it, then load the latest and
                make your changes again.
              </Trans>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={reload.isPending}
                onClick={() => {
                  reload.mutate();
                }}
              >
                <Trans>Load the latest and drop my changes</Trans>
              </Button>
              <Button
                variant="quiet"
                size="small"
                onClick={() => {
                  setConflict(false);
                }}
              >
                <Trans>Keep my version open</Trans>
              </Button>
            </div>
          </div>
        ) : null}

        {(view === 'steps' || view === 'canvas' || view === 'settings') && !read.ok ? (
          <div
            role="status"
            className="flex min-w-0 flex-col items-start gap-2 rounded-xl border border-destructive bg-card px-4 py-3 text-md"
          >
            <p>
              <Trans>
                The JSON view holds text that can't be read, so this view shows the last version
                that could, and can't be changed until the JSON is fixed.
              </Trans>
            </p>
            <SearchLink
              to={{ ...here, view: 'json' }}
              navigation={navigation}
              className="py-1 text-link underline-offset-2 hover:underline"
            >
              <Trans>Fix it in the JSON view</Trans>
            </SearchLink>
          </div>
        ) : null}

        {view === 'canvas' && untriggered ? (
          <p role="note" className="rounded-xl border border-border bg-card px-4 py-3 text-md">
            <Trans>
              Nothing starts this workflow on its own: it runs only when another workflow starts it.
              Add a trigger if it should also start by itself.
            </Trans>
          </p>
        ) : null}
        {view === 'steps' ? (
          <StepsLoader
            draft={draft}
            setup={setup}
            issues={issues}
            editable={editable}
            editing={stepEditing}
            onEditInJson={showInJson}
          />
        ) : null}
        {view === 'canvas' ? (
          <CanvasLoader
            draft={draft}
            setup={setup}
            steps={catalog.steps}
            stepGroups={catalog.stepGroups}
            issues={issues}
            editable={editable}
            editing={stepEditing}
            stats={stats.data}
            statsFailed={stats.isError}
            onWantStats={() => {
              setStatsWanted(true);
            }}
            onChange={changeDraft}
            onEditInJson={showInJson}
          />
        ) : null}
        {view === 'settings' ? (
          <SettingsLoader draft={draft} editable={editable} onChange={changeDraft} />
        ) : null}
        {view === 'runs' ? (
          <RunsLoader
            automationId={saved.id}
            runId={runId}
            navigation={navigation}
            setup={setup}
            triggers={triggerNames}
          />
        ) : null}
        {view === 'logs' ? (
          <LogsLoader
            automationId={saved.id}
            navigation={navigation}
            setup={setup}
            actions={actions}
          />
        ) : null}
        {stepEditing.dialogs}
        {/* Kept while another view shows, so the text and its place survive a change of view. */}
        <div hidden={view !== 'json'} className="min-w-0">
          {view === 'json' && issues.length > 0 ? (
            <IssueList
              issues={issues}
              label={errors.length === 0 ? t`Warnings` : t`Problems found`}
              onLocate={locate}
            />
          ) : null}
          <JsonView
            text={text}
            read={read}
            name={name}
            editable={access.canManage}
            errorCount={errors.length}
            selection={view === 'json' ? selection : undefined}
            onText={changeText}
            onUndo={() => {
              changeDraft(draft);
            }}
          />
        </div>
      </div>

      {publishWanted ? (
        <PublishLoader
          open={publishOpen}
          onOpenChange={setPublishOpen}
          automation={saved}
          setup={setup}
          unsaved={unsaved}
          errors={errors}
          warnings={issues.filter((issue) => issue.level === 'warning')}
          publishing={publish.isPending}
          refusal={publishRefusal}
          onPublish={(note) => {
            publish.mutate(note);
          }}
        />
      ) : null}
      {testWanted ? (
        <TestLoader
          open={testing}
          onOpenChange={setTesting}
          automationId={saved.id}
          saved={saved.draft}
          setup={setup}
          unsaved={unsaved}
        />
      ) : null}

      {versionsWanted ? (
        <VersionsLoader
          open={versionsOpen}
          onOpenChange={setVersionsOpen}
          automationId={saved.id}
          liveVersion={liveVersion}
          draft={draft}
          baseDraftVersion={saved.draftVersion}
          unsaved={unsaved}
          canManage={editable}
          setup={setup}
          onRestored={({ automation, validation }, version) => {
            adopt(automation);
            setChecked({ draftVersion: automation.draftVersion, validation });
            setProblem(undefined);
            setRefused([]);
            setNotice(
              t`Version ${version} is now the draft. Nothing was published; publish when it is ready.`,
            );
          }}
          onConflict={() => {
            setConflict(true);
          }}
        />
      ) : null}

      <AutomationDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title={<Trans>Leave without saving?</Trans>}
        description={<Trans>Your changes to this draft haven't been saved.</Trans>}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="quiet"
            onClick={() => {
              blocker.proceed?.();
            }}
          >
            <Trans>Leave and drop my changes</Trans>
          </Button>
          <Button
            onClick={() => {
              blocker.reset?.();
            }}
          >
            <Trans>Stay here</Trans>
          </Button>
        </div>
      </AutomationDialog>
    </div>
  );
}
