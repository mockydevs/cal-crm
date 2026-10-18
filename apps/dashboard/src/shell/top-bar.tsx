import { useLingui } from '@lingui/react/macro';
import { Avatar } from '@repo/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import { getGoogleConnections } from '@repo/contracts';
import { useRef, type ReactElement, type RefObject } from 'react';
import { apiIn } from '../api';
import { sessionQuery, signOut } from '../auth';
import { googleConnectionsKey } from '../calendar-connections-rules';
import { initialsOf } from '../workspace';
import type { CurrentModule, ModuleTab } from './modules';
import { NotificationsBell } from './notifications-bell';

/** The signed-in person, and the way out. */
function AccountMenu({
  container,
}: {
  /** Where the menu opens, so it's in the bar's landmark, as everything on a page is in one. */
  readonly container: RefObject<HTMLElement | null>;
}): ReactElement {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // The layout only renders once the session is known.
  const user = useQuery(sessionQuery).data?.user;
  const leave = useMutation({
    mutationFn: signOut,
    onSettled: async () => {
      queryClient.setQueryData(sessionQuery.queryKey, null);
      await navigate({ to: '/sign-in' });
      // Only once the app's pages are gone, so none of them asks again for what it showed.
      queryClient.clear();
    },
  });
  if (user === undefined) return <></>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Your account`}
        className="flex size-11 items-center justify-center rounded-full hover:bg-muted data-popup-open:bg-muted lg:size-9"
      >
        <Avatar fallback={initialsOf(user.name, user.email)} size="small" tint={4} />
      </DropdownMenuTrigger>
      <DropdownMenuContent container={container} align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-px pb-2 text-sm">
            {user.name === '' ? null : (
              <span className="wrap-break-word text-foreground">{user.name}</span>
            )}
            <span className="text-xs font-normal break-all">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={leave.isPending}
            onClick={() => {
              leave.mutate();
            }}
          >
            <LogOut aria-hidden className="size-[18px]" strokeWidth={1.8} />
            {t`Sign out`}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The tabs this install offers: one that needs Google Calendar's OAuth client is drawn only
 * where the install has it, so no tab leads to a page with nothing to do.
 */
function useOfferedTabs(
  tabs: readonly ModuleTab[] | undefined,
  businessId: string | undefined,
): readonly ModuleTab[] | undefined {
  const asks = businessId !== undefined && tabs?.some((tab) => tab.needs === 'google_calendar');
  const google = useQuery({
    queryKey: googleConnectionsKey(businessId ?? ''),
    queryFn: () => apiIn(businessId ?? '').request(getGoogleConnections, {}),
    enabled: asks === true,
    staleTime: 60_000,
  });
  return tabs?.filter((tab) => tab.needs === undefined || google.data?.available === true);
}

const tabClassName =
  'flex min-h-11 items-end border-b-2 border-transparent px-2 pb-2 font-medium text-body hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-link lg:min-h-0';

/**
 * Above every page: the name of the module the page is in, the module's pages as tabs, and
 * the signed-in person. The name is not a heading: each page has its own.
 */
export function TopBar({
  place,
  slug,
  businessId,
}: {
  readonly place: CurrentModule;
  /** The business the page is in, for the tabs' addresses. */
  readonly slug: string | undefined;
  /** The same business, for its notifications; none on a page outside a business. */
  readonly businessId: string | undefined;
}): ReactElement {
  const { i18n, t } = useLingui();
  const barRef = useRef<HTMLElement>(null);
  const name = place.name === undefined ? undefined : i18n._(place.name);
  const tabs = useOfferedTabs(place.tabs, businessId);
  const tabsName = place.tabsName === undefined ? name : i18n._(place.tabsName);
  return (
    <section
      ref={barRef}
      aria-label={t`Top bar`}
      className="flex min-w-0 items-end gap-x-6 border-b bg-card px-4 pt-2 lg:sticky lg:top-0 lg:z-30 lg:min-h-[92px] lg:pt-4"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-end gap-x-5 gap-y-1">
        {name === undefined ? null : (
          <p className="mb-2.5 text-lg leading-6 font-medium wrap-break-word">{name}</p>
        )}
        {name === undefined || tabs === undefined || slug === undefined ? null : (
          <nav aria-label={tabsName} className="flex flex-wrap gap-x-1">
            {tabs.map((tab) => (
              <Link
                key={`${tab.to}:${tab.splat ?? ''}`}
                to={tab.to}
                params={tab.splat === undefined ? { slug } : { slug, _splat: tab.splat }}
                // Which tab the page is under is the bar's to say: a contact's own page is
                // under the list it came from, and a company's is not.
                activeOptions={{ exact: true }}
                aria-current={tab === place.tab ? 'page' : undefined}
                className={tabClassName}
              >
                {i18n._(tab.label)}
              </Link>
            ))}
          </nav>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 self-start">
        {businessId === undefined || slug === undefined ? null : (
          <NotificationsBell businessId={businessId} slug={slug} />
        )}
        <AccountMenu container={barRef} />
      </div>
    </section>
  );
}
