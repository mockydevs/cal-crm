// The modules of a business, in GoHighLevel's order and under its names, and each one's
// pages: the sidebar lists the modules, and the top bar names the one the page is in, with
// its pages as tabs. A module with nothing built yet has a page that says so; a tab is
// listed only once its page exists.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useMatch, useMatchRoute } from '@tanstack/react-router';
import {
  Calendar,
  ChartColumn,
  CreditCard,
  Globe,
  Image,
  LayoutDashboard,
  MessageCircle,
  Send,
  Settings,
  SquareKanban,
  Store,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/** An address in a business that a module, a tab or a settings link opens, or is found at. */
export type ModulePlace =
  | '/b/$slug'
  | '/b/$slug/inbox'
  | '/b/$slug/calls'
  | '/b/$slug/inbox/manual-actions'
  | '/b/$slug/calendar'
  | '/b/$slug/calendar/appointments'
  | '/b/$slug/contacts'
  | '/b/$slug/contacts/bulk-actions'
  | '/b/$slug/contacts/companies'
  | '/b/$slug/tasks'
  | '/b/$slug/deals'
  | '/b/$slug/deals/pipelines'
  | '/b/$slug/deals/bulk-actions'
  | '/b/$slug/payments/$'
  | '/b/$slug/marketing'
  | '/b/$slug/marketing/emails'
  | '/b/$slug/marketing/snippets'
  | '/b/$slug/marketing/trigger-links'
  | '/b/$slug/automations'
  | '/b/$slug/automations/overview'
  | '/b/$slug/sites/$'
  | '/b/$slug/media-storage'
  | '/b/$slug/reports'
  | '/b/$slug/reports/attribution'
  | '/b/$slug/reports/appointments'
  | '/b/$slug/app-marketplace'
  | '/b/$slug/settings'
  | '/b/$slug/settings/business'
  | '/b/$slug/settings/team'
  | '/b/$slug/settings/deal-stages'
  | '/b/$slug/settings/sign-in'
  | '/b/$slug/settings/calendars'
  | '/b/$slug/settings/calendars/availability'
  | '/b/$slug/settings/calendars/connections'
  | '/b/$slug/settings/email'
  | '/b/$slug/settings/sms'
  | '/b/$slug/settings/ai-models'
  | '/b/$slug/settings/custom-fields'
  | '/b/$slug/settings/custom-values'
  | '/b/$slug/settings/import'
  | '/b/$slug/settings/scoring'
  | '/b/$slug/settings/domains'
  | '/b/$slug/settings/tags'
  | '/b/$slug/settings/lead-sources'
  | '/b/$slug/settings/lead-sources/tracking-links'
  | '/b/$slug/settings/lead-sources/check'
  | '/b/$slug/settings/apps'
  | '/b/$slug/settings/audit-logs'
  | '/b/$slug/settings/notifications'
  | '/b/$slug/settings/forms'
  | '/b/$slug/settings/webchat';

export interface ModuleTab {
  readonly to: ModulePlace;
  readonly label: MessageDescriptor;
  /** False for a tab that opens a page of another module, which then names the page. */
  readonly here: boolean;
  /** What follows the address, for a tab of a module whose pages are one route (Sites). */
  readonly splat?: string;
  /** Drawn only where the install offers this: Google Calendar's OAuth client. */
  readonly needs?: 'google_calendar';
}

export interface Module {
  readonly to: ModulePlace;
  readonly label: MessageDescriptor;
  readonly icon: LucideIcon;
  /** Pages of the module that are not under its own address. */
  readonly also?: readonly ModulePlace[];
  readonly tabs?: readonly ModuleTab[];
}

const dashboard: Module = { to: '/b/$slug', label: msg`Dashboard`, icon: LayoutDashboard };

/**
 * Above the sidebar's divider. GoHighLevel's first two, Ask AI and Launchpad, are not here:
 * the assistant is on every page instead, at the bottom right.
 */
export const upperModules: readonly Module[] = [
  dashboard,
  {
    to: '/b/$slug/inbox',
    label: msg`Conversations`,
    icon: MessageCircle,
    also: ['/b/$slug/calls'],
    // GoHighLevel's Analytics and Settings tabs are response-time targets, which nothing
    // serves yet.
    tabs: [
      { to: '/b/$slug/inbox', label: msg`Conversations`, here: true },
      { to: '/b/$slug/calls', label: msg`Call history`, here: true },
      { to: '/b/$slug/inbox/manual-actions', label: msg`Manual Actions`, here: true },
      // Marketing's pages; GoHighLevel reaches them from here too. One page, two doors.
      { to: '/b/$slug/marketing/snippets', label: msg`Snippets`, here: false },
      { to: '/b/$slug/marketing/trigger-links', label: msg`Trigger Links`, here: false },
    ],
  },
  {
    to: '/b/$slug/calendar',
    label: msg`Calendars`,
    icon: Calendar,
    tabs: [
      { to: '/b/$slug/calendar', label: msg`Calendar view`, here: true },
      { to: '/b/$slug/calendar/appointments', label: msg`Appointment list view`, here: true },
      // Calendars are set up in one place, Settings → Calendars; this page is for the day's work.
    ],
  },
  {
    to: '/b/$slug/contacts',
    label: msg`Contacts`,
    icon: Users,
    also: ['/b/$slug/tasks'],
    tabs: [
      { to: '/b/$slug/contacts', label: msg`Smart Lists`, here: true },
      { to: '/b/$slug/contacts/bulk-actions', label: msg`Bulk Actions`, here: true },
      { to: '/b/$slug/tasks', label: msg`Tasks`, here: true },
      { to: '/b/$slug/contacts/companies', label: msg`Companies`, here: true },
      // The fields are set up in Settings; GoHighLevel reaches them from here too.
      { to: '/b/$slug/settings/custom-fields', label: msg`Custom Fields`, here: false },
    ],
  },
  {
    to: '/b/$slug/deals',
    label: msg`Opportunities`,
    icon: SquareKanban,
    tabs: [
      { to: '/b/$slug/deals', label: msg`Opportunities`, here: true },
      { to: '/b/$slug/deals/pipelines', label: msg`Pipelines`, here: true },
      { to: '/b/$slug/deals/bulk-actions', label: msg`Bulk Actions`, here: true },
    ],
  },
  {
    // One route holds the module, as Sites: what follows /payments/ names the page.
    to: '/b/$slug/payments/$',
    label: msg`Payments`,
    icon: CreditCard,
    // GoHighLevel's "Invoices & Estimates" as two tabs, then what else is built.
    tabs: [
      { to: '/b/$slug/payments/$', splat: 'invoices', label: msg`Invoices`, here: true },
      { to: '/b/$slug/payments/$', splat: 'quotes', label: msg`Quotes`, here: true },
      { to: '/b/$slug/payments/$', splat: 'receipts', label: msg`Receipts`, here: true },
      { to: '/b/$slug/payments/$', splat: 'products', label: msg`Products`, here: true },
      { to: '/b/$slug/payments/$', splat: 'settings', label: msg`Settings`, here: true },
    ],
  },
];

/** Below the divider. */
export const lowerModules: readonly Module[] = [
  {
    to: '/b/$slug/marketing',
    label: msg`Marketing`,
    icon: Send,
    // GoHighLevel's order, with the tabs that are built. Emails has its own pages inside
    // it: Templates so far.
    tabs: [
      { to: '/b/$slug/marketing/emails', label: msg`Emails`, here: true },
      { to: '/b/$slug/marketing/snippets', label: msg`Snippets`, here: true },
      { to: '/b/$slug/marketing/trigger-links', label: msg`Trigger Links`, here: true },
    ],
  },
  {
    to: '/b/$slug/automations',
    label: msg`Automation`,
    icon: Zap,
    // GoHighLevel's third tab, Global Workflow Settings, has nothing behind it yet.
    tabs: [
      { to: '/b/$slug/automations', label: msg`Workflows`, here: true },
      { to: '/b/$slug/automations/overview', label: msg`Overview`, here: true },
    ],
  },
  {
    // One route holds the module: what follows /sites/ names the page, and nothing is Funnels.
    to: '/b/$slug/sites/$',
    label: msg`Sites`,
    icon: Globe,
    // GoHighLevel's order, with the tabs that are built. Forms and the chat widget keep the
    // addresses they had under Settings.
    also: ['/b/$slug/settings/forms', '/b/$slug/settings/webchat'],
    tabs: [
      { to: '/b/$slug/sites/$', splat: 'funnels', label: msg`Funnels`, here: true },
      { to: '/b/$slug/sites/$', splat: 'websites', label: msg`Websites`, here: true },
      { to: '/b/$slug/settings/forms', label: msg`Forms`, here: true },
      { to: '/b/$slug/settings/webchat', label: msg`Chat Widget`, here: true },
    ],
  },
  { to: '/b/$slug/media-storage', label: msg`Media Storage`, icon: Image },
  {
    to: '/b/$slug/reports',
    label: msg`Reporting`,
    icon: ChartColumn,
    // GoHighLevel's tabs that have real numbers behind them. Google Ads, Meta Ads, Call
    // report and Local Marketing Audit join when they are built; a saved report's page is
    // under Custom reports.
    tabs: [
      { to: '/b/$slug/reports', label: msg`Custom reports`, here: true },
      { to: '/b/$slug/reports/attribution', label: msg`Attribution report`, here: true },
      { to: '/b/$slug/reports/appointments', label: msg`Appointment report`, here: true },
    ],
  },
  { to: '/b/$slug/app-marketplace', label: msg`App Marketplace`, icon: Store },
];

/** Pinned at the foot of the sidebar. Inside it, the sidebar lists its pages instead. */
export const settingsModule: Module = {
  to: '/b/$slug/settings',
  label: msg`Settings`,
  icon: Settings,
};

export interface SettingsPage {
  readonly to: ModulePlace;
  readonly label: MessageDescriptor;
  /** The page's own tabs in the top bar, as GoHighLevel's Opportunities & Pipelines has. */
  readonly tabs?: readonly ModuleTab[];
  /** True for a page the top bar names itself, in place of "Settings", as GoHighLevel's Calendars. */
  readonly titled?: boolean;
}

export interface SettingsGroup {
  readonly label: MessageDescriptor;
  readonly pages: readonly SettingsPage[];
}

/** The settings pages there are, grouped and named as GoHighLevel has them. */
export const settingsGroups: readonly SettingsGroup[] = [
  {
    label: msg`My Business`,
    pages: [
      { to: '/b/$slug/settings/business', label: msg`Business Profile` },
      { to: '/b/$slug/settings/team', label: msg`Users` },
      { to: '/b/$slug/settings/sign-in', label: msg`Sign-in and security` },
      { to: '/b/$slug/settings/notifications', label: msg`My Notifications` },
    ],
  },
  {
    label: msg`Business Services`,
    pages: [
      {
        to: '/b/$slug/settings/calendars',
        label: msg`Calendars`,
        titled: true,
        // Three of GoHighLevel's four tabs: Preferences has nothing behind it here, so it
        // is not drawn. Connections is Google Calendar, drawn only where the install can
        // connect it.
        tabs: [
          { to: '/b/$slug/settings/calendars', label: msg`Calendars`, here: true },
          {
            to: '/b/$slug/settings/calendars/availability',
            label: msg`Availability`,
            here: true,
          },
          {
            to: '/b/$slug/settings/calendars/connections',
            label: msg`Connections`,
            here: true,
            needs: 'google_calendar',
          },
        ],
      },
      { to: '/b/$slug/settings/email', label: msg`Email Services` },
      { to: '/b/$slug/settings/sms', label: msg`Phone System` },
      { to: '/b/$slug/settings/ai-models', label: msg`AI Models` },
    ],
  },
  {
    label: msg`Other Settings`,
    pages: [
      { to: '/b/$slug/settings/custom-fields', label: msg`Custom Fields` },
      { to: '/b/$slug/settings/custom-values', label: msg`Custom Values` },
      { to: '/b/$slug/settings/import', label: msg`Import Data` },
      { to: '/b/$slug/settings/scoring', label: msg`Manage Scoring` },
      { to: '/b/$slug/settings/domains', label: msg`Domains & URL Redirects` },
      { to: '/b/$slug/settings/tags', label: msg`Tags` },
      {
        // Ours: GoHighLevel has no such page. How a lead's source is named, in one place.
        to: '/b/$slug/settings/lead-sources',
        label: msg`Lead Sources`,
        titled: true,
        tabs: [
          { to: '/b/$slug/settings/lead-sources', label: msg`Rules`, here: true },
          {
            to: '/b/$slug/settings/lead-sources/tracking-links',
            label: msg`Tracking links`,
            here: true,
          },
          { to: '/b/$slug/settings/lead-sources/check', label: msg`Check a link`, here: true },
        ],
      },
      { to: '/b/$slug/settings/apps', label: msg`Apps and API keys` },
      { to: '/b/$slug/settings/audit-logs', label: msg`Audit Logs` },
    ],
  },
];

// Settings last: the pages that moved out of it are still under its address, and belong to
// the module that lists them. The Dashboard is not here: its address starts all the others.
const elsewhere: readonly Module[] = [
  ...upperModules.filter((each) => each !== dashboard),
  ...lowerModules,
  settingsModule,
];

export interface CurrentModule {
  /** The module the page is in; none on a page outside them all, such as the trash. */
  readonly module: Module | undefined;
  /** What the top bar calls the place: the module's name, or the page's own. */
  readonly name: MessageDescriptor | undefined;
  /** The tabs the top bar shows: the module's, or in Settings the page's own. */
  readonly tabs: readonly ModuleTab[] | undefined;
  /**
   * What the tabs are called as a group: the module's name, or in Settings the page's, since
   * the sidebar's list of settings pages already has the name "Settings".
   */
  readonly tabsName: MessageDescriptor | undefined;
  /** The tab the page is under, when there are tabs. */
  readonly tab: ModuleTab | undefined;
}

const nowhere: CurrentModule = {
  module: undefined,
  name: undefined,
  tabs: undefined,
  tabsName: undefined,
  tab: undefined,
};

/** Where the page is among the modules of the business named `slug`, or at the agency. */
export function useCurrentModule(slug: string | undefined): CurrentModule {
  const matchRoute = useMatchRoute();
  const atAgency = useMatch({ from: '/_app/agency', shouldThrow: false }) !== undefined;
  if (slug === undefined) {
    if (!atAgency) return nowhere;
    const inSettings = matchRoute({ to: '/agency/settings', fuzzy: true }) !== false;
    return { ...nowhere, name: inSettings ? msg`Settings` : msg`Businesses` };
  }
  const at = (to: ModulePlace | '/b/$slug/trash' | '/b/$slug/assistant', fuzzy = true): boolean =>
    matchRoute({ to, params: { slug }, fuzzy }) !== false;
  if (at('/b/$slug', false)) return { ...nowhere, module: dashboard, name: dashboard.label };
  // A page listed under `also` is its module's before it is the module its address is under.
  const module =
    elsewhere.find((each) => each.also?.some((to) => at(to)) === true) ??
    elsewhere.find((each) => at(each.to));
  if (module === undefined) {
    if (at('/b/$slug/trash')) return { ...nowhere, name: msg`Trash` };
    return at('/b/$slug/assistant') ? { ...nowhere, name: msg`Assistant` } : nowhere;
  }
  const settingsPage =
    module === settingsModule
      ? settingsGroups.flatMap((group) => group.pages).find((page) => at(page.to))
      : undefined;
  const tabs = module === settingsModule ? settingsPage?.tabs : module.tabs;
  // The longest address wins, so Companies is not also the list it sits under.
  const under = (each: ModuleTab): boolean => {
    if (each.splat === undefined) return at(each.to);
    const found = matchRoute({ to: each.to, params: { slug }, fuzzy: true });
    const rest = found !== false && '_splat' in found ? String(found._splat) : undefined;
    return rest === each.splat || rest?.startsWith(`${each.splat}/`) === true;
  };
  const tab = tabs
    ?.filter((each) => each.here && under(each))
    .toSorted((one, other) => other.to.length - one.to.length)[0];
  const name = settingsPage?.titled === true ? settingsPage.label : module.label;
  return { module, name, tabs, tabsName: settingsPage?.label ?? module.label, tab };
}
