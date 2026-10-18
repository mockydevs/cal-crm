// Marketing → Trigger Links (laid out as GoHighLevel's): a named web address a message
// carries as {{trigger_link.key}}. The list is the server's, newest first, a page at a
// time, searched there, with each link's clicks. Analyze lists who clicked one link and
// when. Reading is open to the business; changing anything needs the permission to manage
// templates, which the server says with canManage.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createTriggerLink,
  deleteTriggerLink,
  getTriggerLink,
  listTriggerLinkClicks,
  listTriggerLinks,
  mergeKeyFromName,
  mergeToken,
  triggerLinkMergeKey,
  updateTriggerLink,
  TRIGGER_LINK_LIMITS,
  type TriggerLink,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  ContactName,
  linkClassName,
  panelFormClassName,
  RightPanel,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './conversation-extras-panel';
import { clickRange, rangeBackwards } from './conversation-extras-rules';
import { ListSearch } from './list-toolbar';
import { noRejection, type Rejection } from './problems';
import {
  cellClassName,
  ConfirmDialog,
  FormProblem,
  headerCellClassName,
  isStale,
  listCardClassName,
  ListFooter,
  ListProblem,
  MergeToken,
  retryFaults,
  RowMenu,
  savingProblem,
  tableClassName,
  tableRegionClassName,
  useSettled,
  ViewSwitch,
} from './settings-list';
import {
  emptyTrail,
  rangeOf,
  trailBack,
  trailCursor,
  trailForward,
  type PageSize,
} from './settings-rules';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

type Opened =
  | {
      readonly kind: 'link';
      readonly link: TriggerLink | undefined;
      /** The link a new one starts as a copy of. */
      readonly from?: TriggerLink;
    }
  | { readonly kind: 'delete'; readonly link: TriggerLink };

const linksKey = (businessId: string) => ['b', businessId, 'trigger-links'] as const;

export function TriggerLinksPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const [view, setView] = useState<'links' | 'analyze'>('links');
  const [search, setSearch] = useState('');
  const q = useSettled(search).trim();
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [trail, setTrail] = useState(emptyTrail);
  const [opened, setOpened] = useState<Opened>();
  const [analyzed, setAnalyzed] = useState<TriggerLink>();
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const after = trailCursor(trail);
  const links = useQuery({
    queryKey: [...linksKey(business.id), 'list', { q, pageSize, after }],
    queryFn: () =>
      api.request(listTriggerLinks, {
        query: {
          limit: pageSize,
          ...(q === '' ? {} : { q }),
          ...(after === undefined ? {} : { after }),
        },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const refresh = () => cache.invalidateQueries({ queryKey: linksKey(business.id) });
  const close = (message = '') => {
    setOpened(undefined);
    setNotice(message);
  };
  const open = (next: Opened, trigger: HTMLElement | null) => {
    returnFocusRef.current = trigger;
    setOpened(next);
    setNotice('');
  };

  const remove = useMutation({
    mutationFn: async (link: TriggerLink) => {
      await api.request(deleteTriggerLink, { params: { linkId: link.id } });
      return link;
    },
    onSuccess: async (link) => {
      // The last row of a page is gone: show the page before it.
      if (links.data?.items.length === 1) setTrail(trailBack);
      if (analyzed?.id === link.id) setAnalyzed(undefined);
      await refresh();
      close(t`Link deleted.`);
    },
  });

  const canManage = links.data?.canManage === true;
  const day = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const items = links.data?.items ?? [];
  const total = links.data?.total ?? 0;
  const range = rangeOf({ index: trail.index, pageSize, shown: items.length, total });
  const actionsFor = (name: string) => t`Actions for ${name}`;
  const removingName = opened?.kind === 'delete' ? opened.link.name : '';
  const removingToken = opened?.kind === 'delete' ? mergeToken(opened.link.mergeKey) : '';
  const editing = opened?.kind === 'link' ? opened.link : undefined;
  const copying = opened?.kind === 'link' && opened.from !== undefined;

  return (
    <Page
      title={t`Trigger Links`}
      actions={
        canManage ? (
          <Button
            onClick={(event) => {
              open({ kind: 'link', link: undefined }, event.currentTarget);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>Add link</Trans>
          </Button>
        ) : undefined
      }
    >
      <p className="text-md text-muted-foreground">
        <Trans>
          A trigger link goes inside a text message or an email. When a contact opens it, the click
          is recorded on the contact and can start a workflow.
        </Trans>
      </p>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {links.data !== undefined && !canManage ? (
        <p className="text-md text-muted-foreground">
          <Trans>
            You can read trigger links. Changing them needs permission to manage templates.
          </Trans>
        </p>
      ) : null}
      <div>
        <ViewSwitch
          label={t`Links or their clicks`}
          value={view}
          onChange={setView}
          views={[
            { value: 'links', label: t`Link` },
            { value: 'analyze', label: t`Analyze` },
          ]}
        />
      </div>
      {view === 'links' ? (
        <section aria-label={t`Links`} className={listCardClassName}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ListSearch
              label={t`Search links`}
              value={search}
              onChange={(next) => {
                setSearch(next);
                setTrail(emptyTrail);
              }}
            />
          </div>
          {links.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading links…</Trans>
            </p>
          ) : null}
          {links.isError ? (
            <ListProblem
              onRetry={() => {
                void links.refetch();
              }}
            >
              <Trans>The links couldn't be loaded.</Trans>
            </ListProblem>
          ) : null}
          {links.data !== undefined && items.length === 0 ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              {q === '' ? <Trans>No links available.</Trans> : <Trans>No links match.</Trans>}
            </p>
          ) : null}
          {items.length === 0 ? null : (
            <div role="region" aria-label={t`Links table`} className={tableRegionClassName}>
              <table className={`${tableClassName} min-w-[1080px] table-fixed`}>
                <caption className="sr-only">
                  <Trans>Trigger links</Trans>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={`${headerCellClassName} w-[18%]`}>
                      <Trans>Name</Trans>
                    </th>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Link URL</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[24%]`}>
                      <Trans>Link key</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-16`}>
                      <Trans>Clicks</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-20`}>
                      <Trans>Contacts</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-36`}>
                      <Trans>Last click</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-28`}>
                      <Trans>Date added</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-16`}>
                      <span className="sr-only">
                        <Trans>Actions</Trans>
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((link) => (
                    <tr key={link.id} className="hover:bg-muted">
                      <th
                        scope="row"
                        className={`${cellClassName} text-left font-medium wrap-anywhere text-foreground`}
                      >
                        {link.name}
                      </th>
                      <td className={`${cellClassName} truncate`} title={link.url}>
                        {/^https?:\/\//.test(link.url) ? (
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className={linkClassName}
                          >
                            {link.url}
                          </a>
                        ) : (
                          link.url
                        )}
                      </td>
                      <td className={cellClassName}>
                        <MergeToken
                          token={mergeToken(link.mergeKey)}
                          onCopied={(token) => {
                            setNotice(t`Copied ${token}`);
                          }}
                        />
                      </td>
                      <td className={cellClassName}>{link.clicks}</td>
                      <td className={cellClassName}>{link.contacts}</td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {link.lastClickedAt === null ? (
                          <span className="text-muted-foreground">
                            <Trans>Never</Trans>
                          </span>
                        ) : (
                          moment.format(new Date(link.lastClickedAt))
                        )}
                      </td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {day.format(new Date(link.createdAt))}
                      </td>
                      <td className={`${cellClassName} text-right`}>
                        <RowMenu
                          label={actionsFor(link.name)}
                          onOpen={(trigger) => {
                            returnFocusRef.current = trigger;
                          }}
                          actions={[
                            ...(canManage
                              ? [
                                  {
                                    label: t`Edit`,
                                    onSelect: () => {
                                      open({ kind: 'link', link }, returnFocusRef.current);
                                    },
                                  },
                                ]
                              : []),
                            ...(canManage
                              ? [
                                  {
                                    label: t`Duplicate`,
                                    onSelect: () => {
                                      open(
                                        { kind: 'link', link: undefined, from: link },
                                        returnFocusRef.current,
                                      );
                                    },
                                  },
                                ]
                              : []),
                            {
                              label: t`Analyze`,
                              immediate: true,
                              onSelect: () => {
                                setAnalyzed(link);
                                setView('analyze');
                                setNotice('');
                              },
                            },
                            ...(canManage
                              ? [
                                  {
                                    label: t`Delete`,
                                    destructive: true,
                                    onSelect: () => {
                                      remove.reset();
                                      open({ kind: 'delete', link }, returnFocusRef.current);
                                    },
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {links.data === undefined ? null : (
            <ListFooter
              perPageLabel={t`Rows per page`}
              pageSize={pageSize}
              onPageSize={(size) => {
                setPageSize(size);
                setTrail(emptyTrail);
              }}
              range={range}
              number={trail.index + 1}
              previous={trail.index > 0}
              next={links.data.next !== null}
              busy={links.isFetching && links.isPlaceholderData}
              onPrevious={() => {
                setTrail(trailBack);
              }}
              onNext={() => {
                setTrail(trailForward(trail, links.data.next));
              }}
            />
          )}
        </section>
      ) : (
        <LinkClicks link={analyzed} onChoose={setAnalyzed} />
      )}

      <RightPanel
        open={opened?.kind === 'link'}
        onClose={close}
        returnFocus={returnFocusRef}
        title={
          copying ? (
            <Trans>Duplicate link</Trans>
          ) : editing === undefined ? (
            <Trans>Add link</Trans>
          ) : (
            <Trans>Edit link</Trans>
          )
        }
        description={<Trans>Where the link sends whoever opens it.</Trans>}
      >
        {opened?.kind === 'link' ? (
          <LinkForm
            key={
              opened.link === undefined
                ? `new:${opened.from?.id ?? ''}`
                : `${opened.link.id}:${opened.link.revision}`
            }
            link={opened.link}
            from={opened.from}
            onCancel={close}
            onSaved={async (created) => {
              await refresh();
              close(created ? t`Link created.` : t`Link saved.`);
            }}
            onReload={(latest) => {
              setOpened({ kind: 'link', link: latest });
            }}
          />
        ) : null}
      </RightPanel>

      <ConfirmDialog
        open={opened?.kind === 'delete'}
        returnFocus={returnFocusRef}
        title={opened?.kind === 'delete' ? <Trans>Delete {removingName}?</Trans> : null}
        description={
          opened?.kind === 'delete' ? (
            <Trans>
              Its click history is deleted with it. Addresses already sent stop working, and a
              message that still uses {removingToken} is not sent.
            </Trans>
          ) : null
        }
        confirmLabel={t`Delete`}
        destructive
        busy={remove.isPending}
        problem={
          remove.isError
            ? remove.error instanceof ApiError
              ? (remove.error.problem.detail ?? t`It wasn't deleted. Try again.`)
              : t`It wasn't deleted. Check your connection and try again.`
            : undefined
        }
        onClose={close}
        onConfirm={() => {
          if (opened?.kind === 'delete') remove.mutate(opened.link);
        }}
      />
    </Page>
  );
}

function LinkForm({
  link,
  from,
  onCancel,
  onSaved,
  onReload,
}: {
  readonly link: TriggerLink | undefined;
  /** For a new link: the one it copies, which gives it its address and a name to change. */
  readonly from?: TriggerLink | undefined;
  readonly onCancel: () => void;
  readonly onSaved: (created: boolean) => Promise<void>;
  /** The saved version, to edit in place of the one someone else has since changed. */
  readonly onReload: (latest: TriggerLink) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const original = from?.name ?? '';
  const copyName = t`Copy of ${original}`.slice(0, 120);
  const [name, setName] = useState(link?.name ?? (from === undefined ? '' : copyName));
  const [url, setUrl] = useState(link?.url ?? from?.url ?? '');
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const save = useMutation({
    mutationFn: () =>
      link === undefined
        ? api.request(createTriggerLink, { body: { name, url } })
        : api.request(updateTriggerLink, {
            params: { linkId: link.id },
            body: { name, url, revision: link.revision },
          }),
    onSuccess: () => onSaved(link === undefined),
    onError: (error) => {
      setProblem(
        savingProblem(error, t`The link wasn't saved. Check your connection and try again.`),
      );
    },
  });
  const reload = useMutation({
    mutationFn: () => {
      if (link === undefined) throw new Error('Nothing saved to reload.');
      return api.request(getTriggerLink, { params: { linkId: link.id } });
    },
    onSuccess: onReload,
    onError: () => {
      setProblem({
        fields: {},
        form: t`The saved version couldn't be loaded. It may have been deleted.`,
      });
    },
  });
  const token = mergeToken(link?.mergeKey ?? triggerLinkMergeKey(mergeKeyFromName(name, 'link')));
  return (
    <Form<Record<string, unknown>>
      className={panelFormClassName}
      errors={problem.fields}
      onFormSubmit={() => {
        setProblem(noRejection);
        save.mutate();
      }}
    >
      <div className={sidePanelBodyClassName}>
        <Field name="name">
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            required
            maxLength={120}
            autoComplete="off"
            placeholder={t`Enter link name`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {name.trim() === '' && link === undefined ? null : (
            <FieldDescription>
              {link === undefined ? (
                <Trans>
                  Key: <code className="font-mono text-xs">{token}</code>. A number is added if that
                  key is taken. It never changes afterwards.
                </Trans>
              ) : (
                <Trans>
                  Key: <code className="font-mono text-xs">{token}</code>. Renaming the link keeps
                  this key.
                </Trans>
              )}
            </FieldDescription>
          )}
          <FieldError />
        </Field>
        <Field name="url">
          <FieldLabel>
            <Trans>Link URL</Trans>
          </FieldLabel>
          <Input
            required
            inputMode="url"
            maxLength={TRIGGER_LINK_LIMITS.url}
            autoComplete="off"
            placeholder="https://"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
          <FieldDescription>
            {link === undefined ? (
              <Trans>A full web address, starting with https:// or http://.</Trans>
            ) : (
              <Trans>
                A full web address, starting with https:// or http://. Addresses already sent go to
                the new one.
              </Trans>
            )}
          </FieldDescription>
          <FieldError />
        </Field>
        <FormProblem
          problem={problem}
          stale={isStale(save.error)}
          busy={reload.isPending}
          onReload={() => {
            reload.mutate();
          }}
        />
      </div>
      <div className={sidePanelFooterClassName}>
        <Button
          variant="secondary"
          disabled={save.isPending}
          onClick={() => {
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={save.isPending || name.trim() === '' || url.trim() === ''}>
          {link === undefined ? t`Create link` : t`Save changes`}
        </Button>
      </div>
    </Form>
  );
}

const NO_LINK = 'none';

/** Analyze: who clicked one link and when, newest first, over a range of days. */
function LinkClicks({
  link,
  onChoose,
}: {
  readonly link: TriggerLink | undefined;
  readonly onChoose: (link: TriggerLink | undefined) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [trail, setTrail] = useState(emptyTrail);
  const fromId = useId();
  const toId = useId();

  // The links to choose from: the newest, as many as one page of the list may hold.
  const choices = useQuery({
    queryKey: [...linksKey(business.id), 'choices'],
    queryFn: () => api.request(listTriggerLinks, { query: { limit: TRIGGER_LINK_LIMITS.page } }),
    retry: retryFaults,
  });
  const listed = choices.data?.items ?? [];
  const offered =
    link === undefined || listed.some((each) => each.id === link.id) ? listed : [link, ...listed];
  // The counts beside the name are the list's, which a click since has moved on.
  const chosen = listed.find((each) => each.id === link?.id) ?? link;

  const backwards = rangeBackwards(fromDay, toDay);
  const after = trailCursor(trail);
  const asked = clickRange(fromDay, toDay);
  const clicks = useQuery({
    queryKey: [...linksKey(business.id), 'clicks', chosen?.id, { asked, pageSize, after }],
    queryFn: () =>
      api.request(listTriggerLinkClicks, {
        params: { linkId: chosen?.id ?? '' },
        query: { limit: pageSize, ...asked, ...(after === undefined ? {} : { after }) },
      }),
    enabled: chosen !== undefined && !backwards,
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const items = clicks.data?.items ?? [];
  const range = rangeOf({
    index: trail.index,
    pageSize,
    shown: items.length,
    total: clicks.data?.clicks ?? 0,
  });
  const ranged = fromDay !== '' || toDay !== '';
  const statClassName = 'flex min-w-32 flex-col gap-0.5 rounded-lg border border-border px-3 py-2';

  return (
    <section aria-label={t`Analyze`} className={listCardClassName}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
          <Trans>Link</Trans>
          <Select
            aria-label={t`Link`}
            className="w-auto max-w-full min-w-56"
            value={chosen?.id ?? NO_LINK}
            onValueChange={(next) => {
              onChoose(offered.find((each) => each.id === next));
              setTrail(emptyTrail);
            }}
          >
            <option value={NO_LINK}>{t`Choose a link`}</option>
            {offered.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex flex-col gap-1.5 text-sm font-medium">
          <label htmlFor={fromId}>
            <Trans>From</Trans>
          </label>
          <Input
            id={fromId}
            type="date"
            className="w-auto"
            value={fromDay}
            max={toDay === '' ? undefined : toDay}
            onChange={(event) => {
              setFromDay(event.target.value);
              setTrail(emptyTrail);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5 text-sm font-medium">
          <label htmlFor={toId}>
            <Trans>To</Trans>
          </label>
          <Input
            id={toId}
            type="date"
            className="w-auto"
            value={toDay}
            min={fromDay === '' ? undefined : fromDay}
            onChange={(event) => {
              setToDay(event.target.value);
              setTrail(emptyTrail);
            }}
          />
        </div>
      </div>
      {choices.isError ? (
        <ListProblem
          onRetry={() => {
            void choices.refetch();
          }}
        >
          <Trans>The links couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {choices.data !== undefined && choices.data.total > listed.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            The newest links are listed here. For an older one, choose Analyze in its menu on the
            Link tab.
          </Trans>
        </p>
      ) : null}
      {chosen === undefined ? (
        <p className="py-6 text-center text-md text-muted-foreground">
          <Trans>Choose a link to see who clicked it.</Trans>
        </p>
      ) : backwards ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          <Trans>The range ends before it starts.</Trans>
        </p>
      ) : (
        <>
          {clicks.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading clicks…</Trans>
            </p>
          ) : null}
          {clicks.isError ? (
            <ListProblem
              onRetry={() => {
                void clicks.refetch();
              }}
            >
              <Trans>The clicks couldn't be loaded.</Trans>
            </ListProblem>
          ) : null}
          {clicks.data === undefined ? null : (
            <dl className="flex flex-wrap gap-3">
              <div className={statClassName}>
                <dt className="text-xs text-muted-foreground">
                  {ranged ? <Trans>Clicks in the range</Trans> : <Trans>Clicks</Trans>}
                </dt>
                <dd className="text-lg font-medium text-foreground">{clicks.data.clicks}</dd>
              </div>
              <div className={statClassName}>
                <dt className="text-xs text-muted-foreground">
                  {ranged ? <Trans>Contacts in the range</Trans> : <Trans>Contacts</Trans>}
                </dt>
                <dd className="text-lg font-medium text-foreground">{clicks.data.contacts}</dd>
              </div>
              <div className={statClassName}>
                <dt className="text-xs text-muted-foreground">
                  <Trans>Last click</Trans>
                </dt>
                <dd className="text-lg font-medium text-foreground">
                  {chosen.lastClickedAt === null
                    ? t`Never`
                    : moment.format(new Date(chosen.lastClickedAt))}
                </dd>
              </div>
            </dl>
          )}
          {clicks.data !== undefined && items.length === 0 ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              {ranged ? (
                <Trans>Nobody clicked this link in the range.</Trans>
              ) : (
                <Trans>Nobody has clicked this link yet.</Trans>
              )}
            </p>
          ) : null}
          {items.length === 0 ? null : (
            <div role="region" aria-label={t`Clicks table`} className={tableRegionClassName}>
              <table className={tableClassName}>
                <caption className="sr-only">
                  <Trans>Clicks</Trans>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Contact</Trans>
                    </th>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Clicked</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((click) => (
                    <tr key={click.id} className="hover:bg-muted">
                      <th
                        scope="row"
                        className={`${cellClassName} text-left font-medium wrap-anywhere text-foreground`}
                      >
                        <ContactName contact={click.contact} />
                      </th>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {moment.format(new Date(click.clickedAt))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {clicks.data === undefined ? null : (
            <ListFooter
              perPageLabel={t`Rows per page`}
              pageSize={pageSize}
              onPageSize={(size) => {
                setPageSize(size);
                setTrail(emptyTrail);
              }}
              range={range}
              number={trail.index + 1}
              previous={trail.index > 0}
              next={clicks.data.next !== null}
              busy={clicks.isFetching && clicks.isPlaceholderData}
              onPrevious={() => {
                setTrail(trailBack);
              }}
              onNext={() => {
                setTrail(trailForward(trail, clicks.data.next));
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
