import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import type { BusinessSummary } from '@repo/contracts';
import { Avatar } from '@repo/ui/components/avatar';
import { Badge } from '@repo/ui/components/badge';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { initialsOf } from '../workspace';

const statuses: Record<Exclude<BusinessSummary['status'], 'active'>, MessageDescriptor> = {
  suspended: msg`Suspended`,
  archived: msg`Archived`,
};

/** Businesses to enter, as cards that open each one. */
export function BusinessList({
  businesses,
}: {
  readonly businesses: readonly BusinessSummary[];
}): ReactElement {
  const { i18n, t } = useLingui();
  return (
    <ul
      aria-label={t`Businesses`}
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3"
    >
      {businesses.map((business) => (
        <li key={business.id}>
          <Link
            to="/b/$slug"
            params={{ slug: business.slug }}
            className="flex min-h-18 items-center gap-3 rounded-card border bg-card px-4 py-3 hover:bg-muted"
          >
            <Avatar fallback={initialsOf(business.name, business.slug)} size="medium" tint={4} />
            <span className="min-w-0 flex-1 text-md font-semibold wrap-break-word">
              {business.name}
            </span>
            {business.status === 'active' ? null : (
              <Badge>{i18n._(statuses[business.status])}</Badge>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
