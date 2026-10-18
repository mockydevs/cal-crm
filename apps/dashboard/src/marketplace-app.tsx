// An app's page in the App Marketplace, as GoHighLevel's: its Overview and the
// Permissions it asks for, then Install App, a review of those permissions, and Allow &
// Install. Once installed the button reads Uninstall, which asks first. Someone who lacks
// one of the permissions is told which, and can't install it: an install grants only what
// the installer holds. In this version an install is a record of consent; the page says
// plainly that the app gets no connection to the business yet.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getMarketplaceApp,
  installMarketplaceApp,
  uninstallMarketplaceApp,
  type MarketplaceAppDetail,
  type MarketplaceInstall,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { EmptyState } from '@repo/ui/components/empty-state';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, Info, SearchX } from 'lucide-react';
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  AppIcon,
  CategoryChips,
  InstalledBadge,
  marketplaceAppKey,
  marketplaceKey,
} from './marketplace-parts';
import { eventName, scopeName } from './marketplace-rules';
import { ConfirmDialog, ListProblem, retryFaults, SmallDialog } from './settings-list';
import { Page } from './shell/page';

export interface MarketplaceAppPageProps {
  readonly client: Client;
  readonly businessId: string;
  readonly slug: string;
  readonly appId: string;
}

/** What went wrong, in the server's words when it gave any. */
const reasonOf = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? (error.problem.detail ?? fallback) : fallback;

function BackLink({ slug }: { readonly slug: string }): ReactElement {
  return (
    <Link
      to="/b/$slug/app-marketplace"
      params={{ slug }}
      className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-medium text-link hover:underline lg:min-h-8"
    >
      <ChevronLeft aria-hidden className="size-4" strokeWidth={2} />
      <Trans>App Marketplace</Trans>
    </Link>
  );
}

export function MarketplaceAppPage({
  client,
  businessId,
  slug,
  appId,
}: MarketplaceAppPageProps): ReactElement {
  const { t } = useLingui();
  const app = useQuery({
    queryKey: marketplaceAppKey(businessId, appId),
    queryFn: () => client.request(getMarketplaceApp, { params: { appId } }),
    retry: retryFaults,
  });

  if (app.isPending) {
    return (
      <Page title={t`App Marketplace`}>
        <BackLink slug={slug} />
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading the app…</Trans>
        </p>
      </Page>
    );
  }
  if (app.isError) {
    const missing = app.error instanceof ApiError && app.error.status === 404;
    return (
      <Page title={missing ? t`App not found` : t`App Marketplace`}>
        <BackLink slug={slug} />
        {missing ? (
          <EmptyState
            icon={<SearchX strokeWidth={1.8} />}
            title={<Trans>Not in the marketplace</Trans>}
            description={<Trans>This app isn’t listed for this business.</Trans>}
          />
        ) : (
          <ListProblem
            onRetry={() => {
              void app.refetch();
            }}
          >
            <Trans>The app couldn’t be loaded.</Trans>
          </ListProblem>
        )}
      </Page>
    );
  }
  return <AppDetail client={client} businessId={businessId} slug={slug} app={app.data} />;
}

function AppDetail({
  client,
  businessId,
  slug,
  app,
}: Omit<MarketplaceAppPageProps, 'appId'> & {
  readonly app: MarketplaceAppDetail;
}): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const id = useId();
  const actionRef = useRef<HTMLButtonElement>(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const { name, install, developer } = app;
  const missing = install === null ? app.missingScopes : [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: marketplaceKey(businessId) });

  const installing = useMutation({
    mutationFn: () => client.request(installMarketplaceApp, { params: { appId: app.id } }),
    onSuccess: async () => {
      setReviewing(false);
      setNotice(t`${name} is installed.`);
      await refresh();
    },
  });
  const uninstalling = useMutation({
    mutationFn: (installId: string) =>
      client.request(uninstallMarketplaceApp, { params: { installId } }),
    onSuccess: async () => {
      setConfirming(false);
      setNotice(t`${name} is uninstalled.`);
      await refresh();
    },
  });

  // One button that reads Install App or Uninstall, so the keyboard comes back to it from
  // either dialog whichever it reads by then.
  const action =
    !app.canInstall || (install === null && app.status !== 'listed') ? null : (
      <Button
        ref={actionRef}
        variant={install === null ? 'primary' : 'secondary'}
        disabled={missing.length > 0}
        aria-describedby={missing.length > 0 ? `${id}-missing` : undefined}
        onClick={() => {
          setNotice('');
          if (install === null) {
            installing.reset();
            setReviewing(true);
          } else {
            uninstalling.reset();
            setConfirming(true);
          }
        }}
      >
        {install === null ? <Trans>Install App</Trans> : <Trans>Uninstall</Trans>}
      </Button>
    );

  return (
    <Page title={name}>
      <BackLink slug={slug} />
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 rounded-card border border-border bg-card p-5">
        <div className="flex min-w-0 flex-[1_1_280px] items-start gap-4">
          <AppIcon name={name} iconUrl={app.iconUrl} large />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm text-muted-foreground">
              <Trans>By {developer}</Trans>
            </p>
            {app.tagline === '' ? null : <p className="text-md wrap-anywhere">{app.tagline}</p>}
            {install === null ? null : <InstalledBadge />}
          </div>
        </div>
        {action}
      </div>
      <p role="status" className="text-sm font-medium empty:sr-only">
        {notice}
      </p>
      <Note>
        <Trans>
          Installing gives the app what it asks for in this business. The app connects through the
          link its developer gives you, and only reads and changes what is listed here. Uninstalling
          disconnects it at once.
        </Trans>
      </Note>
      {!app.canInstall ? (
        <Note>
          <Trans>
            Only people who can manage apps and API keys install and uninstall apps here.
          </Trans>
        </Note>
      ) : null}
      {install === null && app.status !== 'listed' ? (
        <Note>
          <Trans>This app is no longer listed, so it can’t be installed.</Trans>
        </Note>
      ) : null}
      {missing.length > 0 ? (
        <div
          id={`${id}-missing`}
          className="flex flex-col gap-2 rounded-card border border-destructive/40 bg-card p-4 text-sm"
        >
          <p className="font-medium">
            <Trans>
              You can’t install this app: it asks for permissions you don’t have. Someone who has
              them can install it.
            </Trans>
          </p>
          <ul className="list-disc pl-5">
            {missing.map((scope) => (
              <li key={scope}>{scopeName(scope, i18n)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Section id={`${id}-overview`} title={<Trans>Overview</Trans>}>
          <p className="text-md wrap-anywhere whitespace-pre-line">
            {app.description === '' ? <Trans>No description.</Trans> : app.description}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">
              <Trans>Developer</Trans>
            </dt>
            <dd className="wrap-anywhere">{app.developer}</dd>
            <dt className="text-muted-foreground">
              <Trans>Website</Trans>
            </dt>
            <dd className="wrap-anywhere">
              {app.websiteUrl === null ? (
                <Trans>None</Trans>
              ) : (
                <a
                  href={app.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link underline"
                >
                  {app.websiteUrl}
                </a>
              )}
            </dd>
            <dt className="text-muted-foreground">
              <Trans>Support email</Trans>
            </dt>
            <dd className="wrap-anywhere">
              {app.supportEmail === null ? (
                <Trans>None</Trans>
              ) : (
                <a href={`mailto:${app.supportEmail}`} className="text-link underline">
                  {app.supportEmail}
                </a>
              )}
            </dd>
            <dt className="text-muted-foreground">
              <Trans>Categories</Trans>
            </dt>
            <dd>
              {app.categories.length === 0 ? (
                <Trans>None</Trans>
              ) : (
                <CategoryChips categories={app.categories} />
              )}
            </dd>
          </dl>
        </Section>
        <Section id={`${id}-permissions`} title={<Trans>Permissions</Trans>}>
          <ScopeList
            scopes={app.scopes}
            lead={<Trans>{name} asks to:</Trans>}
            none={<Trans>It asks for no permissions.</Trans>}
          />
          <ReadList
            groups={app.readGroups}
            lead={<Trans>It may read:</Trans>}
            none={<Trans>It reads nothing.</Trans>}
          />
          <EventList events={app.webhookEvents} />
        </Section>
        {install === null ? null : <Installation install={install} />}
      </div>
      <SmallDialog
        open={reviewing}
        onClose={() => {
          setReviewing(false);
        }}
        title={<Trans>Install {name}?</Trans>}
        description={<Trans>Allowing it gives {name} these permissions in this business.</Trans>}
        returnFocus={actionRef}
      >
        <ScopeList
          scopes={app.scopes}
          lead={null}
          none={<Trans>It asks for no permissions.</Trans>}
        />
        <ReadList
          groups={app.readGroups}
          lead={<Trans>It may read:</Trans>}
          none={<Trans>It reads nothing.</Trans>}
        />
        <EventList events={app.webhookEvents} />
        <p className="text-sm text-muted-foreground">
          <Trans>Uninstalling it later disconnects it at once.</Trans>
        </p>
        {installing.isError ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {reasonOf(
              installing.error,
              t`The app wasn’t installed. Check your connection and try again.`,
            )}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={installing.isPending}
            onClick={() => {
              setReviewing(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={installing.isPending}
            onClick={() => {
              installing.mutate();
            }}
          >
            <Trans>Allow & Install</Trans>
          </Button>
        </div>
      </SmallDialog>
      <ConfirmDialog
        open={confirming}
        title={<Trans>Uninstall {name}?</Trans>}
        description={
          <Trans>
            {name} is disconnected at once and keeps no access to this business. You can install it
            again later.
          </Trans>
        }
        confirmLabel={t`Uninstall`}
        destructive
        busy={uninstalling.isPending}
        problem={
          uninstalling.isError
            ? reasonOf(
                uninstalling.error,
                t`The app wasn’t uninstalled. Check your connection and try again.`,
              )
            : undefined
        }
        returnFocus={actionRef}
        onConfirm={() => {
          if (install !== null) uninstalling.mutate(install.id);
        }}
        onClose={() => {
          setConfirming(false);
        }}
      />
    </Page>
  );
}

function Note({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <p className="flex max-w-prose items-start gap-2 text-sm text-muted-foreground">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.8} />
      <span>{children}</span>
    </p>
  );
}

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-5"
    >
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ScopeList({
  scopes,
  lead,
  none,
}: {
  readonly scopes: readonly string[];
  readonly lead: ReactNode;
  readonly none: ReactNode;
}): ReactElement {
  const { i18n } = useLingui();
  if (scopes.length === 0) return <p className="text-sm">{none}</p>;
  return (
    <>
      {lead === null ? null : <p className="text-sm">{lead}</p>}
      <ul className="list-disc pl-5 text-sm">
        {scopes.map((scope) => (
          <li key={scope}>{scopeName(scope, i18n)}</li>
        ))}
      </ul>
    </>
  );
}

/** The API's groups an app may read, by their names in the API reference. */
export function ReadList({
  groups,
  lead,
  none,
}: {
  readonly groups: readonly string[];
  readonly lead: ReactNode;
  readonly none: ReactNode;
}): ReactElement {
  if (groups.length === 0) return <p className="text-sm">{none}</p>;
  return (
    <>
      <p className="text-sm">{lead}</p>
      <ul className="list-disc pl-5 text-sm">
        {groups.map((group) => (
          <li key={group}>{group}</li>
        ))}
      </ul>
    </>
  );
}

/** What the app is told of by webhook, in people's words; nothing when it is told of nothing. */
export function EventList({ events }: { readonly events: readonly string[] }): ReactElement | null {
  const { i18n } = useLingui();
  if (events.length === 0) return null;
  return (
    <>
      <p className="text-sm">
        <Trans>It is told when:</Trans>
      </p>
      <ul className="list-disc pl-5 text-sm">
        {events.map((event) => (
          <li key={event}>{eventName(event, i18n)}</li>
        ))}
      </ul>
    </>
  );
}

/** Who installed the app here, when, and what this business gave it. */
function Installation({ install }: { readonly install: MarketplaceInstall }): ReactElement {
  const { i18n } = useLingui();
  const id = useId();
  const when = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
    new Date(install.installedAt),
  );
  const who = install.installedBy;
  return (
    <Section id={id} title={<Trans>Installed</Trans>}>
      <p className="text-sm">
        {who === null ? (
          <Trans>Installed on {when}.</Trans>
        ) : (
          <Trans>
            Installed by {who} on {when}.
          </Trans>
        )}
      </p>
      <ScopeList
        scopes={install.grantedScopes}
        lead={<Trans>Permissions given:</Trans>}
        none={<Trans>It was given no permissions.</Trans>}
      />
      <ReadList
        groups={install.grantedReadGroups}
        lead={<Trans>It may read:</Trans>}
        none={<Trans>It reads nothing.</Trans>}
      />
    </Section>
  );
}
