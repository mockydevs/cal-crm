// The Automation module's first page: the list of a business's workflows, or, when the
// address names one, its builder. The builder is its own chunk, fetched when a workflow is
// opened, so the list stays light.
import { useLocation } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import AutomationBuilderLoader from './automation-builder-loader';
import { AutomationList } from './automation-list';
import type { AutomationsNavigation, AutomationsSearch } from './automation-navigation';
import { useBusiness } from './workspace';

export type { AutomationsSearch } from './automation-navigation';

// Kept in its own file so the route can validate an address without loading this page.
export { automationsSearch } from './automation-search';

export interface AutomationsPageProps {
  readonly search: AutomationsSearch;
  readonly onSearch: (search: AutomationsSearch, how?: { readonly replace?: boolean }) => void;
}

export function AutomationsPage({ search, onSearch }: AutomationsPageProps): ReactElement {
  const business = useBusiness();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigation: AutomationsNavigation = {
    hrefFor: (to) => {
      const query = new URLSearchParams({
        ...(to.automation === undefined ? {} : { automation: to.automation }),
        ...(to.view === undefined ? {} : { view: to.view }),
        ...(to.run === undefined ? {} : { run: to.run }),
        ...(to.folder === undefined ? {} : { folder: to.folder }),
        ...(to.list === undefined ? {} : { list: to.list }),
      }).toString();
      return query === '' ? pathname : `${pathname}?${query}`;
    },
    go: onSearch,
  };
  return search.automation === undefined ? (
    <AutomationList
      // Each folder and each tab is its own list: a filter typed in one is not the next one's.
      key={`${business.id}:${search.list ?? ''}:${search.folder ?? ''}`}
      folder={search.folder}
      deleted={search.list === 'deleted'}
      recipe={
        search.recipe === undefined
          ? undefined
          : { recipe: search.recipe, calendar: search.calendar }
      }
      navigation={navigation}
    />
  ) : (
    <AutomationBuilderLoader
      key={`${business.id}:${search.automation}`}
      automationId={search.automation}
      view={search.view ?? 'canvas'}
      runId={search.run}
      navigation={navigation}
    />
  );
}
