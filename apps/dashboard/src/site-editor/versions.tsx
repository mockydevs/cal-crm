// A page's versions. The editor saves by itself into one
// working draft; a version is kept when someone saves one on purpose here (with a name, if
// they like), publishes or restores; thirty are kept. The panel lists the three kinds apart
// (version-rules.ts), says when each was saved and by whom, and lets one be looked at as a
// visitor would see it, without changing anything, or saved again as the newest version,
// which never changes the live page.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getSitePageVersion,
  listSitePageVersions,
  restoreSitePageVersion,
  saveSitePageDraft,
  type PageDocument,
  type SitePage,
  type SitePageVersionList,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { renderPage } from '@repo/site-render';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';
import {
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { apiIn } from '../api';
import { ConfirmDialog, retryFaults, returnTo } from '../settings-list';
import { FitWidth } from '../site-publish';
import { useBusiness } from '../workspace';
import { DEVICE_WIDTH, type Device } from './device';
import {
  groupVersions,
  kindOf,
  nameOf,
  VERSION_NAME_MAX,
  versionNameOf,
  writtenAt,
} from './version-rules';

type Version = SitePageVersionList['items'][number];

/**
 * A page drawn by the published page's own renderer, to look at and nothing more: the
 * frame runs no script and reaches nothing of the dashboard. What a published page shows
 * through something of the business's own is not drawn: a form (a script draws it), a
 * calendar's button (it links to the calendar's booking page) and custom code. A countdown
 * shows the time left as it is now, and does not tick here.
 */
export function PageRender({
  document,
  title,
  device,
}: {
  readonly document: PageDocument;
  readonly title: string;
  readonly device: Device;
}): ReactElement {
  // Read once: what a countdown shows is decided when the page is drawn.
  const [now] = useState(() => Date.now());
  const html = useMemo(
    () =>
      renderPage(document, {
        siteBase: '',
        title,
        index: false,
        preview: true,
        steps: new Map(),
        sections: new Map(),
        forms: new Map(),
        formScriptUrl: '',
        calendars: new Map(),
        now,
      })?.html,
    [document, title, now],
  );
  if (html === undefined)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        <Trans>This is a code page, which can't be shown here yet.</Trans>
      </p>
    );
  return (
    <FitWidth width={DEVICE_WIDTH[device]} className="bg-muted" testId="page-render">
      <iframe title={title} sandbox="" srcDoc={html} className="size-full border-0" />
    </FitWidth>
  );
}

const sheetClassName =
  'fixed inset-y-0 right-0 z-[65] flex w-[min(720px,100vw)] flex-col overflow-hidden bg-card text-card-foreground shadow-xl outline-none';

/** What saving what is being edited first came to: why it could not, or the page as saved. */
export type Prepared = { readonly problem: string } | { readonly page: SitePage };

const badgeClassName = 'rounded-full px-2 py-0.5 text-xs font-medium';

export function VersionsDialog({
  page,
  device,
  prepare,
  onRestored,
  onKept,
  returnFocus,
  onClose,
}: {
  readonly page: SitePage;
  readonly device: Device;
  /** Saves what is being edited first, and answers with the page as the server now has it. */
  readonly prepare: () => Promise<Prepared>;
  readonly onRestored: (page: SitePage) => void;
  /** Hears that the page as saved was kept as a version on purpose. */
  readonly onKept: (page: SitePage) => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [viewing, setViewing] = useState<number>();
  const [asking, setAsking] = useState<Version>();
  const [problem, setProblem] = useState<string>();
  const [name, setName] = useState('');
  const [kept, setKept] = useState<{ readonly said: string; readonly failed: boolean }>();
  const restoreRef = useRef<HTMLElement | null>(null);
  const versions = useQuery({
    // An autosave leaves the version's number as it is and moves the page's revision.
    queryKey: ['b', business.id, 'sites', 'versions', page.id, page.currentVersion, page.revision],
    queryFn: () => api.request(listSitePageVersions, { params: { id: page.id } }),
    retry: retryFaults,
  });
  const shown = useQuery({
    queryKey: ['b', business.id, 'sites', 'version', page.id, viewing, page.revision],
    queryFn: () =>
      api.request(getSitePageVersion, { params: { id: page.id, version: viewing ?? 1 } }),
    enabled: viewing !== undefined,
    retry: retryFaults,
  });
  const restore = useMutation({
    mutationFn: async (version: Version) => {
      const ready = await prepare();
      if ('problem' in ready) throw new Error(ready.problem);
      return api.request(restoreSitePageVersion, {
        params: { id: page.id },
        body: { revision: ready.page.revision, version: version.number },
      });
    },
    onSuccess: (restored) => {
      setAsking(undefined);
      onRestored(restored);
      onClose();
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? error.status === 409
            ? t`The page changed meanwhile. Close this and try again.`
            : (error.problem.detail ?? t`It wasn't restored. Check your connection and try again.`)
          : error.message,
      );
    },
  });
  const keep = useMutation({
    mutationFn: async (typed: string) => {
      const ready = await prepare();
      if ('problem' in ready) throw new Error(ready.problem);
      const chosen = versionNameOf(typed);
      // Not an autosave: the page as it stands is kept as a version that nothing rewrites.
      return api.request(saveSitePageDraft, {
        params: { id: page.id },
        body: {
          baseVersion: ready.page.currentVersion,
          revision: ready.page.revision,
          document: ready.page.document,
          ...(chosen === undefined ? {} : { name: chosen }),
        },
      });
    },
    onSuccess: (saved, typed) => {
      const number = saved.currentVersion;
      const chosen = versionNameOf(typed);
      setName('');
      setKept({
        said:
          chosen === undefined
            ? t`Kept as version ${number}.`
            : t`Kept as version ${number}, "${chosen}".`,
        failed: false,
      });
      onKept(saved);
    },
    onError: (error) => {
      setKept({
        said:
          error instanceof ApiError
            ? error.status === 409
              ? t`The page changed meanwhile. Close this and try again.`
              : (error.problem.errors?.[0]?.message ??
                error.problem.detail ??
                t`The version wasn't kept. Check your connection and try again.`)
            : error.message,
        failed: true,
      });
    },
  });
  const when = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const authorOf = (version: Version): string =>
    version.createdBy.name ??
    (version.createdBy.kind === 'assistant'
      ? t`The assistant`
      : version.createdBy.kind === 'api'
        ? t`An app`
        : t`Someone`);
  const askedNumber = asking?.number ?? 0;
  const groups = groupVersions(versions.data?.items ?? []);
  const row = (version: Version): ReactElement => {
    const number = version.number;
    const author = authorOf(version);
    const from = version.restoredFrom ?? 0;
    const named = nameOf(version);
    const kind = kindOf(version);
    return (
      <li
        key={number}
        data-kind={kind}
        className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-control border border-border px-3 py-2"
      >
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
          <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
            {named === undefined ? (
              <Trans>Version {number}</Trans>
            ) : (
              <span className="min-w-0 wrap-anywhere">{named}</span>
            )}
            {version.current ? (
              <span className={`${badgeClassName} bg-secondary text-secondary-foreground`}>
                <Trans>Newest</Trans>
              </span>
            ) : null}
            {version.published ? (
              <span
                className={`${badgeClassName} border border-success-line bg-success-subtle text-success`}
              >
                <Trans>Live</Trans>
              </span>
            ) : null}
          </p>
          <p className="text-xs wrap-anywhere text-muted-foreground">
            {named === undefined ? null : (
              <>
                <Trans>Version {number}</Trans>
                {' · '}
              </>
            )}
            {when.format(new Date(writtenAt(version)))} · {author}
            {version.restoredFrom === null ? null : (
              <>
                {' · '}
                <Trans>a copy of version {from}</Trans>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="small"
            aria-label={t`Look at version ${number}`}
            onClick={() => {
              setViewing(number);
            }}
          >
            <Trans>View</Trans>
          </Button>
          {version.current || !page.canManage ? null : (
            <Button
              variant="secondary"
              size="small"
              aria-label={t`Restore version ${number}`}
              onClick={(event) => {
                restoreRef.current = event.currentTarget;
                setProblem(undefined);
                setAsking(version);
              }}
            >
              <Trans>Restore</Trans>
            </Button>
          )}
        </div>
      </li>
    );
  };
  const group = (
    testId: string,
    title: ReactNode,
    about: ReactNode,
    items: readonly Version[],
  ): ReactElement | null =>
    items.length === 0 ? null : (
      <section data-testid={testId} className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">{about}</p>
        </div>
        <ol className="flex min-w-0 flex-col gap-2">{items.map(row)}</ol>
      </section>
    );
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !restore.isPending && !keep.isPending) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        <Dialog.Popup className={sheetClassName} finalFocus={returnTo(returnFocus)}>
          <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {viewing === undefined ? null : (
                <Button
                  variant="quiet"
                  size="small"
                  className="px-2.5"
                  aria-label={t`Back to the list of versions`}
                  onClick={() => {
                    setViewing(undefined);
                  }}
                >
                  <ArrowLeft aria-hidden className="size-5" strokeWidth={1.8} />
                </Button>
              )}
              <Dialog.Title className="text-base font-medium">
                {viewing === undefined ? (
                  <Trans>Versions</Trans>
                ) : (
                  <Trans>Version {viewing}, to look at</Trans>
                )}
              </Dialog.Title>
            </div>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          {viewing !== undefined ? (
            shown.data === undefined ? (
              <p role="status" className="p-4 text-sm text-muted-foreground">
                {shown.isError ? (
                  <Trans>The version couldn't be loaded. Go back and try again.</Trans>
                ) : (
                  <Trans>Loading…</Trans>
                )}
              </p>
            ) : (
              <>
                <Dialog.Description className="px-4 py-2 text-sm text-muted-foreground">
                  <Trans>
                    As a visitor would see it. Forms, calendar buttons and custom code are not drawn
                    here. Nothing you do here changes the page.
                  </Trans>
                </Dialog.Description>
                <PageRender
                  document={shown.data.document}
                  title={t`Version ${viewing} of the page`}
                  device={device}
                />
              </>
            )
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              <Dialog.Description className="text-sm text-muted-foreground">
                <Trans>
                  The editor saves your work by itself into one working draft. Keep a version to
                  hold the page as it is now; the newest thirty versions are kept. Restoring one
                  saves a copy of it as the newest version; the live page does not change until you
                  publish.
                </Trans>
              </Dialog.Description>
              {page.canManage ? (
                <form
                  className="flex min-w-0 flex-wrap items-end gap-2 rounded-control border border-border p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setKept(undefined);
                    keep.mutate(name);
                  }}
                >
                  <Field name="versionName" className="min-w-0 flex-1 basis-56 gap-1">
                    <FieldLabel>
                      <Trans>Name for this version (optional)</Trans>
                    </FieldLabel>
                    <Input
                      maxLength={VERSION_NAME_MAX}
                      autoComplete="off"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                      }}
                    />
                  </Field>
                  <Button type="submit" disabled={keep.isPending}>
                    {keep.isPending ? <Trans>Saving…</Trans> : <Trans>Save a version</Trans>}
                  </Button>
                  <p
                    role={kept?.failed === true ? 'alert' : 'status'}
                    data-testid="version-kept"
                    className={`basis-full text-sm empty:hidden ${kept?.failed === true ? 'font-medium text-destructive' : 'text-body'}`}
                  >
                    {kept?.said ?? ''}
                  </p>
                </form>
              ) : null}
              {versions.data === undefined ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {versions.isError ? (
                    <Trans>The versions couldn't be loaded. Close this and try again.</Trans>
                  ) : (
                    <Trans>Loading…</Trans>
                  )}
                </p>
              ) : (
                <>
                  {group(
                    'versions-draft',
                    <Trans>Working draft</Trans>,
                    <Trans>
                      What the editor saves by itself as you work. It is rewritten in place.
                    </Trans>,
                    groups.draft === undefined ? [] : [groups.draft],
                  )}
                  {group(
                    'versions-kept',
                    <Trans>Kept versions</Trans>,
                    <Trans>
                      Saved on purpose, published or restored. Nothing changes them afterwards.
                    </Trans>,
                    groups.kept,
                  )}
                  {group(
                    'versions-checkpoints',
                    <Trans>Automatic checkpoints</Trans>,
                    <Trans>
                      Earlier working drafts, kept as they were when a newer version began.
                    </Trans>,
                    groups.checkpoints,
                  )}
                </>
              )}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
      <ConfirmDialog
        open={asking !== undefined}
        title={<Trans>Restore version {askedNumber}</Trans>}
        description={
          <Trans>
            What you are editing is saved first, so nothing is lost. Then a copy of version{' '}
            {askedNumber} is saved as the newest version and opens here. The live page does not
            change.
          </Trans>
        }
        confirmLabel={t`Restore as the draft`}
        busy={restore.isPending}
        problem={problem}
        returnFocus={restoreRef}
        onClose={() => {
          if (!restore.isPending) setAsking(undefined);
        }}
        onConfirm={() => {
          setProblem(undefined);
          if (asking !== undefined) restore.mutate(asking);
        }}
      />
    </Dialog.Root>
  );
}
