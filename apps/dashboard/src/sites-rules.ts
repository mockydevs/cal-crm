// What the Sites pages work out before they draw: which page an address under /sites names,
// what a list asks the server for, the path a step's name suggests, the order of a funnel's
// steps after one moves, which of a site's settings changed, and what the template
// library's filters ask for. Types only come from the contracts here, so the rules weigh
// nothing in a page that uses them.
import type {
  ListSitesQuery,
  ListSiteTemplatesQuery,
  Site,
  SiteKeepArrival,
  SiteKind,
  SitePageSummary,
  SiteStepSummary,
} from '@repo/contracts';

export const siteTabs = ['steps', 'stats', 'security', 'settings'] as const;
export type SiteTab = (typeof siteTabs)[number];

/**
 * The parts of Sites that are stored but that nothing serves yet. Each stays out of view
 * until the stage that makes it real (nothing on screen that does nothing); its screens and
 * its API are kept, and it comes back by setting its line to true.
 */
export const SITE_STAGES: Readonly<
  Record<'splitTests' | 'stats' | 'connectedDomains' | 'selling' | 'pageSpeed', boolean>
> = {
  /** Stage 4: a variation page, the shares, "Start split test" and "Declare winner". */
  splitTests: false,
  /** Stage 4: the Stats tab. Nothing counts a view or an opt-in yet. */
  stats: false,
  /**
   * Stage 5: what only a site's own domain can do. The Security tab (response headers),
   * the Domain selector and the site's path under it, tracking code and the chat widget.
   */
  connectedDomains: false,
  /** Stage 7: payment mode and "Require credit card". */
  selling: false,
  /** Stage 6: Image Optimization, Optimize JavaScript, GDPR fonts, Auto-generate schema. */
  pageSpeed: false,
};

/** The tabs of a site's page that are shown: those whose stage has landed. */
export const shownSiteTabs: readonly SiteTab[] = siteTabs.filter(
  (tab) =>
    (tab !== 'stats' || SITE_STAGES.stats) && (tab !== 'security' || SITE_STAGES.connectedDomains),
);

/** The page an address under /sites names. */
export type SitesPlace =
  | { readonly at: 'list'; readonly kind: SiteKind; readonly folderId: string | undefined }
  | {
      readonly at: 'site';
      readonly kind: SiteKind;
      readonly siteId: string;
      readonly tab: SiteTab;
      readonly stepId: string | undefined;
    }
  | { readonly at: 'nowhere' };

/** Where a site's answer is kept, so every part of its page reads and refreshes the same one. */
export const siteKey = (businessId: string, siteId: string): readonly string[] => [
  'b',
  businessId,
  'sites',
  'site',
  siteId,
];

const kindWords = { funnels: 'funnel', websites: 'website' } as const;
const wordOf = { funnel: 'funnels', website: 'websites' } as const;
const idOf = (prefix: string, value: string | undefined): value is string =>
  value !== undefined && new RegExp(`^${prefix}_[0-9a-z]{26}$`).test(value);
const isTab = (value: string): value is SiteTab => shownSiteTabs.some((tab) => tab === value);

/**
 * Reads what follows /sites/ in the address: `funnels`, `funnels/folder/{id}`,
 * `funnels/{site}`, `funnels/{site}/{tab}` and `funnels/{site}/steps/{step}`, and the same
 * under `websites`. Nothing at all is the Funnels list, the module's first tab.
 */
export function placeOf(splat: string | undefined): SitesPlace {
  const parts = (splat ?? '').split('/').filter((part) => part !== '');
  const [word, second, third, fourth, ...rest] = parts;
  if (word === undefined) return { at: 'list', kind: 'funnel', folderId: undefined };
  if (word !== 'funnels' && word !== 'websites') return { at: 'nowhere' };
  const kind = kindWords[word];
  if (rest.length > 0) return { at: 'nowhere' };
  if (second === undefined) return { at: 'list', kind, folderId: undefined };
  if (second === 'folder') {
    return idOf('sfld', third) && fourth === undefined
      ? { at: 'list', kind, folderId: third }
      : { at: 'nowhere' };
  }
  if (!idOf('site', second)) return { at: 'nowhere' };
  if (third === undefined) {
    return { at: 'site', kind, siteId: second, tab: 'steps', stepId: undefined };
  }
  if (!isTab(third)) return { at: 'nowhere' };
  if (fourth === undefined) {
    return { at: 'site', kind, siteId: second, tab: third, stepId: undefined };
  }
  return third === 'steps' && idOf('sstp', fourth)
    ? { at: 'site', kind, siteId: second, tab: 'steps', stepId: fourth }
    : { at: 'nowhere' };
}

/** What follows /sites/ in the address of a list. */
export function listSplat(kind: SiteKind, folderId?: string): string {
  return folderId === undefined ? wordOf[kind] : `${wordOf[kind]}/folder/${folderId}`;
}

/** What follows /sites/ in the address of a funnel's or a website's page. */
export function siteSplat(
  kind: SiteKind,
  siteId: string,
  tab: SiteTab = 'steps',
  stepId?: string,
): string {
  const base = `${wordOf[kind]}/${siteId}`;
  if (tab !== 'steps') return `${base}/${tab}`;
  return stepId === undefined ? base : `${base}/steps/${stepId}`;
}

/** The two views of a list, as GoHighLevel's switch: newest change first, or by name. */
export const siteViews = ['recent', 'list'] as const;
export type SiteView = (typeof siteViews)[number];

export type SiteListQuery = Pick<ListSitesQuery, 'kind' | 'sort' | 'limit'> &
  Partial<Pick<ListSitesQuery, 'folder' | 'q' | 'after'>>;

/**
 * What a list asks the server for. A search at Home looks through every folder; without
 * one, Home holds the sites that are in no folder.
 */
export function listQueryOf({
  kind,
  folderId,
  text,
  view,
  limit,
  after,
}: {
  readonly kind: SiteKind;
  readonly folderId: string | undefined;
  readonly text: string;
  readonly view: SiteView;
  readonly limit: number;
  readonly after: string | undefined;
}): SiteListQuery {
  const q = text.trim().slice(0, 120);
  const folder = folderId ?? (q === '' ? 'none' : undefined);
  return {
    kind,
    sort: view === 'recent' ? 'updated' : 'name',
    limit,
    ...(folder === undefined ? {} : { folder }),
    ...(q === '' ? {} : { q }),
    ...(after === undefined ? {} : { after }),
  };
}

/** The path a step's name suggests: "Thank You!" gives thank-you. */
export function pathOf(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

/** A funnel's steps with one moved a place up or down; the same order at either end. */
export function movedStep(
  ids: readonly string[],
  id: string,
  direction: 'up' | 'down',
): readonly string[] {
  const from = ids.indexOf(id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from === -1 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return ids;
  next.splice(to, 0, moved);
  return next;
}

/** The step a site's page shows: the one the address names, or else the first. */
export function chosenStep(
  steps: readonly SiteStepSummary[],
  stepId: string | undefined,
): SiteStepSummary | undefined {
  return steps.find((step) => step.id === stepId) ?? steps[0];
}

/** A step's control page, or its variation when it has one. */
export function pageOf(
  step: SiteStepSummary,
  role: SitePageSummary['role'],
): SitePageSummary | undefined {
  return step.pages.find((page) => page.role === role);
}

/** A share of a hundred as typed: a whole number from 0 to 100, or nothing. */
export function weightOf(text: string): number | undefined {
  if (!/^\d{1,3}$/.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return value <= 100 ? value : undefined;
}

export const siteFlags = [
  'paymentLive',
  'requireCard',
  'optimizeImages',
  'lazyCustomCode',
  'privacyFonts',
  'autoSchema',
] as const;
export type SiteFlag = (typeof siteFlags)[number];

/** A site's settings as its form holds them: every box a string, every switch a boolean. */
export interface SiteSettingsDraft extends Record<SiteFlag, boolean> {
  readonly name: string;
  /** The domain's id, or '' for none. */
  readonly domainId: string;
  readonly path: string;
  readonly faviconUrl: string;
  readonly headCode: string;
  readonly bodyCode: string;
  /** The chat widget's id, or '' for none. */
  readonly chatWidgetId: string;
  /** Whether the site's pages keep how a visitor arrived between pages. */
  readonly keepArrival: SiteKeepArrival;
}

/**
 * The three answers to "Remember how visitors arrived", in the order the setting offers
 * them: the cautious one a site starts with first, then always, then never.
 */
export const keepArrivalChoices = [
  'unless_opted_out',
  'always',
  'never',
] as const satisfies readonly SiteKeepArrival[];

export function settingsDraftOf(site: Site): SiteSettingsDraft {
  return {
    name: site.name,
    domainId: site.domain?.id ?? '',
    path: site.path,
    faviconUrl: site.faviconUrl ?? '',
    headCode: site.headCode,
    bodyCode: site.bodyCode,
    chatWidgetId: site.chatWidgetId ?? '',
    paymentLive: site.paymentLive,
    requireCard: site.requireCard,
    optimizeImages: site.optimizeImages,
    lazyCustomCode: site.lazyCustomCode,
    privacyFonts: site.privacyFonts,
    autoSchema: site.autoSchema,
    keepArrival: site.keepArrival,
  };
}

/** What Save sends: the revision and only the settings that differ from the saved site. */
export interface SiteSettingsChange extends Partial<Record<SiteFlag, boolean>> {
  readonly revision: number;
  readonly name?: string;
  readonly domainId?: string | null;
  readonly path?: string;
  readonly faviconUrl?: string | null;
  readonly headCode?: string;
  readonly bodyCode?: string;
  readonly chatWidgetId?: string | null;
  readonly keepArrival?: SiteKeepArrival;
}

/** The change a draft makes to its site, or nothing when it makes none. */
export function settingsChangeOf(
  site: Site,
  draft: SiteSettingsDraft,
): SiteSettingsChange | undefined {
  const saved = settingsDraftOf(site);
  const name = draft.name.trim();
  const path = draft.path.trim();
  const favicon = draft.faviconUrl.trim();
  const flags = Object.fromEntries(
    siteFlags.filter((flag) => draft[flag] !== saved[flag]).map((flag) => [flag, draft[flag]]),
  );
  const change = {
    ...(name === saved.name ? {} : { name }),
    ...(draft.domainId === saved.domainId
      ? {}
      : { domainId: draft.domainId === '' ? null : draft.domainId }),
    ...(path === saved.path ? {} : { path }),
    ...(favicon === saved.faviconUrl ? {} : { faviconUrl: favicon === '' ? null : favicon }),
    ...(draft.headCode === saved.headCode ? {} : { headCode: draft.headCode }),
    ...(draft.bodyCode === saved.bodyCode ? {} : { bodyCode: draft.bodyCode }),
    ...(draft.chatWidgetId === saved.chatWidgetId
      ? {}
      : { chatWidgetId: draft.chatWidgetId === '' ? null : draft.chatWidgetId }),
    ...(draft.keepArrival === saved.keepArrival ? {} : { keepArrival: draft.keepArrival }),
    ...flags,
  };
  return Object.keys(change).length === 0 ? undefined : { revision: site.revision, ...change };
}

export interface SecurityHeader {
  readonly name: string;
  readonly value: string;
}

/** Whether a site already adds a header of this name, whatever its capitals. */
export function hasHeader(headers: readonly SecurityHeader[], name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return headers.some((header) => header.name.toLowerCase() === wanted);
}

/** A rate from 0 to 1 as a percentage with at most one decimal: 0.125 is 12.5%. */
export function rateText(rate: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(rate);
}

export const templateLists = ['all', 'mine', 'shared', 'favorites'] as const;
export type TemplateList = (typeof templateLists)[number];

/** What the template library's left side and filters hold. */
export interface TemplateFilters {
  readonly list: TemplateList;
  readonly categories: readonly string[];
  readonly types: readonly string[];
  readonly tags: readonly string[];
  readonly text: string;
  readonly sort: 'recent' | 'popular';
}

export const noTemplateFilters: TemplateFilters = {
  list: 'all',
  categories: [],
  types: [],
  tags: [],
  text: '',
  sort: 'recent',
};

/** Whether any filter narrows the library beyond the list chosen at its left. */
export function templatesNarrowed(filters: TemplateFilters): boolean {
  return (
    filters.categories.length + filters.types.length + filters.tags.length > 0 ||
    filters.text.trim() !== ''
  );
}

/** A list of ticked values with one ticked or unticked. */
export function toggled(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values.filter((each) => each !== value) : [...values, value];
}

export type TemplateQuery = Pick<ListSiteTemplatesQuery, 'kind' | 'list' | 'sort' | 'limit'> &
  Partial<Pick<ListSiteTemplatesQuery, 'category' | 'type' | 'tag' | 'q' | 'after'>>;

/**
 * What the library asks the server for. The server takes several values of a filter with
 * commas between them, so a value that holds a comma cannot be asked for and is left out.
 */
export function templateQueryOf(
  kind: SiteKind,
  filters: TemplateFilters,
  after: string | undefined,
): TemplateQuery {
  const several = (values: readonly string[]): string =>
    values
      .filter((value) => !value.includes(','))
      .join(',')
      .slice(0, 600);
  const category = several(filters.categories);
  const type = several(filters.types);
  const tag = several(filters.tags);
  const q = filters.text.trim().slice(0, 120);
  return {
    kind,
    list: filters.list,
    sort: filters.sort,
    limit: 24,
    ...(category === '' ? {} : { category }),
    ...(type === '' ? {} : { type }),
    ...(tag === '' ? {} : { tag }),
    ...(q === '' ? {} : { q }),
    ...(after === undefined ? {} : { after }),
  };
}
