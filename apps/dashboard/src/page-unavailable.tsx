// What a page shows when it can't be shown: its code didn't arrive (each page's code is
// fetched when the page is first opened), the server didn't answer, or it failed while
// drawing. The router shows it in place of the page, for every route (main.tsx), and in
// place of the whole app when the app itself can't start, so it is laid out to stand alone
// in the middle of whatever it is given. A new page fetches the code afresh, so the way
// forward is a reload; nothing typed is lost that the page itself hadn't already lost.
import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { useCallback, type ReactElement } from 'react';
import { failureDetails, failureKind } from './page-failure';

export function PageUnavailable({ error }: { readonly error?: unknown }): ReactElement {
  // Whatever was being used is gone, so the keyboard lands on the way forward.
  const focusOnMount = useCallback((button: HTMLButtonElement | null) => {
    button?.focus();
  }, []);
  const kind = failureKind(error, typeof navigator === 'undefined' ? true : navigator.onLine);
  const details = failureDetails(error);
  return (
    <div className="flex min-h-[70dvh] w-full min-w-0 items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-md min-w-0 flex-col items-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          {/* Drawn here, not taken from the icon set: this screen arrives with the first
              load, and must not bring the set with it. */}
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="size-6"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
        </span>
        <h1 className="text-2xl leading-tight font-semibold text-foreground">
          <Trans>This page couldn't load</Trans>
        </h1>
        <p className="text-md text-muted-foreground">
          {kind === 'offline' ? (
            <Trans>You appear to be offline. Check your connection first.</Trans>
          ) : kind === 'server' ? (
            <Trans>
              The server didn't answer. It may be restarting or unreachable; this usually clears up
              in a moment.
            </Trans>
          ) : kind === 'code' ? (
            <Trans>
              Part of the page didn't arrive. That happens on a weak connection, or just after an
              update.
            </Trans>
          ) : (
            <Trans>Something went wrong while showing it. Your saved work is not affected.</Trans>
          )}
        </p>
        <div role="alert" className="flex min-w-0 flex-col items-center gap-3 text-md">
          <p>
            <Trans>Reload the page to try again.</Trans>
          </p>
          <Button
            ref={focusOnMount}
            onClick={() => {
              window.location.reload();
            }}
          >
            <Trans>Reload page</Trans>
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm">
          <button
            type="button"
            className="min-h-11 rounded-control px-1 font-medium text-link underline lg:min-h-9"
            onClick={() => {
              window.history.back();
            }}
          >
            <Trans>Go back</Trans>
          </button>
          {/* A plain link, not the router's: it starts the app afresh, which is the point. */}
          <a
            href="/"
            className="flex min-h-11 items-center rounded-control px-1 font-medium text-link underline lg:min-h-9"
          >
            <Trans>Go to the start page</Trans>
          </a>
        </div>
        {details === undefined ? null : (
          <details className="w-full min-w-0 text-left text-sm text-muted-foreground">
            <summary className="mx-auto flex min-h-11 w-fit cursor-pointer items-center rounded-control px-1 lg:min-h-9">
              <Trans>Technical details</Trans>
            </summary>
            <p className="mt-1 rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs wrap-anywhere whitespace-pre-wrap text-body">
              {details}
            </p>
            <p className="mt-2 text-center text-xs">
              <Trans>
                If this keeps happening, send these details to whoever runs this system.
              </Trans>
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
