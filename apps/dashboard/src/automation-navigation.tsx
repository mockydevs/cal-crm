// How the Automations page reads and changes its address: which automation is open, and
// in which view. The route owns the address; the page is given what it says and a way to
// change it, and builds real links from the two.
import type { MouseEvent, ReactElement, ReactNode } from 'react';

/** What the address says: which automation is open, in which view, and which of its runs. */
export interface AutomationsSearch {
  readonly automation?: string;
  /**
   * The canvas unless the address says another: the Steps or JSON view of the builder, the
   * Settings tab, the Enrollment history (runs) or the Execution logs.
   */
  readonly view?: 'steps' | 'json' | 'settings' | 'runs' | 'logs';
  /** One run, opened from the automation's runs. */
  readonly run?: string;
  /** In the list of workflows: the folder that is open; the top level without one. */
  readonly folder?: string;
  /** In the list of workflows: the Deleted list, in place of all workflows. */
  readonly list?: 'deleted';
  /**
   * In the list of workflows: "Start from a recipe" open on this recipe, as a calendar's
   * settings open "Appointment reminders", with that calendar (its id) chosen.
   */
  readonly recipe?: 'appointment_reminders';
  readonly calendar?: string;
}

export type AutomationView = 'canvas' | 'steps' | 'json' | 'settings' | 'runs' | 'logs';

export interface AutomationsNavigation {
  /** The address a search would have, for a link's href. */
  readonly hrefFor: (search: AutomationsSearch) => string;
  readonly go: (search: AutomationsSearch, how?: { readonly replace?: boolean }) => void;
}

/** A real link that changes the address without reloading; modified clicks open as links do. */
export function SearchLink({
  to,
  navigation,
  children,
  ...anchor
}: {
  readonly to: AutomationsSearch;
  readonly navigation: AutomationsNavigation;
  readonly children: ReactNode;
  readonly className?: string;
  readonly 'aria-current'?: 'page';
  readonly 'aria-label'?: string;
}): ReactElement {
  return (
    <a
      {...anchor}
      href={navigation.hrefFor(to)}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        navigation.go(to);
      }}
    >
      {children}
    </a>
  );
}
