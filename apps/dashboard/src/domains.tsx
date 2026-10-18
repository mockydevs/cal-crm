// Settings → Domains & URL Redirects: the domains a business has connected for its funnels
// and websites, and the redirects on them.
//
// GoHighLevel's page (`settings/domain`, read live 2026-10-11) has two tabs, Domains and
// URL Redirects, and with no domain a panel "Purchase or Transfer-In Domain". The owner
// decided the same day that nothing here buys or transfers a domain: the page connects one
// a business already owns, and for someone without one there is a plain link to a
// registrar's own site. Connecting is one DNS record, a CNAME for a subdomain or an A
// record for a root domain, the two shapes GoHighLevel's help shows
// (https://help.gohighlevel.com/support/solutions/articles/48001153720-set-up-a-root-domain-or-subdomain-for-highlevel-sites);
// the record is shown exactly as the server gives it, and Check asks the server to look it
// up.
//
// An install that has not been told where its sites answer gives no record and refuses a
// check: the page says so in a sentence. Reading is open to the business; changing anything
// needs the permission the server reports with canManage.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  createSiteDomain,
  deleteSiteDomain,
  listSiteDomains,
  updateSiteDomain,
  verifySiteDomain,
  type SiteDomain,
  type SiteDomainList,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { EmptyState } from '@repo/ui/components/empty-state';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from './api';
import { RedirectsView } from './domain-redirects';
import {
  checkedHostname,
  REGISTRAR_NAME,
  REGISTRAR_URL,
  type DomainsView as View,
} from './domain-rules';
import { noRejection, type Rejection } from './problems';
import {
  ConfirmDialog,
  iconButtonClassName,
  listCardClassName,
  ListProblem,
  retryFaults,
  savingProblem,
  SmallDialog,
  ViewSwitch,
} from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

/** The list of domains, shared with a site's own Settings, which offers them by name. */
export const domainsKey = (businessId: string) => ['b', businessId, 'sites', 'domains'] as const;

const outsideLinkClassName = 'text-link underline underline-offset-2';

/** For someone with no domain yet: a registrar's own site. Nothing is bought in this product. */
function RegistrarLink(): ReactElement {
  return (
    <p className="text-sm text-muted-foreground">
      <Trans>
        Don't have a domain yet? Get one at{' '}
        <a
          href={REGISTRAR_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={outsideLinkClassName}
        >
          {REGISTRAR_NAME} (opens in a new tab)
        </a>
        , then come back and connect it.
      </Trans>
    </p>
  );
}

/** One value of a DNS record as it must be typed at the DNS provider, and the button that copies it. */
function RecordValue({
  value,
  copyLabel,
  onCopied,
}: {
  readonly value: string;
  readonly copyLabel: string;
  readonly onCopied: (value: string) => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <code className="min-w-0 rounded-control bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere text-body">
        {value}
      </code>
      <button
        type="button"
        className={iconButtonClassName}
        aria-label={copyLabel}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              onCopied(value);
            },
            () => undefined,
          );
        }}
      >
        {copied ? (
          <Check aria-hidden className="size-4 text-success" strokeWidth={2} />
        ) : (
          <Copy aria-hidden className="size-4" strokeWidth={1.8} />
        )}
      </button>
    </span>
  );
}

const termClassName = 'self-center text-sm text-muted-foreground';

function DomainCard({
  domain,
  canManage,
  onNotice,
  onCopied,
  onRemove,
}: {
  readonly domain: SiteDomain;
  readonly canManage: boolean;
  /** Something the page says once, for everyone: what a check found. */
  readonly onNotice: (notice: string) => void;
  readonly onCopied: (value: string) => void;
  readonly onRemove: (domain: SiteDomain, opener: HTMLElement | null) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const { hostname, record, verification } = domain;
  const key = domainsKey(business.id);
  const put = (next: SiteDomain) => {
    queryClient.setQueryData<SiteDomainList>(key, (now) =>
      now === undefined
        ? now
        : { ...now, items: now.items.map((each) => (each.id === next.id ? next : each)) },
    );
  };

  const check = useMutation({
    mutationFn: () => apiIn(business.id).request(verifySiteDomain, { params: { id: domain.id } }),
    onSuccess: (checked) => {
      put(checked);
      setProblem(undefined);
      onNotice(
        checked.verification.status === 'verified'
          ? t`${hostname} is verified.`
          : t`${hostname} isn't verified yet.`,
      );
    },
    onError: (error) => {
      // The one thing a check is refused for: the install has no sites address.
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t`It wasn't checked: this install's sites address isn't set up yet.`
          : savingProblem(error, t`It wasn't checked. Check your connection and try again.`).form,
      );
    },
  });
  const www = useMutation({
    mutationFn: (wwwRedirect: boolean) =>
      apiIn(business.id).request(updateSiteDomain, {
        params: { id: domain.id },
        body: { revision: domain.revision, wwwRedirect },
      }),
    onSuccess: (saved) => {
      put(saved);
      setProblem(undefined);
    },
    onError: async (error) => {
      setProblem(
        savingProblem(error, t`It wasn't saved. Check your connection and try again.`).form,
      );
      // Someone else changed the domain first: show what is saved now.
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  const statuses: Readonly<Record<SiteDomain['verification']['status'], string>> = {
    pending: t`Pending`,
    verified: t`Verified`,
    failed: t`Failed`,
  };
  const certificates: Readonly<Record<Exclude<SiteDomain['certificateStatus'], 'none'>, string>> = {
    pending: t`Certificate: pending`,
    issued: t`Certificate: issued`,
    failed: t`Certificate: failed`,
  };
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const checkedAt =
    verification.checkedAt === null ? null : moment.format(new Date(verification.checkedAt));
  const busy = check.isPending || www.isPending;

  return (
    <li>
      <section
        aria-label={hostname}
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="min-w-0 text-base font-medium wrap-anywhere">{hostname}</h2>
          <Badge size="count">{statuses[verification.status]}</Badge>
          {domain.certificateStatus === 'none' ? null : (
            <Badge size="count">{certificates[domain.certificateStatus]}</Badge>
          )}
          {canManage ? (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={busy}
                onClick={() => {
                  setProblem(undefined);
                  check.mutate();
                }}
              >
                {check.isPending ? <Trans>Checking…</Trans> : <Trans>Check</Trans>}
              </Button>
              <Button
                variant="secondary"
                size="small"
                className="border-destructive text-destructive"
                disabled={busy}
                onClick={(event) => {
                  onRemove(domain, event.currentTarget);
                }}
              >
                <Trans>Remove</Trans>
              </Button>
            </div>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          <span>
            <Plural
              value={domain.siteCount}
              _0="Not linked to a funnel or website."
              one="Linked to # funnel or website."
              other="Linked to # funnels and websites."
            />
          </span>{' '}
          <span>
            {checkedAt === null ? (
              <Trans>Not checked yet.</Trans>
            ) : (
              <Trans>Last checked {checkedAt}.</Trans>
            )}
          </span>
        </p>
        {verification.status === 'failed' && verification.error !== null ? (
          <p className="text-sm font-medium text-destructive">{verification.error}</p>
        ) : null}
        {record === null ? (
          <p className="text-sm">
            <Trans>
              This install's sites address isn't set up yet, so there is no DNS record to add and
              the domain can't be checked. Whoever runs this install sets that address up.
            </Trans>
          </p>
        ) : (
          <div role="group" aria-label={t`DNS record`} className="flex min-w-0 flex-col gap-2">
            <p className="text-sm">
              {verification.status === 'verified' ? (
                <Trans>Keep this record at your DNS provider:</Trans>
              ) : (
                <Trans>
                  Add this record at your DNS provider, then press Check. A new record can take a
                  while to be seen.
                </Trans>
              )}
            </p>
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              <dt className={termClassName}>
                <Trans>Type</Trans>
              </dt>
              <dd className="flex min-h-11 items-center lg:min-h-8">
                <code className="rounded-control bg-muted px-1.5 py-0.5 font-mono text-xs text-body">
                  {record.type}
                </code>
              </dd>
              <dt className={termClassName}>
                <Trans>Name</Trans>
              </dt>
              <dd className="min-w-0">
                <RecordValue value={record.host} copyLabel={t`Copy name`} onCopied={onCopied} />
              </dd>
              <dt className={termClassName}>
                <Trans>Value</Trans>
              </dt>
              <dd className="min-w-0">
                <RecordValue value={record.value} copyLabel={t`Copy value`} onCopied={onCopied} />
              </dd>
            </dl>
          </div>
        )}
        {record?.type === 'A' ? (
          <label className="flex min-h-11 min-w-0 items-center gap-2 text-sm wrap-anywhere lg:min-h-8">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-primary"
              checked={domain.wwwRedirect}
              disabled={!canManage || busy}
              onChange={(event) => {
                www.mutate(event.target.checked);
              }}
            />
            <Trans>
              Also answer at www.{hostname}, and send it to {hostname}
            </Trans>
          </label>
        ) : null}
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
      </section>
    </li>
  );
}

function ConnectDialog({
  returnFocus,
  onConnected,
  onClose,
}: {
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onConnected: (domain: SiteDomain) => Promise<void>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [hostname, setHostname] = useState('');
  // What the last try was refused with; it goes when the box changes or Connect is pressed again.
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const connect = useMutation({
    mutationFn: (body: { readonly hostname: string }) =>
      apiIn(business.id).request(createSiteDomain, { body }),
    onSuccess: onConnected,
    onError: (error) => {
      setProblem(
        savingProblem(error, t`It wasn't connected. Check your connection and try again.`),
      );
    },
  });
  const ready = hostname.trim() !== '' && !connect.isPending;
  return (
    <SmallDialog
      open
      title={<Trans>Connect a domain</Trans>}
      description={
        <Trans>
          Type a domain or subdomain you own. You'll get one DNS record to add at your DNS provider.
        </Trans>
      }
      returnFocus={returnFocus}
      onClose={() => {
        if (!connect.isPending) onClose();
      }}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          const checked = checkedHostname(hostname);
          if (!checked.ok) {
            setProblem(checked.problem);
            return;
          }
          setProblem(noRejection);
          connect.mutate(checked.body);
        }}
      >
        <Field name="hostname" invalid={problem.fields['hostname'] !== undefined}>
          <FieldLabel>
            <Trans>Domain</Trans>
          </FieldLabel>
          <Input
            required
            maxLength={253}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={hostname}
            onChange={(event) => {
              setHostname(event.target.value);
              setProblem(noRejection);
            }}
          />
          <FieldDescription>
            <Trans>For example, www.example.com or example.com, without https://.</Trans>
          </FieldDescription>
          {problem.fields['hostname'] === undefined ? null : (
            <FieldError match>{problem.fields['hostname']}</FieldError>
          )}
        </Field>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={connect.isPending}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={!ready}>
            {connect.isPending ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

function DomainsList(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const queryClient = useQueryClient();
  const key = domainsKey(business.id);
  const list = useQuery({
    queryKey: key,
    queryFn: () => apiIn(business.id).request(listSiteDomains, {}),
    retry: retryFaults,
  });
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<SiteDomain>();
  const [removeProblem, setRemoveProblem] = useState<string>();
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const remove = useMutation({
    mutationFn: (domain: SiteDomain) =>
      apiIn(business.id).request(deleteSiteDomain, { params: { id: domain.id } }),
    onSuccess: async (_, domain) => {
      setRemoving(undefined);
      const { hostname } = domain;
      setNotice(t`${hostname} was removed.`);
      // Its redirects went with it, and its sites are now without a domain.
      await queryClient.invalidateQueries({ queryKey: ['b', business.id, 'sites'] });
    },
    onError: (error) => {
      setRemoveProblem(
        savingProblem(error, t`It wasn't removed. Check your connection and try again.`).form,
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
  const copied = (value: string) => {
    setNotice(t`Copied ${value}`);
  };
  const connectButton = (
    <Button
      onClick={(event) => {
        returnFocusRef.current = event.currentTarget;
        setConnecting(true);
      }}
    >
      <Trans>Connect a domain</Trans>
    </Button>
  );
  const removingName = removing?.hostname ?? '';

  return (
    <section aria-label={t`Domains`} className={listCardClassName}>
      {list.data !== undefined && !canManage ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            You can look at domains. Connecting, checking and removing them needs permission to
            manage domains.
          </Trans>
        </p>
      ) : null}
      {list.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading domains…</Trans>
        </p>
      ) : null}
      {list.isError ? (
        <ListProblem
          onRetry={() => {
            void list.refetch();
          }}
        >
          {list.error instanceof ApiError ? (
            (list.error.problem.detail ?? <Trans>The domains couldn't be loaded.</Trans>)
          ) : (
            <Trans>The domains couldn't be loaded. Check your connection.</Trans>
          )}
        </ListProblem>
      ) : null}
      {list.data !== undefined && items.length === 0 ? (
        <EmptyState
          className="border-0 p-2"
          title={<Trans>No domains connected yet</Trans>}
          description={
            <Trans>Connect a domain you own, and your funnels and websites can answer at it.</Trans>
          }
          action={
            <div className="flex flex-col items-start gap-3">
              {canManage ? connectButton : null}
              <RegistrarLink />
            </div>
          }
        />
      ) : null}
      {items.length > 0 ? (
        <>
          {canManage ? <div className="flex justify-end">{connectButton}</div> : null}
          <ul className="flex flex-col gap-3">
            {items.map((domain) => (
              <DomainCard
                key={domain.id}
                domain={domain}
                canManage={canManage}
                onNotice={setNotice}
                onCopied={copied}
                onRemove={(chosen, opener) => {
                  returnFocusRef.current = opener;
                  setRemoveProblem(undefined);
                  setRemoving(chosen);
                }}
              />
            ))}
          </ul>
          <RegistrarLink />
        </>
      ) : null}
      <p role="status" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {connecting ? (
        <ConnectDialog
          returnFocus={returnFocusRef}
          onClose={() => {
            setConnecting(false);
          }}
          onConnected={async (domain) => {
            setConnecting(false);
            const { hostname } = domain;
            setNotice(
              domain.record === null
                ? t`${hostname} is connected.`
                : t`${hostname} is connected. Add its DNS record, then press Check.`,
            );
            await queryClient.invalidateQueries({ queryKey: key });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== undefined}
        title={<Trans>Remove domain</Trans>}
        description={
          <Trans>
            {removingName} and its redirects will be removed. Funnels and websites linked to it
            stay, without a domain.
          </Trans>
        }
        confirmLabel={remove.isPending ? t`Removing…` : t`Remove`}
        destructive
        busy={remove.isPending}
        problem={removeProblem}
        returnFocus={returnFocusRef}
        onConfirm={() => {
          if (removing !== undefined) remove.mutate(removing);
        }}
        onClose={() => {
          if (!remove.isPending) setRemoving(undefined);
        }}
      />
    </section>
  );
}

export function DomainsPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [view, setView] = useState<View>('domains');
  return (
    <Page title={t`Domains & URL Redirects`}>
      <p className="text-md text-muted-foreground">
        <Trans>
          Connect a domain you own for your funnels and websites, and send addresses on it somewhere
          else.
        </Trans>
      </p>
      <div className="flex">
        <ViewSwitch
          label={t`Domains & URL Redirects`}
          views={[
            { value: 'domains', label: <Trans>Domains</Trans> },
            { value: 'redirects', label: <Trans>URL Redirects</Trans> },
          ]}
          value={view}
          onChange={setView}
        />
      </div>
      {view === 'domains' ? (
        <DomainsList key={business.id} />
      ) : (
        <RedirectsView
          key={business.id}
          onConnectDomain={() => {
            setView('domains');
          }}
        />
      )}
    </Page>
  );
}
