// The other tabs of a funnel's or a website's page, and its Share dialog: Stats (page views
// and opt-ins per step, with Reset), Security (the response headers the site adds), and
// Settings (the cards GoHighLevel has, with the fields the server keeps). Fetched when one
// of them is first opened. Sales and Events are not here: nothing serves them yet. Stats,
// Security and the settings that only a later stage applies are kept here and out of view
// until then (sites-rules.ts, SITE_STAGES).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  deleteSite,
  exportSite,
  getSite,
  getSiteStats,
  resetSiteStats,
  setSiteSecurityHeaders,
  updateSite,
  type Site,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { apiIn } from './api';
import { Switch } from './automation-switch';
import { noRejection, type Rejection } from './problems';
import {
  cellClassName,
  ConfirmDialog,
  FormProblem,
  headerCellClassName,
  iconButtonClassName,
  isStale,
  ListProblem,
  retryFaults,
  savingProblem,
  SmallDialog,
  tableClassName,
} from './settings-list';
import { FormRefusal } from './sites-dialogs';
import { useSitesNavigate } from './sites-links';
import {
  hasHeader,
  listSplat,
  rateText,
  SITE_STAGES,
  settingsChangeOf,
  settingsDraftOf,
  siteKey,
  type SecurityHeader,
  type SiteFlag,
  type SiteSettingsDraft,
} from './sites-rules';
import { useBusiness } from './workspace';

const cardClassName = 'flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-4';
const NONE = 'none';
// The Stats table's cells: narrower under a finger, so five columns fit a phone.
const headClassName = `${headerCellClassName} whitespace-normal max-sm:px-1.5`;
const numberClassName = `${cellClassName} text-right tabular-nums max-sm:px-1.5`;

/** The first thing a refusal says, wherever it says it. */
const saidBy = (error: unknown, fallback: string): string => {
  const words = savingProblem(error, fallback);
  return Object.values(words.fields)[0] ?? words.form ?? fallback;
};

export function SiteStats({ site }: { readonly site: Site }): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const funnel = site.kind === 'funnel';
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const resetRef = useRef<HTMLButtonElement>(null);
  const statsKey = ['b', business.id, 'sites', 'stats', site.id] as const;
  const stats = useQuery({
    queryKey: statsKey,
    queryFn: () => apiIn(business.id).request(getSiteStats, { params: { id: site.id }, query: {} }),
    retry: retryFaults,
  });
  const reset = useMutation({
    mutationFn: () => apiIn(business.id).request(resetSiteStats, { params: { id: site.id } }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: statsKey });
      setAsking(false);
      setNotice(t`The statistics were reset.`);
    },
    onError: (error) => {
      setProblem(saidBy(error, t`They weren't reset. Check your connection and try again.`));
    },
  });
  const day = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const number = new Intl.NumberFormat(i18n.locale);
  const read = stats.data;
  const firstDay = read === undefined ? '' : day.format(new Date(read.from));
  const lastDay = read === undefined ? '' : day.format(new Date(read.to));
  const siteName = site.name;
  const counts = (row: {
    readonly views: number;
    readonly uniqueViews: number;
    readonly optIns: number;
    readonly optInRate: number;
  }): ReactElement => (
    <>
      <td className={numberClassName}>{number.format(row.views)}</td>
      <td className={numberClassName}>{number.format(row.uniqueViews)}</td>
      <td className={numberClassName}>{number.format(row.optIns)}</td>
      <td className={numberClassName}>{rateText(row.optInRate, i18n.locale)}</td>
    </>
  );
  return (
    <section aria-label={t`Stats`} className={cardClassName}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-medium">
            <Trans>Stats</Trans>
          </h2>
          {read === undefined ? null : (
            <p className="text-sm text-muted-foreground">
              <Trans>
                {firstDay} to {lastDay}
              </Trans>
            </p>
          )}
        </div>
        {site.canManage ? (
          <Button
            ref={resetRef}
            variant="secondary"
            onClick={() => {
              setNotice('');
              setProblem(undefined);
              setAsking(true);
            }}
          >
            <Trans>Reset</Trans>
          </Button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {stats.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {stats.isError ? (
        <ListProblem
          onRetry={() => {
            void stats.refetch();
          }}
        >
          <Trans>The statistics couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {read === undefined ? null : read.steps.length === 0 ? (
        <p className="py-6 text-center text-md text-muted-foreground">
          {funnel ? (
            <Trans>This funnel has no steps to count yet.</Trans>
          ) : (
            <Trans>This website has no pages to count yet.</Trans>
          )}
        </p>
      ) : (
        // Nothing to press inside, so it folds to the width it is given instead of scrolling.
        <div className="rounded-lg border border-border">
          <table className={`${tableClassName} table-fixed`}>
            <caption className="sr-only">
              <Trans>Page views and opt-ins for each step</Trans>
            </caption>
            <thead>
              <tr>
                <th scope="col" rowSpan={2} className={`${headClassName} w-2/5`}>
                  {funnel ? <Trans>Step</Trans> : <Trans>Page</Trans>}
                </th>
                <th scope="colgroup" colSpan={2} className={`${headClassName} text-center`}>
                  <Trans>Page Views</Trans>
                </th>
                <th scope="colgroup" colSpan={2} className={`${headClassName} text-center`}>
                  <Trans>Opt-Ins</Trans>
                </th>
              </tr>
              <tr>
                <th scope="col" className={`${headClassName} text-right`}>
                  <Trans>All</Trans>
                </th>
                <th scope="col" className={`${headClassName} text-right`}>
                  <Trans>Uniques</Trans>
                </th>
                <th scope="col" className={`${headClassName} text-right`}>
                  <Trans>All</Trans>
                </th>
                <th scope="col" className={`${headClassName} text-right`}>
                  <Trans>Rate</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {read.steps.map((step) => (
                <Fragment key={step.stepId}>
                  <tr>
                    <th
                      scope="row"
                      className={`${cellClassName} text-left font-medium wrap-anywhere max-sm:px-1.5`}
                    >
                      {step.name}
                    </th>
                    {counts(step)}
                  </tr>
                  {step.pages.length < 2
                    ? null
                    : step.pages.map((page) => (
                        <tr key={page.pageId}>
                          <th
                            scope="row"
                            className={`${cellClassName} pl-6 text-left font-normal wrap-anywhere text-muted-foreground max-sm:pl-3`}
                          >
                            {page.role === 'control' ? (
                              <Trans>Control</Trans>
                            ) : (
                              <Trans>Variation</Trans>
                            )}
                          </th>
                          {counts(page)}
                        </tr>
                      ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={asking}
        title={<Trans>Reset statistics</Trans>}
        description={
          <Trans>
            Every count of {siteName} goes back to zero, for good. This can't be undone.
          </Trans>
        }
        confirmLabel={t`Reset for good`}
        destructive
        busy={reset.isPending}
        problem={problem}
        returnFocus={resetRef}
        onClose={() => {
          setAsking(false);
        }}
        onConfirm={() => {
          setProblem(undefined);
          reset.mutate();
        }}
      />
    </section>
  );
}

export function SiteSecurity({ site }: { readonly site: Site }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const addRef = useRef<HTMLButtonElement>(null);
  const save = useMutation({
    mutationFn: (headers: readonly SecurityHeader[]) =>
      apiIn(business.id).request(setSiteSecurityHeaders, {
        params: { id: site.id },
        body: { revision: site.revision, headers: [...headers] },
      }),
    onSuccess: (saved) => {
      cache.setQueryData(siteKey(business.id, site.id), saved);
    },
    onError: (error) => {
      const said = saidBy(
        error,
        t`The headers weren't saved. Check your connection and try again.`,
      );
      if (adding) setProblem(said);
      else setNotice(said);
      if (isStale(error)) void cache.invalidateQueries({ queryKey: siteKey(business.id, site.id) });
    },
  });
  const headers = site.securityHeaders;
  const twice = hasHeader(headers, name);
  const words = {
    remove: (header: string) => t`Remove ${header}`,
    removed: (header: string) => t`${header} was removed.`,
  };
  const ready = name.trim() !== '' && value.trim() !== '' && !twice && !save.isPending;
  return (
    <section aria-label={t`Security Headers`} className={cardClassName}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-medium">
            <Trans>Security Headers</Trans>
          </h2>
          <p className="text-sm text-muted-foreground">
            <Trans>Response headers added to every page of this site.</Trans>
          </p>
        </div>
        {site.canManage ? (
          <Button
            ref={addRef}
            variant="secondary"
            onClick={() => {
              setName('');
              setValue('');
              setNotice('');
              setProblem(undefined);
              setAdding(true);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>Add security header</Trans>
          </Button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {headers.length === 0 ? (
        <p className="py-6 text-center text-md text-muted-foreground">
          <Trans>No security headers yet.</Trans>
        </p>
      ) : (
        <table className={`${tableClassName} table-fixed`}>
          <caption className="sr-only">
            <Trans>Security Headers</Trans>
          </caption>
          <thead>
            <tr>
              <th scope="col" className={`${headerCellClassName} w-2/5`}>
                <Trans>Header</Trans>
              </th>
              <th scope="col" className={headerCellClassName}>
                <Trans>Value</Trans>
              </th>
              {site.canManage ? (
                <th scope="col" className={`${headerCellClassName} w-16`}>
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {headers.map((header) => (
              <tr key={header.name}>
                <th scope="row" className={`${cellClassName} text-left font-medium wrap-anywhere`}>
                  {header.name}
                </th>
                <td className={`${cellClassName} font-mono text-xs wrap-anywhere`}>
                  {header.value}
                </td>
                {site.canManage ? (
                  <td className={`${cellClassName} text-right`}>
                    <button
                      type="button"
                      className={iconButtonClassName}
                      aria-label={words.remove(header.name)}
                      disabled={save.isPending}
                      onClick={() => {
                        setNotice('');
                        save.mutate(
                          headers.filter((each) => each.name !== header.name),
                          {
                            onSuccess: () => {
                              setNotice(words.removed(header.name));
                            },
                          },
                        );
                      }}
                    >
                      <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding ? (
        <SmallDialog
          open
          title={<Trans>Add security header</Trans>}
          returnFocus={addRef}
          onClose={() => {
            if (!save.isPending) setAdding(false);
          }}
        >
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!ready) return;
              setProblem(undefined);
              const added = name.trim();
              save.mutate([...headers, { name: added, value: value.trim() }], {
                onSuccess: () => {
                  setAdding(false);
                  setNotice(t`${added} was added.`);
                },
              });
            }}
          >
            <Field name="name" invalid={twice}>
              <FieldLabel>
                <Trans>Header</Trans>
              </FieldLabel>
              <Input
                required
                maxLength={100}
                autoComplete="off"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <FieldDescription>
                <Trans>For example, X-Frame-Options.</Trans>
              </FieldDescription>
              {twice ? (
                <FieldError match>
                  <Trans>This site already adds that header.</Trans>
                </FieldError>
              ) : null}
            </Field>
            <Field name="value">
              <FieldLabel>
                <Trans>Value</Trans>
              </FieldLabel>
              <Input
                required
                maxLength={4000}
                autoComplete="off"
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            </Field>
            <FormRefusal problem={{ fields: {}, form: problem }} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                disabled={save.isPending}
                onClick={() => {
                  setAdding(false);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" disabled={!ready}>
                {save.isPending ? <Trans>Saving…</Trans> : <Trans>Add</Trans>}
              </Button>
            </div>
          </form>
        </SmallDialog>
      ) : null}
    </section>
  );
}

function FlagRow({
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  readonly title: ReactNode;
  readonly hint: ReactNode;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactElement {
  const titleId = useId();
  const hintId = useId();
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={titleId} className="text-sm font-medium">
          {title}
        </span>
        <span id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </span>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-labelledby={titleId}
        aria-describedby={hintId}
        onChange={onChange}
      />
    </div>
  );
}

// The library and what a page needs of it (a public address): fetched when first asked for.
const MediaChoice = lazy(() => import('./site-media-choice'));
// How visitors arrived, kept between pages: three answers and their sentences, fetched apart.
const ArrivalSetting = lazy(() => import('./site-arrival-setting'));

export function SiteSettings({ site }: { readonly site: Site }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const go = useSitesNavigate();
  const api = apiIn(business.id);
  const funnel = site.kind === 'funnel';
  const [draft, setDraft] = useState(() => settingsDraftOf(site));
  const [choosingFavicon, setChoosingFavicon] = useState(false);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<string>();
  const deleteRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [refusals, setRefusals] = useState(0);
  // The keyboard goes to the first field a refusal names, in the order the form shows them.
  useEffect(() => {
    if (refusals > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refusals]);
  const domains = useQuery({
    queryKey: ['b', business.id, 'sites', 'domains'] as const,
    queryFn: async () => (await import('./site-settings-reads')).readSiteDomains(business.id),
    retry: retryFaults,
    enabled: SITE_STAGES.connectedDomains,
  });
  const widgets = useQuery({
    queryKey: ['b', business.id, 'sites', 'chat-widgets'] as const,
    queryFn: async () => (await import('./site-settings-reads')).readChatWidgets(business.id),
    retry: retryFaults,
    enabled: SITE_STAGES.connectedDomains,
  });
  const change = settingsChangeOf(site, draft);
  const save = useMutation({
    mutationFn: (body: NonNullable<typeof change>) =>
      api.request(updateSite, { params: { id: site.id }, body }),
    onSuccess: (saved) => {
      cache.setQueryData(siteKey(business.id, site.id), saved);
      setDraft(settingsDraftOf(saved));
      setNotice(t`Settings saved.`);
      void cache.invalidateQueries({ queryKey: ['b', business.id, 'sites', 'list'] });
    },
    onError: (error) => {
      setStale(isStale(error));
      setProblem(
        savingProblem(error, t`The settings weren't saved. Check your connection and try again.`),
      );
      setRefusals((count) => count + 1);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.request(deleteSite, { params: { id: site.id } }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['b', business.id, 'sites', 'list'] });
      go(listSplat(site.kind), true);
    },
    onError: (error) => {
      setDeleteProblem(saidBy(error, t`It wasn't deleted. Check your connection and try again.`));
    },
  });
  const readOnly = !site.canManage;
  const set = <Key extends keyof SiteSettingsDraft>(
    key: Key,
    value: SiteSettingsDraft[Key],
  ): void => {
    setDraft((now) => ({ ...now, [key]: value }));
    setNotice('');
    setProblem((now) =>
      now.fields[key] === undefined
        ? now
        : {
            form: now.form,
            fields: Object.fromEntries(Object.entries(now.fields).filter(([name]) => name !== key)),
          },
    );
  };
  const refusalOf = (key: keyof SiteSettingsDraft): ReactElement | null =>
    problem.fields[key] === undefined ? null : <FieldError match>{problem.fields[key]}</FieldError>;
  const flag = (key: SiteFlag, title: ReactNode, hint: ReactNode): ReactElement => (
    <FlagRow
      title={title}
      hint={hint}
      checked={draft[key]}
      disabled={readOnly}
      onChange={(checked) => {
        set(key, checked);
      }}
    />
  );
  const domainItems = domains.data?.items ?? [];
  // The site's own domain is offered even before, or without, the list of domains.
  const domainChoices =
    site.domain === null || domainItems.some((each) => each.id === site.domain?.id)
      ? domainItems.map((each) => ({
          id: each.id,
          hostname: each.hostname,
          verified: each.verification.status === 'verified',
        }))
      : [site.domain];
  const widgetItems = widgets.data?.data ?? [];
  const unverified = (hostname: string): string => t`${hostname} (not verified yet)`;
  const siteName = site.name;
  return (
    <form
      ref={formRef}
      noValidate
      aria-label={funnel ? t`Funnel settings` : t`Website settings`}
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (change === undefined || save.isPending) return;
        setProblem(noRejection);
        setStale(false);
        save.mutate(change);
      }}
    >
      {readOnly ? (
        <p className="text-md text-muted-foreground">
          <Trans>
            You can look at these settings. Changing them needs permission to manage sites.
          </Trans>
        </p>
      ) : null}
      <section className={cardClassName}>
        <h2 className="text-base font-medium">
          {funnel ? <Trans>Funnel details</Trans> : <Trans>Website details</Trans>}
        </h2>
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <Field name="name" invalid={problem.fields['name'] !== undefined}>
            <FieldLabel>
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              required
              maxLength={120}
              autoComplete="off"
              disabled={readOnly}
              value={draft.name}
              onChange={(event) => {
                set('name', event.target.value);
              }}
            />
            {refusalOf('name')}
          </Field>
          {SITE_STAGES.connectedDomains ? (
            <>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  <Trans>Domain</Trans>
                  <Select
                    aria-label={t`Domain`}
                    disabled={readOnly}
                    aria-invalid={problem.fields['domainId'] !== undefined}
                    value={draft.domainId === '' ? NONE : draft.domainId}
                    onValueChange={(next) => {
                      set('domainId', next === NONE ? '' : next);
                    }}
                  >
                    <option value={NONE}>{t`No domain`}</option>
                    {domainChoices.map((each) => (
                      <option key={each.id} value={each.id}>
                        {each.verified ? each.hostname : unverified(each.hostname)}
                      </option>
                    ))}
                  </Select>
                </label>
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Can't find your domain? Connecting one is done in Settings, on a page that isn't
                    available yet.
                  </Trans>
                </p>
                {problem.fields['domainId'] === undefined ? null : (
                  <p role="alert" className="text-sm font-medium text-destructive">
                    {problem.fields['domainId']}
                  </p>
                )}
              </div>
              <Field name="path" invalid={problem.fields['path'] !== undefined}>
                <FieldLabel>
                  <Trans>Path</Trans>
                </FieldLabel>
                <Input
                  maxLength={200}
                  autoComplete="off"
                  autoCapitalize="none"
                  disabled={readOnly}
                  value={draft.path}
                  onChange={(event) => {
                    set('path', event.target.value);
                  }}
                />
                <FieldDescription>
                  <Trans>Lowercase letters, numbers and hyphens, with / between parts.</Trans>
                </FieldDescription>
                {refusalOf('path')}
              </Field>
            </>
          ) : null}
          <Field name="faviconUrl" invalid={problem.fields['faviconUrl'] !== undefined}>
            <FieldLabel>
              <Trans>Favicon URL</Trans>
            </FieldLabel>
            <Input
              inputMode="url"
              maxLength={2000}
              autoComplete="off"
              autoCapitalize="none"
              disabled={readOnly}
              value={draft.faviconUrl}
              onChange={(event) => {
                set('faviconUrl', event.target.value);
              }}
            />
            {refusalOf('faviconUrl')}
            {readOnly ? null : (
              <Button
                variant="secondary"
                size="small"
                className="self-start"
                onClick={() => {
                  setChoosingFavicon(true);
                }}
              >
                <Trans>Choose from Media Storage</Trans>
              </Button>
            )}
          </Field>
          {choosingFavicon ? (
            <Suspense fallback={null}>
              <MediaChoice
                businessId={business.id}
                title={<Trans>Choose a favicon</Trans>}
                onChosen={(address) => {
                  set('faviconUrl', address);
                  setChoosingFavicon(false);
                }}
                onClose={() => {
                  setChoosingFavicon(false);
                }}
              />
            </Suspense>
          ) : null}
        </div>
      </section>
      <Suspense fallback={null}>
        <ArrivalSetting
          value={draft.keepArrival}
          disabled={readOnly}
          onChange={(next) => {
            set('keepArrival', next);
          }}
        />
      </Suspense>
      {SITE_STAGES.connectedDomains ? (
        <section className={cardClassName}>
          <h2 className="text-base font-medium">
            <Trans>Tracking and scripts</Trans>
          </h2>
          <Field name="headCode" invalid={problem.fields['headCode'] !== undefined}>
            <FieldLabel>
              <Trans>Head tracking code</Trans>
            </FieldLabel>
            <Textarea
              rows={4}
              maxLength={50000}
              className="font-mono text-xs"
              disabled={readOnly}
              value={draft.headCode}
              onChange={(event) => {
                set('headCode', event.target.value);
              }}
            />
            {refusalOf('headCode')}
          </Field>
          <Field name="bodyCode" invalid={problem.fields['bodyCode'] !== undefined}>
            <FieldLabel>
              <Trans>Body tracking code</Trans>
            </FieldLabel>
            <Textarea
              rows={4}
              maxLength={50000}
              className="font-mono text-xs"
              disabled={readOnly}
              value={draft.bodyCode}
              onChange={(event) => {
                set('bodyCode', event.target.value);
              }}
            />
            {refusalOf('bodyCode')}
          </Field>
          <div className="flex max-w-md min-w-0 flex-col gap-1.5">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <Trans>Chat widget</Trans>
              <Select
                aria-label={t`Chat widget`}
                disabled={readOnly}
                aria-invalid={problem.fields['chatWidgetId'] !== undefined}
                value={draft.chatWidgetId === '' ? NONE : draft.chatWidgetId}
                onValueChange={(next) => {
                  set('chatWidgetId', next === NONE ? '' : next);
                }}
              >
                <option value={NONE}>{t`None`}</option>
                {widgetItems.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
                {site.chatWidgetId !== null &&
                !widgetItems.some((each) => each.id === site.chatWidgetId) ? (
                  <option value={site.chatWidgetId}>{t`The widget chosen now`}</option>
                ) : null}
              </Select>
            </label>
            {problem.fields['chatWidgetId'] === undefined ? null : (
              <p role="alert" className="text-sm font-medium text-destructive">
                {problem.fields['chatWidgetId']}
              </p>
            )}
          </div>
        </section>
      ) : null}
      {SITE_STAGES.selling ? (
        <section className={cardClassName}>
          <h2 className="text-base font-medium">
            <Trans>Payments and checkout</Trans>
          </h2>
          <p className="text-sm text-muted-foreground">
            <Trans>These two are kept for selling from a page, which isn't available yet.</Trans>
          </p>
          {flag(
            'paymentLive',
            <Trans>Payment mode: Live</Trans>,
            <Trans>
              Turn this on to accept live payments through your connected payment providers
            </Trans>,
          )}
          {flag(
            'requireCard',
            <Trans>Require credit card</Trans>,
            <Trans>Even for $0 purchases.</Trans>,
          )}
        </section>
      ) : null}
      {SITE_STAGES.pageSpeed ? (
        <section className={cardClassName}>
          <h2 className="text-base font-medium">
            <Trans>Performance and compliance</Trans>
          </h2>
          {flag(
            'optimizeImages',
            <Trans>Image Optimization</Trans>,
            <Trans>Images are served from a CDN with caching.</Trans>,
          )}
          {flag(
            'lazyCustomCode',
            <Trans>Optimize JavaScript</Trans>,
            <Trans>Custom code is lazy loaded.</Trans>,
          )}
          {flag(
            'privacyFonts',
            <Trans>GDPR compliant fonts</Trans>,
            <Trans>Fonts are served by this site instead of Google Fonts.</Trans>,
          )}
        </section>
      ) : null}
      {SITE_STAGES.pageSpeed ? (
        <section className={cardClassName}>
          <h2 className="text-base font-medium">
            <Trans>SEO and AEO</Trans>
          </h2>
          {flag(
            'autoSchema',
            <Trans>Auto-generate schema</Trans>,
            <Trans>Adds schema markup on publish to pages that have none.</Trans>,
          )}
        </section>
      ) : null}
      <FormProblem
        problem={problem}
        stale={stale}
        busy={save.isPending}
        onReload={() => {
          void api.request(getSite, { params: { id: site.id } }).then(
            (fresh) => {
              cache.setQueryData(siteKey(business.id, site.id), fresh);
              setDraft(settingsDraftOf(fresh));
              setProblem(noRejection);
              setStale(false);
            },
            () => undefined,
          );
        }}
      />
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {readOnly ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            ref={deleteRef}
            variant="secondary"
            className="border-destructive text-destructive"
            disabled={save.isPending}
            onClick={() => {
              setDeleteProblem(undefined);
              setDeleting(true);
            }}
          >
            {funnel ? <Trans>Delete funnel</Trans> : <Trans>Delete website</Trans>}
          </Button>
          <Button type="submit" disabled={change === undefined || save.isPending}>
            {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={deleting}
        title={funnel ? <Trans>Delete funnel</Trans> : <Trans>Delete website</Trans>}
        description={
          <Trans>
            This will permanently remove {siteName} with all its pages, settings and data. It is
            deleted for good and can't be undone.
          </Trans>
        }
        confirmLabel={t`Delete for good`}
        destructive
        busy={remove.isPending}
        problem={deleteProblem}
        returnFocus={deleteRef}
        onClose={() => {
          setDeleting(false);
        }}
        onConfirm={() => {
          setDeleteProblem(undefined);
          remove.mutate();
        }}
      />
    </form>
  );
}

/** Share: the site as a signed text another business of the agency can import. */
export function ShareDialog({
  site,
  returnFocus,
  onClose,
}: {
  readonly site: Site;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const funnel = site.kind === 'funnel';
  const [copied, setCopied] = useState(false);
  const make = useMutation({
    mutationFn: () => apiIn(business.id).request(exportSite, { params: { id: site.id } }),
  });
  const bundle = make.data?.bundle;
  return (
    <SmallDialog
      open
      title={funnel ? <Trans>Share funnel</Trans> : <Trans>Share website</Trans>}
      description={
        <Trans>
          Makes a text that another business of this agency can import as a copy. It leaves out the
          domain, the chat widget, tracking codes and statistics.
        </Trans>
      }
      returnFocus={returnFocus}
      onClose={onClose}
    >
      {bundle === undefined ? (
        <Button
          className="self-start"
          disabled={make.isPending}
          onClick={() => {
            make.mutate();
          }}
        >
          {make.isPending ? <Trans>Preparing…</Trans> : <Trans>Create share text</Trans>}
        </Button>
      ) : (
        <>
          <Field name="bundle">
            <FieldLabel>
              <Trans>Share text</Trans>
            </FieldLabel>
            <Textarea readOnly rows={6} className="font-mono text-xs break-all" value={bundle} />
          </Field>
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => {
              void navigator.clipboard.writeText(bundle).then(
                () => {
                  setCopied(true);
                },
                () => undefined,
              );
            }}
          >
            <Trans>Copy text</Trans>
          </Button>
        </>
      )}
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {copied ? t`Copied.` : ''}
      </p>
      {make.isError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {saidBy(make.error, t`It couldn't be shared. Check your connection and try again.`)}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          variant="secondary"
          onClick={() => {
            onClose();
          }}
        >
          <Trans>Done</Trans>
        </Button>
      </div>
    </SmallDialog>
  );
}
