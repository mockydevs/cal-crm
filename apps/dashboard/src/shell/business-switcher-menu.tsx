// The business switcher's list: searched, the current business first and the rest by name.
// It is loaded when the switcher is first reached for, so a page that never opens it does
// not carry the list's code.
import { Trans, useLingui } from '@lingui/react/macro';
import { Avatar } from '@repo/ui/components/avatar';
import { ComboboxMenu, type ComboboxMenuOption } from '@repo/ui/components/combobox';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import { initialsOf } from '../workspace';
import type { BusinessSwitcherProps } from './business-switcher-props';

/** What the list's first entry chooses: the agency's list of every business. */
const AGENCY = 'agency';

export default function BusinessSwitcherMenu({
  me,
  business,
  section,
  atAgency,
  name,
  agencyIcon,
  avatarClassName,
  className,
  startOpen,
  children,
}: BusinessSwitcherProps & {
  /** Where the page is, as the button names it. */
  readonly name: string;
  readonly agencyIcon: ReactNode;
  readonly avatarClassName: string;
  readonly className: string;
  /** Whether the list is open as it appears: it appears because its button was pressed. */
  readonly startOpen: boolean;
  /** What the button shows. */
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  const navigate = useNavigate();
  // The list opens in here, so it's in the sidebar's banner landmark, as everything on a page
  // is in a landmark.
  const listRef = useRef<HTMLDivElement>(null);
  const agencyView = t`Agency view`;
  const allBusinesses = t`All businesses`;
  const options = useMemo<readonly ComboboxMenuOption[]>(() => {
    const others = me.businesses
      .filter((each) => each.id !== business?.id)
      .toSorted((one, other) => one.name.localeCompare(other.name));
    return [
      ...(me.agencyStaff
        ? [{ value: AGENCY, label: agencyView, detail: allBusinesses, leading: agencyIcon }]
        : []),
      ...[...(business === undefined ? [] : [business]), ...others].map((each) => ({
        value: each.id,
        label: each.name,
        detail: each.slug,
        leading: (
          <Avatar
            fallback={initialsOf(each.name, each.slug)}
            size="small"
            tint={4}
            className={avatarClassName}
          />
        ),
      })),
    ];
  }, [
    me.agencyStaff,
    me.businesses,
    business,
    agencyView,
    allBusinesses,
    agencyIcon,
    avatarClassName,
  ]);
  return (
    <div ref={listRef} className="min-w-0">
      <ComboboxMenu
        label={t`Business: ${name}`}
        title={name}
        options={options}
        value={business?.id ?? (atAgency ? AGENCY : null)}
        defaultOpen={startOpen}
        onChoose={(value) => {
          if (value === AGENCY) {
            void navigate({ to: '/agency' });
            return;
          }
          const chosen = me.businesses.find((each) => each.id === value);
          if (chosen !== undefined) void navigate({ to: section, params: { slug: chosen.slug } });
        }}
        searchLabel={t`Find a business`}
        empty={<Trans>No businesses match.</Trans>}
        container={listRef}
        className={className}
      >
        {children}
      </ComboboxMenu>
    </div>
  );
}
