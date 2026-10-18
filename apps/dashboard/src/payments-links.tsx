// The way from one Payments page to another. The whole module is one route whose address
// ends in whatever follows /payments/ (payments-rules.ts reads it), so every link and every
// move inside the module goes through here.
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import type { PaymentsSearch } from './payments-search';
import { useBusiness } from './workspace';

export function PaymentsLink({
  splat,
  search,
  className,
  children,
  'aria-label': label,
}: {
  /** What follows /payments/ in the address: see documentSplat and receiptSplat. */
  readonly splat: string;
  readonly search?: PaymentsSearch;
  readonly className?: string;
  readonly children: ReactNode;
  readonly 'aria-label'?: string;
}): ReactElement {
  const business = useBusiness();
  return (
    <Link
      to="/b/$slug/payments/$"
      params={{ slug: business.slug, _splat: splat }}
      search={search ?? {}}
      activeOptions={{ exact: true }}
      aria-label={label}
      className={className}
    >
      {children}
    </Link>
  );
}

/** Opens another Payments page: `replace` when the page left is gone, such as a deleted draft. */
export function usePaymentsNavigate(): (splat: string, replace?: boolean) => void {
  const business = useBusiness();
  const navigate = useNavigate();
  return (splat, replace = false) => {
    void navigate({
      to: '/b/$slug/payments/$',
      params: { slug: business.slug, _splat: splat },
      search: {},
      replace,
    });
  };
}
