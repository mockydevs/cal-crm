// The App Marketplace: the apps the agency has listed, as a grid of cards, with a
// search and a category, and the Installed tab, which lists this business's installs
// (listInstalledMarketplaceApps) and finds among them on the page. A card opens the app's
// page, where it is installed and uninstalled.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  listInstalledMarketplaceApps,
  listMarketplaceApps,
  marketplaceCategories,
  type MarketplaceApp,
  type MarketplaceCategory,
} from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { EmptyState } from '@repo/ui/components/empty-state';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { SearchX, Store } from 'lucide-react';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { ListSearch } from './list-toolbar';
import { AppIcon, CategoryChips, InstalledBadge, marketplaceKey } from './marketplace-parts';
import { categoryNames, matchesApp } from './marketplace-rules';
import type { MarketplaceSearch } from './marketplace-search';
import { Tabs } from './phone-system-parts';
import { ListProblem, retryFaults, useSettled } from './settings-list';
import { Page } from './shell/page';

const ANY = 'any';

export interface MarketplacePageProps {
  readonly client: Client;
  readonly businessId: string;
  readonly slug: string;
  /** What the address holds: the tab, the search and the category. */
  readonly search: MarketplaceSearch;
  readonly onSearch: (next: MarketplaceSearch) => void;
}

/** What goes in the address: All apps, no search and every category are left out. */
const searchOf = (
  tab: 'all' | 'installed',
  q: string,
  category: MarketplaceCategory | undefined,
): MarketplaceSearch => ({
  ...(tab === 'installed' ? { tab } : {}),
  ...(q.trim() === '' ? {} : { q }),
  ...(category === undefined ? {} : { category }),
});

export function MarketplacePage({
  client,
  businessId,
  slug,
  search,
  onSearch,
}: MarketplacePageProps): ReactElement {
  const { t, i18n } = useLingui();
  const id = useId();
  const tab = search.tab ?? 'all';
  const category = search.category;
  const [typed, setTyped] = useState(search.q ?? '');
  const settled = useSettled(typed);
  const q = settled.trim();

  // The search goes in the address once typing pauses, so going back to the list finds it.
  useEffect(() => {
    const wanted = settled.trim() === '' ? undefined : settled;
    if (wanted !== search.q) onSearch(searchOf(tab, settled, category));
  }, [settled, search.q, tab, category, onSearch]);

  const apps = useQuery({
    queryKey: [...marketplaceKey(businessId), 'apps', { q, category }],
    queryFn: () =>
      client.request(listMarketplaceApps, {
        query: { ...(q === '' ? {} : { q }), ...(category === undefined ? {} : { category }) },
      }),
    enabled: tab === 'all',
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const installs = useQuery({
    queryKey: [...marketplaceKey(businessId), 'installs'],
    queryFn: () => client.request(listInstalledMarketplaceApps, {}),
    enabled: tab === 'installed',
    retry: retryFaults,
  });
  const shown = tab === 'all' ? apps : installs;
  const searching = q !== '' || category !== undefined;
  const items =
    tab === 'all'
      ? apps.data?.items
      : installs.data?.items.filter((app) => matchesApp(app, q, category));

  return (
    <Page title={t`App Marketplace`}>
      <p className="max-w-prose text-md text-muted-foreground">
        <Trans>
          Apps your agency has made available to this business. Open one to see what it asks to do
          before you install it.
        </Trans>
      </p>
      <Tabs
        label={t`App Marketplace`}
        idBase={id}
        current={tab}
        tabs={[
          { id: 'all', label: t`All apps` },
          { id: 'installed', label: t`Installed` },
        ]}
        onChange={(next) => {
          onSearch(searchOf(next, typed, category));
        }}
      />
      <div
        role="tabpanel"
        id={`${id}-panel-${tab}`}
        aria-labelledby={`${id}-tab-${tab}`}
        className="flex min-w-0 flex-col gap-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <ListSearch label={t`Search apps`} value={typed} onChange={setTyped} />
          <Select
            aria-label={t`Category`}
            className="w-auto max-w-full min-w-44"
            value={category ?? ANY}
            onValueChange={(next) => {
              const chosen = marketplaceCategories.find((each) => each === next);
              onSearch(searchOf(tab, typed, chosen));
            }}
          >
            <option value={ANY}>{t`All categories`}</option>
            {marketplaceCategories.map((each) => (
              <option key={each} value={each}>
                {i18n._(categoryNames[each])}
              </option>
            ))}
          </Select>
        </div>
        {shown.isError ? (
          <ListProblem
            onRetry={() => {
              void shown.refetch();
            }}
          >
            <Trans>The apps couldn’t be loaded.</Trans>
          </ListProblem>
        ) : items === undefined ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading the apps…</Trans>
          </p>
        ) : items.length > 0 ? (
          <AppGrid apps={items} slug={slug} />
        ) : searching ? (
          <EmptyState
            icon={<SearchX strokeWidth={1.8} />}
            title={<Trans>No apps match</Trans>}
            description={<Trans>Try other words or another category.</Trans>}
          />
        ) : tab === 'installed' ? (
          <EmptyState
            icon={<Store strokeWidth={1.8} />}
            title={<Trans>No apps installed</Trans>}
            description={<Trans>Apps you install show here.</Trans>}
          />
        ) : (
          <EmptyState
            icon={<Store strokeWidth={1.8} />}
            title={<Trans>No apps yet</Trans>}
            description={<Trans>Your agency hasn’t listed any apps.</Trans>}
          />
        )}
      </div>
    </Page>
  );
}

function AppGrid({
  apps,
  slug,
}: {
  readonly apps: readonly MarketplaceApp[];
  readonly slug: string;
}): ReactElement {
  const { t } = useLingui();
  return (
    <ul
      aria-label={t`Apps`}
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4"
    >
      {apps.map((app) => (
        <li
          key={app.id}
          className="relative flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4 hover:border-primary hover:shadow-[0_1px_3px_rgb(16_24_40/0.1)]"
        >
          <div className="flex min-w-0 items-start gap-3">
            <AppIcon name={app.name} iconUrl={app.iconUrl} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* The whole card opens the app: the link's box covers it. */}
              <Link
                to="/b/$slug/app-marketplace/$appId"
                params={{ slug, appId: app.id }}
                className="font-semibold wrap-anywhere text-foreground outline-none after:absolute after:inset-0 after:rounded-card focus-visible:after:outline-2 focus-visible:after:outline-primary"
              >
                {app.name}
              </Link>
              <span className="text-sm wrap-anywhere text-muted-foreground">{app.developer}</span>
            </div>
            {app.install === null ? null : <InstalledBadge />}
          </div>
          {app.tagline === '' ? null : (
            <p className="text-sm wrap-anywhere text-body">{app.tagline}</p>
          )}
          <CategoryChips categories={app.categories} />
        </li>
      ))}
    </ul>
  );
}
