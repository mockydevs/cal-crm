// The page editor: a funnel step's or a website page's content, edited on a canvas that
// draws it as it will be published. It has the whole window, as the workflow builder has.
// This file is the page around the canvas: it reads the page, keeps the draft saved by
// itself (into the page's one working draft, so saving often does not fill its list of
// versions) with the version the edits started from, keeps unsaved work across a failed
// save and a reload, asks before a newer version someone else saved is written over, says
// up front when this install serves no public page, and offers Preview, Publish and
// Versions. It never publishes by itself.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getSite,
  getSitePage,
  listCalendars,
  listForms,
  listSitePageElements,
  listSitePageVersions,
  saveSitePageDraft,
  type Calendar,
  type FormSummary,
  type Site,
  type SiteKind,
  type SitePage,
  type SitePageElementList,
  type VisualPageDocument,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { ArrowLeft, History, Redo2, Undo2 } from 'lucide-react';
import {
  lazy,
  Suspense,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { apiIn } from '../api';
import { ConfirmDialog, retryFaults, RowMenu, SmallDialog, ViewSwitch } from '../settings-list';
import { usePageTitle } from '../shell/page';
import { PublicPagesNotice, PublishBadge, usePublicStatus } from '../site-publish';
import { publishStateOf, withPageStanding } from '../site-publish-rules';
import { SitesLink } from '../sites-links';
import { siteKey, siteSplat } from '../sites-rules';
import { useBusiness } from '../workspace';
import {
  autosave,
  canSaveNow,
  hasUnsavedWork,
  SAVE_PAUSE_MS,
  saveDueIn,
  startAutosave,
  type Autosave,
  type AutosaveEvent,
} from './autosave';
import { useCanvasActions, useCanvasHistory } from './canvas-api';
import type { Device } from './device';
import { toCanvas, toDocument, type CanvasData } from './document-map';
import { problemsByNode, type CalendarChoice } from './element-rules';
import type { CanvasCalendars, CanvasForms } from './elements';
import { EditorFactsContext, NodeProblemsContext, type EditorFacts } from './fields';
import {
  browserStorage,
  clearDraft,
  draftKey,
  isRestorable,
  readDraft,
  sameDocument,
  writeDraft,
  type LocalDraft,
} from './local-draft';
import { ElementsPanel, OutlinePanel, SayContext, SelectionPanel, useTypeNames } from './panels';
import { picturesRead } from './pending-pictures';
import { checkCanvas, type EditorProblem } from './problems';
import type { Prepared } from './versions';

// The canvas and the library it stands on are the largest part of the editor, so they are
// a chunk of their own: it is asked for as soon as this file runs, and arrives while the
// page, the site and the forms are being read. The dialogs are fetched when first opened.
const canvasModule = () => import('./canvas');
void canvasModule();
const SiteCanvas = lazy(async () => ({ default: (await canvasModule()).SiteCanvas }));
const CanvasFrame = lazy(async () => ({ default: (await canvasModule()).CanvasFrame }));
const publishModule = () => import('../site-publish-dialogs');
const PreviewDialog = lazy(async () => ({ default: (await publishModule()).PreviewDialog }));
const PublishDialog = lazy(async () => ({ default: (await publishModule()).PublishDialog }));
const UnpublishDialog = lazy(async () => ({ default: (await publishModule()).UnpublishDialog }));
const ProblemList = lazy(async () => ({ default: (await publishModule()).ProblemList }));
const versionsModule = () => import('./versions');
const VersionsDialog = lazy(async () => ({ default: (await versionsModule()).VersionsDialog }));
const PageRender = lazy(async () => ({ default: (await versionsModule()).PageRender }));

/** How long after the last change the page is checked and kept in this browser. */
const SETTLE_MS = 400;

/** The forms of the business that are not archived: the list comes fifty at a time. */
async function allForms(client: Client): Promise<FormSummary[]> {
  const items: FormSummary[] = [];
  let after: string | undefined;
  do {
    const page = await client.request(listForms, {
      query: { limit: 50, archived: 'false', ...(after === undefined ? {} : { after }) },
    });
    items.push(...page.items);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined && items.length < 500);
  return items;
}

/** Every calendar of the business, fifty at a time: a calendar element names one of them. */
async function allCalendars(client: Client): Promise<Calendar[]> {
  const items: Calendar[] = [];
  let after: string | undefined;
  do {
    const page = await client.request(listCalendars, {
      query: { limit: 50, ...(after === undefined ? {} : { after }) },
    });
    items.push(...page.items);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined && items.length < 500);
  return items;
}

function Frame({
  kind,
  siteId,
  stepId,
  children,
}: {
  readonly kind: SiteKind;
  readonly siteId: string;
  readonly stepId?: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
      <SitesLink
        splat={siteSplat(kind, siteId, 'steps', stepId)}
        className="flex min-h-11 items-center gap-1.5 self-start rounded-control text-sm font-medium text-link hover:underline lg:min-h-8"
      >
        <ArrowLeft aria-hidden className="size-4" strokeWidth={2} />
        {kind === 'funnel' ? <Trans>Back to the funnel</Trans> : <Trans>Back to the website</Trans>}
      </SitesLink>
      {children}
    </div>
  );
}

export default function SiteEditorPage({
  kind,
  siteId,
  pageId,
}: {
  /** The list the address is under: funnels or websites. */
  readonly kind: SiteKind;
  readonly siteId: string;
  readonly pageId: string;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  // Read anew each time the editor opens: a page kept from an earlier visit would name a
  // version that is no longer the newest, and every save would be refused.
  const openedId = useId();
  const page = useQuery({
    queryKey: ['b', business.id, 'sites', 'editing', pageId, openedId],
    queryFn: () => apiIn(business.id).request(getSitePage, { params: { id: pageId } }),
    retry: retryFaults,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const site = useQuery({
    queryKey: siteKey(business.id, siteId),
    queryFn: () => apiIn(business.id).request(getSite, { params: { id: siteId } }),
    retry: retryFaults,
  });
  const elements = useQuery({
    queryKey: ['sites', 'page-elements'],
    queryFn: () => apiIn(business.id).request(listSitePageElements, {}),
    retry: retryFaults,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const forms = useQuery({
    queryKey: ['b', business.id, 'sites', 'editor-forms'],
    queryFn: () => allForms(apiIn(business.id)),
    retry: retryFaults,
  });
  const calendars = useQuery({
    queryKey: ['b', business.id, 'sites', 'editor-calendars'],
    queryFn: () => allCalendars(apiIn(business.id)),
    retry: retryFaults,
  });
  usePageTitle(t`Page editor`);
  const failed = [page, site, elements, forms, calendars].find((each) => each.isError);
  const status = failed?.error instanceof ApiError ? failed.error.status : undefined;
  if (
    page.data === undefined ||
    site.data === undefined ||
    elements.data === undefined ||
    forms.data === undefined ||
    calendars.data === undefined
  )
    return (
      <Frame kind={kind} siteId={siteId}>
        <h1 className="text-[30px] leading-tight font-semibold">
          <Trans>Page editor</Trans>
        </h1>
        {failed === undefined ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : status === 404 ? (
          <p role="alert" className="text-md">
            <Trans>This page is no longer here. It may have been deleted.</Trans>
          </p>
        ) : status === 403 ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            <Trans>You don't have permission to see this business's sites.</Trans>
          </p>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm font-medium text-destructive">
              <Trans>The page couldn't be loaded. Check your connection and try again.</Trans>
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                void failed.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </div>
        )}
      </Frame>
    );
  const read = page.data;
  if (read.document.mode !== 'visual')
    return (
      <Frame kind={kind} siteId={siteId} stepId={read.stepId}>
        <h1 className="text-[30px] leading-tight font-semibold">
          <Trans>Page editor</Trans>
        </h1>
        <p className="text-md">
          <Trans>
            This is a code page: its files are not edited here, and a code page can't be published
            yet.
          </Trans>
        </p>
      </Frame>
    );
  if (!read.canManage)
    return (
      <div className="flex h-dvh min-h-0 flex-col">
        <Frame kind={kind} siteId={siteId} stepId={read.stepId}>
          <h1 className="text-[30px] leading-tight font-semibold">
            <Trans>Page</Trans>
          </h1>
          <p className="text-md text-muted-foreground">
            <Trans>You can look at this page. Changing it needs permission to manage sites.</Trans>
          </p>
        </Frame>
        <Suspense fallback={null}>
          <PageRender document={read.document} title={t`The page as saved`} device="desktop" />
        </Suspense>
      </div>
    );
  return (
    <LoadedEditor
      key={read.id}
      first={read}
      document={read.document}
      site={site.data}
      elements={elements.data.items}
      forms={forms.data}
      calendars={calendars.data}
    />
  );
}

/** What the top bar says of the draft, and what it offers when the draft is not saved. */
function SaveState({
  save,
  problems,
  onSaveNow,
  onShowProblems,
  onChoose,
}: {
  readonly save: Autosave;
  readonly problems: number;
  readonly onSaveNow: () => void;
  readonly onShowProblems: (trigger: HTMLElement) => void;
  readonly onChoose: () => void;
}): ReactElement {
  const { status } = save;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <p role="status" data-testid="save-state" className="text-sm text-body">
        {status === 'saved' ? (
          <Trans>Saved</Trans>
        ) : status === 'saving' ? (
          <Trans>Saving…</Trans>
        ) : status === 'dirty' ? (
          <Trans>Not saved</Trans>
        ) : status === 'failed' ? (
          <Trans>Not saved: the save didn't arrive. Trying again by itself.</Trans>
        ) : status === 'conflict' ? (
          <Trans>Not saved: someone else saved a newer version.</Trans>
        ) : (
          <Trans>Not saved: {problems} to put right first.</Trans>
        )}
      </p>
      {status === 'failed' ? (
        <Button variant="secondary" size="small" onClick={onSaveNow}>
          <Trans>Save now</Trans>
        </Button>
      ) : status === 'conflict' ? (
        <Button variant="secondary" size="small" onClick={onChoose}>
          <Trans>Choose whose to keep</Trans>
        </Button>
      ) : status === 'invalid' ? (
        <Button
          variant="secondary"
          size="small"
          onClick={(event) => {
            onShowProblems(event.currentTarget);
          }}
        >
          <Trans>Show what</Trans>
        </Button>
      ) : null}
    </div>
  );
}

/** Undo and redo. Apart from the bar, so the bar is not drawn again with every change. */
function UndoRedo(): ReactElement {
  const { t } = useLingui();
  const { canUndo, canRedo } = useCanvasHistory();
  const { undo, redo } = useCanvasActions();
  return (
    <>
      <Button
        variant="quiet"
        size="small"
        className="px-2.5"
        aria-label={t`Undo`}
        disabled={!canUndo}
        onClick={undo}
      >
        <Undo2 aria-hidden className="size-4" strokeWidth={1.8} />
      </Button>
      <Button
        variant="quiet"
        size="small"
        className="px-2.5"
        aria-label={t`Redo`}
        disabled={!canRedo}
        onClick={redo}
      >
        <Redo2 aria-hidden className="size-4" strokeWidth={1.8} />
      </Button>
    </>
  );
}

type Asked = 'preview' | 'publish' | 'unpublish' | 'versions' | 'problems';
type Pane = 'page' | 'add' | 'layers' | 'edit';

/**
 * A newer version someone else saved while this page was being edited. Neither is dropped
 * without a word: "Keep mine" saves these edits as a version on top of theirs, which stays
 * in the list of versions; "Load theirs" opens theirs and says that these edits go.
 */
function ConflictDialog({
  pageId,
  title,
  device,
  onKeepMine,
  onLoadTheirs,
  onClose,
}: {
  readonly pageId: string;
  readonly title: string;
  readonly device: Device;
  readonly onKeepMine: (theirs: SitePage) => void;
  readonly onLoadTheirs: (theirs: SitePage) => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const openedId = useId();
  const noFocusRef = useRef<HTMLElement | null>(null);
  const [looking, setLooking] = useState(false);
  const theirs = useQuery({
    queryKey: ['b', business.id, 'sites', 'conflict', pageId, openedId],
    queryFn: async () => {
      const api = apiIn(business.id);
      const [page, versions] = await Promise.all([
        api.request(getSitePage, { params: { id: pageId } }),
        api.request(listSitePageVersions, { params: { id: pageId } }),
      ]);
      return { page, newest: versions.items.find((version) => version.current) };
    },
    retry: retryFaults,
    gcTime: 0,
  });
  const found = theirs.data;
  const version = found?.page.currentVersion ?? 0;
  const who = found?.newest?.createdBy.name ?? t`Someone else`;
  const when =
    found?.newest === undefined
      ? ''
      : new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(found.newest.createdAt),
        );
  return (
    <SmallDialog
      open
      title={<Trans>A newer version was saved</Trans>}
      description={
        found === undefined ? undefined : (
          <Trans>
            {who} saved version {version} of this page on {when}, after you started editing. Your
            changes are still here and are not saved yet.
          </Trans>
        )
      }
      returnFocus={noFocusRef}
      onClose={onClose}
    >
      {found === undefined ? (
        <p role={theirs.isError ? 'alert' : 'status'} className="text-sm text-muted-foreground">
          {theirs.isError ? (
            <Trans>The newer version couldn't be read. Check your connection and try again.</Trans>
          ) : (
            <Trans>Reading the newer version…</Trans>
          )}
        </p>
      ) : (
        <>
          {looking ? (
            <div className="flex h-64 min-w-0 flex-col overflow-hidden rounded-control border border-border">
              <Suspense fallback={null}>
                <PageRender document={found.page.document} title={title} device={device} />
              </Suspense>
            </div>
          ) : null}
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-body">
            <li>
              <Trans>
                Keep mine saves your changes as the newest version. Theirs stays in Versions, where
                it can be restored.
              </Trans>
            </li>
            <li>
              <Trans>Load theirs opens their version here. Your unsaved changes are dropped.</Trans>
            </li>
          </ul>
        </>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {found === undefined ? (
          theirs.isError ? (
            <Button
              variant="secondary"
              onClick={() => {
                void theirs.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          ) : null
        ) : (
          <>
            <Button
              variant="secondary"
              aria-pressed={looking}
              onClick={() => {
                setLooking((now) => !now);
              }}
            >
              <Trans>Look at theirs</Trans>
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                onLoadTheirs(found.page);
              }}
            >
              <Trans>Load theirs</Trans>
            </Button>
            <Button
              onClick={() => {
                onKeepMine(found.page);
              }}
            >
              <Trans>Keep mine</Trans>
            </Button>
          </>
        )}
      </div>
    </SmallDialog>
  );
}

interface ChromeProps {
  readonly site: Site;
  readonly page: SitePage;
  readonly stepName: string;
  readonly elements: SitePageElementList['items'];
  readonly device: Device;
  readonly onDevice: (device: Device) => void;
  readonly save: Autosave;
  readonly problems: readonly EditorProblem[];
  readonly said: string;
  readonly onSaveNow: () => void;
  /** Saves what is on screen now; says why it could not, or nothing when it did. */
  readonly flush: () => Promise<string | undefined>;
  /** The same, answering with the page as the server has it afterwards. */
  readonly pageAfterFlush: () => Promise<Prepared>;
  /** Hears of the page as the server now has it after a publish, an unpublish or a kept version. */
  readonly onPage: (page: SitePage) => void;
  readonly onLoad: (page: SitePage) => void;
  readonly onKeepMine: (theirs: SitePage) => void;
}

/** Everything around the canvas: the top bar, the two panels, the status line, the dialogs. */
function Chrome({
  site,
  page,
  stepName,
  elements,
  device,
  onDevice,
  save,
  problems,
  said,
  onSaveNow,
  flush,
  pageAfterFlush,
  onPage,
  onLoad,
  onKeepMine,
}: ChromeProps): ReactElement {
  const { t } = useLingui();
  const actions = useCanvasActions();
  const funnel = site.kind === 'funnel';
  const publicStatus = usePublicStatus();
  const { scripts } = use(EditorFactsContext);
  const [asked, setAsked] = useState<Asked>();
  const [choosing, setChoosing] = useState(false);
  const [pane, setPane] = useState<Pane>('page');
  const [leftTab, setLeftTab] = useState<'elements' | 'layers'>('elements');
  const openerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const conflict = save.status === 'conflict';
  // The question is put as soon as the server refuses a save; it can be set aside and
  // asked for again from the top bar.
  const [answered, setAnswered] = useState(false);
  if (!conflict && answered) setAnswered(false);
  const ask = (what: Asked, trigger: HTMLElement | null): void => {
    openerRef.current = trigger;
    setAsked(what);
  };
  const close = (): void => {
    setAsked(undefined);
  };
  const jump = (nodeId: string): void => {
    if (!actions.selectSaved(nodeId)) return;
    setPane('edit');
    // The dialog gives the keyboard back to its openerRef first; then the panel takes it.
    window.setTimeout(() => {
      headingRef.current?.focus();
    }, 0);
  };
  const marked = useMemo(
    () =>
      new Set(
        [...problems, ...(page.problems ?? [])].flatMap((problem) =>
          problem.nodeId === null ? [] : [problem.nodeId],
        ),
      ),
    [problems, page.problems],
  );
  // What is wrong with each element: the page as it stands, and the saved page as the
  // server found it. Shown at the element itself, in its panel.
  const nodeProblems = useMemo(
    () => problemsByNode(problems, page.problems),
    [problems, page.problems],
  );
  const unsaved = hasUnsavedWork(save);
  const state = publishStateOf(page, unsaved);
  const liveUrl = typeof page.liveUrl === 'string' ? page.liveUrl : undefined;
  // What a published popup does not do on this install, when its server says so.
  const popupNote =
    scripts?.popup === false
      ? t`Opens over the page from a link or a button. On this install it does not open by itself.`
      : null;
  const left = pane === 'add' || pane === 'layers' ? 'flex' : 'hidden';
  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-col bg-background">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <SitesLink
            splat={siteSplat(site.kind, site.id, 'steps', page.stepId)}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-control text-sm font-medium text-link hover:underline lg:min-h-8"
          >
            <ArrowLeft aria-hidden className="size-4" strokeWidth={2} />
            {funnel ? <Trans>Back to the funnel</Trans> : <Trans>Back to the website</Trans>}
          </SitesLink>
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-base font-medium">{stepName}</h1>
            <p className="truncate text-xs text-muted-foreground">{site.name}</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ViewSwitch
            label={t`Device`}
            value={device}
            onChange={onDevice}
            views={[
              { value: 'desktop', label: <Trans>Desktop</Trans> },
              { value: 'tablet', label: <Trans>Tablet</Trans> },
              { value: 'mobile', label: <Trans>Mobile</Trans> },
            ]}
          />
          <UndoRedo />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SaveState
            save={save}
            problems={problems.length}
            onSaveNow={onSaveNow}
            onShowProblems={(trigger) => {
              ask('problems', trigger);
            }}
            onChoose={() => {
              setChoosing(true);
            }}
          />
          <PublishBadge state={state} />
          <Button
            variant="secondary"
            size="small"
            onClick={(event) => {
              ask('versions', event.currentTarget);
            }}
          >
            <History aria-hidden className="size-4" strokeWidth={1.8} />
            <Trans>Versions</Trans>
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={(event) => {
              ask('preview', event.currentTarget);
            }}
          >
            <Trans>Preview</Trans>
          </Button>
          {page.canPublish ? (
            <Button
              size="small"
              onClick={(event) => {
                ask('publish', event.currentTarget);
              }}
            >
              <Trans>Publish</Trans>
            </Button>
          ) : null}
          {page.canPublish && page.publishedVersion !== null ? (
            <RowMenu
              label={t`More for this page`}
              actions={[
                ...(liveUrl === undefined
                  ? []
                  : [
                      {
                        label: t`Open live page`,
                        onSelect: () => {
                          window.open(liveUrl, '_blank', 'noopener,noreferrer');
                        },
                      },
                    ]),
                {
                  label: t`Unpublish`,
                  destructive: true,
                  onSelect: () => {
                    setAsked('unpublish');
                  },
                },
              ]}
              onOpen={(trigger) => {
                openerRef.current = trigger;
              }}
            />
          ) : null}
        </div>
      </header>
      {publicStatus !== undefined && !publicStatus.enabled ? (
        <div className="border-b border-border bg-card px-3 py-2">
          <PublicPagesNotice status={publicStatus} />
        </div>
      ) : null}
      <div className="border-b border-border bg-card px-3 py-2 lg:hidden">
        <ViewSwitch
          label={t`Part of the editor`}
          value={pane}
          onChange={(next) => {
            setPane(next);
            if (next === 'add') setLeftTab('elements');
            if (next === 'layers') setLeftTab('layers');
          }}
          views={[
            { value: 'page', label: <Trans>Page</Trans> },
            { value: 'add', label: <Trans>Add</Trans> },
            { value: 'layers', label: <Trans>Layers</Trans> },
            { value: 'edit', label: <Trans>Edit</Trans> },
          ]}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          aria-label={t`Add to the page, and its layers`}
          className={`${left} min-h-0 w-full min-w-0 shrink-0 flex-col border-r border-border bg-card lg:flex lg:w-72`}
        >
          <div className="hidden border-b border-border px-3 py-2 lg:block">
            <ViewSwitch
              label={t`Left panel`}
              value={leftTab}
              onChange={setLeftTab}
              views={[
                { value: 'elements', label: <Trans>Elements</Trans> },
                { value: 'layers', label: <Trans>Layers</Trans> },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {leftTab === 'elements' ? (
              <ElementsPanel elements={elements} popupNote={popupNote} />
            ) : (
              <OutlinePanel marked={marked} />
            )}
          </div>
        </aside>
        <section
          aria-label={t`The page`}
          className={`${pane === 'page' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col lg:flex`}
        >
          <CanvasFrame device={device} />
        </section>
        <aside
          aria-label={t`What is selected`}
          className={`${pane === 'edit' ? 'flex' : 'hidden'} min-h-0 w-full min-w-0 shrink-0 flex-col overflow-y-auto border-l border-border bg-card lg:flex lg:w-80`}
        >
          <NodeProblemsContext value={nodeProblems}>
            <SelectionPanel headingRef={headingRef} />
          </NodeProblemsContext>
        </aside>
      </div>
      <footer className="flex min-h-8 min-w-0 items-center border-t border-border bg-card px-3 py-1">
        <p
          role="status"
          aria-live="polite"
          data-testid="said"
          className="min-w-0 truncate text-sm text-body"
        >
          {said}
        </p>
      </footer>

      <Suspense fallback={null}>
        {asked === 'preview' ? (
          <PreviewDialog
            pageId={page.id}
            device={device}
            prepare={flush}
            returnFocus={openerRef}
            onClose={close}
          />
        ) : null}
        {asked === 'publish' ? (
          <PublishDialog
            pageId={page.id}
            prepare={flush}
            onJump={jump}
            onChanged={onPage}
            returnFocus={openerRef}
            onClose={close}
          />
        ) : null}
        {asked === 'unpublish' ? (
          <UnpublishDialog page={page} onChanged={onPage} returnFocus={openerRef} onClose={close} />
        ) : null}
        {asked === 'versions' ? (
          <VersionsDialog
            page={page}
            device={device}
            prepare={pageAfterFlush}
            onRestored={onLoad}
            onKept={onPage}
            returnFocus={openerRef}
            onClose={close}
          />
        ) : null}
      </Suspense>
      <SmallDialog
        open={asked === 'problems'}
        title={<Trans>Not saved yet</Trans>}
        description={
          <Trans>
            The page as it stands can't be saved. Your work is kept in this browser meanwhile.
          </Trans>
        }
        returnFocus={openerRef}
        onClose={close}
      >
        <Suspense fallback={null}>
          <ProblemList
            title={<Trans>Put these right:</Trans>}
            problems={problems}
            onJump={(nodeId) => {
              close();
              jump(nodeId);
            }}
          />
        </Suspense>
      </SmallDialog>
      {conflict && (!answered || choosing) ? (
        <ConflictDialog
          pageId={page.id}
          title={t`The newer version`}
          device={device}
          onKeepMine={(theirs) => {
            setChoosing(false);
            onKeepMine(theirs);
          }}
          onLoadTheirs={onLoad}
          onClose={() => {
            setAnswered(true);
            setChoosing(false);
          }}
        />
      ) : null}
    </div>
  );
}

function LoadedEditor({
  first,
  document: firstDocument,
  site,
  elements,
  forms,
  calendars,
}: {
  readonly first: SitePage;
  readonly document: VisualPageDocument;
  readonly site: Site;
  readonly elements: SitePageElementList['items'];
  readonly forms: readonly FormSummary[];
  readonly calendars: readonly Calendar[];
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const businessId = business.id;
  const pageId = first.id;
  const siteId = site.id;
  const key = draftKey(businessId, pageId);
  const [storage] = useState(browserStorage);
  const publicStatus = usePublicStatus();
  const [server, setServer] = useState(first);
  const serverRef = useRef(first);
  const [save, setSave] = useState(() => startAutosave(first.currentVersion));
  const saveRef = useRef(save);
  const [canvas, setCanvas] = useState(() => ({ key: 1, initial: toCanvas(firstDocument) }));
  const latestRef = useRef<CanvasData>(canvas.initial);
  /** What the server holds: an edit that puts the page back as it was is not a change. */
  const baselineRef = useRef<unknown>(firstDocument);
  const [problems, setProblems] = useState<readonly EditorProblem[]>([]);
  const [device, setDevice] = useState<Device>('desktop');
  const [said, setSaid] = useState('');
  const [offer, setOffer] = useState<LocalDraft | null>(() => {
    const kept = readDraft(storage, key);
    return isRestorable(kept, first) ? kept : null;
  });
  const inFlightRef = useRef<Promise<void> | null>(null);
  const settleRef = useRef<number | undefined>(undefined);
  const noFocusRef = useRef<HTMLElement | null>(null);

  const step = site.steps.find((each) => each.id === first.stepId);
  const stepName = step?.name ?? (site.kind === 'funnel' ? t`Funnel step` : t`Website page`);
  usePageTitle(t`Edit ${stepName}`);

  const dispatchSave = useCallback((event: AutosaveEvent): void => {
    const before = saveRef.current;
    const after = autosave(before, event);
    saveRef.current = after;
    // Only what the page shows is put on screen: a letter typed into a field counts as an
    // edit, and must not draw the whole editor again.
    if (
      after.status !== before.status ||
      after.failures !== before.failures ||
      after.baseVersion !== before.baseVersion
    )
      setSave(after);
  }, []);
  const pauseRef = useRef<number | undefined>(undefined);
  const runSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());
  /** Saves after a pause in the edits: each edit starts the pause again. */
  const saveAfterPause = useCallback((): void => {
    window.clearTimeout(pauseRef.current);
    pauseRef.current = window.setTimeout(() => {
      if (canSaveNow(saveRef.current)) void runSaveRef.current();
    }, SAVE_PAUSE_MS);
  }, []);
  const took = useCallback(
    (page: SitePage): void => {
      serverRef.current = page;
      setServer(page);
      // The funnel's own page shows where this page now stands the moment it is opened,
      // and reads the site again to be sure.
      cache.setQueryData<Site>(siteKey(businessId, siteId), (kept) =>
        kept === undefined ? kept : withPageStanding(kept, page),
      );
      void cache.invalidateQueries({ queryKey: siteKey(businessId, siteId) });
    },
    [cache, businessId, siteId],
  );
  /**
   * The page after something other than an edit moved it on: a publish, an unpublish or a
   * version kept on purpose. The next save starts from the version it now has.
   */
  const moved = useCallback(
    (page: SitePage): void => {
      took(page);
      dispatchSave({ type: 'version_moved', version: page.currentVersion });
    },
    [took, dispatchSave],
  );

  const runSave = useCallback((): Promise<void> => {
    if (inFlightRef.current !== null) return inFlightRef.current;
    const work = async (): Promise<void> => {
      const checked = checkCanvas(latestRef.current);
      setProblems(checked.problems);
      if (checked.document === null) {
        dispatchSave({ type: 'checked', valid: false });
        return;
      }
      dispatchSave({ type: 'save_started' });
      try {
        // An autosave: the server rewrites the page's working draft in place, and keeps a
        // version only when one is asked for. It names the revision the page had when it
        // was last read or saved here.
        const page = await apiIn(businessId).request(saveSitePageDraft, {
          params: { id: pageId },
          body: {
            baseVersion: saveRef.current.baseVersion,
            revision: serverRef.current.revision,
            autosave: true,
            document: checked.document,
          },
        });
        baselineRef.current = checked.document;
        took(page);
        dispatchSave({ type: 'save_succeeded', version: page.currentVersion });
        // Edits made while the save was on its way are still only here: they are saved next.
        if (saveRef.current.status === 'saved') clearDraft(storage, key);
        else saveAfterPause();
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) dispatchSave({ type: 'conflict' });
        else if (error instanceof ApiError && error.status === 422) {
          // The server would not take what the contract here accepted: its own sentences.
          const errors = error.problem.errors ?? [];
          setProblems(
            errors.length === 0
              ? [{ message: error.message, nodeId: null, blocking: true }]
              : errors.map((each) => ({ message: each.message, nodeId: null, blocking: true })),
          );
          dispatchSave({ type: 'save_refused' });
        } else dispatchSave({ type: 'save_failed' });
      }
    };
    const running = work().finally(() => {
      inFlightRef.current = null;
    });
    inFlightRef.current = running;
    return running;
  }, [businessId, pageId, key, storage, dispatchSave, took, saveAfterPause]);
  useEffect(() => {
    runSaveRef.current = runSave;
  }, [runSave]);

  const flush = useCallback(async (): Promise<string | undefined> => {
    // A picture's size still being read is part of the page: it is waited for first.
    await picturesRead();
    for (let tries = 0; tries < 3; tries += 1) {
      if (inFlightRef.current !== null) await inFlightRef.current;
      if (!canSaveNow(saveRef.current)) break;
      await runSave();
    }
    switch (saveRef.current.status) {
      case 'saved':
        return undefined;
      case 'invalid':
        return t`The page can't be saved as it stands. Put right what the top bar lists, then try again.`;
      case 'conflict':
        return t`Someone else saved a newer version of this page. Choose whose to keep first.`;
      case 'dirty':
      case 'saving':
      case 'failed':
        return t`Your changes couldn't be saved. Check your connection and try again.`;
    }
  }, [runSave, t]);
  const pageAfterFlush = useCallback(async (): Promise<Prepared> => {
    const problem = await flush();
    return problem === undefined ? { page: serverRef.current } : { problem };
  }, [flush]);

  const keep = useCallback((): void => {
    writeDraft(storage, key, {
      baseVersion: saveRef.current.baseVersion,
      savedAt: new Date().toISOString(),
      document: toDocument(latestRef.current),
    });
  }, [storage, key]);

  const changed = useCallback(
    (data: CanvasData): void => {
      if (data === latestRef.current) return;
      latestRef.current = data;
      if (saveRef.current.status === 'saved' && sameDocument(toDocument(data), baselineRef.current))
        return;
      dispatchSave({ type: 'edited' });
      // The draft is saved by itself after a pause in the edits.
      saveAfterPause();
      window.clearTimeout(settleRef.current);
      settleRef.current = window.setTimeout(() => {
        const checked = checkCanvas(latestRef.current);
        setProblems(checked.problems);
        dispatchSave({ type: 'checked', valid: checked.document !== null });
        if (hasUnsavedWork(saveRef.current)) keep();
      }, SETTLE_MS);
    },
    [dispatchSave, keep, saveAfterPause],
  );

  // A save that did not arrive is tried again by itself, later each time.
  const { status, failures } = save;
  useEffect(() => {
    if (status !== 'failed') return;
    const timer = window.setTimeout(
      () => {
        void runSave();
      },
      saveDueIn(saveRef.current) ?? SAVE_PAUSE_MS,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [status, failures, runSave]);

  // Leaving the tab, or the window (another window, another app), saves at once, without
  // waiting for the pause: a save rewrites the working draft, so one more costs no version.
  useEffect(() => {
    const saveNow = (): void => {
      if (hasUnsavedWork(saveRef.current)) keep();
      if (canSaveNow(saveRef.current)) void runSave();
    };
    const hidden = (): void => {
      if (window.document.visibilityState === 'hidden') saveNow();
    };
    window.document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', saveNow);
    return () => {
      window.document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('blur', saveNow);
      window.clearTimeout(settleRef.current);
      window.clearTimeout(pauseRef.current);
    };
  }, [keep, runSave]);

  // A draft kept in this browser that is not offered back is older than what the server
  // holds, or the same: it is let go.
  useEffect(() => {
    if (offer === null && !hasUnsavedWork(saveRef.current)) clearDraft(storage, key);
  }, [offer, storage, key]);

  const blocker = useBlocker({
    // Leaving saves first; only what could not be saved is asked about.
    shouldBlockFn: async () => {
      if (!hasUnsavedWork(saveRef.current)) return false;
      keep();
      return (await flush()) !== undefined;
    },
    enableBeforeUnload: () => hasUnsavedWork(saveRef.current),
    withResolver: true,
  });

  const load = useCallback(
    (page: SitePage): void => {
      if (page.document.mode !== 'visual') return;
      const initial = toCanvas(page.document);
      latestRef.current = initial;
      baselineRef.current = page.document;
      window.clearTimeout(settleRef.current);
      took(page);
      setProblems([]);
      setCanvas((now) => ({ key: now.key + 1, initial }));
      dispatchSave({ type: 'loaded', version: page.currentVersion });
      clearDraft(storage, key);
    },
    [took, dispatchSave, storage, key],
  );
  const restoreKept = (draft: LocalDraft): void => {
    // Taken as it was kept: the editor checks it before it is saved, as it checks any edit.
    const initial = toCanvas(draft.document as VisualPageDocument);
    latestRef.current = initial;
    setCanvas((now) => ({ key: now.key + 1, initial }));
    // It still names the version it was made on: if the server has a newer one since, the
    // save is refused and the person is asked whose to keep.
    dispatchSave({ type: 'kept_mine', baseVersion: draft.baseVersion });
    dispatchSave({ type: 'edited' });
    saveAfterPause();
    setOffer(null);
    setSaid(t`Your unsaved changes are back. They are saved in a moment.`);
  };

  const facts = useMemo<EditorFacts>(() => {
    const at = site.steps.findIndex((each) => each.id === first.stepId);
    return {
      funnel: site.kind === 'funnel',
      forms: forms.map((form) => ({
        id: form.id,
        name: form.name,
        published: form.status === 'published',
      })),
      steps: site.steps
        .filter((each) => each.id !== first.stepId)
        .map((each) => ({ id: each.id, name: each.name })),
      calendars: calendars.map((calendar) => ({
        id: calendar.id,
        name: calendar.name,
        active: calendar.isActive,
      })),
      scripts: publicStatus?.scripts ?? null,
      hasNextStep: at !== -1 && at < site.steps.length - 1,
      notes: new Map(
        elements.flatMap((element) =>
          element.note === null ? [] : [[element.type, element.note] as const],
        ),
      ),
    };
  }, [site, forms, calendars, elements, first.stepId, publicStatus]);
  const canvasForms = useMemo<CanvasForms>(
    () => new Map(facts.forms.map((form) => [form.id, form])),
    [facts],
  );
  const canvasCalendars = useMemo<CanvasCalendars>(
    () =>
      new Map(facts.calendars.map((calendar): [string, CalendarChoice] => [calendar.id, calendar])),
    [facts],
  );
  const typeNames = useTypeNames();
  const droppedIn = useCallback(
    (type: string): void => {
      const added = typeNames[type] ?? type;
      setSaid(t`${added} added where it was dropped.`);
    },
    [typeNames, t],
  );
  const keptAt =
    offer === null
      ? ''
      : new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(offer.savedAt),
        );

  return (
    <EditorFactsContext value={facts}>
      <SayContext value={setSaid}>
        <Suspense
          fallback={
            <p role="status" className="p-4 text-sm text-muted-foreground">
              <Trans>Loading the editor…</Trans>
            </p>
          }
        >
          <SiteCanvas
            key={canvas.key}
            initial={canvas.initial}
            forms={canvasForms}
            calendars={canvasCalendars}
            countdownTicks={publicStatus?.scripts.countdown ?? null}
            device={device}
            onChange={changed}
            onDroppedIn={droppedIn}
          >
            <Chrome
              site={site}
              page={server}
              stepName={stepName}
              elements={elements}
              device={device}
              onDevice={setDevice}
              save={save}
              problems={problems}
              said={said}
              onSaveNow={() => {
                void runSave();
              }}
              flush={flush}
              pageAfterFlush={pageAfterFlush}
              onPage={moved}
              onLoad={load}
              onKeepMine={(theirs) => {
                dispatchSave({ type: 'kept_mine', baseVersion: theirs.currentVersion });
                took(theirs);
                void runSave();
              }}
            />
          </SiteCanvas>
        </Suspense>
        <ConfirmDialog
          open={offer !== null}
          title={<Trans>Restore unsaved changes?</Trans>}
          description={
            <Trans>
              This browser kept changes to this page from {keptAt} that were never saved. Restore
              them, or carry on from the saved page and let them go.
            </Trans>
          }
          confirmLabel={t`Restore them`}
          busy={false}
          problem={undefined}
          returnFocus={noFocusRef}
          onClose={() => {
            clearDraft(storage, key);
            setOffer(null);
          }}
          onConfirm={() => {
            if (offer !== null) restoreKept(offer);
          }}
        />
        <SmallDialog
          open={blocker.status === 'blocked'}
          title={<Trans>Leave with unsaved changes?</Trans>}
          description={
            <Trans>
              Some changes to this page aren't saved. They are kept in this browser and offered back
              the next time this page is openedId here.
            </Trans>
          }
          returnFocus={noFocusRef}
          onClose={() => {
            blocker.reset?.();
          }}
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                blocker.proceed?.();
              }}
            >
              <Trans>Leave</Trans>
            </Button>
            <Button
              onClick={() => {
                blocker.reset?.();
              }}
            >
              <Trans>Stay and keep editing</Trans>
            </Button>
          </div>
        </SmallDialog>
      </SayContext>
    </EditorFactsContext>
  );
}
