// A page's place on the web, as the funnel's page and the page editor both show it: where
// the page stands, its live address with Copy and Open, and what to do when it has none.
// The dialogs that preview and publish a page are in site-publish-dialogs.tsx, fetched when
// one is first opened.
import { Trans, useLingui } from '@lingui/react/macro';
import type { SitePublicStatus } from '@repo/contracts';
import { Button, buttonVariants } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { publicPagesOff, type PublishState } from './site-publish-rules';
import { useBusiness } from './workspace';

/* eslint-disable lingui/no-unlocalized-strings -- class names */
const badgeClassName = {
  unpublished: 'bg-secondary text-secondary-foreground',
  published: 'border border-success-line bg-success-subtle text-success',
  changes: 'bg-attention text-attention-foreground',
} satisfies Record<PublishState, string>;
/* eslint-enable lingui/no-unlocalized-strings */

/** Where a page stands, in a word or two. */
export function PublishBadge({ state }: { readonly state: PublishState }): ReactElement {
  return (
    <span
      data-testid="publish-state"
      className={`inline-flex min-h-6 items-center rounded-full px-2.5 text-xs font-medium ${badgeClassName[state]}`}
    >
      {state === 'unpublished' ? (
        <Trans>Not published</Trans>
      ) : state === 'published' ? (
        <Trans>Published</Trans>
      ) : (
        <Trans>Published · changes not yet published</Trans>
      )}
    </span>
  );
}

/**
 * Whether this install serves public pages at all, as its server says. It is the same for
 * every page of the install and does not change while the dashboard is open, so it is read
 * once and kept. Undefined until the answer is here, and for a server with no such answer.
 */
export function usePublicStatus(): SitePublicStatus | undefined {
  const business = useBusiness();
  return useQuery({
    queryKey: ['sites', 'public-status'],
    // The operation is fetched with the question (site-public-status.ts), not carried by
    // every page that draws a publish badge.
    queryFn: async () => (await import('./site-public-status')).readPublicStatus(business.id),
    staleTime: 5 * 60_000,
    retry: false,
  }).data;
}

/**
 * What to do when a page is published and still has no address: said to an owner. The
 * server's own sentence when it gave one (`getSitePublicStatus`), else what is known to be
 * the one cause on this server.
 */
export function NoPublicPages({
  reason,
}: {
  readonly reason?: string | null | undefined;
}): ReactElement {
  return (
    <p className="rounded-control bg-secondary px-3 py-2 text-sm">
      {typeof reason === 'string' && reason !== '' ? (
        <Trans>Public pages are switched off on this install. {reason}</Trans>
      ) : (
        <Trans>
          Public pages are switched off on this install, so the page has no address yet. To switch
          them on, whoever runs the server sets PUBLIC_INTAKE_SECRET in its settings (the .env file)
          and restarts it.
        </Trans>
      )}
    </p>
  );
}

/**
 * Said up front, where pages are built and published, on an install that serves none:
 * before anyone presses Publish and wonders where the page is. Nothing is drawn on an
 * install that serves pages, or while that is not known.
 */
export function PublicPagesNotice({
  status,
}: {
  readonly status: SitePublicStatus | undefined;
}): ReactElement | null {
  if (!publicPagesOff(status)) return null;
  const reason = status.reason ?? '';
  return (
    <p
      data-testid="public-pages-off"
      className="rounded-control bg-attention px-3 py-2 text-sm text-attention-foreground"
    >
      <Trans>
        Visitors can't reach pages on this install yet: public pages are switched off. {reason} You
        can still build, save and publish; a published page gets its address once they are on.
      </Trans>
    </p>
  );
}

/** A page's live address, with Copy and Open. */
export function LiveAddress({ url }: { readonly url: string }): ReactElement {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <p className="min-w-0 text-sm wrap-anywhere">
        <span className="text-muted-foreground">
          <Trans>Live at</Trans>
        </span>{' '}
        <span data-testid="live-address" className="font-medium text-foreground">
          {url}
        </span>
      </p>
      <Button
        variant="secondary"
        size="small"
        aria-label={t`Copy the live address`}
        onClick={() => {
          void navigator.clipboard.writeText(url).then(
            () => {
              setCopied(true);
            },
            () => undefined,
          );
        }}
      >
        <Copy aria-hidden className="size-4" strokeWidth={1.8} />
        <Trans>Copy</Trans>
      </Button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({ variant: 'secondary', size: 'small' })}
        aria-label={t`Open the live page in a new tab`}
      >
        <ExternalLink aria-hidden className="size-4" strokeWidth={1.8} />
        <Trans>Open live page</Trans>
      </a>
      <span role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {copied ? t`Copied.` : ''}
      </span>
    </div>
  );
}

/** Something drawn at a fixed width, made smaller when there is less room than that. */
export function FitWidth({
  width,
  className,
  testId,
  children,
}: {
  readonly width: number;
  readonly className?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}): ReactElement {
  const roomRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = roomRef.current;
    if (element === null) return;
    const measure = (): void => {
      setBox({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const scale = box.width === 0 ? 1 : Math.min(1, box.width / width);
  return (
    <div
      ref={roomRef}
      className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${className ?? ''}`}
    >
      <div
        data-testid={testId}
        data-width={width}
        className="absolute top-0 origin-top-left bg-card shadow-sm"
        style={{
          width,
          height: box.height / scale,
          left: Math.max(0, (box.width - width * scale) / 2),
          transform: `scale(${String(scale)})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
