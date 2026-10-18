// The URL Redirects view of Settings → Domains & URL Redirects: an address on a connected
// domain sent to a funnel or website of the business, or to any web address, permanently
// (301) or for now (302). The list, and a dialog that adds or changes one with exactly what
// `createSiteRedirectInput` and `updateSiteRedirectInput` take: a change keeps its domain.
// The API's own schema checks a draft before it is sent, and a refusal from the server is
// said under the box it names.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createSiteRedirect,
  deleteSiteRedirect,
  listSiteDomains,
  listSiteRedirects,
  listSites,
  SITE_LIMITS,
  updateSiteRedirect,
  type SiteDomain,
  type SiteRedirect,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { apiIn } from './api';
import {
  checkedRedirect,
  redirectAddress,
  redirectDraftOf,
  redirectReady,
  redirectRejection,
  type RedirectDraft,
  type RedirectField,
} from './domain-rules';
import { noRejection, type Rejection } from './problems';
import {
  cellClassName,
  ConfirmDialog,
  FormProblem,
  headerCellClassName,
  isStale,
  listCardClassName,
  ListProblem,
  retryFaults,
  RowMenu,
  savingProblem,
  SmallDialog,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import { useBusiness } from './workspace';

const NO_SITE = 'none';
const labelClassName = 'flex flex-col gap-1.5 text-sm font-medium';

const redirectsKey = (businessId: string) => ['b', businessId, 'sites', 'redirects'] as const;

/** What a redirect's two kinds of answer are called, in the list and in the dialog. */
function useStatusWords(): Readonly<Record<RedirectDraft['status'], string>> {
  const { t } = useLingui();
  return { '301': t`Permanent (301)`, '302': t`Temporary (302)` };
}

function RedirectDialog({
  redirect,
  domains,
  returnFocus,
  onSaved,
  onClose,
}: {
  /** The redirect to change, or undefined for a new one. */
  readonly redirect: SiteRedirect | undefined;
  readonly domains: readonly SiteDomain[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onSaved: (saved: SiteRedirect) => Promise<void>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const queryClient = useQueryClient();
  const statusWords = useStatusWords();
  const [draft, setDraft] = useState(() => redirectDraftOf(redirect, domains[0]?.id ?? ''));
  const [revision, setRevision] = useState(redirect?.revision);
  // What the last Save was refused with. A box's refusal goes when the box changes, and
  // every one goes when Save is pressed again: a box left as it was is asked about anew.
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [stale, setStale] = useState(false);
  const [refusals, setRefusals] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const errorId = useId();
  // The keyboard goes to the first box a refusal names, in the order the dialog shows them.
  useEffect(() => {
    if (refusals > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refusals]);
  const refuse = (next: Rejection) => {
    setProblem(next);
    setRefusals((count) => count + 1);
  };
  const change = <Name extends RedirectField>(name: Name, value: RedirectDraft[Name]) => {
    setDraft((now) => ({ ...now, [name]: value }));
    setProblem((now) =>
      now.fields[name] === undefined
        ? now
        : {
            form: now.form,
            fields: Object.fromEntries(Object.entries(now.fields).filter(([box]) => box !== name)),
          },
    );
  };

  // The funnels and websites a redirect can go to: the first page of each, by name.
  const sites = useQuery({
    queryKey: ['b', business.id, 'sites', 'redirect-targets'] as const,
    queryFn: async () => {
      const api = apiIn(business.id);
      const [funnels, websites] = await Promise.all([
        api.request(listSites, {
          query: { kind: 'funnel', sort: 'name', limit: SITE_LIMITS.page },
        }),
        api.request(listSites, {
          query: { kind: 'website', sort: 'name', limit: SITE_LIMITS.page },
        }),
      ]);
      return {
        items: [...funnels.items, ...websites.items],
        more: funnels.next !== null || websites.next !== null,
      };
    },
    retry: retryFaults,
  });
  const listed = sites.data?.items ?? [];
  // The site a redirect already goes to is offered even before, or without, the list.
  const held = redirect?.target.type === 'site' ? redirect.target : undefined;
  const own =
    held === undefined || listed.some((each) => each.id === held.siteId)
      ? []
      : [{ id: held.siteId, name: held.siteName, kind: held.siteKind }];
  const siteChoices = [...own, ...listed];
  const siteLabel = (site: { readonly name: string; readonly kind: 'funnel' | 'website' }) => {
    const { name } = site;
    return site.kind === 'funnel' ? t`${name} (funnel)` : t`${name} (website)`;
  };

  const save = useMutation({
    mutationFn: (body: Extract<ReturnType<typeof checkedRedirect>, { ok: true }>['body']) => {
      const api = apiIn(business.id);
      if ('revision' in body) {
        if (redirect === undefined) throw new Error('A change needs the redirect it changes.');
        return api.request(updateSiteRedirect, { params: { id: redirect.id }, body });
      }
      return api.request(createSiteRedirect, { body });
    },
    onSuccess: onSaved,
    onError: (error) => {
      setStale(isStale(error));
      refuse(
        error instanceof ApiError && error.problem.errors !== undefined
          ? redirectRejection(error.problem.errors)
          : savingProblem(
              error,
              t`The redirect wasn't saved. Check your connection and try again.`,
            ),
      );
    },
  });
  const reload = useMutation({
    mutationFn: () => apiIn(business.id).request(listSiteRedirects, {}),
    onSuccess: (fresh) => {
      queryClient.setQueryData(redirectsKey(business.id), fresh);
      const saved = fresh.items.find((each) => each.id === redirect?.id);
      if (saved === undefined) {
        onClose();
        return;
      }
      setDraft(redirectDraftOf(saved, ''));
      setRevision(saved.revision);
      setProblem(noRejection);
      setStale(false);
    },
  });
  const busy = save.isPending || reload.isPending;
  const ready = redirectReady(draft) && !busy;

  const refusalOf = (name: RedirectField): ReactElement | null =>
    problem.fields[name] === undefined ? null : (
      <FieldError match>{problem.fields[name]}</FieldError>
    );
  /** A choice among a few: the label, the select, and what the server said about it. */
  const choice = (
    name: RedirectField,
    label: string,
    value: string,
    onValue: (next: string) => void,
    options: ReactNode,
    disabled = false,
  ): ReactElement => {
    const said = problem.fields[name];
    return (
      <div className="flex flex-col gap-1.5">
        <label className={labelClassName}>
          {label}
          <Select
            aria-label={label}
            {...(said === undefined
              ? {}
              : { 'aria-describedby': `${errorId}-${name}`, 'aria-invalid': true })}
            disabled={disabled}
            value={value}
            onValueChange={onValue}
          >
            {options}
          </Select>
        </label>
        {said === undefined ? null : (
          <p
            id={`${errorId}-${name}`}
            role="alert"
            className="text-sm font-medium text-destructive"
          >
            {said}
          </p>
        )}
      </div>
    );
  };

  return (
    <SmallDialog
      open
      title={redirect === undefined ? <Trans>Add redirect</Trans> : <Trans>Edit redirect</Trans>}
      returnFocus={returnFocus}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          const checked = checkedRedirect(draft, revision);
          if (!checked.ok) {
            setStale(false);
            refuse(checked.problem);
            return;
          }
          setProblem(noRejection);
          save.mutate(checked.body);
        }}
      >
        {choice(
          'domainId',
          t`Domain`,
          draft.domainId,
          (next) => {
            change('domainId', next);
          },
          redirect === undefined ? (
            domains.map((each) => (
              <option key={each.id} value={each.id}>
                {each.hostname}
              </option>
            ))
          ) : (
            <option value={redirect.domainId}>{redirect.hostname}</option>
          ),
          redirect !== undefined,
        )}
        <Field name="path" invalid={problem.fields['path'] !== undefined}>
          <FieldLabel>
            <Trans>Path</Trans>
          </FieldLabel>
          <Input
            required
            maxLength={500}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={draft.path}
            onChange={(event) => {
              change('path', event.target.value);
            }}
          />
          <FieldDescription>
            <Trans>What follows the domain, starting with /. For example, /spring-offer.</Trans>
          </FieldDescription>
          {refusalOf('path')}
        </Field>
        {choice(
          'targetType',
          t`Send to`,
          draft.targetType,
          (next) => {
            change('targetType', next === 'site' ? 'site' : 'url');
          },
          <>
            <option value="url">{t`A web address`}</option>
            <option value="site">{t`A funnel or website`}</option>
          </>,
        )}
        {draft.targetType === 'site' ? (
          <>
            {choice(
              'siteId',
              t`Funnel or website`,
              draft.siteId === '' ? NO_SITE : draft.siteId,
              (next) => {
                change('siteId', next === NO_SITE ? '' : next);
              },
              <>
                <option value={NO_SITE}>
                  {sites.isPending ? t`Loading funnels and websites…` : t`Choose one`}
                </option>
                {siteChoices.map((each) => (
                  <option key={each.id} value={each.id}>
                    {siteLabel(each)}
                  </option>
                ))}
              </>,
            )}
            {sites.isError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                <Trans>The funnels and websites couldn't be loaded.</Trans>
              </p>
            ) : null}
            {sites.data?.more === true ? (
              <p className="text-sm text-muted-foreground">
                <Trans>Only the first funnels and websites by name are listed here.</Trans>
              </p>
            ) : null}
          </>
        ) : (
          <Field name="url" invalid={problem.fields['url'] !== undefined}>
            <FieldLabel>
              <Trans>Web address</Trans>
            </FieldLabel>
            <Input
              required
              maxLength={2000}
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.url}
              onChange={(event) => {
                change('url', event.target.value);
              }}
            />
            <FieldDescription>
              <Trans>Starting with https:// or http://.</Trans>
            </FieldDescription>
            {refusalOf('url')}
          </Field>
        )}
        {choice(
          'status',
          t`Type`,
          draft.status,
          (next) => {
            change('status', next === '302' ? '302' : '301');
          },
          <>
            <option value="301">{statusWords['301']}</option>
            <option value="302">{statusWords['302']}</option>
          </>,
        )}
        <FormProblem
          problem={problem}
          stale={stale}
          busy={busy}
          onReload={() => {
            reload.mutate();
          }}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={!ready}>
            {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

type Editing =
  { readonly kind: 'new' } | { readonly kind: 'edit'; readonly redirect: SiteRedirect } | undefined;

export function RedirectsView({
  onConnectDomain,
}: {
  /** Goes to the Domains view: a redirect needs a connected domain to live on. */
  readonly onConnectDomain: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const queryClient = useQueryClient();
  const statusWords = useStatusWords();
  const key = redirectsKey(business.id);
  const list = useQuery({
    queryKey: key,
    queryFn: () => apiIn(business.id).request(listSiteRedirects, {}),
    retry: retryFaults,
  });
  const domains = useQuery({
    queryKey: ['b', business.id, 'sites', 'domains'] as const,
    queryFn: () => apiIn(business.id).request(listSiteDomains, {}),
    retry: retryFaults,
  });
  const [editing, setEditing] = useState<Editing>();
  const [deleting, setDeleting] = useState<SiteRedirect>();
  const [deleteProblem, setDeleteProblem] = useState<string>();
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const remove = useMutation({
    mutationFn: (redirect: SiteRedirect) =>
      apiIn(business.id).request(deleteSiteRedirect, { params: { id: redirect.id } }),
    onSuccess: async (_, redirect) => {
      setDeleting(undefined);
      const address = redirectAddress(redirect);
      setNotice(t`The redirect at ${address} was deleted.`);
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => {
      setDeleteProblem(
        savingProblem(error, t`It wasn't deleted. Check your connection and try again.`).form,
      );
    },
  });

  if (list.error instanceof ApiError && list.error.status === 403) {
    return (
      <p role="alert" className="text-md">
        <Trans>You need permission to manage domains.</Trans>
      </p>
    );
  }
  const items = list.data?.items ?? [];
  const canManage = list.data?.canManage === true;
  const domainItems = domains.data?.items ?? [];
  const deletingAddress = deleting === undefined ? '' : redirectAddress(deleting);
  const addButton = (
    <Button
      onClick={(event) => {
        returnFocusRef.current = event.currentTarget;
        setEditing({ kind: 'new' });
      }}
    >
      <Trans>Add redirect</Trans>
    </Button>
  );

  return (
    <section aria-label={t`URL Redirects`} className={listCardClassName}>
      {list.data !== undefined && !canManage ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            You can look at redirects. Adding and changing them needs permission to manage domains.
          </Trans>
        </p>
      ) : null}
      {list.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading redirects…</Trans>
        </p>
      ) : null}
      {list.isError ? (
        <ListProblem
          onRetry={() => {
            void list.refetch();
          }}
        >
          {list.error instanceof ApiError ? (
            (list.error.problem.detail ?? <Trans>The redirects couldn't be loaded.</Trans>)
          ) : (
            <Trans>The redirects couldn't be loaded. Check your connection.</Trans>
          )}
        </ListProblem>
      ) : null}
      {list.data !== undefined && canManage && domains.data !== undefined ? (
        domainItems.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              <Trans>A redirect lives on a connected domain. Connect a domain first.</Trans>
            </p>
            <Button variant="secondary" size="small" onClick={onConnectDomain}>
              <Trans>Go to Domains</Trans>
            </Button>
          </div>
        ) : (
          <div className="flex justify-end">{addButton}</div>
        )
      ) : null}
      {list.data !== undefined && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            No redirects yet. A redirect sends an address on one of your domains to a funnel, a
            website or any web address.
          </Trans>
        </p>
      ) : null}
      {items.length > 0 ? (
        <div className={tableRegionClassName}>
          <table className={tableClassName}>
            <caption className="sr-only">
              <Trans>URL redirects, by domain and path</Trans>
            </caption>
            <thead>
              <tr>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Address</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Goes to</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Type</Trans>
                </th>
                {canManage ? (
                  <th scope="col" className={headerCellClassName}>
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {items.map((redirect) => {
                const address = redirectAddress(redirect);
                return (
                  <tr key={redirect.id}>
                    <th
                      scope="row"
                      className={`${cellClassName} text-left font-medium wrap-anywhere`}
                    >
                      {address}
                    </th>
                    <td className={`${cellClassName} wrap-anywhere`}>
                      {redirect.target.type === 'url' ? (
                        redirect.target.url
                      ) : (
                        <>
                          {redirect.target.siteName}{' '}
                          <span className="text-muted-foreground">
                            {redirect.target.siteKind === 'funnel' ? (
                              <Trans>(funnel)</Trans>
                            ) : (
                              <Trans>(website)</Trans>
                            )}
                          </span>
                        </>
                      )}
                    </td>
                    <td className={`${cellClassName} whitespace-nowrap`}>
                      {statusWords[redirect.status === 302 ? '302' : '301']}
                    </td>
                    {canManage ? (
                      <td className={`${cellClassName} text-right`}>
                        <RowMenu
                          label={t`Actions for ${address}`}
                          onOpen={(trigger) => {
                            returnFocusRef.current = trigger;
                          }}
                          actions={[
                            {
                              label: t`Edit`,
                              onSelect: () => {
                                setEditing({ kind: 'edit', redirect });
                              },
                            },
                            {
                              label: t`Delete`,
                              destructive: true,
                              onSelect: () => {
                                setDeleteProblem(undefined);
                                setDeleting(redirect);
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
      ) : null}
      <p role="status" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {editing === undefined ? null : (
        <RedirectDialog
          key={editing.kind === 'edit' ? editing.redirect.id : 'new'}
          redirect={editing.kind === 'edit' ? editing.redirect : undefined}
          domains={domainItems}
          returnFocus={returnFocusRef}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={async (saved) => {
            setEditing(undefined);
            const address = redirectAddress(saved);
            setNotice(t`The redirect at ${address} was saved.`);
            await queryClient.invalidateQueries({ queryKey: key });
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        title={<Trans>Delete redirect</Trans>}
        description={<Trans>{deletingAddress} will stop redirecting.</Trans>}
        confirmLabel={remove.isPending ? t`Deleting…` : t`Delete`}
        destructive
        busy={remove.isPending}
        problem={deleteProblem}
        returnFocus={returnFocusRef}
        onConfirm={() => {
          if (deleting !== undefined) remove.mutate(deleting);
        }}
        onClose={() => {
          if (!remove.isPending) setDeleting(undefined);
        }}
      />
    </section>
  );
}
