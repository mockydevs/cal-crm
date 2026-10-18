// Marketing → Emails → Templates: the emails workflows and campaigns send, as a library. At
// the left, every template, those in no folder, each folder with how many it holds, then
// Archived and Trash. At
// the right, one slim row of search, filters, order and view over a compact table (or cards
// with a picture of each email), a page at a time. One button adds a designed email, a
// plain-text one or a folder. Ticked templates can be moved, archived or deleted together.
// Deleting moves a template to the trash, where it can be restored; one a published
// workflow sends can't be deleted. Everything the list shows is kept in the address.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  duplicateMessageTemplate,
  listMessageTemplateFolders,
  listMessageTemplates,
  restoreMessageTemplate,
  type BulkMessageTemplatesResult,
  type MessageTemplate,
  type MessageTemplateSummary,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { EmailsNav, InfoTip, LibraryEmpty, NewMenu, NothingMatches } from '../email-library/header';
import { LibraryPanel, type PanelEntry } from '../email-library/panel';
import { folderTree, pageSelection, toggled, withPage } from '../email-library/rules';
import { BulkBar, LibraryToolbar } from '../email-library/table';
import { listCardClassName, ListProblem, useSettled } from '../list-table';
import { type RowAction } from '../email-library/row-menu';
import { LibraryFooter } from '../email-library/footer';
import {
  emptyTrail,
  rangeOf,
  trailBack,
  trailCursor,
  trailForward,
  type PageSize,
} from '../settings-rules';
import { Page } from '../shell/page';
import type { FolderEdit } from '../template-folder-editor';
import { folderLabels } from '../template-folder-rules';
import type { TemplatesSearch } from '../templates-search';
import { useBusiness } from '../workspace';
import type { Opened } from './open';
import { retryRead } from './retry';
import { TemplateTable, type RowProps } from './rows';
import { bulkActionsOf, listQueryOf, placeOf, rowActionsOf, withPlace } from './rules';

const TemplateGrid = lazy(() => import('./grid'));
// A template opens in the page's plain-text form or the popup editor, each fetched when
// first opened.
const OpenPlain = lazy(async () => ({ default: (await import('./open')).OpenPlain }));
const OpenFormatted = lazy(async () => ({ default: (await import('./open')).OpenFormatted }));
const RenameDialog = lazy(async () => ({ default: (await import('./dialogs')).RenameDialog }));
const ArchiveDialog = lazy(async () => ({ default: (await import('./dialogs')).ArchiveDialog }));
const DeleteDialog = lazy(async () => ({ default: (await import('./dialogs')).DeleteDialog }));
const MoveDialog = lazy(async () => ({ default: (await import('./dialogs')).MoveDialog }));
const BulkConfirmDialog = lazy(async () => ({
  default: (await import('./dialogs')).BulkConfirmDialog,
}));
const TemplateFolderEditor = lazy(async () => ({
  default: (await import('../template-folder-editor')).TemplateFolderEditor,
}));

type Asking =
  | {
      readonly kind: 'rename' | 'archive' | 'delete';
      readonly template: MessageTemplateSummary;
    }
  | { readonly kind: 'move'; readonly templates: readonly MessageTemplateSummary[] }
  | {
      readonly kind: 'bulk';
      readonly action: 'archive' | 'delete';
      readonly templates: readonly MessageTemplateSummary[];
    }
  | { readonly kind: 'folder'; readonly edit: FolderEdit };

interface Said {
  readonly text: string;
  /** Takes back what was just done, such as a delete. */
  readonly undo?: (() => void) | undefined;
}

export default function TemplatesPage({
  search,
  onSearch,
}: {
  readonly search: TemplatesSearch;
  /** Changes the address: handed what it holds now, so two quick changes both land. */
  readonly onSearch: (change: (now: TemplatesSearch) => TemplatesSearch) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [opened, setOpened] = useState<Opened>();
  const [asking, setAsking] = useState<Asking>();
  const [said, setSaid] = useState<Said>();
  const [problem, setProblem] = useState<string>();
  const [trail, setTrail] = useState(emptyTrail);
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  // Another list starts at its first page, with nothing ticked.
  const asked = JSON.stringify(search);
  const [shown, setShown] = useState(asked);
  if (shown !== asked) {
    setShown(asked);
    setTrail(emptyTrail);
    setSelected(new Set());
  }

  // What is typed reaches the address once typing pauses; a search the address gets from
  // elsewhere (back, a link) is shown in the box.
  const [text, setText] = useState(search.q ?? '');
  const settled = useSettled(text.trim());
  const [seenQ, setSeenQ] = useState(search.q ?? '');
  if ((search.q ?? '') !== seenQ) {
    setSeenQ(search.q ?? '');
    if ((search.q ?? '') !== settled) setText(search.q ?? '');
  }
  useEffect(() => {
    onSearch((now) => {
      if ((now.q ?? '') === settled) return now;
      const { q: _q, ...rest } = now;
      return settled === '' ? rest : { ...rest, q: settled };
    });
  }, [settled, onSearch]);

  const folders = useQuery({
    queryKey: ['b', business.id, 'message-template-folders'],
    queryFn: () => apiIn(business.id).request(listMessageTemplateFolders, {}),
    retry: retryRead,
  });
  const query = listQueryOf(search, { limit: pageSize, after: trailCursor(trail) });
  const list = useQuery({
    queryKey: ['b', business.id, 'message-templates', query],
    queryFn: () => apiIn(business.id).request(listMessageTemplates, { query }),
    placeholderData: keepPreviousData,
    retry: retryRead,
  });

  const refresh = (): void => {
    void cache.invalidateQueries({ queryKey: ['b', business.id, 'message-templates'] });
    void cache.invalidateQueries({ queryKey: ['b', business.id, 'message-template-folders'] });
  };
  const tell = (next: Said): void => {
    setProblem(undefined);
    setSaid(next);
  };
  const fail = (error: unknown, fallback: string): void => {
    setSaid(undefined);
    setProblem(error instanceof ApiError ? (error.problem.detail ?? fallback) : fallback);
  };

  const restore = useMutation({
    mutationFn: (template: Pick<MessageTemplateSummary, 'id' | 'revision' | 'name'>) =>
      apiIn(business.id).request(restoreMessageTemplate, {
        params: { id: template.id },
        body: { revision: template.revision },
      }),
    onSuccess: (template) => {
      const { name } = template;
      tell({ text: t`${name} restored.` });
      refresh();
      toHeading();
    },
    onError: (error) => {
      fail(error, t`The template could not be restored. Try again.`);
    },
  });
  const duplicate = useMutation({
    mutationFn: (template: MessageTemplateSummary) =>
      apiIn(business.id).request(duplicateMessageTemplate, {
        params: { id: template.id },
        body: {},
      }),
    onSuccess: (copy) => {
      const { name } = copy;
      tell({ text: t`${name} created.` });
      refresh();
    },
    onError: (error) => {
      fail(error, t`The template could not be duplicated. Try again.`);
    },
  });
  const bulkRestore = useMutation({
    mutationFn: async (ids: readonly string[]) =>
      (await import('./dialogs')).requestBulk(business.id, 'restore', ids),
    onSuccess: (result) => {
      afterBulk(result);
    },
    onError: (error) => {
      fail(error, t`Nothing was restored. Try again.`);
    },
  });

  const items = list.data?.items ?? [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const canManage = list.data?.canManage ?? false;
  const folderItems = folders.data?.items ?? [];
  const counts = folders.data?.counts;
  const place = placeOf(search);
  const filtered = search.q !== undefined || search.type !== undefined || search.used !== undefined;

  // What a bulk action came to: how many were changed, and each one left as it was, why.
  function afterBulk(result: BulkMessageTemplatesResult): void {
    const done = result.done + result.unchanged;
    const doneWords = {
      move: plural(done, { one: '# template moved.', other: '# templates moved.' }),
      archive: plural(done, { one: '# template archived.', other: '# templates archived.' }),
      delete: plural(done, {
        one: '# template moved to the trash.',
        other: '# templates moved to the trash.',
      }),
      restore: plural(done, { one: '# template restored.', other: '# templates restored.' }),
    }[result.action];
    const skipped = result.results
      .filter((each) => each.outcome === 'skipped')
      .map((each) => `${byId.get(each.id)?.name ?? each.id}: ${each.reason?.message ?? ''}`);
    const skippedCount = skipped.length;
    tell({
      text:
        skippedCount === 0
          ? doneWords
          : `${doneWords} ${plural(skippedCount, { one: '# left as it was', other: '# left as they were' })}: ${skipped.join(' ')}`,
    });
    setSelected(new Set());
    refresh();
    toHeading();
  }

  // A row that leaves the list (deleted, archived, restored) takes the button that acted on
  // it with it, and the bulk bar goes with the selection: the keyboard goes to the list's
  // heading instead of the page.
  function toHeading(): void {
    openerRef.current = headingRef.current;
    headingRef.current?.focus();
  }
  // Ticks belong to the page showing.
  const toPage = (next: typeof trail): void => {
    setTrail(next);
    setSelected(new Set());
  };

  const ask = (next: Asking, trigger: HTMLElement | null): void => {
    openerRef.current = trigger;
    setProblem(undefined);
    setAsking(next);
  };
  const open = (item: MessageTemplateSummary): void => {
    setOpened(
      item.format === 'html' ? { kind: 'formatted', id: item.id } : { kind: 'saved', id: item.id },
    );
  };
  // The folder a new template or folder goes in: none for every template or those in none.
  const inFolder = search.folder === 'root' ? undefined : search.folder;

  const actionsOf = (item: MessageTemplateSummary): readonly RowAction[] =>
    rowActionsOf(item, canManage).map((key): RowAction => {
      switch (key) {
        case 'open':
          return {
            label: t`Open`,
            onSelect: () => {
              open(item);
            },
          };
        case 'edit':
          return {
            label: t`Edit`,
            onSelect: () => {
              open(item);
            },
          };
        case 'duplicate':
          return {
            label: t`Duplicate`,
            immediate: true,
            onSelect: () => {
              duplicate.mutate(item);
            },
          };
        case 'rename':
          return {
            label: t`Rename`,
            onSelect: () => {
              ask({ kind: 'rename', template: item }, openerRef.current);
            },
          };
        case 'move':
          return {
            label: t`Move to folder`,
            onSelect: () => {
              ask({ kind: 'move', templates: [item] }, openerRef.current);
            },
          };
        case 'archive':
          return {
            label: t`Archive`,
            onSelect: () => {
              ask({ kind: 'archive', template: item }, openerRef.current);
            },
          };
        case 'restore':
          return {
            label: t`Restore`,
            immediate: true,
            onSelect: () => {
              restore.mutate(item);
            },
          };
        case 'delete':
          return {
            label: t`Delete`,
            destructive: true,
            onSelect: () => {
              ask({ kind: 'delete', template: item }, openerRef.current);
            },
          };
      }
    });

  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const rows: RowProps[] = items.map((item) => ({
    item,
    ticked: selected.has(item.id),
    onTick: () => {
      setSelected((now) => toggled(now, item.id));
    },
    actions: actionsOf(item),
    onOpen:
      item.deletedAt === null || item.deletedAt === undefined
        ? () => {
            open(item);
          }
        : undefined,
    onMenu: (trigger) => {
      openerRef.current = trigger;
    },
    when: dates.format(
      new Date(search.show === 'trash' ? (item.deletedAt ?? item.updatedAt) : item.updatedAt),
    ),
  }));
  const pageIds = items.map((item) => item.id);
  const ticked = items.filter((item) => selected.has(item.id));
  const pageTicked = pageSelection(selected, pageIds);

  // The left panel: everything, the folders as they nest, then Archived and Trash.
  const labels = folderLabels(folderItems);
  const folderEntries: PanelEntry[] = folderTree(folderItems).map((folder) => ({
    key: folder.id,
    label: folder.name,
    path: labels.get(folder.id) ?? folder.name,
    count: folder.templateCount,
    depth: folder.depth,
    kind: 'folder',
    ...(folders.data?.canManage === true
      ? {
          actions: [
            {
              label: t`Rename or move folder`,
              onSelect: () => {
                ask({ kind: 'folder', edit: { kind: 'update', folder } }, openerRef.current);
              },
            },
            {
              label: t`Delete folder`,
              destructive: true,
              onSelect: () => {
                ask({ kind: 'folder', edit: { kind: 'remove', folder } }, openerRef.current);
              },
            },
          ],
        }
      : {}),
  }));
  const entries: PanelEntry[] = [
    { key: 'all', label: t`All templates`, count: counts?.all, kind: 'all' },
    { key: 'root', label: t`No folder`, count: counts?.unfiled, kind: 'unfiled' },
    ...folderEntries,
    { key: 'archived', label: t`Archived`, count: counts?.archived, kind: 'archived' },
    { key: 'trash', label: t`Trash`, count: counts?.deleted, kind: 'trash' },
  ];
  const placeName = entries.find((entry) => entry.key === place)?.label ?? t`All templates`;

  const newFolder = (trigger: HTMLElement | null): void => {
    ask({ kind: 'folder', edit: { kind: 'create', parentId: inFolder ?? null } }, trigger);
  };
  const newChoices = canManage
    ? [
        {
          label: t`Designed email`,
          hint: t`Layout, images and buttons, in the email editor`,
          onSelect: () => {
            setOpened({
              kind: 'formatted',
              id: undefined,
              ...(inFolder === undefined ? {} : { folderId: inFolder }),
            });
          },
        },
        {
          label: t`Plain text`,
          hint: t`Text only, like a personal email`,
          onSelect: () => {
            setOpened({ kind: 'new', folderId: inFolder });
          },
        },
        { label: t`Folder`, hint: t`To group templates`, onSelect: newFolder },
      ]
    : [];

  return (
    <Page
      title={t`Email templates`}
      actions={
        <div className="flex flex-1 items-center gap-2">
          <InfoTip label={t`About templates`}>
            <Trans>
              Workflows and campaigns send these emails. Editing a template changes what every
              workflow that sends it sends from then on. Merge fields such as the contact's first
              name are filled in for each contact.
            </Trans>
          </InfoTip>
          <div className="ml-auto">
            <NewMenu label={t`New template`} choices={newChoices} />
          </div>
        </div>
      }
    >
      <EmailsNav slug={business.slug} current="templates" />
      {opened !== undefined && (opened.kind === 'new' || opened.kind === 'saved') ? (
        <Suspense fallback={<p role="status" className="text-sm">{t`Loading the template…`}</p>}>
          <OpenPlain
            key={opened.kind === 'new' ? 'new' : opened.id}
            opened={opened}
            onClose={() => {
              setOpened(undefined);
            }}
            onSaved={refresh}
            onConvert={(draft, id) => {
              setOpened({
                kind: 'convert',
                id,
                folderId: opened.kind === 'new' ? opened.folderId : undefined,
                subject: draft.subject,
                body: draft.body,
              });
            }}
          />
        </Suspense>
      ) : (
        library()
      )}
      {opened !== undefined && (opened.kind === 'formatted' || opened.kind === 'convert') ? (
        <Suspense fallback={null}>
          <OpenFormatted
            key={opened.kind === 'convert' ? `convert:${opened.id ?? 'new'}` : (opened.id ?? 'new')}
            opened={opened}
            onClose={() => {
              setOpened(undefined);
            }}
            onSaved={refresh}
          />
        </Suspense>
      ) : null}
      <Suspense fallback={null}>{dialog()}</Suspense>
    </Page>
  );

  function library(): ReactElement {
    const listed = list.data;
    const bulk = bulkActionsOf(search.show);
    return (
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:gap-4">
        <LibraryPanel
          label={t`Template folders`}
          entries={entries}
          selected={place}
          onSelect={(key) => {
            onSearch((now) => withPlace(now, key));
          }}
          newFolderLabel={t`New folder`}
          onNewFolder={folders.data?.canManage === true ? newFolder : undefined}
          onMenu={(trigger) => {
            openerRef.current = trigger;
          }}
        />
        <section aria-labelledby={headingId} className={`${listCardClassName} min-w-0 flex-1`}>
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="sr-only">
            {placeName}
          </h2>
          <LibraryToolbar
            searchLabel={t`Search templates`}
            search={text}
            onSearch={(value) => {
              setText(value.slice(0, 120));
            }}
            choices={[
              {
                label: t`Type`,
                value: search.type ?? 'all',
                width: 'w-36',
                options: [
                  { value: 'all', label: t`All types` },
                  { value: 'html', label: t`Designed` },
                  { value: 'text', label: t`Plain text` },
                ],
                onChange: (value) => {
                  onSearch(({ type: _type, ...now }) =>
                    value === 'html' || value === 'text' ? { ...now, type: value } : now,
                  );
                },
              },
              {
                label: t`Workflows`,
                value: search.used ?? 'any',
                width: 'w-44',
                options: [
                  { value: 'any', label: t`Any workflow use` },
                  { value: 'yes', label: t`Used in workflows` },
                  { value: 'no', label: t`Not used` },
                ],
                onChange: (value) => {
                  onSearch(({ used: _used, ...now }) =>
                    value === 'yes' || value === 'no' ? { ...now, used: value } : now,
                  );
                },
              },
              {
                label: t`Sort`,
                value: search.sort ?? 'name',
                width: 'w-40',
                options: [
                  { value: 'name', label: t`Name` },
                  { value: 'updated', label: t`Last updated` },
                  { value: 'uses', label: t`Most used` },
                ],
                onChange: (value) => {
                  onSearch(({ sort: _sort, ...now }) =>
                    value === 'updated' || value === 'uses' ? { ...now, sort: value } : now,
                  );
                },
              },
            ]}
            layout={search.layout ?? 'list'}
            onLayout={(layout) => {
              onSearch(({ layout: _layout, ...now }) =>
                layout === 'grid' ? { ...now, layout } : now,
              );
            }}
          />
          {ticked.length === 0 ? null : (
            <BulkBar
              count={ticked.length}
              busy={bulkRestore.isPending}
              onClear={() => {
                setSelected(new Set());
              }}
              actions={bulk.map((key) => {
                switch (key) {
                  case 'move':
                    return {
                      label: t`Move to folder`,
                      onSelect: (trigger) => {
                        ask({ kind: 'move', templates: ticked }, trigger);
                      },
                    };
                  case 'archive':
                    return {
                      label: t`Archive`,
                      onSelect: (trigger) => {
                        ask({ kind: 'bulk', action: 'archive', templates: ticked }, trigger);
                      },
                    };
                  case 'delete':
                    return {
                      label: t`Delete`,
                      destructive: true,
                      onSelect: (trigger) => {
                        ask({ kind: 'bulk', action: 'delete', templates: ticked }, trigger);
                      },
                    };
                  case 'restore':
                    return {
                      label: t`Restore`,
                      onSelect: () => {
                        bulkRestore.mutate(ticked.map((item) => item.id));
                      },
                    };
                }
              })}
            />
          )}
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 text-sm text-body empty:hidden"
          >
            {said === undefined ? null : (
              <>
                <span>{said.text}</span>
                {said.undo === undefined ? null : (
                  <Button size="small" variant="secondary" onClick={said.undo}>
                    <Trans>Undo</Trans>
                  </Button>
                )}
              </>
            )}
          </div>
          {problem === undefined ? null : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {problem}
            </p>
          )}
          {list.isPending ? <p role="status" className="text-sm">{t`Loading templates…`}</p> : null}
          {list.isError ? (
            <ListProblem
              onRetry={() => {
                if (list.error instanceof ApiError && list.error.status === 422)
                  setTrail(emptyTrail);
                void list.refetch();
              }}
            >
              {t`We couldn't load the templates.`}
            </ListProblem>
          ) : null}
          {listed !== undefined && items.length === 0 ? empty() : null}
          {items.length === 0 ? null : search.layout === 'grid' ? (
            <Suspense fallback={<p role="status" className="text-sm">{t`Loading templates…`}</p>}>
              <TemplateGrid rows={rows} canTick={canManage} />
            </Suspense>
          ) : (
            <TemplateTable
              rows={rows}
              page={pageTicked === 'some' ? 'some' : pageTicked === 'all'}
              onTickPage={(on) => {
                setSelected((now) => withPage(now, pageIds, on));
              }}
              whenLabel={search.show === 'trash' ? t`Deleted` : t`Updated`}
              canTick={canManage}
            />
          )}
          {listed === undefined || items.length === 0 ? null : (
            <LibraryFooter
              perPageLabel={t`Templates per page`}
              pageSize={pageSize}
              onPageSize={(size) => {
                setPageSize(size);
                toPage(emptyTrail);
              }}
              range={rangeOf({
                index: trail.index,
                pageSize,
                shown: items.length,
                total: listed.total ?? 0,
              })}
              number={trail.index + 1}
              previous={trail.index > 0}
              next={listed.nextCursor !== null}
              busy={list.isFetching}
              onPrevious={() => {
                toPage(trailBack(trail));
              }}
              onNext={() => {
                toPage(trailForward(trail, listed.nextCursor));
              }}
            />
          )}
        </section>
      </div>
    );
  }

  function empty(): ReactElement {
    if (filtered) return <NothingMatches />;
    if (search.show === 'trash')
      return (
        <LibraryEmpty
          title={<Trans>The trash is empty.</Trans>}
          action={
            <p className="text-sm text-muted-foreground">
              <Trans>Deleted templates wait here until you restore them.</Trans>
            </p>
          }
        />
      );
    if (search.show === 'archived')
      return <LibraryEmpty title={<Trans>No archived templates.</Trans>} action={null} />;
    if (search.folder === 'root')
      return <LibraryEmpty title={<Trans>Every template is in a folder.</Trans>} action={null} />;
    if (search.folder !== undefined)
      return <LibraryEmpty title={<Trans>This folder is empty.</Trans>} action={null} />;
    const [designed] = newChoices;
    return (
      <LibraryEmpty
        title={
          canManage ? (
            <Trans>
              No templates yet. Write an email once, and workflows and campaigns can send it.
            </Trans>
          ) : (
            <Trans>Nobody has written a template yet, and your role can't add one.</Trans>
          )
        }
        action={
          designed === undefined ? null : (
            <Button
              onClick={() => {
                designed.onSelect(null);
              }}
            >
              <Trans>Write the first template</Trans>
            </Button>
          )
        }
      />
    );
  }

  function dialog(): ReactElement | null {
    if (asking === undefined) return null;
    const close = (): void => {
      setAsking(undefined);
    };
    switch (asking.kind) {
      case 'rename':
        return (
          <RenameDialog
            template={asking.template}
            returnFocus={openerRef}
            onClose={close}
            onSaved={(saved) => {
              close();
              const { name } = saved;
              tell({ text: t`Renamed to ${name}.` });
              refresh();
            }}
          />
        );
      case 'archive':
        return (
          <ArchiveDialog
            template={asking.template}
            returnFocus={openerRef}
            onClose={close}
            onDone={(archived) => {
              openerRef.current = headingRef.current;
              close();
              const { name } = archived;
              tell({
                text: t`${name} archived.`,
                undo: () => {
                  restore.mutate(archived);
                },
              });
              refresh();
            }}
          />
        );
      case 'delete':
        return (
          <DeleteDialog
            template={asking.template}
            returnFocus={openerRef}
            onClose={close}
            onDone={(deleted: MessageTemplate) => {
              openerRef.current = headingRef.current;
              close();
              const { name } = deleted;
              tell({
                text: t`${name} moved to the trash.`,
                undo: () => {
                  restore.mutate(deleted);
                },
              });
              refresh();
            }}
          />
        );
      case 'move':
        return (
          <MoveDialog
            templates={asking.templates}
            returnFocus={openerRef}
            onClose={close}
            onDone={(result) => {
              // Moved out of the folder showing, or many at once: the row or the bar goes.
              if (result !== undefined || search.folder !== undefined)
                openerRef.current = headingRef.current;
              close();
              if (result === undefined) {
                tell({ text: t`Template moved.` });
                refresh();
              } else afterBulk(result);
            }}
          />
        );
      case 'bulk':
        return (
          <BulkConfirmDialog
            action={asking.action}
            templates={asking.templates}
            returnFocus={openerRef}
            onClose={close}
            onDone={(result) => {
              openerRef.current = headingRef.current;
              close();
              afterBulk(result);
            }}
          />
        );
      case 'folder':
        return (
          <TemplateFolderEditor
            edit={asking.edit}
            folders={folderItems}
            returnFocus={openerRef}
            onClose={close}
            onSaved={(next) => {
              close();
              refresh();
              // A new or changed folder is shown; a removed one gives way to its parent.
              onSearch((now) => withPlace(now, next ?? 'all'));
            }}
          />
        );
    }
  }
}
