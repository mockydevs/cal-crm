// A funnel's page and a website's page (GoHighLevel's): Back, the name, Share, and the tabs
// Steps, Stats, Security and Settings. This file holds the frame and the Steps tab: the
// list of steps at the left with "Add new step", and the chosen step's Overview (its
// Control and Variation pages, the split test, clone and delete) and Publishing (name and
// path). A website is the same without the order, the variation and the split test. The
// other tabs and Share are fetched when first opened (site-tabs.tsx). A page's card says
// where the page stands on the web and offers Edit (the page editor, src/site-editor),
// Preview, Publish and Unpublish. What nothing serves yet is out of view until its stage
// lands (sites-rules.ts, SITE_STAGES): the Stats and Security tabs, and the variation with
// its split test.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  cloneSiteStep,
  createSiteStep,
  createSiteVariation,
  declareSiteWinner,
  deleteSiteStep,
  getSite,
  reorderSiteSteps,
  setSiteSplitTest,
  updateSiteStep,
  type Site,
  type SiteKind,
  type SitePage as SitePageDetail,
  type SitePageSummary,
  type SiteStepSummary,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button, buttonVariants } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Share2 } from 'lucide-react';
import {
  lazy,
  Suspense,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { apiIn } from './api';
import { noRejection, type Rejection } from './problems';
import {
  ConfirmDialog,
  iconButtonClassName,
  ListProblem,
  retryFaults,
  savingProblem,
  SmallDialog,
  ViewSwitch,
} from './settings-list';
import { usePageTitle } from './shell/page';
import {
  LiveAddress,
  NoPublicPages,
  PublicPagesNotice,
  PublishBadge,
  usePublicStatus,
} from './site-publish';
import { publishStateOf, withPageStanding } from './site-publish-rules';
import { FormRefusal } from './sites-dialogs';
import { SiteEditorLink, SitesLink, useSitesNavigate } from './sites-links';
import {
  chosenStep,
  listSplat,
  movedStep,
  pageOf,
  pathOf,
  shownSiteTabs,
  SITE_STAGES,
  siteKey,
  siteSplat,
  weightOf,
  type SiteTab,
} from './sites-rules';
import { useBusiness } from './workspace';

const tabsModule = () => import('./site-tabs');
const SiteStats = lazy(async () => ({ default: (await tabsModule()).SiteStats }));
const SiteSecurity = lazy(async () => ({ default: (await tabsModule()).SiteSecurity }));
const SiteSettings = lazy(async () => ({ default: (await tabsModule()).SiteSettings }));
const ShareDialog = lazy(async () => ({ default: (await tabsModule()).ShareDialog }));
const publishModule = () => import('./site-publish-dialogs');
const PreviewDialog = lazy(async () => ({ default: (await publishModule()).PreviewDialog }));
const PublishDialog = lazy(async () => ({ default: (await publishModule()).PublishDialog }));
const UnpublishDialog = lazy(async () => ({ default: (await publishModule()).UnpublishDialog }));

const cardClassName = 'flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4';
const tabClassName =
  'flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium text-body -outline-offset-2 hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-link lg:min-h-10';

export default function SitePage({
  kind,
  siteId,
  tab,
  stepId,
}: {
  /** The list the address is under, for the way back before the site has loaded. */
  readonly kind: SiteKind;
  readonly siteId: string;
  readonly tab: SiteTab;
  readonly stepId: string | undefined;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const current = useQuery({
    queryKey: siteKey(business.id, siteId),
    queryFn: () => apiIn(business.id).request(getSite, { params: { id: siteId } }),
    retry: retryFaults,
  });
  const site = current.data;
  const [sharing, setSharing] = useState(false);
  const shareRef = useRef<HTMLButtonElement>(null);
  const funnel = (site?.kind ?? kind) === 'funnel';
  usePageTitle(site?.name ?? (funnel ? t`Funnel` : t`Website`));
  const status = current.error instanceof ApiError ? current.error.status : undefined;
  const tabNames = {
    steps: funnel ? <Trans>Steps</Trans> : <Trans>Pages</Trans>,
    stats: <Trans>Stats</Trans>,
    security: <Trans>Security</Trans>,
    settings: <Trans>Settings</Trans>,
  } satisfies Record<SiteTab, ReactNode>;
  const loading = (
    <p role="status" className="text-sm text-muted-foreground">
      <Trans>Loading…</Trans>
    </p>
  );
  return (
    <>
      <SitesLink
        splat={listSplat(site?.kind ?? kind)}
        className="flex min-h-11 items-center gap-1.5 self-start rounded-control text-sm font-medium text-link hover:underline lg:min-h-8"
      >
        <ArrowLeft aria-hidden className="size-4" strokeWidth={2} />
        <Trans>Back</Trans>
      </SitesLink>
      {site === undefined ? (
        <>
          <h1 className="text-[30px] leading-tight font-semibold">
            {funnel ? <Trans>Funnel</Trans> : <Trans>Website</Trans>}
          </h1>
          {current.isPending ? (
            loading
          ) : status === 404 ? (
            <p role="alert" className="text-md">
              {funnel ? (
                <Trans>This funnel is no longer here. It may have been deleted.</Trans>
              ) : (
                <Trans>This website is no longer here. It may have been deleted.</Trans>
              )}
            </p>
          ) : status === 403 ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              <Trans>You don't have permission to see this business's sites.</Trans>
            </p>
          ) : (
            <ListProblem
              onRetry={() => {
                void current.refetch();
              }}
            >
              <Trans>It couldn't be loaded.</Trans>
            </ListProblem>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
            <h1 className="min-w-0 text-[30px] leading-tight font-semibold wrap-anywhere">
              {site.name}
            </h1>
            {site.canShare ? (
              <Button
                ref={shareRef}
                variant="secondary"
                onClick={() => {
                  setSharing(true);
                }}
              >
                <Share2 aria-hidden className="size-4" strokeWidth={1.8} />
                <Trans>Share</Trans>
              </Button>
            ) : null}
          </div>
          <nav
            aria-label={funnel ? t`Funnel sections` : t`Website sections`}
            className="flex flex-wrap gap-x-1 border-b border-border"
          >
            {shownSiteTabs.map((each) => (
              <SitesLink
                key={each}
                splat={siteSplat(site.kind, site.id, each)}
                current={each === tab}
                className={tabClassName}
              >
                {tabNames[each]}
              </SitesLink>
            ))}
          </nav>
          {tab === 'steps' ? (
            <SiteSteps site={site} stepId={stepId} />
          ) : (
            <Suspense fallback={loading}>
              {tab === 'stats' ? (
                <SiteStats site={site} />
              ) : tab === 'security' ? (
                <SiteSecurity site={site} />
              ) : (
                <SiteSettings site={site} />
              )}
            </Suspense>
          )}
          {sharing ? (
            <Suspense fallback={null}>
              <ShareDialog
                site={site}
                returnFocus={shareRef}
                onClose={() => {
                  setSharing(false);
                }}
              />
            </Suspense>
          ) : null}
        </>
      )}
    </>
  );
}

type StepView = 'overview' | 'publishing';

type Asked =
  | { readonly kind: 'add' }
  | { readonly kind: 'delete'; readonly step: SiteStepSummary }
  | { readonly kind: 'winner'; readonly step: SiteStepSummary; readonly page: SitePageSummary };

function SiteSteps({
  site,
  stepId,
}: {
  readonly site: Site;
  readonly stepId: string | undefined;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const go = useSitesNavigate();
  const api = apiIn(business.id);
  const funnel = site.kind === 'funnel';
  const step = chosenStep(site.steps, stepId);
  const [asked, setAsked] = useState<Asked>();
  // Kept here, so a step that was just saved shows the section it was saved from.
  const [view, setView] = useState<StepView>('overview');
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const refresh = (): Promise<void> =>
    cache.invalidateQueries({ queryKey: siteKey(business.id, site.id) });
  const publicStatus = usePublicStatus();
  const ask = (next: Asked, trigger: HTMLElement | null): void => {
    returnFocusRef.current = trigger;
    setAsked(next);
    setNotice('');
    setProblem(undefined);
  };
  const close = (message = ''): void => {
    setAsked(undefined);
    setNotice(message);
    setProblem(undefined);
  };
  // What a change that was refused says where everyone hears it; the page is read again,
  // since a refusal usually means someone else changed the site first.
  const refusedWith = (fallback: string) => (error: unknown) => {
    const words = savingProblem(error, fallback);
    const said = Object.values(words.fields)[0] ?? words.form ?? fallback;
    if (asked === undefined) setNotice(said);
    else setProblem(said);
    void refresh();
  };
  const notChanged = t`It wasn't changed. Check your connection and try again.`;
  // What is said about one step, by its name.
  const words = {
    copied: (name: string) => t`Copied as ${name}.`,
    deleted: (name: string) => t`${name} was deleted.`,
    added: (name: string) => t`${name} was added.`,
    up: (name: string) => t`Move ${name} up`,
    down: (name: string) => t`Move ${name} down`,
  };
  const askedName = asked?.kind === 'delete' ? asked.step.name : '';

  const reorder = useMutation({
    mutationFn: (stepIds: readonly string[]) =>
      api.request(reorderSiteSteps, {
        params: { id: site.id },
        body: { revision: site.revision, stepIds: [...stepIds] },
      }),
    onSuccess: async () => {
      await refresh();
      setNotice(t`The order was saved.`);
    },
    onError: refusedWith(notChanged),
  });
  const clone = useMutation({
    mutationFn: (source: SiteStepSummary) =>
      api.request(cloneSiteStep, { params: { id: source.id }, body: {} }),
    onSuccess: async (copy) => {
      await refresh();
      setNotice(words.copied(copy.name));
      go(siteSplat(site.kind, site.id, 'steps', copy.id));
    },
    onError: refusedWith(t`It wasn't copied. Check your connection and try again.`),
  });
  const remove = useMutation({
    mutationFn: (gone: SiteStepSummary) => api.request(deleteSiteStep, { params: { id: gone.id } }),
    onSuccess: async (_, gone) => {
      await refresh();
      close(words.deleted(gone.name));
      go(siteSplat(site.kind, site.id), true);
    },
    onError: refusedWith(t`It wasn't deleted. Check your connection and try again.`),
  });
  const variation = useMutation({
    mutationFn: (target: SiteStepSummary) =>
      api.request(createSiteVariation, {
        params: { id: target.id },
        body: { revision: target.revision, copyControl: true },
      }),
    onSuccess: async () => {
      await refresh();
      setNotice(t`Variation created as a copy of the control page.`);
    },
    onError: refusedWith(notChanged),
  });
  const splitTest = useMutation({
    mutationFn: ({
      target,
      ...body
    }: {
      readonly target: SiteStepSummary;
      readonly active: boolean;
      readonly controlWeight: number;
    }) =>
      api.request(setSiteSplitTest, {
        params: { id: target.id },
        body: { revision: target.revision, ...body },
      }),
    onSuccess: async (saved) => {
      await refresh();
      setNotice(saved.splitTest ? t`The split test is running.` : t`The split test is stopped.`);
    },
    onError: refusedWith(notChanged),
  });
  const winner = useMutation({
    mutationFn: ({ target, page }: { target: SiteStepSummary; page: SitePageSummary }) =>
      api.request(declareSiteWinner, {
        params: { id: target.id },
        body: { revision: target.revision, pageId: page.id },
      }),
    onSuccess: async () => {
      await refresh();
      close(t`The winner is now the step's only page.`);
    },
    onError: refusedWith(notChanged),
  });
  const busy =
    reorder.isPending ||
    clone.isPending ||
    remove.isPending ||
    variation.isPending ||
    splitTest.isPending ||
    winner.isPending;
  const ids = site.steps.map((each) => each.id);

  return (
    <>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {site.canManage ? null : (
        <p className="text-md text-muted-foreground">
          <Trans>You can look at this. Changing it needs permission to manage sites.</Trans>
        </p>
      )}
      <PublicPagesNotice status={publicStatus} />
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section aria-label={funnel ? t`Funnel steps` : t`Website pages`} className={cardClassName}>
          <h2 className="text-base font-medium">
            {funnel ? <Trans>Funnel steps</Trans> : <Trans>Website pages</Trans>}
          </h2>
          {site.steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {funnel ? (
                <Trans>This funnel has no steps yet.</Trans>
              ) : (
                <Trans>This website has no pages yet.</Trans>
              )}
            </p>
          ) : (
            <ol className="flex min-w-0 flex-col gap-1">
              {site.steps.map((each, index) => (
                <li key={each.id} className="flex min-w-0 items-center gap-1">
                  <SitesLink
                    splat={siteSplat(site.kind, site.id, 'steps', each.id)}
                    current={each.id === step?.id}
                    className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-control px-2 py-1 text-sm -outline-offset-2 hover:bg-muted aria-[current=page]:bg-accent aria-[current=page]:text-link"
                  >
                    <span className="font-medium wrap-anywhere">{each.name}</span>
                    <span className="text-xs wrap-anywhere text-muted-foreground">
                      /{each.path}
                    </span>
                  </SitesLink>
                  {funnel && site.canManage && site.steps.length > 1 ? (
                    <>
                      <button
                        type="button"
                        className={iconButtonClassName}
                        aria-label={words.up(each.name)}
                        disabled={index === 0 || busy}
                        onClick={() => {
                          setNotice('');
                          reorder.mutate(movedStep(ids, each.id, 'up'));
                        }}
                      >
                        <ArrowUp aria-hidden className="size-4" strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className={iconButtonClassName}
                        aria-label={words.down(each.name)}
                        disabled={index === site.steps.length - 1 || busy}
                        onClick={() => {
                          setNotice('');
                          reorder.mutate(movedStep(ids, each.id, 'down'));
                        }}
                      >
                        <ArrowDown aria-hidden className="size-4" strokeWidth={1.8} />
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {site.canManage ? (
            <Button
              variant="secondary"
              onClick={(event) => {
                ask({ kind: 'add' }, event.currentTarget);
              }}
            >
              <Plus aria-hidden className="size-4" strokeWidth={2} />
              {funnel ? <Trans>Add new step</Trans> : <Trans>Add new page</Trans>}
            </Button>
          ) : null}
        </section>
        {step === undefined ? null : (
          <StepDetail
            key={`${step.id}:${String(step.revision)}:${String(step.pages.length)}`}
            site={site}
            step={step}
            busy={busy}
            view={view}
            onView={setView}
            publicReason={publicStatus?.reason}
            onSaved={async (message) => {
              await refresh();
              setNotice(message);
            }}
            onPageChanged={(page) => {
              // Shown at once, from the answer itself; the site is read again when the
              // dialog that changed it closes.
              cache.setQueryData<Site>(siteKey(business.id, site.id), (kept) =>
                kept === undefined ? kept : withPageStanding(kept, page),
              );
            }}
            onClone={() => {
              setNotice('');
              clone.mutate(step);
            }}
            onDelete={(trigger) => {
              ask({ kind: 'delete', step }, trigger);
            }}
            onVariation={() => {
              setNotice('');
              variation.mutate(step);
            }}
            onSplitTest={(active, controlWeight) => {
              setNotice('');
              splitTest.mutate({ target: step, active, controlWeight });
            }}
            onWinner={(page, trigger) => {
              ask({ kind: 'winner', step, page }, trigger);
            }}
          />
        )}
      </div>

      {asked?.kind === 'add' ? (
        <AddStepDialog
          funnel={funnel}
          returnFocus={returnFocusRef}
          onClose={close}
          save={async (body) => {
            const added = await api.request(createSiteStep, { params: { id: site.id }, body });
            await refresh();
            close(words.added(added.name));
            go(siteSplat(site.kind, site.id, 'steps', added.id));
          }}
        />
      ) : null}
      <ConfirmDialog
        open={asked?.kind === 'delete'}
        title={funnel ? <Trans>Delete Funnel Step</Trans> : <Trans>Delete page</Trans>}
        description={
          asked?.kind !== 'delete' ? null : (
            <Trans>
              {askedName} will be deleted for good, with its pages, their versions and its
              statistics. This can't be undone.
            </Trans>
          )
        }
        confirmLabel={t`Delete for good`}
        destructive
        busy={remove.isPending}
        problem={problem}
        returnFocus={returnFocusRef}
        onClose={close}
        onConfirm={() => {
          if (asked?.kind === 'delete') remove.mutate(asked.step);
        }}
      />
      <ConfirmDialog
        open={asked?.kind === 'winner'}
        title={<Trans>Declare winner</Trans>}
        description={
          asked?.kind !== 'winner' ? null : asked.page.role === 'control' ? (
            <Trans>
              The control page stays. The split test ends, and the variation is deleted for good
              with its versions and statistics.
            </Trans>
          ) : (
            <Trans>
              The variation becomes the step's page. The split test ends, and the control page is
              deleted for good with its versions and statistics.
            </Trans>
          )
        }
        confirmLabel={t`Declare winner`}
        destructive
        busy={winner.isPending}
        problem={problem}
        returnFocus={returnFocusRef}
        onClose={close}
        onConfirm={() => {
          if (asked?.kind === 'winner') winner.mutate({ target: asked.step, page: asked.page });
        }}
      />
    </>
  );
}

function AddStepDialog({
  funnel,
  returnFocus,
  save,
  onClose,
}: {
  readonly funnel: boolean;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly save: (body: { readonly name: string; readonly path: string }) => Promise<void>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const [name, setName] = useState('');
  // The path follows the name until it is typed in itself.
  const [path, setPath] = useState<string>();
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const shownPath = path ?? pathOf(name);
  const add = useMutation({
    mutationFn: save,
    onError: (error) => {
      setProblem(savingProblem(error, t`It wasn't added. Check your connection and try again.`));
    },
  });
  const ready = name.trim() !== '' && shownPath.trim() !== '' && !add.isPending;
  return (
    <SmallDialog
      open
      title={funnel ? <Trans>New step in funnel</Trans> : <Trans>New page in website</Trans>}
      returnFocus={returnFocus}
      onClose={() => {
        if (!add.isPending) onClose();
      }}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setProblem(noRejection);
          add.mutate({ name: name.trim(), path: shownPath.trim() });
        }}
      >
        <Field name="name" invalid={problem.fields['name'] !== undefined}>
          <FieldLabel>
            <Trans>Name for page</Trans>
          </FieldLabel>
          <Input
            required
            maxLength={120}
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {problem.fields['name'] === undefined ? null : (
            <FieldError match>{problem.fields['name']}</FieldError>
          )}
        </Field>
        <Field name="path" invalid={problem.fields['path'] !== undefined}>
          <FieldLabel>
            <Trans>Path</Trans>
          </FieldLabel>
          <Input
            required
            maxLength={200}
            autoComplete="off"
            autoCapitalize="none"
            value={shownPath}
            onChange={(event) => {
              setPath(event.target.value);
            }}
          />
          <FieldDescription>
            <Trans>Lowercase letters, numbers and hyphens, with / between parts.</Trans>
          </FieldDescription>
          {problem.fields['path'] === undefined ? null : (
            <FieldError match>{problem.fields['path']}</FieldError>
          )}
        </Field>
        <FormRefusal problem={problem} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={add.isPending}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={!ready}>
            {add.isPending ? (
              <Trans>Creating…</Trans>
            ) : funnel ? (
              <Trans>Create funnel step</Trans>
            ) : (
              <Trans>Create page</Trans>
            )}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

type PageAsk = 'preview' | 'publish' | 'unpublish';

/**
 * One page of a step: where it stands on the web, and the ways to work on it. Edit opens
 * the page editor; Preview shows the newest saved version; Publish first shows what
 * stands in the way, and Unpublish asks before it takes the page off the web.
 */
function PageCard({
  site,
  title,
  page,
  share,
  action,
  onChanged,
  onSettled,
}: {
  readonly site: Site;
  readonly title: ReactNode;
  readonly page: SitePageSummary;
  /** Its share of the step's visitors, shown while there is a variation. */
  readonly share: number | undefined;
  readonly action: ReactNode;
  /** Hears that the page was published or unpublished, with the page as it now stands. */
  readonly onChanged: (page: SitePageDetail) => void;
  /** Hears that a dialog which changed the page has closed: the site is read again. */
  readonly onSettled: () => void;
}): ReactElement {
  const { i18n } = useLingui();
  const [asked, setAsked] = useState<PageAsk>();
  const openerRef = useRef<HTMLElement | null>(null);
  const published = page.publishedAt;
  const when =
    published === null
      ? ''
      : new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(new Date(published));
  const state = publishStateOf(page);
  const ask = (what: PageAsk, trigger: HTMLElement): void => {
    openerRef.current = trigger;
    setAsked(what);
  };
  const changedRef = useRef(false);
  const changed = (next: SitePageDetail): void => {
    changedRef.current = true;
    onChanged(next);
  };
  const close = (): void => {
    setAsked(undefined);
    if (changedRef.current) onSettled();
    changedRef.current = false;
  };
  return (
    <section className="flex min-w-0 flex-1 basis-56 flex-col gap-2 rounded-card border border-border p-4">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <PublishBadge state={state} />
        {published === null ? null : (
          <p className="text-sm text-muted-foreground">
            <Trans>Published {when}</Trans>
          </p>
        )}
      </div>
      {share === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          <Trans>{share}% of visitors</Trans>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SiteEditorLink
          kind={site.kind}
          siteId={site.id}
          pageId={page.id}
          className={buttonVariants({
            variant: site.canManage ? 'primary' : 'secondary',
            size: 'small',
          })}
        >
          {site.canManage ? <Trans>Edit</Trans> : <Trans>View</Trans>}
        </SiteEditorLink>
        <Button
          variant="secondary"
          size="small"
          onClick={(event) => {
            ask('preview', event.currentTarget);
          }}
        >
          <Trans>Preview</Trans>
        </Button>
        {site.canPublish && state !== 'published' ? (
          <Button
            variant="secondary"
            size="small"
            onClick={(event) => {
              ask('publish', event.currentTarget);
            }}
          >
            {state === 'changes' ? <Trans>Publish changes</Trans> : <Trans>Publish</Trans>}
          </Button>
        ) : null}
        {site.canPublish && state !== 'unpublished' ? (
          <Button
            variant="secondary"
            size="small"
            onClick={(event) => {
              ask('unpublish', event.currentTarget);
            }}
          >
            <Trans>Unpublish</Trans>
          </Button>
        ) : null}
        {action}
      </div>
      {asked === undefined ? null : (
        <Suspense fallback={null}>
          {asked === 'preview' ? (
            <PreviewDialog pageId={page.id} returnFocus={openerRef} onClose={close} />
          ) : asked === 'publish' ? (
            <PublishDialog
              pageId={page.id}
              onChanged={changed}
              returnFocus={openerRef}
              onClose={close}
            />
          ) : (
            <UnpublishDialog
              page={page}
              onChanged={changed}
              returnFocus={openerRef}
              onClose={close}
            />
          )}
        </Suspense>
      )}
    </section>
  );
}

function StepDetail({
  site,
  step,
  busy,
  view,
  onView,
  publicReason,
  onSaved,
  onPageChanged,
  onClone,
  onDelete,
  onVariation,
  onSplitTest,
  onWinner,
}: {
  readonly site: Site;
  readonly step: SiteStepSummary;
  readonly busy: boolean;
  readonly view: StepView;
  readonly onView: (view: StepView) => void;
  /** Why this install serves no public page, in the server's words, when it said. */
  readonly publicReason: string | null | undefined;
  readonly onSaved: (message: string) => Promise<void>;
  readonly onPageChanged: (page: SitePageDetail) => void;
  readonly onClone: () => void;
  readonly onDelete: (trigger: HTMLElement) => void;
  readonly onVariation: () => void;
  readonly onSplitTest: (active: boolean, controlWeight: number) => void;
  readonly onWinner: (page: SitePageSummary, trigger: HTMLElement) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const funnel = site.kind === 'funnel';
  const control = pageOf(step, 'control');
  const other = pageOf(step, 'variation');
  const [weight, setWeight] = useState(String(control?.weight ?? 100));
  const [name, setName] = useState(step.name);
  const [path, setPath] = useState(step.path);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const update = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(updateSiteStep, {
        params: { id: step.id },
        body: { revision: step.revision, name: name.trim(), path: path.trim() },
      }),
    onSuccess: () => onSaved(funnel ? t`Step updated.` : t`Page updated.`),
    onError: (error) => {
      setProblem(savingProblem(error, t`It wasn't saved. Check your connection and try again.`));
    },
  });
  const controlWeight = weightOf(weight);
  // A variation and its split test are out of view until visitors are really shared
  // between the pages (SITE_STAGES.splitTests); the control page is what everyone is served.
  const variation = SITE_STAGES.splitTests ? other : undefined;
  const published = control !== undefined && control.publishedVersion !== null;
  const settled = (): void => {
    void onSaved('');
  };
  const winnerButton = (page: SitePageSummary): ReactNode =>
    variation !== undefined && site.canManage ? (
      <Button
        variant="secondary"
        size="small"
        disabled={busy}
        aria-label={
          page.role === 'control'
            ? t`Declare the control page the winner`
            : t`Declare the variation the winner`
        }
        onClick={(event) => {
          onWinner(page, event.currentTarget);
        }}
      >
        <Trans>Declare winner</Trans>
      </Button>
    ) : null;
  return (
    <section aria-label={step.name} className={cardClassName}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="min-w-0 text-base font-medium wrap-anywhere">{step.name}</h2>
        <ViewSwitch
          label={funnel ? t`Step sections` : t`Page sections`}
          value={view}
          onChange={onView}
          views={[
            { value: 'overview', label: <Trans>Overview</Trans> },
            { value: 'publishing', label: <Trans>Publishing</Trans> },
          ]}
        />
      </div>
      {view === 'overview' ? (
        <>
          {typeof step.liveUrl === 'string' ? (
            <LiveAddress url={step.liveUrl} />
          ) : published ? (
            <NoPublicPages reason={publicReason} />
          ) : null}
          <div className="flex min-w-0 flex-wrap items-stretch gap-3">
            {control === undefined ? null : (
              <PageCard
                site={site}
                title={funnel ? <Trans>Control</Trans> : <Trans>Page</Trans>}
                page={control}
                share={variation === undefined ? undefined : control.weight}
                action={winnerButton(control)}
                onChanged={onPageChanged}
                onSettled={settled}
              />
            )}
            {!funnel || !SITE_STAGES.splitTests ? null : variation === undefined ? (
              <section className="flex min-w-0 flex-1 basis-56 flex-col gap-2 rounded-card border border-dashed border-border p-4">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <Trans>Variation</Trans>
                </h3>
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Start split test: Optimize your lead and sales generation with split tests.
                  </Trans>
                </p>
                {site.canManage ? (
                  <Button
                    variant="secondary"
                    size="small"
                    className="self-start"
                    disabled={busy}
                    onClick={onVariation}
                  >
                    <Plus aria-hidden className="size-4" strokeWidth={2} />
                    <Trans>Create variation</Trans>
                  </Button>
                ) : null}
              </section>
            ) : (
              <PageCard
                site={site}
                title={<Trans>Variation</Trans>}
                page={variation}
                share={variation.weight}
                action={winnerButton(variation)}
                onChanged={onPageChanged}
                onSettled={settled}
              />
            )}
          </div>
          {funnel && variation !== undefined ? (
            <div className="flex flex-wrap items-end gap-3 rounded-card border border-border p-4">
              <p className="min-w-0 flex-1 basis-56 text-sm">
                {step.splitTest ? (
                  <Trans>The split test is running: visitors are shared between the pages.</Trans>
                ) : (
                  <Trans>The split test is stopped: every visitor sees the control page.</Trans>
                )}
              </p>
              {site.canManage ? (
                <>
                  <Field
                    name="controlWeight"
                    invalid={controlWeight === undefined}
                    className="w-40"
                  >
                    <FieldLabel>
                      <Trans>Control share (%)</Trans>
                    </FieldLabel>
                    <Input
                      inputMode="numeric"
                      maxLength={3}
                      value={weight}
                      onChange={(event) => {
                        setWeight(event.target.value);
                      }}
                    />
                  </Field>
                  <Button
                    variant={step.splitTest ? 'secondary' : 'primary'}
                    disabled={busy || controlWeight === undefined}
                    onClick={() => {
                      if (controlWeight !== undefined) onSplitTest(!step.splitTest, controlWeight);
                    }}
                  >
                    {step.splitTest ? (
                      <Trans>Stop split test</Trans>
                    ) : (
                      <Trans>Start split test</Trans>
                    )}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          {site.canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="border-destructive text-destructive"
                disabled={busy}
                onClick={(event) => {
                  onDelete(event.currentTarget);
                }}
              >
                {funnel ? <Trans>Delete Funnel Step</Trans> : <Trans>Delete page</Trans>}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={onClone}>
                {funnel ? <Trans>Clone Funnel Step</Trans> : <Trans>Clone page</Trans>}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <form
          noValidate
          className="flex max-w-xl flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (update.isPending || name.trim() === '' || path.trim() === '') return;
            setProblem(noRejection);
            update.mutate();
          }}
        >
          <Field name="name" invalid={problem.fields['name'] !== undefined}>
            <FieldLabel>{funnel ? <Trans>Step name</Trans> : <Trans>Page name</Trans>}</FieldLabel>
            <Input
              required
              maxLength={120}
              autoComplete="off"
              disabled={!site.canManage}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            {problem.fields['name'] === undefined ? null : (
              <FieldError match>{problem.fields['name']}</FieldError>
            )}
          </Field>
          <Field name="path" invalid={problem.fields['path'] !== undefined}>
            <FieldLabel>{funnel ? <Trans>Step path</Trans> : <Trans>Page path</Trans>}</FieldLabel>
            <Input
              required
              maxLength={200}
              autoComplete="off"
              autoCapitalize="none"
              disabled={!site.canManage}
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
              }}
            />
            <FieldDescription>
              <Trans>Nested paths are supported: offers/spring.</Trans>
            </FieldDescription>
            {problem.fields['path'] === undefined ? null : (
              <FieldError match>{problem.fields['path']}</FieldError>
            )}
          </Field>
          <FormRefusal problem={problem} />
          {site.canManage ? (
            <Button
              type="submit"
              className="self-start"
              disabled={update.isPending || name.trim() === '' || path.trim() === ''}
            >
              {update.isPending ? (
                <Trans>Saving…</Trans>
              ) : funnel ? (
                <Trans>Update step</Trans>
              ) : (
                <Trans>Update page</Trans>
              )}
            </Button>
          ) : null}
        </form>
      )}
    </section>
  );
}
