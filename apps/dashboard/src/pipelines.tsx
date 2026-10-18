// The Pipelines page (laid out as GoHighLevel's): the list of pipelines, with a dialog that
// creates one or edits one and its stages. It is shown in two places, as GoHighLevel shows
// it: the Pipelines tab of Opportunities and Settings → Opportunities & Pipelines. The list
// is the server's whole configuration, read and saved under one revision; the search is
// done here, since the server has none. Which dialog is open is in the address, so a reload
// opens it again and Back closes it.
//
// A row's menu also moves the pipeline to a chosen position, duplicates it and deletes it,
// each by its own request under the same revision. The server deletes only a pipeline that
// holds no opportunity and never held one, and says so otherwise.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  deletePipeline,
  duplicatePipeline,
  getPipelines,
  movePipeline,
  savePipelines,
  type Pipeline,
  type PipelineConfiguration,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';

import { apiIn } from './api';
import { ListSearch } from './list-toolbar';
import { copyOf, matching, toInput, withArchived, withMoved } from './pipeline-rules';
import type { PipelinesNavigate, PipelinesSearch } from './pipelines-search';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  isStale,
  listCardClassName,
  ListProblem,
  retryFaults,
  RowMenu,
  SmallDialog,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const PipelineDialog = lazy(() => import('./pipeline-dialog'));

export const pipelinesKey = (businessId: string): readonly string[] => ['pipelines', businessId];

/** What a change made from a row's menu is, so the page can say it happened. */
type RowChange =
  | { readonly kind: 'move'; readonly pipeline: Pipeline; readonly offset: -1 | 1 }
  | { readonly kind: 'position'; readonly pipeline: Pipeline; readonly position: number }
  | { readonly kind: 'archive' | 'restore' | 'duplicate' | 'delete'; readonly pipeline: Pipeline };

/** Asks which place a pipeline should take, counted from 1 as the list counts. */
function PositionDialog({
  pipeline,
  position,
  count,
  busy,
  problem,
  returnFocus,
  onMove,
  onClose,
}: {
  readonly pipeline: Pipeline;
  /** Where it is now. */
  readonly position: number;
  /** How many pipelines there are. */
  readonly count: number;
  readonly busy: boolean;
  readonly problem: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onMove: (position: number) => void;
  readonly onClose: () => void;
}): ReactElement {
  const id = useId();
  const name = pipeline.name;
  const [typed, setTyped] = useState(String(position));
  const wanted = Number(typed);
  const valid = Number.isInteger(wanted) && wanted >= 1 && wanted <= count;
  return (
    <SmallDialog
      open
      onClose={onClose}
      title={<Trans>Move {name} to a position</Trans>}
      description={
        <Trans>
          It is at position {position} of {count}.
        </Trans>
      }
      returnFocus={returnFocus}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) onMove(wanted);
        }}
      >
        <Field>
          <FieldLabel htmlFor={id}>
            <Trans>Position</Trans>
          </FieldLabel>
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={1}
            max={count}
            step={1}
            required
            value={typed}
            disabled={busy}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </Field>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={!valid || busy || wanted === position}>
            <Trans>Move</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

export function PipelinesPage({
  opened,
  navigate,
}: {
  /** What the address says is open: the dialog that creates, or the one that edits. */
  readonly opened: PipelinesSearch;
  readonly navigate: PipelinesNavigate;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const cache = useQueryClient();
  const router = useRouter();
  const key = pipelinesKey(business.id);
  const current = useQuery({
    queryKey: key,
    queryFn: () => client.request(getPipelines, {}),
    retry: retryFaults,
  });
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [archiving, setArchiving] = useState<Pipeline>();
  const [deleting, setDeleting] = useState<Pipeline>();
  const [positioning, setPositioning] = useState<Pipeline>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const change = useMutation({
    mutationFn: (input: RowChange & { readonly configuration: PipelineConfiguration }) => {
      const { configuration, pipeline } = input;
      const params = { id: pipeline.id };
      const revision = configuration.revision;
      if (input.kind === 'position')
        return client.request(movePipeline, {
          params,
          body: { position: input.position, revision },
        });
      if (input.kind === 'duplicate')
        return client.request(duplicatePipeline, { params, body: { revision } });
      if (input.kind === 'delete')
        return client.request(deletePipeline, { params, body: { revision } });
      const items =
        input.kind === 'move'
          ? withMoved(configuration.items, pipeline.id, input.offset)
          : withArchived(configuration.items, pipeline.id, input.kind === 'archive');
      return client.request(savePipelines, { body: toInput(items, configuration.revision) });
    },
    onSuccess: (configuration, input) => {
      cache.setQueryData(key, configuration);
      const name = input.pipeline.name;
      const position = configuration.items.findIndex((item) => item.id === input.pipeline.id) + 1;
      const copy = copyOf(input.configuration.items, configuration.items)?.name ?? '';
      setArchiving(undefined);
      setDeleting(undefined);
      setPositioning(undefined);
      setNotice(
        input.kind === 'move' || input.kind === 'position'
          ? t`${name} moved to position ${position}.`
          : input.kind === 'archive'
            ? t`${name} archived.`
            : input.kind === 'restore'
              ? t`${name} restored.`
              : input.kind === 'duplicate'
                ? t`${name} duplicated as ${copy}.`
                : t`${name} deleted.`,
      );
    },
    onError: (_failure, input) => {
      // A delete is refused with the same answer for a pipeline that holds opportunities and
      // for a list someone else changed, so the list is read again and the dialog says both.
      if (input.kind === 'delete') void cache.invalidateQueries({ queryKey: key });
    },
  });
  const refusedDelete = change.variables?.kind === 'delete' && isStale(change.error);
  const stale = isStale(change.error) && !refusedDelete;
  const refusal =
    change.error instanceof ApiError && change.error.status === 422
      ? (change.error.problem.errors?.find((issue) => issue.message.trim() !== '')?.message ??
        change.error.problem.detail)
      : undefined;
  const changeProblem = !change.isError
    ? undefined
    : refusedDelete
      ? t`This pipeline wasn't deleted. A pipeline that holds opportunities, also in the trash, or that an opportunity ever passed through can't be deleted: archive it instead. The list was reloaded in case someone else changed it.`
      : stale
        ? t`Someone else changed the pipelines. Reload them, then try again.`
        : (refusal ?? t`The change wasn't saved. Check your connection and try again.`);
  const inDialog = archiving !== undefined || deleting !== undefined || positioning !== undefined;

  // Closing goes back to the list as it was when the dialog was opened from it and that is
  // the entry before this one; an address opened by itself just loses what it had open.
  const openKey = opened.mode ?? opened.pipeline;
  const historyIndex = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const listIndexRef = useRef<number>(undefined);
  const openedFromListRef = useRef<string>(undefined);
  const previousKeyRef = useRef(openKey);
  useEffect(() => {
    if (openKey === undefined) listIndexRef.current = historyIndex;
    if (openKey !== previousKeyRef.current)
      openedFromListRef.current = previousKeyRef.current === undefined ? openKey : undefined;
    previousKeyRef.current = openKey;
  }, [openKey, historyIndex]);
  const close = (ignoreBlocker = false) => {
    if (
      openKey !== undefined &&
      openedFromListRef.current === openKey &&
      listIndexRef.current === historyIndex - 1
    )
      router.history.back({ ignoreBlocker });
    else navigate({}, { replace: true, ignoreBlocker });
  };
  const open = (next: PipelinesSearch, trigger: HTMLElement | null) => {
    returnFocusRef.current = trigger;
    setNotice('');
    change.reset();
    navigate(next);
  };

  const configuration = current.data;
  const canManage = configuration?.canManage === true;
  const items = configuration?.items ?? [];
  const rows = matching(items, search);
  const editing = items.find((item) => item.id === opened.pipeline);
  const missing = configuration !== undefined && opened.pipeline !== undefined && !editing;
  const dialogOpen =
    configuration !== undefined && (opened.mode === 'create' ? canManage : editing !== undefined);
  const archivingName = archiving?.name ?? '';
  const deletingName = deleting?.name ?? '';
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Page
      title={t`Pipelines`}
      actions={
        canManage ? (
          <Button
            onClick={(event) => {
              open({ mode: 'create' }, event.currentTarget);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>Create pipeline</Trans>
          </Button>
        ) : undefined
      }
    >
      <p className="text-md text-muted-foreground">
        <Trans>Use pipelines to track opportunities and sales progress across stages.</Trans>
      </p>
      <p role="status" className="text-sm empty:sr-only">
        {change.isPending ? t`Saving…` : notice}
      </p>
      {configuration !== undefined && !canManage ? (
        <p className="text-md text-muted-foreground">
          <Trans>Only someone with permission can change pipelines and stages.</Trans>
        </p>
      ) : null}
      {missing ? (
        <p role="alert" className="text-sm">
          <Trans>That pipeline can't be opened. It may belong to another business.</Trans>
        </p>
      ) : null}
      {changeProblem === undefined || inDialog ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-destructive">{changeProblem}</span>
          {stale ? (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                change.reset();
                void current.refetch();
              }}
            >
              <Trans>Reload pipelines</Trans>
            </Button>
          ) : null}
        </div>
      )}
      <section aria-label={t`Pipelines`} className={listCardClassName}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ListSearch label={t`Search pipelines`} value={search} onChange={setSearch} />
        </div>
        {current.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading pipelines…</Trans>
          </p>
        ) : null}
        {/* A list that didn't load is not an empty list: it says so, and nothing else. */}
        {current.isError ? (
          <ListProblem
            onRetry={() => {
              void current.refetch();
            }}
          >
            <Trans>We couldn't load the pipelines.</Trans>
          </ListProblem>
        ) : null}
        {configuration !== undefined && !current.isError && rows.length === 0 ? (
          <p className="py-6 text-center text-md text-muted-foreground">
            {items.length > 0 ? (
              <Trans>No pipelines match.</Trans>
            ) : canManage ? (
              <Trans>No pipelines yet. Create one to organize your opportunities.</Trans>
            ) : (
              <Trans>No pipelines yet.</Trans>
            )}
          </p>
        ) : null}
        {current.isError || rows.length === 0 ? null : (
          <div role="region" aria-label={t`Pipelines table`} className={tableRegionClassName}>
            <table className={`${tableClassName} table-fixed`}>
              <caption className="sr-only">
                <Trans>Pipelines</Trans>
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={`${headerCellClassName} w-12`}>
                    <span aria-hidden>#</span>
                    <span className="sr-only">
                      <Trans>Position</Trans>
                    </span>
                  </th>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Pipeline name</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-28 sm:w-40`}>
                    <Trans>Total stages</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} hidden w-48 md:table-cell`}>
                    <Trans>Updated on</Trans>
                  </th>
                  {canManage ? (
                    <th scope="col" className={`${headerCellClassName} w-16 sm:w-24`}>
                      <span className="max-sm:sr-only">
                        <Trans>Actions</Trans>
                      </span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ pipeline, position }) => {
                  const name = pipeline.name;
                  const active = pipeline.stages.filter((stage) => !stage.archived).length;
                  const archived = pipeline.stages.length - active;
                  return (
                    <tr key={pipeline.id} className="hover:bg-muted">
                      <td className={`${cellClassName} text-muted-foreground`}>{position}</td>
                      <th scope="row" className={`${cellClassName} text-left font-medium`}>
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <button
                            type="button"
                            className="-mx-1.5 inline-flex min-h-11 min-w-0 items-center rounded-control px-1.5 text-left font-medium wrap-anywhere text-foreground -outline-offset-2 hover:text-link hover:underline lg:min-h-8"
                            onClick={(event) => {
                              open({ pipeline: pipeline.id }, event.currentTarget);
                            }}
                          >
                            {name}
                          </button>
                          {pipeline.archived ? (
                            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                              <Trans>Archived</Trans>
                            </span>
                          ) : null}
                        </span>
                      </th>
                      <td className={cellClassName}>
                        {active}
                        {archived === 0 ? null : (
                          <span className="text-muted-foreground">
                            {' '}
                            <Trans>(+{archived} archived)</Trans>
                          </span>
                        )}
                      </td>
                      <td className={`${cellClassName} hidden md:table-cell`}>
                        {pipeline.updatedAt === undefined ? (
                          '—'
                        ) : (
                          <time dateTime={pipeline.updatedAt}>
                            {dates.format(new Date(pipeline.updatedAt))}
                          </time>
                        )}
                      </td>
                      {canManage ? (
                        <td className={cellClassName}>
                          <RowMenu
                            label={t`Actions for ${name}`}
                            onOpen={(trigger) => {
                              returnFocusRef.current = trigger;
                            }}
                            actions={[
                              {
                                label: t`Edit`,
                                onSelect: () => {
                                  open({ pipeline: pipeline.id }, returnFocusRef.current);
                                },
                              },
                              ...(position > 1
                                ? [
                                    {
                                      label: t`Move up`,
                                      immediate: true,
                                      onSelect: () => {
                                        setNotice('');
                                        change.mutate({
                                          kind: 'move',
                                          pipeline,
                                          offset: -1,
                                          configuration,
                                        });
                                      },
                                    },
                                  ]
                                : []),
                              ...(position < items.length
                                ? [
                                    {
                                      label: t`Move down`,
                                      immediate: true,
                                      onSelect: () => {
                                        setNotice('');
                                        change.mutate({
                                          kind: 'move',
                                          pipeline,
                                          offset: 1,
                                          configuration,
                                        });
                                      },
                                    },
                                  ]
                                : []),
                              ...(items.length > 1
                                ? [
                                    {
                                      label: t`Move to position`,
                                      onSelect: () => {
                                        setNotice('');
                                        change.reset();
                                        setPositioning(pipeline);
                                      },
                                    },
                                  ]
                                : []),
                              {
                                label: t`Duplicate`,
                                immediate: true,
                                onSelect: () => {
                                  setNotice('');
                                  change.mutate({ kind: 'duplicate', pipeline, configuration });
                                },
                              },
                              pipeline.archived
                                ? {
                                    label: t`Restore`,
                                    immediate: true,
                                    onSelect: () => {
                                      setNotice('');
                                      change.mutate({ kind: 'restore', pipeline, configuration });
                                    },
                                  }
                                : {
                                    label: t`Archive`,
                                    onSelect: () => {
                                      setNotice('');
                                      change.reset();
                                      setArchiving(pipeline);
                                    },
                                  },
                              {
                                label: t`Delete`,
                                destructive: true,
                                onSelect: () => {
                                  setNotice('');
                                  change.reset();
                                  setDeleting(pipeline);
                                },
                              },
                            ]}
                          />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ConfirmDialog
        open={archiving !== undefined}
        title={<Trans>Archive {archivingName}?</Trans>}
        description={
          <Trans>
            It stops being offered for new opportunities. Its opportunities and history stay intact,
            and you can restore it at any time.
          </Trans>
        }
        confirmLabel={t`Archive pipeline`}
        busy={change.isPending}
        problem={changeProblem}
        returnFocus={returnFocusRef}
        onConfirm={() => {
          if (archiving !== undefined && configuration !== undefined)
            change.mutate({ kind: 'archive', pipeline: archiving, configuration });
        }}
        onClose={() => {
          setArchiving(undefined);
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        title={<Trans>Delete {deletingName}?</Trans>}
        description={
          <Trans>
            The pipeline and its stages are removed for good. Only a pipeline that holds no
            opportunity and never held one can be deleted; any other can be archived.
          </Trans>
        }
        confirmLabel={t`Delete pipeline`}
        destructive
        busy={change.isPending}
        problem={changeProblem}
        returnFocus={returnFocusRef}
        onConfirm={() => {
          // The list may have been read again since the dialog opened: the revision is its.
          if (deleting !== undefined && configuration !== undefined)
            change.mutate({ kind: 'delete', pipeline: deleting, configuration });
        }}
        onClose={() => {
          change.reset();
          setDeleting(undefined);
        }}
      />
      {positioning === undefined || configuration === undefined ? null : (
        <PositionDialog
          key={positioning.id}
          pipeline={positioning}
          position={items.findIndex((item) => item.id === positioning.id) + 1}
          count={items.length}
          busy={change.isPending}
          problem={changeProblem}
          returnFocus={returnFocusRef}
          onMove={(position) => {
            change.mutate({ kind: 'position', pipeline: positioning, position, configuration });
          }}
          onClose={() => {
            change.reset();
            setPositioning(undefined);
          }}
        />
      )}
      {dialogOpen ? (
        <Suspense fallback={null}>
          <PipelineDialog
            key={opened.pipeline ?? 'create'}
            configuration={configuration}
            pipeline={editing}
            businessId={business.id}
            returnFocus={returnFocusRef}
            onClose={() => {
              close();
            }}
            onSaved={(saved, created) => {
              cache.setQueryData(key, saved);
              setNotice(created ? t`Pipeline created.` : t`Pipeline saved.`);
              close(true);
            }}
          />
        </Suspense>
      ) : null}
    </Page>
  );
}
