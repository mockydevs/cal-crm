// What the App Marketplace keeps in its address: the tab, the words searched for
// and the category. Kept apart, importing nothing, because a route reads its address before
// the page's own code arrives: only this much is in the first load. The categories are the
// contract's (a test holds the two lists equal).

export const marketplaceCategoryNames = [
  'analytics',
  'calendars',
  'communication',
  'marketing',
  'payments',
  'productivity',
  'reporting',
  'sales',
  'other',
] as const;
export type MarketplaceCategoryName = (typeof marketplaceCategoryNames)[number];

/** The longest search the API takes (listMarketplaceAppsQuery). */
export const MARKETPLACE_SEARCH_MAX = 200;

/** The page's address. All apps, no search and every category are left out. */
export interface MarketplaceSearch {
  readonly tab?: 'installed';
  readonly q?: string;
  readonly category?: MarketplaceCategoryName;
}

const isCategory = (value: unknown): value is MarketplaceCategoryName =>
  typeof value === 'string' && (marketplaceCategoryNames as readonly string[]).includes(value);

export function marketplaceSearchOf(search: Record<string, unknown>): MarketplaceSearch {
  const { tab, q, category } = search;
  const words = typeof q === 'string' ? q.slice(0, MARKETPLACE_SEARCH_MAX) : '';
  return {
    ...(tab === 'installed' ? { tab } : {}),
    ...(words.trim() === '' ? {} : { q: words }),
    ...(isCategory(category) ? { category } : {}),
  };
}
