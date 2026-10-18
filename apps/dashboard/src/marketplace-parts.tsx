// What the App Marketplace's list and an app's page share: where their answers
// are kept, an app's picture (its icon, or its initials when it has none or the icon won't
// load), its categories, and the Installed mark.
import { useLingui } from '@lingui/react/macro';
import type { MarketplaceCategory } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { cn } from '@repo/ui/lib/utils';
import { useState, type ReactElement } from 'react';
import { categoryNames } from './marketplace-rules';
import { initialsOf } from './workspace';

/** Everything the business's marketplace pages read: refreshed together after a change. */
export const marketplaceKey = (businessId: string) => ['b', businessId, 'marketplace'] as const;
export const marketplaceAppKey = (businessId: string, appId: string) =>
  [...marketplaceKey(businessId), 'app', appId] as const;

/** The app's icon from its own address, or its initials. Decorative: its name is beside it. */
export function AppIcon({
  name,
  iconUrl,
  large = false,
}: {
  readonly name: string;
  readonly iconUrl: string | null;
  readonly large?: boolean;
}): ReactElement {
  const [broken, setBroken] = useState<string>();
  if (iconUrl !== null && broken !== iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        // Asked for without a referrer: the icon's server isn't told which page shows it.
        referrerPolicy="no-referrer"
        loading="lazy"
        className={cn(
          'shrink-0 rounded-lg border border-border bg-card object-cover',
          large ? 'size-16' : 'size-12',
        )}
        onError={() => {
          setBroken(iconUrl);
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-accent font-semibold text-link',
        large ? 'size-16 text-xl' : 'size-12 text-md',
      )}
    >
      {initialsOf(name, '?')}
    </span>
  );
}

/** What the app is about, as small chips. */
export function CategoryChips({
  categories,
}: {
  readonly categories: readonly MarketplaceCategory[];
}): ReactElement | null {
  const { i18n, t } = useLingui();
  if (categories.length === 0) return null;
  return (
    <ul aria-label={t`Categories`} className="flex flex-wrap gap-1.5">
      {categories.map((category) => (
        <li
          key={category}
          className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
        >
          {i18n._(categoryNames[category])}
        </li>
      ))}
    </ul>
  );
}

/** Says that this business has the app installed. */
export function InstalledBadge(): ReactElement {
  const { t } = useLingui();
  return <Badge className="px-2.5 py-0.5 text-xs">{t`Installed`}</Badge>;
}
