// Version history: every version that was published, newest first, with when, by what kind
// of actor and the note written then. Choosing one shows, in words, what restoring it would
// change in the draft being edited, and restoring saves that version's document as the
// draft: it publishes nothing, and running contacts stay on the version they began on.
//
// The API lists versions and reads one; it has no "restore". Restoring is the ordinary draft
// save, with the draft version it started from, so a save made meanwhile is never overwritten.
//
// Its own chunk, loaded when the history is first asked for.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getAutomationVersion,
  listAutomationVersions,
  replaceAutomationDraft,
  type AutomationDraftSaved,
  type AutomationSetup,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { publishChanges, type Change } from './automation-changes';
import { AutomationDialog } from './automation-dialog';
import { isRecord, type Draft } from './automation-document';
import { momentWords } from './automation-run-words';
import { useBusiness } from './workspace';

export interface VersionsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly automationId: string;
  /** The version new contacts start on, if any. */
  readonly liveVersion: number | undefined;
  /** The draft as it is on screen, saved or not: what a restore would replace. */
  readonly draft: Draft;
  /** The saved draft's version: a restore is refused if someone has saved since. */
  readonly baseDraftVersion: number;
  readonly unsaved: boolean;
  readonly canManage: boolean;
  readonly setup: AutomationSetup;
  readonly onRestored: (saved: AutomationDraftSaved, version: number) => void;
  /** Someone else saved the draft meanwhile. */
  readonly onConflict: () => void;
}

/** Who published, as far as the API says: the kind of actor, never a name. */
function PublishedBy({ kind }: { readonly kind: string }): ReactElement {
  if (kind === 'user') return <Trans>Published by a team member</Trans>;
  if (kind === 'api_key') return <Trans>Published by an app, through the API</Trans>;
  if (kind === 'ai_agent') return <Trans>Published by the assistant</Trans>;
  return <Trans>Published by the system</Trans>;
}

function ChangeLine({ change }: { readonly change: Change }): ReactElement {
  const { t } = useLingui();
  const kind =
    change.kind === 'added' ? t`Added` : change.kind === 'removed' ? t`Removed` : t`Changed`;
  const reads = change.kind === 'removed' ? change.before : change.after;
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-2xl bg-background px-4 py-3">
      <p className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <Badge>{kind}</Badge>
        <span className="min-w-0 wrap-anywhere">{change.title}</span>
      </p>
      {change.kind === 'changed' && change.before !== undefined && change.before !== reads ? (
        <p className="text-sm wrap-anywhere text-muted-foreground line-through">{change.before}</p>
      ) : null}
      {reads === undefined ? null : <p className="text-md wrap-anywhere">{reads}</p>}
      {change.details.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col gap-0.5 text-sm text-body">
          {change.details.map((detail) => {
            const { label } = detail;
            const before = detail.before ?? t`Not set`;
            const after = detail.after ?? t`Not set`;
            return (
              <li key={label} className="wrap-anywhere">
                <Trans>
                  {label}: {before} → {after}
                </Trans>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export default function VersionsDialog({
  open,
  onOpenChange,
  automationId,
  liveVersion,
  draft,
  baseDraftVersion,
  unsaved,
  canManage,
  setup,
  onRestored,
  onConflict,
}: VersionsDialogProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const [chosen, setChosen] = useState<number>();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();

  const versions = useInfiniteQuery({
    queryKey: ['b', business.id, 'automation-versions', automationId, liveVersion ?? 0],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      client.request(listAutomationVersions, {
        params: { id: automationId },
        query: pageParam === 0 ? {} : { after: pageParam },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
  });
  const items = versions.data?.pages.flatMap((page) => page.items) ?? [];

  const version = useQuery({
    queryKey: ['b', business.id, 'automation-version', automationId, chosen],
    queryFn: () =>
      client.request(getAutomationVersion, { params: { id: automationId, version: chosen ?? 1 } }),
    enabled: open && chosen !== undefined,
    staleTime: Infinity,
  });
  const document = version.data?.document;
  // From the draft to the version: what the draft would gain, lose and have changed.
  const changes = useMemo(
    () => (isRecord(document) ? publishChanges(draft, document, setup) : undefined),
    [document, draft, setup],
  );

  const confirmed = chosen ?? 0;
  const restore = useMutation({
    mutationFn: (to: { readonly version: number; readonly document: Draft }) =>
      client.request(replaceAutomationDraft, {
        params: { id: automationId },
        body: { baseDraftVersion, document: { ...to.document } },
      }),
    onSuccess: (saved, to) => {
      setConfirming(false);
      setChosen(undefined);
      onRestored(saved, to.version);
      onOpenChange(false);
    },
    onError: (error) => {
      setConfirming(false);
      if (error instanceof ApiError && error.status === 409) {
        onConflict();
        onOpenChange(false);
        return;
      }
      setProblem(
        !(error instanceof ApiError)
          ? t`We couldn't restore that version. Check your connection and try again.`
          : error.status === 403
            ? t`You don't have permission to change workflows.`
            : (error.problem.errors?.[0]?.message ??
              error.problem.detail ??
              t`We couldn't restore that version. Try again.`),
      );
    },
  });

  return (
    <>
      <AutomationDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setProblem(undefined);
            setConfirming(false);
          }
          onOpenChange(next);
        }}
        wide
        title={<Trans>Version history</Trans>}
        description={
          <Trans>
            Every version that was published. Contacts already in the workflow finish the version
            they started; restoring one only changes the draft.
          </Trans>
        }
      >
        {versions.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading the versions…</Trans>
          </p>
        ) : null}
        {versions.isError ? (
          <div role="alert" className="flex min-w-0 flex-col items-start gap-2 text-md">
            <p>
              <Trans>We couldn't load the versions.</Trans>
            </p>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void versions.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : null}
        {versions.isSuccess && items.length === 0 ? (
          <p className="text-md text-muted-foreground">
            <Trans>
              This workflow hasn't been published yet. Each time it is published, that version is
              kept here.
            </Trans>
          </p>
        ) : null}
        {items.length === 0 ? null : (
          <ul aria-label={t`Published versions`} className="flex min-w-0 flex-col gap-2">
            {items.map((item) => {
              const number = item.version;
              const when = momentWords(item.publishedAt) ?? item.publishedAt;
              const selected = chosen === number;
              return (
                <li key={item.id} className="min-w-0">
                  <button
                    type="button"
                    data-initial-focus={number === items[0]?.version ? true : undefined}
                    aria-pressed={selected}
                    aria-label={t`Version ${number}, published ${when}`}
                    className="flex w-full min-w-0 flex-col items-start gap-1 rounded-xl border border-border bg-card px-4 py-3 text-left hover:bg-muted aria-pressed:border-primary aria-pressed:bg-accent"
                    onClick={() => {
                      setProblem(undefined);
                      setChosen(selected ? undefined : number);
                    }}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2 text-md font-medium">
                      <Trans>Version {number}</Trans>
                      {number === liveVersion ? (
                        <Badge variant="assistant">
                          <Trans>Live</Trans>
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      <time dateTime={item.publishedAt}>{when}</time> ·{' '}
                      <PublishedBy kind={item.publishedByKind} />
                    </span>
                    <span className="max-w-full text-sm wrap-anywhere text-body">
                      {item.changeSummary === '' ? (
                        <Trans>No note was written.</Trans>
                      ) : (
                        item.changeSummary
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {versions.hasNextPage ? (
          <Button
            variant="secondary"
            size="small"
            className="self-start"
            disabled={versions.isFetchingNextPage}
            onClick={() => {
              void versions.fetchNextPage();
            }}
          >
            <Trans>Show older versions</Trans>
          </Button>
        ) : null}

        {chosen === undefined ? null : (
          <section
            aria-label={t`Version ${chosen} compared with your draft`}
            className="flex min-w-0 flex-col gap-3 border-t border-border pt-4"
          >
            <h3 className="text-md font-medium">
              <Trans>What restoring version {chosen} would change in your draft</Trans>
            </h3>
            {version.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                <Trans>Loading that version…</Trans>
              </p>
            ) : null}
            {version.isError ? (
              <p role="alert" className="text-md">
                <Trans>We couldn't load that version. Choose it again to retry.</Trans>
              </p>
            ) : null}
            {changes === undefined ? null : changes.length === 0 ? (
              <p className="text-md text-muted-foreground">
                <Trans>Nothing: your draft already reads as this version does.</Trans>
              </p>
            ) : (
              <ul className="flex min-w-0 flex-col gap-2">
                {changes.map((change, index) => (
                  <ChangeLine key={`${change.about}:${String(index)}`} change={change} />
                ))}
              </ul>
            )}
            {canManage && changes !== undefined && changes.length > 0 ? (
              <Button
                variant="secondary"
                className="self-start"
                disabled={restore.isPending}
                onClick={() => {
                  setProblem(undefined);
                  setConfirming(true);
                }}
              >
                <Trans>Restore this version as the draft</Trans>
              </Button>
            ) : null}
          </section>
        )}
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive wrap-anywhere">
            {problem}
          </p>
        )}
      </AutomationDialog>

      <AutomationDialog
        open={open && confirming && chosen !== undefined}
        onOpenChange={(next) => {
          if (!next) setConfirming(false);
        }}
        title={<Trans>Restore version {confirmed} as the draft?</Trans>}
        description={
          unsaved ? (
            <Trans>
              The draft becomes what this version was, and your unsaved changes are dropped. Nothing
              is published: the live version stays as it is until you publish.
            </Trans>
          ) : (
            <Trans>
              The draft becomes what this version was. Nothing is published: the live version stays
              as it is until you publish.
            </Trans>
          )
        }
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="quiet"
            onClick={() => {
              setConfirming(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            data-initial-focus
            disabled={restore.isPending}
            onClick={() => {
              if (chosen !== undefined && isRecord(document))
                restore.mutate({ version: chosen, document });
            }}
          >
            <Trans>Restore as the draft</Trans>
          </Button>
        </div>
      </AutomationDialog>
    </>
  );
}
