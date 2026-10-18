import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { cn } from '@repo/ui/lib/utils';
import { useSuspenseQuery } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  useMatch,
  useMatchRoute,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import { ArrowLeft, Building2, Menu, Search, X } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AssistantLauncher } from '../assistant/launcher';
import { CommandBarButton, loadCommandBar, useCommandBarShortcut } from '../command-bar-trigger';
import { InboxUnreadBadge } from '../inbox-badge';
import { meQuery, useBusinessInAddress } from '../workspace';
import { BrandMark } from './brand-mark';
import { BusinessSwitcher, type BusinessSection } from './business-switcher';
import { useFullWindow } from './full-window';
import {
  lowerModules,
  settingsGroups,
  settingsModule,
  upperModules,
  useCurrentModule,
  type Module,
  type SettingsGroup,
} from './modules';
import { TopBar } from './top-bar';

// What's on the dark sidebar: its ink, and a ring that shows on it where the accent's
// would not.
const onSidebarClassName =
  'bg-sidebar text-sidebar-foreground [&_:focus-visible]:outline-sidebar-foreground';

// A quiet button on the sidebar's color, in place of the page's grays.
const sidebarButtonClassName =
  'text-sidebar-foreground hover:bg-sidebar-foreground/15 hover:text-sidebar-foreground';

// 36px tall beside the page, and 44px in the drawer, where fingers do the pressing. Hovering
// lightens a link a little; the one the page is in is darker and heavier. Where the
// keyboard is shows as a ring, never as a fill.
const navLinkClassName =
  'flex min-h-11 shrink-0 items-center gap-3 rounded-control px-3 text-md text-sidebar-foreground hover:bg-sidebar-foreground/8 aria-[current=page]:bg-sidebar-active aria-[current=page]:font-medium lg:min-h-9';

// The list scrolls by itself when the window is short, so what's above and below it stays.
// The padding keeps a link's focus ring inside what scrolls, and the thin scrollbar sits
// in it, so nothing moves when it appears.
const navListClassName =
  '-mx-1.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-1.5 py-1 [scrollbar-color:var(--sidebar-active)_transparent] [scrollbar-width:thin]';

function NavLink({
  item,
  slug,
  current,
  businessId,
}: {
  readonly item: Module;
  readonly slug: string;
  /** Whether the page is in this module, wherever its address is. */
  readonly current: boolean;
  /** For the unread count of Conversations; left out where no count is shown. */
  readonly businessId?: string;
}): ReactElement {
  const { i18n } = useLingui();
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      params={{ slug }}
      // Which module the page is in is the shell's to say: a page can be under another
      // module's address.
      activeOptions={{ exact: true }}
      aria-current={current ? 'page' : undefined}
      className={navLinkClassName}
    >
      <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 truncate" title={i18n._(item.label)}>
        {i18n._(item.label)}
      </span>
      {item.to === '/b/$slug/inbox' && businessId !== undefined ? (
        <InboxUnreadBadge businessId={businessId} />
      ) : null}
    </Link>
  );
}

// Every place the switcher can keep someone at, the longest address first, so the most
// specific match wins.
const sections: readonly BusinessSection[] = [
  ...new Set(
    [...upperModules, ...lowerModules, settingsModule].flatMap((item) => [
      item.to,
      ...(item.also ?? []),
      ...(item.tabs ?? []).map((tab) => tab.to),
    ]),
  ),
  ...settingsGroups.flatMap((group) => group.pages.map((page) => page.to)),
]
  .filter((to) => to !== '/b/$slug')
  .sort((one, other) => other.length - one.length);

/** The section of a business the page is in, so the switcher can open it in another. */
function useSection(slug: string | undefined): BusinessSection {
  const matchRoute = useMatchRoute();
  if (slug === undefined) return '/b/$slug';
  const current = sections.find(
    (to) => matchRoute({ to, params: { slug }, fuzzy: true }) !== false,
  );
  return current ?? '/b/$slug';
}

function MainNavigation({ children }: { readonly children: ReactNode }): ReactElement {
  const { t } = useLingui();
  return (
    <nav aria-label={t`Main`} className={navListClassName}>
      {children}
    </nav>
  );
}

function SettingsLinks({
  group,
  slug,
}: {
  readonly group: SettingsGroup;
  readonly slug: string;
}): ReactElement {
  const { i18n } = useLingui();
  const labelId = useId();
  return (
    // 20px above a group, and its label closer to its own pages than to the group before.
    <div
      role="group"
      aria-labelledby={labelId}
      className="mt-4 flex shrink-0 flex-col gap-1 first-of-type:mt-0"
    >
      <span
        id={labelId}
        className="mb-0.5 px-3 text-[11px] leading-4 tracking-wider text-sidebar-foreground/70 uppercase"
      >
        {i18n._(group.label)}
      </span>
      {group.pages.map((page) => (
        <Link key={page.to} to={page.to} params={{ slug }} className={navLinkClassName}>
          <span className="min-w-0 truncate" title={i18n._(page.label)}>
            {i18n._(page.label)}
          </span>
        </Link>
      ))}
    </div>
  );
}

/**
 * In Settings, the sidebar lists the settings pages in place of the modules: a way back
 * first, then the pages in their groups.
 */
function SettingsNavigation({
  slug,
  onBack,
}: {
  readonly slug: string;
  readonly onBack: (event: MouseEvent<HTMLAnchorElement>) => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <nav aria-label={t`Settings`} className={navListClassName}>
      <Link
        to="/b/$slug"
        params={{ slug }}
        // Every page is under the Dashboard's address: this is not where the page is.
        activeOptions={{ exact: true }}
        onClick={onBack}
        className={navLinkClassName}
      >
        <ArrowLeft aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
        <Trans>Go Back</Trans>
      </Link>
      <span aria-hidden className="px-3 pt-2 pb-1 text-base font-medium">
        <Trans>Settings</Trans>
      </span>
      {settingsGroups.map((group) => (
        <SettingsLinks key={group.label.id} group={group} slug={slug} />
      ))}
    </nav>
  );
}

function Sidebar({
  onSearch,
  onBack,
  className,
}: {
  readonly onSearch: () => void;
  /** Leaves Settings for where the person was before it. */
  readonly onBack: (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly className?: string;
}): ReactElement {
  const me = useSuspenseQuery(meQuery).data;
  const business = useBusinessInAddress();
  const atAgency = useMatch({ from: '/_app/agency', shouldThrow: false }) !== undefined;
  const section = useSection(business?.slug);
  const { module } = useCurrentModule(business?.slug);
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-4 px-3 pt-4 pb-3', onSidebarClassName, className)}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <BrandMark />
        <span className="min-w-0 truncate text-base font-medium" title={me.agency.name}>
          {me.agency.name}
        </span>
      </div>

      <BusinessSwitcher me={me} business={business} section={section} atAgency={atAgency} />

      <CommandBarButton onOpen={onSearch} />

      {business !== undefined && module === settingsModule ? (
        <SettingsNavigation slug={business.slug} onBack={onBack} />
      ) : business !== undefined ? (
        <>
          <MainNavigation>
            {upperModules.map((item) => (
              <NavLink
                key={item.to}
                item={item}
                slug={business.slug}
                current={item === module}
                businessId={business.id}
              />
            ))}
            <div role="separator" className="mx-3 my-2 h-px shrink-0 bg-sidebar-foreground/20" />
            {lowerModules.map((item) => (
              <NavLink key={item.to} item={item} slug={business.slug} current={item === module} />
            ))}
          </MainNavigation>
          <div className="flex shrink-0 flex-col border-t border-sidebar-foreground/20 pt-3">
            <NavLink item={settingsModule} slug={business.slug} current={false} />
          </div>
        </>
      ) : atAgency ? (
        <MainNavigation>
          <Link to="/agency" activeOptions={{ exact: true }} className={navLinkClassName}>
            <Building2 aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
            <span>
              <Trans>Businesses</Trans>
            </span>
          </Link>
        </MainNavigation>
      ) : null}
    </div>
  );
}

const CommandBar = lazy(async () => ({ default: (await loadCommandBar()).CommandBar }));

export function AppShell(): ReactElement {
  const { t } = useLingui();
  const [searching, setSearching] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const me = useSuspenseQuery(meQuery).data;
  const business = useBusinessInAddress();
  const atAgency = useMatch({ from: '/_app/agency', shouldThrow: false }) !== undefined;
  const section = useSection(business?.slug);
  const place = useCurrentModule(business?.slug);
  const router = useRouter();
  // The address the page on screen is at, which is what says whether it is in Settings: not
  // the one a page still loading is on its way to.
  const href = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).href,
  });
  const inSettings = place.module === settingsModule;
  // Where the person was before Settings, for its way back.
  const beforeSettingsRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!inSettings) beforeSettingsRef.current = href;
  }, [href, inSettings]);
  const slug = business?.slug;
  const goBack = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      const before = beforeSettingsRef.current;
      // Otherwise the link's own address: the Dashboard. A page of another business is
      // not somewhere to go back to.
      if (before === undefined || slug === undefined) return;
      if (before !== `/b/${slug}` && !before.startsWith(`/b/${slug}/`)) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      void router.navigate({ href: before });
    },
    [router, slug],
  );
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setNavigating(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => {
      desktop.removeEventListener('change', closeOnDesktop);
    };
  }, []);
  // Fetched once the shell is up, so the shortcut opens the bar at once.
  useEffect(() => {
    void loadCommandBar();
  }, []);
  const toggle = useCallback(() => {
    setSearching((open) => !open);
  }, []);
  useCommandBarShortcut(toggle);
  const fullWindow = useFullWindow();
  // The assistant's launcher is on every page of a business but its own full-screen view,
  // where the conversation already is. Not at the agency, and not on a page that takes the
  // whole window: the workflow builder has its own controls in that corner.
  const atAssistant =
    useMatch({ from: '/_app/b/$slug/assistant', shouldThrow: false }) !== undefined;
  // A page that takes the whole window (full-window.ts) keeps the way past everything to its
  // content, the one main landmark and the command bar, and nothing else of the shell.
  if (fullWindow)
    return (
      <div className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only rounded-lg bg-card px-4 py-2 text-foreground focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50"
        >
          <Trans>Skip to content</Trans>
        </a>
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col focus:outline-none">
          <Outlet />
        </main>
        <Suspense fallback={null}>
          <CommandBar open={searching} onOpenChange={setSearching} />
        </Suspense>
      </div>
    );
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <a
        href="#main"
        className="sr-only rounded-lg bg-card px-4 py-2 text-foreground focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50"
      >
        <Trans>Skip to content</Trans>
      </a>
      <header className="relative z-40 hidden w-(--sidebar-width) shrink-0 bg-sidebar text-sidebar-foreground lg:block">
        <Sidebar
          // In view however long the page is, with Settings at its foot.
          className="sticky top-0 h-dvh"
          onBack={goBack}
          onSearch={() => {
            setSearching(true);
          }}
        />
      </header>
      <Dialog.Root open={navigating} onOpenChange={setNavigating}>
        <header
          className={cn(
            'relative z-40 flex min-w-0 items-center gap-2 px-3 py-3 lg:hidden',
            onSidebarClassName,
          )}
        >
          <Dialog.Trigger
            render={
              <Button
                variant="quiet"
                className={sidebarButtonClassName}
                aria-label={t`Open navigation`}
              />
            }
          >
            <Menu aria-hidden className="size-5" strokeWidth={1.8} />
          </Dialog.Trigger>
          <div className="min-w-0 flex-1">
            <BusinessSwitcher me={me} business={business} section={section} atAgency={atAgency} />
          </div>
          <Button
            variant="quiet"
            className={sidebarButtonClassName}
            aria-label={t`Search Ctrl K`}
            onClick={() => {
              setSearching(true);
            }}
          >
            <Search aria-hidden className="size-5" strokeWidth={1.8} />
          </Button>
        </header>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
          <Dialog.Popup
            className={cn(
              'fixed inset-y-0 left-0 z-60 flex w-[min(320px,calc(100%-32px))] flex-col overflow-y-auto overscroll-contain rounded-r-card shadow-xl outline-none',
              onSidebarClassName,
            )}
            onClickCapture={(event) => {
              if (event.target instanceof Element && event.target.closest('a') !== null)
                setNavigating(false);
            }}
          >
            <div className="flex items-center justify-between border-b border-sidebar-foreground/30 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3">
              <Dialog.Title className="text-md font-medium">
                <Trans>Navigation</Trans>
              </Dialog.Title>
              <Dialog.Close
                render={
                  <Button
                    variant="quiet"
                    className={sidebarButtonClassName}
                    aria-label={t`Close navigation`}
                  />
                }
              >
                <X aria-hidden className="size-5" strokeWidth={1.8} />
              </Dialog.Close>
            </div>
            <div className="flex flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
              <Sidebar
                className="flex-1"
                onBack={goBack}
                onSearch={() => {
                  setNavigating(false);
                  setSearching(true);
                }}
              />
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar place={place} slug={business?.slug} businessId={business?.id} />
        {/* Room at the foot of every page for the assistant's launcher, so the last line of
            a page is never under it. */}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pt-4 pb-20 focus:outline-none">
          <div className="flex flex-col gap-5">
            <Outlet />
          </div>
        </main>
      </div>
      {business === undefined || atAssistant ? null : (
        <AssistantLauncher businessId={business.id} slug={business.slug} />
      )}
      <Suspense fallback={null}>
        <CommandBar open={searching} onOpenChange={setSearching} />
      </Suspense>
    </div>
  );
}
