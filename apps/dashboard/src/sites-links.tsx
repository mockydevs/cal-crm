// The way from one Sites page to another. The whole module is one route whose address ends
// in whatever follows /sites/ (sites-rules.ts reads it), so every link and every move
// inside the module goes through here.
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactElement, ReactNode, Ref } from 'react';
import { useBusiness } from './workspace';

export function SitesLink({
  splat,
  current,
  className,
  children,
  ref,
}: {
  /** What follows /sites/ in the address: see listSplat and siteSplat. */
  readonly splat: string;
  /** Whether the link names the page showing, as a tab does. */
  readonly current?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLAnchorElement>;
}): ReactElement {
  const business = useBusiness();
  return (
    <Link
      ref={ref}
      to="/b/$slug/sites/$"
      params={{ slug: business.slug, _splat: splat }}
      // Which page is showing is the page's to say: a site's address starts its tabs'.
      activeOptions={{ exact: true }}
      aria-current={current === true ? 'page' : undefined}
      className={className}
    >
      {children}
    </Link>
  );
}

/** Opens another Sites page: `replace` when the page left is gone, such as a deleted site. */
export function useSitesNavigate(): (splat: string, replace?: boolean) => void {
  const business = useBusiness();
  const navigate = useNavigate();
  return (splat, replace = false) => {
    void navigate({
      to: '/b/$slug/sites/$',
      params: { slug: business.slug, _splat: splat },
      replace,
    });
  };
}

const wordOf = { funnel: 'funnels', website: 'websites' } as const;

/** The way to a page's editor, which has the whole window (routes: …/pages/{page}/edit). */
export function SiteEditorLink({
  kind,
  siteId,
  pageId,
  className,
  children,
}: {
  readonly kind: 'funnel' | 'website';
  readonly siteId: string;
  readonly pageId: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  const business = useBusiness();
  return (
    <Link
      to="/b/$slug/sites/$kind/$siteId/pages/$pageId/edit"
      params={{ slug: business.slug, kind: wordOf[kind], siteId, pageId }}
      className={className}
    >
      {children}
    </Link>
  );
}
