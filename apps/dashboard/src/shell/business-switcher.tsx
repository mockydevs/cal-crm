import { Trans, useLingui } from '@lingui/react/macro';
import { Avatar } from '@repo/ui/components/avatar';
import { Building2, ChevronsUpDown } from 'lucide-react';
import { lazy, Suspense, useId, useState, type ReactElement, type ReactNode } from 'react';
import { initialsOf } from '../workspace';
import type { BusinessSwitcherProps } from './business-switcher-props';

export type { BusinessSection, BusinessSwitcherProps } from './business-switcher-props';

// One row, 44px tall, on the sidebar's color and a little lighter than it. The hover fill
// stays light enough for the small second line to read on it.
const triggerClassName =
  'flex h-11 w-full min-w-0 items-center gap-2.5 rounded-control bg-sidebar-foreground/10 px-2 text-left text-sidebar-foreground';

const avatarClassName = 'size-7 text-xs';

const loadMenu = () => import('./business-switcher-menu');
const BusinessSwitcherMenu = lazy(loadMenu);

/** What the switcher shows: where the page is, on one line, over a small label. */
function Place({ icon, name }: { readonly icon: ReactNode; readonly name: string }): ReactElement {
  return (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-md leading-5 font-medium">{name}</span>
        <span className="truncate text-xs leading-4 text-sidebar-foreground/70">
          <Trans>Business</Trans>
        </span>
      </span>
    </>
  );
}

const agencyIcon = (
  <span
    aria-hidden
    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground [&_svg]:size-4"
  >
    <Building2 strokeWidth={1.75} />
  </span>
);

/**
 * At the top of the navigation: the business the page is in, and a list to move to another,
 * or for agency staff to the agency's list of all of them. The list can be searched, has
 * the current business first and the rest by name, and opens another business in the
 * section this page is in. Someone with no business to enter has nowhere to go, so it's
 * just a label.
 *
 * The list's code is fetched when the pointer or the keyboard first reaches the button, and
 * the button stands in for the list until it is pressed: the list then takes its place,
 * already open.
 */
export function BusinessSwitcher({
  me,
  business,
  section,
  atAgency,
}: BusinessSwitcherProps): ReactElement {
  const { t } = useLingui();
  // Whether the list has been asked for. Until then the button below stands in for it.
  const [opened, setOpened] = useState(false);
  const listId = useId();
  const name =
    business !== undefined ? business.name : atAgency ? t`All businesses` : t`Choose a business`;
  const place = (
    <Place
      icon={
        business !== undefined ? (
          <Avatar
            fallback={initialsOf(business.name, business.slug)}
            size="small"
            tint={4}
            className={avatarClassName}
          />
        ) : (
          agencyIcon
        )
      }
      name={name}
    />
  );

  if (!me.agencyStaff && me.businesses.length === 0) {
    return (
      <div className={triggerClassName} title={name}>
        {place}
      </div>
    );
  }
  const buttonClassName = `${triggerClassName} hover:bg-sidebar-foreground/15 data-popup-open:bg-sidebar-foreground/15`;
  const shown = (
    <>
      {place}
      <ChevronsUpDown aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
    </>
  );
  // Fetched as soon as the pointer or the keyboard reaches the button, so it is there by
  // the time the button is pressed.
  const fetchList = () => {
    void loadMenu();
  };
  // The same button as the list's own, named and announced the same way, so nothing changes
  // for anyone when the list takes its place.
  const standIn = (
    <div className="min-w-0">
      <button
        type="button"
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={false}
        aria-controls={listId}
        aria-label={t`Business: ${name}`}
        title={name}
        className={buttonClassName}
        onPointerEnter={fetchList}
        onFocus={fetchList}
        onClick={() => {
          setOpened(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpened(true);
          }
        }}
      >
        {shown}
      </button>
      {/* Where the list will be: a combobox names what it opens, even while shut. */}
      <div id={listId} hidden />
    </div>
  );
  if (!opened) return standIn;
  return (
    <Suspense fallback={standIn}>
      <BusinessSwitcherMenu
        me={me}
        business={business}
        section={section}
        atAgency={atAgency}
        name={name}
        agencyIcon={agencyIcon}
        avatarClassName={avatarClassName}
        className={buttonClassName}
        startOpen
      >
        {shown}
      </BusinessSwitcherMenu>
    </Suspense>
  );
}
