// What the shell keeps of the command bar: the sidebar's Search button and the ⌘K or Ctrl+K
// shortcut. The bar itself loads apart, after the shell has rendered, so the first page
// doesn't wait for it.
import { Trans, useLingui } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import { useEffect, type ReactElement } from 'react';

/** The bar's code, fetched once and kept. */
export const loadCommandBar = (): Promise<typeof import('./command-bar')> =>
  import('./command-bar');

/** The sidebar's button for the bar, showing its shortcut. */
export function CommandBarButton({ onOpen }: { readonly onOpen: () => void }): ReactElement {
  const { t } = useLingui();
  const apple = /Mac|iPhone|iPad/.test(navigator.userAgent);
  return (
    <button
      type="button"
      aria-keyshortcuts="Control+K Meta+K"
      onClick={onOpen}
      className="flex min-h-11 w-full shrink-0 items-center gap-2.5 rounded-control border border-sidebar-foreground/20 bg-sidebar-active px-2.5 text-md leading-[normal] text-sidebar-foreground hover:border-sidebar-foreground/40 lg:min-h-9"
    >
      <Search aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="flex-1 text-left">
        <Trans>Search</Trans>
      </span>
      <kbd className="rounded-sm bg-sidebar px-1.5 py-px font-sans text-[11px] leading-4">
        {apple ? '⌘K' : t`Ctrl K`}
      </kbd>
    </button>
  );
}

/** Opens and closes the bar with ⌘K or Ctrl+K, wherever focus is. */
export function useCommandBarShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [toggle]);
}
