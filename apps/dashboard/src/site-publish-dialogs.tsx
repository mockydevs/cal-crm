// A page's way onto the web, as the funnel's page and the page editor both offer it: a
// preview of the newest saved version, Publish, which first shows what stands in the way,
// and Unpublish. Publishing is always something a person presses: nothing here publishes by
// itself. Fetched when one of them is first opened, so the funnel's page does not carry
// them until then.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getSitePage,
  getSitePagePreview,
  publishSitePage,
  unpublishSitePage,
  type SitePage,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button, buttonVariants } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, X } from 'lucide-react';
import { useEffect, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { apiIn } from './api';
import { ConfirmDialog, returnTo, SmallDialog, ViewSwitch } from './settings-list';
import { FitWidth, LiveAddress, NoPublicPages, usePublicStatus } from './site-publish';
import {
  PREVIEW_WIDTHS,
  previewLifeMs,
  publicPagesOff,
  refusedProblems,
  serverProblems,
  type PageProblem,
  type PreviewDevice,
} from './site-publish-rules';
import { useBusiness } from './workspace';

const sheetClassName =
  'fixed inset-2 z-[65] flex flex-col overflow-hidden rounded-card bg-card text-card-foreground shadow-xl outline-none sm:inset-6';

/**
 * A preview of a page's newest saved version, as a visitor would see it, in a frame at a
 * device's width. The link is the server's signed one, good for an hour: a new one is
 * asked for before it runs out, and whenever the preview is refreshed.
 */
export function PreviewDialog({
  pageId,
  device: firstDevice = 'desktop',
  prepare,
  returnFocus,
  onClose,
}: {
  readonly pageId: string;
  readonly device?: PreviewDevice;
  /** Saves what is being edited first; says why it could not, or nothing when it did. */
  readonly prepare?: () => Promise<string | undefined>;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [device, setDevice] = useState<PreviewDevice>(firstDevice);
  const status = usePublicStatus();
  const pagesOff = publicPagesOff(status);
  // A new number asks for a new link: on opening, on Refresh, and when one runs out.
  const [asked, setAsked] = useState(1);
  const link = useQuery({
    queryKey: ['b', business.id, 'sites', 'preview', pageId, asked, pagesOff],
    queryFn: async () => {
      const unsaved = await prepare?.();
      if (unsaved !== undefined) return { unsaved, preview: undefined };
      // A preview is a public page too: an install that serves none has no link to give.
      if (pagesOff) return { unsaved: undefined, preview: undefined };
      const made = await apiIn(business.id).request(getSitePagePreview, {
        params: { id: pageId },
      });
      return { unsaved: undefined, preview: made };
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const preview = link.data?.preview;
  const unsaved = link.data?.unsaved;
  const expiresAt = preview?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = window.setTimeout(
      () => {
        setAsked((count) => count + 1);
      },
      previewLifeMs(expiresAt, Date.now()),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [expiresAt]);
  const off = pagesOff || (link.error instanceof ApiError && link.error.status === 409);
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        <Dialog.Popup className={sheetClassName} finalFocus={returnTo(returnFocus)}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
            <Dialog.Title className="text-base font-medium">
              <Trans>Preview</Trans>
            </Dialog.Title>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ViewSwitch
                label={t`Preview width`}
                value={device}
                onChange={setDevice}
                views={[
                  { value: 'desktop', label: <Trans>Desktop</Trans> },
                  { value: 'tablet', label: <Trans>Tablet</Trans> },
                  { value: 'mobile', label: <Trans>Mobile</Trans> },
                ]}
              />
              {off ? null : (
                <Button
                  variant="secondary"
                  size="small"
                  disabled={link.isFetching}
                  onClick={() => {
                    setAsked((count) => count + 1);
                  }}
                >
                  <RefreshCw aria-hidden className="size-4" strokeWidth={1.8} />
                  <Trans>Refresh</Trans>
                </Button>
              )}
              {preview === undefined ? null : (
                <a
                  href={preview.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ variant: 'secondary', size: 'small' })}
                >
                  <ExternalLink aria-hidden className="size-4" strokeWidth={1.8} />
                  <Trans>Open in a new tab</Trans>
                </a>
              )}
              <Dialog.Close
                render={
                  <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
                }
              >
                <X aria-hidden className="size-5" strokeWidth={1.8} />
              </Dialog.Close>
            </div>
          </div>
          {preview !== undefined ? (
            <>
              <Dialog.Description className="px-4 py-2 text-sm text-muted-foreground">
                <Trans>
                  The newest saved version, as a visitor would see it. Only someone with this link
                  can open it, for an hour.
                </Trans>
              </Dialog.Description>
              <FitWidth width={PREVIEW_WIDTHS[device]} className="bg-muted" testId="preview-stage">
                <iframe
                  key={preview.url}
                  title={t`Preview of the page`}
                  src={preview.url}
                  referrerPolicy="no-referrer"
                  className="size-full border-0"
                />
              </FitWidth>
            </>
          ) : (
            <div className="flex min-w-0 flex-col items-start gap-3 p-4">
              {link.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  <Trans>Getting the preview…</Trans>
                </p>
              ) : unsaved !== undefined ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {unsaved}
                </p>
              ) : off ? (
                <>
                  <NoPublicPages reason={status?.reason} />
                  <p className="text-sm text-body">
                    <Trans>A preview is served the way a published page is, so it waits too.</Trans>
                  </p>
                </>
              ) : (
                <>
                  <p role="alert" className="text-sm font-medium text-destructive">
                    <Trans>
                      The preview couldn't be made. Check your connection and try again.
                    </Trans>
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setAsked((count) => count + 1);
                    }}
                  >
                    <Trans>Try again</Trans>
                  </Button>
                </>
              )}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ProblemList({
  title,
  problems,
  onJump,
}: {
  readonly title: ReactNode;
  readonly problems: readonly PageProblem[];
  readonly onJump: ((nodeId: string) => void) | undefined;
}): ReactElement | null {
  if (problems.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {problems.map((problem, index) => (
          <li
            // eslint-disable-next-line @eslint-react/no-array-index-key -- two problems may say the same of one element
            key={index}
            className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-control border border-border px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1 basis-48 wrap-anywhere">{problem.message}</span>
            {problem.nodeId !== null && onJump !== undefined ? (
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  if (problem.nodeId !== null) onJump(problem.nodeId);
                }}
              >
                <Trans>Show it</Trans>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Publish: what stands in the way first, then the press that makes the newest saved
 * version live, then the live address. A problem that blocks stops it here, before the
 * server is asked; what the server still refuses is listed at its elements.
 */
export function PublishDialog({
  pageId,
  prepare,
  onJump,
  onChanged,
  returnFocus,
  onClose,
}: {
  readonly pageId: string;
  /** Saves what is being edited first; says why it could not, or nothing when it did. */
  readonly prepare?: () => Promise<string | undefined>;
  /** Takes the person to an element of the page; left out where the page is not open. */
  readonly onJump?: (nodeId: string) => void;
  /** Hears of the page as the server now has it: published, or read again. */
  readonly onChanged: (page: SitePage) => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [asked, setAsked] = useState(1);
  const [refused, setRefused] = useState<readonly PageProblem[]>([]);
  const [said, setSaid] = useState<string>();
  const [live, setLive] = useState<SitePage>();
  const status = usePublicStatus();
  const pagesOff = publicPagesOff(status);
  const current = useQuery({
    queryKey: ['b', business.id, 'sites', 'publishing', pageId, asked],
    queryFn: async () => {
      const unsaved = await prepare?.();
      if (unsaved !== undefined) return { unsaved, page: undefined };
      return {
        unsaved: undefined,
        page: await api.request(getSitePage, { params: { id: pageId } }),
      };
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const page = current.data?.page;
  const unsaved = current.data?.unsaved;
  const publish = useMutation({
    mutationFn: (target: SitePage) =>
      api.request(publishSitePage, {
        params: { id: target.id },
        body: { revision: target.revision },
      }),
    onSuccess: (published) => {
      setLive(published);
      onChanged(published);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 422) {
        const found = refusedProblems(error.problem.errors);
        setRefused(found);
        setSaid(
          found.length === 0
            ? (error.problem.detail ?? t`The server refused to publish it.`)
            : undefined,
        );
      } else if (error instanceof ApiError && error.status === 409) {
        // Someone changed the page meanwhile: it is read again, and its problems with it.
        setSaid(t`The page changed since this was opened. Look again, then publish.`);
        setAsked((count) => count + 1);
      } else if (error instanceof ApiError && error.status === 403)
        setSaid(t`You need permission to publish sites.`);
      else setSaid(t`It wasn't published. Check your connection and try again.`);
    },
  });
  const found = refused.length > 0 ? refused : serverProblems(page?.problems);
  const blocking = found.filter((problem) => problem.blocking);
  const warnings = found.filter((problem) => !problem.blocking);
  const jump =
    onJump === undefined
      ? undefined
      : (nodeId: string): void => {
          onClose();
          onJump(nodeId);
        };
  return (
    <SmallDialog
      open
      title={
        live === undefined ? (
          <Trans>Publish page</Trans>
        ) : typeof live.liveUrl === 'string' ? (
          <Trans>The page is live</Trans>
        ) : (
          <Trans>The page is published</Trans>
        )
      }
      description={
        live !== undefined ? (
          typeof live.liveUrl === 'string' ? (
            <Trans>Visitors now see the version you just published.</Trans>
          ) : live.role === 'variation' ? (
            <Trans>
              The version you just published is this variation's. Visitors are served the control
              page.
            </Trans>
          ) : (
            <Trans>
              The version you just published is the one visitors will see. They can't reach it yet.
            </Trans>
          )
        ) : (
          <Trans>
            Makes the newest saved version what visitors see. Nothing is published until you press
            Publish.
          </Trans>
        )
      }
      returnFocus={returnFocus}
      onClose={() => {
        if (!publish.isPending) onClose();
      }}
    >
      {live !== undefined ? (
        <>
          {typeof live.liveUrl === 'string' ? (
            <LiveAddress url={live.liveUrl} />
          ) : live.role === 'variation' ? null : (
            <NoPublicPages reason={status?.reason} />
          )}
          <div className="flex justify-end">
            <Button
              onClick={() => {
                onClose();
              }}
            >
              <Trans>Done</Trans>
            </Button>
          </div>
        </>
      ) : (
        <>
          {current.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Checking the page…</Trans>
            </p>
          ) : unsaved !== undefined ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {unsaved}
            </p>
          ) : page === undefined ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              <Trans>The page couldn't be checked. Check your connection and try again.</Trans>
            </p>
          ) : (
            <>
              <ProblemList
                title={
                  refused.length > 0 ? (
                    <Trans>The server refused to publish it. Put these right first:</Trans>
                  ) : (
                    <Trans>Put these right first. They stop the page being published:</Trans>
                  )
                }
                problems={blocking}
                onJump={jump}
              />
              <ProblemList
                title={<Trans>Worth a look. These don't stop publishing:</Trans>}
                problems={warnings}
                onJump={jump}
              />
              {found.length === 0 ? (
                <p className="text-sm text-body">
                  <Trans>Nothing stands in the way.</Trans>
                </p>
              ) : null}
              {pagesOff ? (
                <div data-testid="publish-pages-off" className="flex min-w-0 flex-col gap-1.5">
                  <NoPublicPages reason={status.reason} />
                  <p className="text-sm text-body">
                    <Trans>
                      Publishing still works: it records this version as the one to show. Visitors
                      reach it once public pages are on.
                    </Trans>
                  </p>
                </div>
              ) : null}
              {page.canPublish ? null : (
                <p className="text-sm text-muted-foreground">
                  <Trans>You can look at this. Publishing needs permission to publish sites.</Trans>
                </p>
              )}
            </>
          )}
          {said === undefined ? null : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {said}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              disabled={publish.isPending}
              onClick={() => {
                onClose();
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
            {page === undefined && !current.isPending ? (
              <Button
                onClick={() => {
                  setAsked((count) => count + 1);
                }}
              >
                <Trans>Check again</Trans>
              </Button>
            ) : (
              <Button
                disabled={
                  page === undefined || blocking.length > 0 || publish.isPending || !page.canPublish
                }
                onClick={() => {
                  if (page === undefined) return;
                  setSaid(undefined);
                  setRefused([]);
                  publish.mutate(page);
                }}
              >
                {publish.isPending ? <Trans>Publishing…</Trans> : <Trans>Publish</Trans>}
              </Button>
            )}
          </div>
        </>
      )}
    </SmallDialog>
  );
}

/** Unpublish: asks first, since the page stops answering at once. */
export function UnpublishDialog({
  page,
  onChanged,
  returnFocus,
  onClose,
}: {
  readonly page: { readonly id: string; readonly revision?: number };
  readonly onChanged: (page: SitePage) => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [problem, setProblem] = useState<string>();
  const unpublish = useMutation({
    mutationFn: async () => {
      // The funnel's page knows a page only in brief: its revision is read here.
      const revision =
        page.revision ?? (await api.request(getSitePage, { params: { id: page.id } })).revision;
      return api.request(unpublishSitePage, { params: { id: page.id }, body: { revision } });
    },
    onSuccess: (unpublished) => {
      onChanged(unpublished);
      onClose();
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t`The page changed meanwhile. Try again.`
          : error instanceof ApiError && error.status === 403
            ? t`You need permission to publish sites.`
            : t`It wasn't unpublished. Check your connection and try again.`,
      );
    },
  });
  return (
    <ConfirmDialog
      open
      title={<Trans>Unpublish page</Trans>}
      description={
        <Trans>
          The page stops answering at its address at once: visitors get "not found". Its content and
          its versions stay, and it can be published again.
        </Trans>
      }
      confirmLabel={t`Unpublish`}
      destructive
      busy={unpublish.isPending}
      problem={problem}
      returnFocus={returnFocus}
      onClose={onClose}
      onConfirm={() => {
        setProblem(undefined);
        unpublish.mutate();
      }}
    />
  );
}
