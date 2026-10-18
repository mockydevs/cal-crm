// Marketing → Emails → Campaigns: every email campaign of the business, newest first, laid
// out as the Templates page is: the folders at the left with how many each holds (and those
// in no folder), one slim
// row of search and status over a compact table (name with its audience under it, status
// with why it waits, recipients, when it is due or was sent, last change), a page at a
// time, and the menu each status allows. Ticked campaigns can be moved, or deleted while
// they are drafts. A campaign opens on its own page: the editor while it is a draft, its
// results after. What the list shows is kept in the address.
//
// Its words are in the campaigns catalog (lingui.config.ts, campaigns-words.ts).
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  cancelEmailCampaign,
  createEmailCampaign,
  deleteEmailCampaign,
  listEmailCampaigns,
  pauseEmailCampaign,
  resumeEmailCampaign,
  type EmailCampaignSummary,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import type { CampaignsSearch } from '../campaigns-search';
import { campaignStatusChoices } from '../campaigns-search';
import { withEmailWords } from '../email-words';
import { EmailsNav, InfoTip, LibraryEmpty, NewMenu, NothingMatches } from '../email-library/header';
import { LibraryPanel, type PanelEntry } from '../email-library/panel';
import { folderTree, pageSelection, settleAtMost, toggled, withPage } from '../email-library/rules';
import {
  BulkBar,
  compactCellClassName,
  compactHeaderClassName,
  hoverOpenClassName,
  LibraryToolbar,
  rowClassName,
  TickBox,
  wideOnlyClassName,
} from '../email-library/table';
import {
  listCardClassName,
  ListProblem,
  tableClassName,
  tableRegionClassName,
  useSettled,
} from '../list-table';
import { RowMenu, type RowAction as MenuAction } from '../email-library/row-menu';
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
import { useBusiness } from '../workspace';
import { ConfirmDialog } from './controls';
import {
  campaignKeys,
  isRefusal,
  retryFaults,
  saidBy,
  useAudienceNames,
  useCampaignFolders,
} from './data';
import type { FolderEdit } from './folders';
import { useCampaignMailboxes } from './mailboxes';
import { linkClassName, StatusPill } from './parts';
import {
  audienceSentence,
  cancelConsequence,
  folderLabels,
  momentIn,
  rowActions,
  rowMoment,
  statusFilterWords,
  statusLine,
  waitingLine,
  type AudienceNames,
} from './rules';

// The dialog that starts a campaign shows the template list, whose words are the email
// catalog's: fetched with them when it is opened.
const NewCampaignDialog = lazy(() => withEmailWords(import('./new-dialog')));
// The folder and move dialogs, fetched when one is first opened.
const FolderEditor = lazy(async () => ({ default: (await import('./folders')).FolderEditor }));
const MoveCampaignDialog = lazy(async () => ({
  default: (await import('./folders')).MoveCampaignDialog,
}));

// How many drafts a bulk delete asks the server to delete at once.
const BULK_AT_ONCE = 5;

type Change = 'delete' | 'cancel' | 'pause' | 'resume';
type Asking =
  | { readonly kind: Change; readonly campaign: EmailCampaignSummary }
  | { readonly kind: 'move'; readonly campaigns: readonly EmailCampaignSummary[] }
  | { readonly kind: 'bulk-delete'; readonly campaigns: readonly EmailCampaignSummary[] }
  | { readonly kind: 'folder'; readonly edit: FolderEdit }
  | { readonly kind: 'new' };

export default function CampaignsPage({
  search,
  onSearch,
}: {
  readonly search: CampaignsSearch;
  /** Changes the address: handed what it holds now, so two quick changes both land. */
  readonly onSearch: (change: (now: CampaignsSearch) => CampaignsSearch) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [asking, setAsking] = useState<Asking>();
  const [problem, setProblem] = useState<string>();
  const [notice, setNotice] = useState('');
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

  // What is typed reaches the address once typing pauses.
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

  const folders = useCampaignFolders(business.id);
  const query = {
    limit: pageSize,
    ...(search.status === undefined ? {} : { status: search.status }),
    ...(search.folder === undefined ? {} : { folder: search.folder }),
    ...(search.q === undefined ? {} : { q: search.q }),
  };
  const after = trailCursor(trail);
  const list = useQuery({
    queryKey: campaignKeys.list(business.id, { ...query, after }),
    queryFn: () =>
      apiIn(business.id).request(listEmailCampaigns, {
        query: { ...query, ...(after === undefined ? {} : { after }) },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const listed = list.data;
  const items = listed?.items ?? [];
  const permissions = { canManage: listed?.canManage ?? false, canSend: listed?.canSend ?? false };
  const mailboxes = useCampaignMailboxes(business.id, permissions.canManage);
  const names = useAudienceNames(business.id, items.length > 0);
  const filtered = search.status !== undefined || search.q !== undefined;

  const refresh = (): void => {
    void cache.invalidateQueries({ queryKey: campaignKeys.all(business.id) });
    void cache.invalidateQueries({ queryKey: campaignKeys.folders(business.id) });
  };
  const open = (id: string): void => {
    void navigate({
      to: '/b/$slug/marketing/emails/campaigns/$campaignId',
      params: { slug: business.slug, campaignId: id },
    });
  };
  // A row that leaves the list takes the button that acted on it with it, and the bulk bar
  // goes with the selection: the keyboard goes to the list's heading instead of the page.
  const toHeading = (): void => {
    openerRef.current = headingRef.current;
    headingRef.current?.focus();
  };
  // Ticks belong to the page showing.
  const toPage = (next: typeof trail): void => {
    setTrail(next);
    setSelected(new Set());
  };
  const ask = (next: Asking, trigger: HTMLElement | null): void => {
    openerRef.current = trigger;
    setProblem(undefined);
    act.reset();
    setAsking(next);
  };

  const duplicate = useMutation({
    mutationFn: (campaign: EmailCampaignSummary) => {
      const { name } = campaign;
      return apiIn(business.id).request(createEmailCampaign, {
        body: {
          name: t`${name} (copy)`.slice(0, 120),
          folderId: campaign.folderId,
          source: { kind: 'campaign', campaignId: campaign.id },
        },
      });
    },
    onSuccess: (made) => {
      refresh();
      open(made.id);
    },
    onError: (error) => {
      setNotice('');
      setProblem(
        saidBy(error, t`The campaign wasn't duplicated. Check your connection and try again.`),
      );
    },
  });
  const act = useMutation({
    mutationFn: async (asked: { kind: Change; campaign: EmailCampaignSummary }) => {
      const client = apiIn(business.id);
      const params = { id: asked.campaign.id };
      if (asked.kind === 'delete')
        await client.request(deleteEmailCampaign, {
          params,
          body: { revision: asked.campaign.revision },
        });
      else if (asked.kind === 'cancel') await client.request(cancelEmailCampaign, { params });
      else if (asked.kind === 'pause') await client.request(pauseEmailCampaign, { params });
      else await client.request(resumeEmailCampaign, { params });
      return asked;
    },
    onSuccess: (asked) => {
      const { name } = asked.campaign;
      // A deleted draft leaves the list, and a cancelled one may leave a status filter.
      if (asked.kind === 'delete' || search.status !== undefined) toHeading();
      setAsking(undefined);
      setProblem(undefined);
      setNotice(
        {
          delete: t`Deleted “${name}”.`,
          cancel: t`Cancelled “${name}”.`,
          pause: t`Paused “${name}”.`,
          resume: t`Resumed “${name}”.`,
        }[asked.kind],
      );
      refresh();
    },
  });
  // Drafts are deleted one request each, a few at a time; whatever else was ticked is left as
  // it is. A draft the server refused (changed since it was read, too many requests, no
  // connection) is named with the reason it gave.
  const bulkDelete = useMutation({
    mutationFn: async (campaigns: readonly EmailCampaignSummary[]) => {
      const drafts = campaigns.filter((each) => each.status === 'draft');
      const results = await settleAtMost(drafts, BULK_AT_ONCE, (campaign) =>
        apiIn(business.id).request(deleteEmailCampaign, {
          params: { id: campaign.id },
          body: { revision: campaign.revision },
        }),
      );
      return {
        deleted: results.filter((each) => each.status === 'fulfilled').length,
        notDrafts: campaigns.length - drafts.length,
        failed: drafts.flatMap((campaign, index) => {
          const result = results[index];
          return result?.status === 'rejected'
            ? [
                {
                  name: campaign.name,
                  reason: saidBy(result.reason, t`Check your connection and try again.`),
                },
              ]
            : [];
        }),
      };
    },
    onSuccess: ({ deleted, notDrafts, failed }) => {
      toHeading();
      setAsking(undefined);
      setSelected(new Set());
      const done = plural(deleted, { one: '# draft deleted.', other: '# drafts deleted.' });
      const kept =
        notDrafts === 0
          ? []
          : [
              plural(notDrafts, {
                one: '# campaign was kept: only a draft can be deleted.',
                other: '# campaigns were kept: only a draft can be deleted.',
              }),
            ];
      const refused = failed.map(({ name, reason }) => `“${name}”: ${reason}`).join(' ');
      setNotice(
        [done, ...kept, ...(failed.length === 0 ? [] : [t`Not deleted: ${refused}`])].join(' '),
      );
      refresh();
    },
  });

  const words: Readonly<Record<ReturnType<typeof rowActions>[number], string>> = {
    open: t`Open`,
    edit: t`Edit`,
    duplicate: t`Duplicate`,
    move: t`Move to folder`,
    pause: t`Pause`,
    resume: t`Resume`,
    delete: t`Delete`,
    cancel: t`Cancel campaign`,
  };
  const menuOf = (campaign: EmailCampaignSummary): MenuAction[] =>
    rowActions(campaign.status, permissions).map((action) => ({
      label: words[action],
      destructive: action === 'delete' || action === 'cancel',
      immediate: action === 'open' || action === 'edit' || action === 'duplicate',
      onSelect: () => {
        setProblem(undefined);
        if (action === 'open' || action === 'edit') open(campaign.id);
        else if (action === 'duplicate') duplicate.mutate(campaign);
        else if (action === 'move') ask({ kind: 'move', campaigns: [campaign] }, openerRef.current);
        else ask({ kind: action, campaign }, openerRef.current);
      },
    }));

  const folderItems = folders.data?.items ?? [];
  const labels = folderLabels(folderItems);
  const entries: PanelEntry[] = [
    { key: 'all', label: t`All campaigns`, count: folders.data?.counts?.all, kind: 'all' },
    {
      key: 'root',
      label: t`No folder`,
      count: folders.data?.counts?.unfiled,
      kind: 'unfiled',
    },
    ...folderTree(folderItems).map((folder): PanelEntry => ({
      key: folder.id,
      label: folder.name,
      path: labels.get(folder.id) ?? folder.name,
      count: folder.campaignCount,
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
    })),
  ];
  const place = search.folder ?? 'all';
  const placeName = entries.find((entry) => entry.key === place)?.label ?? t`All campaigns`;
  // The folder a new campaign or folder goes in: none for every campaign or those in none.
  const inFolder = search.folder === 'root' ? null : (search.folder ?? null);
  const newFolder = (trigger: HTMLElement | null): void => {
    ask({ kind: 'folder', edit: { kind: 'create', parentId: inFolder } }, trigger);
  };
  const newChoices = permissions.canManage
    ? [
        {
          label: t`Campaign`,
          hint: t`Blank, from a template, or a copy of another`,
          onSelect: (trigger: HTMLElement | null) => {
            ask({ kind: 'new' }, trigger);
          },
        },
        { label: t`Folder`, hint: t`To group campaigns`, onSelect: newFolder },
      ]
    : [];
  // A mailbox switched on for campaigns, and working, is what sending needs first.
  const noMailbox =
    mailboxes.data !== undefined &&
    !mailboxes.data.offered.some((mailbox) => mailbox.status === 'active');

  const pageIds = items.map((item) => item.id);
  const ticked = items.filter((item) => selected.has(item.id));
  const pageTicked = pageSelection(selected, pageIds);
  const askedName = asking !== undefined && 'campaign' in asking ? asking.campaign.name : '';
  const confirms: Readonly<Record<Change, { title: string; description: string; label: string }>> =
    {
      delete: {
        title: t`Delete this draft?`,
        description: t`“${askedName}” is deleted for good. Nothing was sent, so nothing else changes.`,
        label: t`Delete draft`,
      },
      cancel: {
        title: t`Cancel this campaign?`,
        description:
          asking !== undefined && 'campaign' in asking
            ? `“${askedName}”: ${cancelConsequence(asking.campaign.status)}`
            : '',
        label: t`Cancel campaign`,
      },
      pause: {
        title: t`Pause this campaign?`,
        description: t`Nothing more leaves until it is resumed, including emails already handed to the mailbox and not yet sent. Emails that have left stay sent.`,
        label: t`Pause sending`,
      },
      resume: {
        title: t`Resume this campaign?`,
        description: t`Sending goes on from where it stopped. Nobody is sent the campaign twice.`,
        label: t`Resume sending`,
      },
    };

  return (
    <Page
      title={t`Email campaigns`}
      actions={
        <div className="flex flex-1 items-center gap-2">
          <InfoTip label={t`About campaigns`}>
            <Trans>
              A campaign is one email sent to many contacts: now, at a set time, or in batches. It
              needs a mailbox switched on for campaigns that passes its setup checks (Settings →
              Email Services), and contacts who agreed to marketing email. Before anything is sent
              you see who will get it and who will not, and why.
            </Trans>
          </InfoTip>
          <div className="ml-auto">
            <NewMenu label={t`New campaign`} choices={newChoices} />
          </div>
        </div>
      }
    >
      <EmailsNav slug={business.slug} current="campaigns" />
      {permissions.canManage && noMailbox ? (
        <section
          aria-label={t`Before you send`}
          className="flex flex-col gap-1 rounded-card border border-border bg-card px-4 py-3 text-sm"
        >
          <p className="font-medium text-foreground">
            <Trans>Before you send</Trans>
          </p>
          <p className="text-body">
            <Trans>
              No mailbox is switched on for campaigns yet. Connect one and switch it on in{' '}
              <Link
                to="/b/$slug/settings/email"
                params={{ slug: business.slug }}
                className={linkClassName}
              >
                Settings → Email Services
              </Link>
              ; drafts can be written meanwhile.
            </Trans>
          </p>
        </section>
      ) : null}
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:gap-4">
        <LibraryPanel
          label={t`Campaign folders`}
          entries={entries}
          selected={place}
          onSelect={(key) => {
            onSearch(({ folder: _folder, ...now }) =>
              key === 'all' ? now : { ...now, folder: key },
            );
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
            searchLabel={t`Search campaigns`}
            search={text}
            onSearch={(value) => {
              setText(value.slice(0, 120));
            }}
            choices={[
              {
                label: t`Status`,
                value: search.status ?? 'all',
                width: 'w-36',
                options: (['all', ...campaignStatusChoices] as const).map((each) => ({
                  value: each,
                  label: i18n._(statusFilterWords[each]),
                })),
                onChange: (value) => {
                  const status = campaignStatusChoices.find((each) => each === value);
                  onSearch(({ status: _status, ...now }) =>
                    status === undefined ? now : { ...now, status },
                  );
                },
              },
            ]}
          />
          {ticked.length === 0 ? null : (
            <BulkBar
              count={ticked.length}
              busy={bulkDelete.isPending}
              onClear={() => {
                setSelected(new Set());
              }}
              actions={[
                {
                  label: t`Move to folder`,
                  onSelect: (trigger) => {
                    ask({ kind: 'move', campaigns: ticked }, trigger);
                  },
                },
                ...(ticked.some((each) => each.status === 'draft')
                  ? [
                      {
                        label: t`Delete drafts`,
                        destructive: true,
                        onSelect: (trigger: HTMLElement) => {
                          ask({ kind: 'bulk-delete', campaigns: ticked }, trigger);
                        },
                      },
                    ]
                  : []),
              ]}
            />
          )}
          <p role="status" className="text-sm text-body empty:hidden">
            {notice}
          </p>
          {problem === undefined ? null : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {problem}
            </p>
          )}
          {list.isPending ? <p role="status" className="text-sm">{t`Loading campaigns…`}</p> : null}
          {list.isError ? (
            isRefusal(list.error, 403) ? (
              <p role="alert" className="text-sm">
                <Trans>
                  Your role can't see email campaigns. Ask an owner or admin of this business.
                </Trans>
              </p>
            ) : (
              <ListProblem
                onRetry={() => {
                  if (isRefusal(list.error, 422)) setTrail(emptyTrail);
                  void list.refetch();
                }}
              >
                {saidBy(list.error, t`We couldn't load the campaigns.`)}
              </ListProblem>
            )
          ) : null}
          {listed !== undefined && items.length === 0 ? (
            filtered ? (
              <NothingMatches />
            ) : search.folder === 'root' ? (
              <LibraryEmpty title={<Trans>Every campaign is in a folder.</Trans>} action={null} />
            ) : search.folder !== undefined ? (
              <LibraryEmpty title={<Trans>This folder is empty.</Trans>} action={null} />
            ) : (
              <LibraryEmpty
                title={
                  permissions.canManage ? (
                    <Trans>No campaigns yet. Send one email to many contacts, now or later.</Trans>
                  ) : (
                    <Trans>No campaigns yet, and your role can't write one.</Trans>
                  )
                }
                action={
                  permissions.canManage ? (
                    <Button
                      onClick={(event) => {
                        ask({ kind: 'new' }, event.currentTarget);
                      }}
                    >
                      <Trans>New campaign</Trans>
                    </Button>
                  ) : null
                }
              />
            )
          ) : null}
          {items.length === 0 ? null : (
            <div className={tableRegionClassName}>
              <table className={`${tableClassName} min-w-[36rem] table-fixed`}>
                <thead>
                  <tr>
                    {permissions.canManage ? (
                      <th scope="col" className={`${compactHeaderClassName} w-12 px-1`}>
                        <TickBox
                          label={t`Select all campaigns on this page`}
                          checked={pageTicked === 'some' ? 'some' : pageTicked === 'all'}
                          onChange={(on) => {
                            setSelected((now) => withPage(now, pageIds, on));
                          }}
                        />
                      </th>
                    ) : null}
                    <th scope="col" className={`${compactHeaderClassName} w-[36%]`}>
                      <Trans>Name</Trans>
                    </th>
                    <th scope="col" className={`${compactHeaderClassName} w-36`}>
                      <Trans>Status</Trans>
                    </th>
                    <th
                      scope="col"
                      className={`${compactHeaderClassName} ${wideOnlyClassName} w-32`}
                    >
                      <Trans>Recipients</Trans>
                    </th>
                    <th
                      scope="col"
                      className={`${compactHeaderClassName} ${wideOnlyClassName} w-44`}
                    >
                      <Trans>Scheduled or sent</Trans>
                    </th>
                    <th
                      scope="col"
                      className={`${compactHeaderClassName} hidden w-40 xl:table-cell`}
                    >
                      <Trans>Updated</Trans>
                    </th>
                    <th scope="col" className={`${compactHeaderClassName} w-28`}>
                      <span className="sr-only">
                        <Trans>Actions</Trans>
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((campaign) => (
                    <CampaignRow
                      key={campaign.id}
                      campaign={campaign}
                      slug={business.slug}
                      names={names}
                      canTick={permissions.canManage}
                      ticked={selected.has(campaign.id)}
                      onTick={() => {
                        setSelected((now) => toggled(now, campaign.id));
                      }}
                      actions={menuOf(campaign)}
                      onMenu={(trigger) => {
                        openerRef.current = trigger;
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {listed === undefined || items.length === 0 ? null : (
            <LibraryFooter
              perPageLabel={t`Campaigns per page`}
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
              next={listed.next !== null}
              busy={list.isFetching}
              onPrevious={() => {
                toPage(trailBack(trail));
              }}
              onNext={() => {
                toPage(trailForward(trail, listed.next));
              }}
            />
          )}
        </section>
      </div>
      {asking?.kind === 'new' ? (
        <Suspense fallback={null}>
          <NewCampaignDialog
            businessId={business.id}
            slug={business.slug}
            folderId={inFolder}
            returnFocus={openerRef}
            onClose={() => {
              setAsking(undefined);
            }}
            onCreated={(made) => {
              setAsking(undefined);
              refresh();
              open(made.id);
            }}
          />
        </Suspense>
      ) : null}
      {asking?.kind === 'move' ? (
        <Suspense fallback={null}>
          <MoveCampaignDialog
            businessId={business.id}
            campaigns={asking.campaigns}
            returnFocus={openerRef}
            onClose={() => {
              setAsking(undefined);
            }}
            onMoved={({ moved, failed }) => {
              // Many at once take the bar with them; one moved out of the folder showing
              // takes its row.
              if (asking.campaigns.length > 1 || search.folder !== undefined) toHeading();
              setAsking(undefined);
              setSelected(new Set());
              const done = plural(moved, { one: '# campaign moved.', other: '# campaigns moved.' });
              const kept = failed.join(', ');
              setNotice(failed.length === 0 ? done : `${done} ${t`Not moved: ${kept}.`}`);
              refresh();
            }}
          />
        </Suspense>
      ) : null}
      {asking?.kind === 'folder' ? (
        <Suspense fallback={null}>
          <FolderEditor
            businessId={business.id}
            edit={asking.edit}
            folders={folderItems}
            returnFocus={openerRef}
            onClose={() => {
              setAsking(undefined);
            }}
            onSaved={(next) => {
              setAsking(undefined);
              refresh();
              onSearch(({ folder: _folder, ...now }) =>
                next === null ? now : { ...now, folder: next },
              );
            }}
          />
        </Suspense>
      ) : null}
      {asking?.kind === 'bulk-delete' ? (
        <ConfirmDialog
          open
          title={plural(asking.campaigns.filter((each) => each.status === 'draft').length, {
            one: 'Delete # draft?',
            other: 'Delete # drafts?',
          })}
          description={t`They are deleted for good. Nothing was sent, so nothing else changes. Ticked campaigns that are not drafts are kept.`}
          confirmLabel={t`Delete drafts`}
          destructive
          busy={bulkDelete.isPending}
          problem={
            bulkDelete.isError
              ? saidBy(
                  bulkDelete.error,
                  t`That didn't happen. Check your connection and try again.`,
                )
              : undefined
          }
          returnFocus={openerRef}
          onConfirm={() => {
            bulkDelete.mutate(asking.campaigns);
          }}
          onClose={() => {
            if (!bulkDelete.isPending) setAsking(undefined);
          }}
        />
      ) : null}
      {asking !== undefined && 'campaign' in asking ? (
        <ConfirmDialog
          open
          title={confirms[asking.kind].title}
          description={confirms[asking.kind].description}
          confirmLabel={confirms[asking.kind].label}
          destructive={asking.kind === 'delete' || asking.kind === 'cancel'}
          busy={act.isPending}
          problem={
            act.isError
              ? saidBy(act.error, t`That didn't happen. Check your connection and try again.`)
              : undefined
          }
          returnFocus={openerRef}
          onConfirm={() => {
            act.mutate({ kind: asking.kind, campaign: asking.campaign });
          }}
          onClose={() => {
            if (!act.isPending) setAsking(undefined);
          }}
        />
      ) : null}
    </Page>
  );
}

function CampaignRow({
  campaign,
  slug,
  names,
  canTick,
  ticked,
  onTick,
  actions,
  onMenu,
}: {
  readonly campaign: EmailCampaignSummary;
  readonly slug: string;
  readonly names: AudienceNames;
  readonly canTick: boolean;
  readonly ticked: boolean;
  readonly onTick: () => void;
  readonly actions: readonly MenuAction[];
  readonly onMenu: (trigger: HTMLElement | null) => void;
}): ReactElement {
  const { t } = useLingui();
  const { name, counts, timeZone } = campaign;
  const reason = statusLine(campaign);
  const waiting = waitingLine(campaign);
  const moment = rowMoment(campaign);
  const when = moment === undefined ? '' : momentIn(moment.at, timeZone);
  const started = campaign.status !== 'draft' && campaign.status !== 'scheduled';
  const sent = counts.sent.toLocaleString();
  const audience = counts.audience.toLocaleString();
  return (
    <tr className={rowClassName} data-ticked={ticked ? true : undefined}>
      {canTick ? (
        <td className={`${compactCellClassName} px-1`}>
          <TickBox label={t`Select ${name}`} checked={ticked} onChange={onTick} />
        </td>
      ) : null}
      <td className={compactCellClassName}>
        <div className="flex min-w-0 flex-col">
          <Link
            to="/b/$slug/marketing/emails/campaigns/$campaignId"
            params={{ slug, campaignId: campaign.id }}
            className="block truncate rounded-control font-medium text-foreground -outline-offset-2 hover:text-link hover:underline"
          >
            {name}
          </Link>
          <span className="truncate text-xs text-muted-foreground">
            {audienceSentence(campaign.audience, names)}
          </span>
        </div>
      </td>
      <td className={compactCellClassName}>
        <div className="flex min-w-0 flex-col items-start gap-0.5">
          <StatusPill status={campaign.status} />
          {reason === undefined && waiting === undefined ? null : (
            <span className="max-w-full truncate text-xs text-body" title={reason ?? waiting}>
              {reason ?? waiting}
            </span>
          )}
        </div>
      </td>
      <td className={`${compactCellClassName} ${wideOnlyClassName} whitespace-nowrap`}>
        {started ? (
          t`${sent} of ${audience}`
        ) : (
          <span className="text-muted-foreground">
            <span aria-hidden>—</span>
            <span className="sr-only">
              <Trans>Not started</Trans>
            </span>
          </span>
        )}
      </td>
      <td className={`${compactCellClassName} ${wideOnlyClassName} text-xs whitespace-nowrap`}>
        {moment === undefined ? (
          <span className="text-muted-foreground">
            <span aria-hidden>—</span>
            <span className="sr-only">
              <Trans>Not scheduled</Trans>
            </span>
          </span>
        ) : moment.kind === 'due' ? (
          t`Due ${when}`
        ) : moment.kind === 'started' ? (
          t`Started ${when}`
        ) : campaign.status === 'sent' ? (
          t`Sent ${when}`
        ) : (
          t`Ended ${when}`
        )}
      </td>
      <td className={`${compactCellClassName} hidden text-xs whitespace-nowrap xl:table-cell`}>
        {momentIn(campaign.updatedAt, timeZone)}
      </td>
      <td className={`${compactCellClassName} text-right`}>
        <div className="flex items-center justify-end gap-1">
          <Link
            to="/b/$slug/marketing/emails/campaigns/$campaignId"
            params={{ slug, campaignId: campaign.id }}
            aria-label={t`Open ${name}`}
            className={`inline-flex min-h-10 items-center rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted lg:min-h-8 ${hoverOpenClassName}`}
          >
            <Trans>Open</Trans>
          </Link>
          <RowMenu label={t`Actions for ${name}`} actions={actions} onOpen={onMenu} />
        </div>
      </td>
    </tr>
  );
}
