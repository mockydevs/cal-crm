// A row's menu of actions, as GoHighLevel's lists have it: the ⋮ button and what it offers,
// for the Emails libraries. The same menu as the lists' (settings-list.tsx), on its own so
// those pages draw it without the lists' dialogs and popup list, which their route budget
// has no room for (scripts/check-budget.mjs). The lists keep their copy because moving it
// would add a chunk to pages already at their budget.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { EllipsisVertical } from 'lucide-react';
import { useCallback, useRef, type ReactElement } from 'react';
import { iconButtonClassName } from '../list-table';

export interface RowAction {
  readonly label: string;
  readonly destructive?: boolean;
  /** True for an action that happens at once: the keyboard stays on the row's button. */
  readonly immediate?: boolean;
  readonly onSelect: () => void;
}

/**
 * A row's menu of actions. An action opens a dialog, which takes the keyboard; when the
 * dialog closes the keyboard comes back to this row's button, which `onOpen` is handed. An
 * action marked `immediate` opens nothing, so the keyboard goes straight back to the button.
 */
export function RowMenu({
  label,
  actions,
  onOpen,
}: {
  /** What the button is called, such as "Actions for Hours of operation". */
  readonly label: string;
  readonly actions: readonly RowAction[];
  readonly onOpen: (trigger: HTMLElement | null) => void;
}): ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuContainerRef = useRef<HTMLElement | null>(null);
  const registerTrigger = useCallback((trigger: HTMLButtonElement | null) => {
    triggerRef.current = trigger;
    // Stay in the reader's page or dialog landmark instead of putting menu content
    // at the body root, outside the page's accessible structure.
    menuContainerRef.current =
      trigger?.closest<HTMLElement>('main,[role="main"],[role="dialog"],[role="region"]') ?? null;
  }, []);
  const actingRef = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger ref={registerTrigger} aria-label={label} className={iconButtonClassName}>
        <EllipsisVertical aria-hidden className="size-5" strokeWidth={1.8} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={menuContainerRef}
        align="end"
        className="min-w-44"
        // The dialog an action opens takes the keyboard; closing the menu without one
        // gives it back to the button.
        finalFocus={() => {
          const acting = actingRef.current;
          actingRef.current = false;
          return !acting;
        }}
      >
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            className={action.destructive === true ? 'text-destructive' : undefined}
            onClick={() => {
              actingRef.current = action.immediate !== true;
              onOpen(triggerRef.current);
              action.onSelect();
            }}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
