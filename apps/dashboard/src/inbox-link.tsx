// How the Inbox reads and changes its address. The route owns the address; the page is
// given what it says and a way to change it, and makes real links from the two.
import type { MouseEvent, ReactElement, ReactNode, Ref } from 'react';
import type { InboxSearch } from './inbox-search';

export interface InboxNavigation {
  /** The address a search would have, for a link's href. */
  readonly hrefFor: (search: InboxSearch) => string;
  readonly go: (search: InboxSearch, how?: { readonly replace?: boolean }) => void;
}

/** A real link that changes the address without reloading; modified clicks open as links do. */
export function InboxLink({
  to,
  navigation,
  replace = false,
  onGo,
  children,
  ...anchor
}: {
  readonly to: InboxSearch;
  readonly navigation: InboxNavigation;
  /** For a change of filter: Back then leaves the Inbox instead of undoing it. */
  readonly replace?: boolean;
  /** After the address changed in place, such as to move the keyboard to what opened. */
  readonly onGo?: () => void;
  readonly children: ReactNode;
  readonly id?: string;
  readonly ref?: Ref<HTMLAnchorElement>;
  readonly className?: string;
  readonly 'aria-current'?: 'true';
}): ReactElement {
  return (
    <a
      {...anchor}
      href={navigation.hrefFor(to)}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        navigation.go(to, { replace });
        onGo?.();
      }}
    >
      {children}
    </a>
  );
}
