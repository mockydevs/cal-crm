import { Trans, useLingui } from '@lingui/react/macro';
import { Button, buttonVariants } from '@repo/ui/components/button';
import { ArrowLeft, Compass, Home } from 'lucide-react';
import type { ReactElement } from 'react';
import { Page } from './page';

/**
 * An address no page has, or a business that isn't there for this person: it may not
 * exist, or they may not enter it, and the page doesn't say which. It names the address
 * that was asked for and offers the ways on that always work: the start page, back to
 * where they were, and search.
 */
export function NotFound(): ReactElement {
  const { t } = useLingui();
  const asked = window.location.pathname;
  return (
    <Page title={t`Page not found`}>
      <section
        aria-label={t`Page not found`}
        className="flex min-w-0 flex-col items-center gap-6 rounded-card border border-border bg-card px-5 py-12 text-center sm:py-16"
      >
        {/* Decoration only: the heading above already says what happened. */}
        <div aria-hidden className="relative flex items-center justify-center">
          <span className="bg-linear-to-b from-primary/25 to-primary/5 bg-clip-text text-[112px] leading-none font-semibold tracking-tight text-transparent select-none sm:text-[152px]">
            404
          </span>
          <span className="absolute flex size-14 items-center justify-center rounded-full border border-border bg-card text-primary shadow-sm sm:size-16">
            <Compass className="size-7 sm:size-8" strokeWidth={1.6} />
          </span>
        </div>
        <div className="flex max-w-lg min-w-0 flex-col gap-2">
          <h2 className="text-xl font-semibold">
            <Trans>There's nothing at this address</Trans>
          </h2>
          <p className="text-sm text-body">
            <Trans>
              The page may have moved, or the link may be mistyped. Nothing of yours is lost.
            </Trans>
          </p>
          <p className="mx-auto max-w-full rounded-control bg-muted px-2.5 py-1 font-mono text-xs wrap-anywhere text-muted-foreground">
            {asked}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {/* A plain link: it starts from the person's own start page, whichever that is. */}
          <a href="/" className={buttonVariants({ variant: 'primary' })}>
            <Home aria-hidden className="size-[18px]" strokeWidth={1.8} />
            <Trans>Go to the start page</Trans>
          </a>
          <Button
            variant="secondary"
            onClick={() => {
              window.history.back();
            }}
          >
            <ArrowLeft aria-hidden className="size-[18px]" strokeWidth={1.8} />
            <Trans>Go back</Trans>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          <Trans>
            Looking for something? Press{' '}
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-sans text-[11px] font-medium text-foreground">
              Ctrl K
            </kbd>{' '}
            to search.
          </Trans>
        </p>
      </section>
    </Page>
  );
}
