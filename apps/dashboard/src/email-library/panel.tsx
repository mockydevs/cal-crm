// The left panel of an Emails library: everything, what is in no folder, each folder
// (nested as the folders are) with how many it holds, and the places at the bottom such as
// Archived and Trash. A folder's own menu renames or removes it. Narrower than the desktop
// layout the panel is a list to choose from above the table, with the chosen folder's menu
// beside it.
import { useLingui } from '@lingui/react/macro';
import { Select } from './select';
import { Archive, Folder, FolderPlus, FolderX, Inbox, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { iconButtonClassName } from '../list-table';
import { RowMenu, type RowAction } from './row-menu';

export interface PanelEntry {
  /** What the page keeps in its address for this place: "all", "root", a folder's id… */
  readonly key: string;
  readonly label: string;
  /** The label with the folders it is in, for the narrow list. */
  readonly path?: string;
  readonly count?: number | undefined;
  readonly depth?: number;
  readonly kind: 'all' | 'unfiled' | 'folder' | 'archived' | 'trash';
  /** A folder's own actions: rename, remove. */
  readonly actions?: readonly RowAction[];
}

const icons = {
  all: Inbox,
  unfiled: FolderX,
  folder: Folder,
  archived: Archive,
  trash: Trash2,
} as const;

// Each level of folder sits 14px further in; folders nest at most five deep.
const indents = ['pl-2', 'pl-5.5', 'pl-9', 'pl-12.5', 'pl-16'] as const;

const entryClassName =
  'group flex min-h-11 w-full min-w-0 items-center gap-2 rounded-control pr-2 text-left text-sm text-body -outline-offset-2 hover:bg-muted aria-[current=true]:bg-accent aria-[current=true]:font-medium aria-[current=true]:text-link lg:min-h-9';

export function LibraryPanel({
  label,
  entries,
  selected,
  onSelect,
  newFolderLabel,
  onNewFolder,
  onMenu,
}: {
  /** What the panel is called, such as "Template folders". */
  readonly label: string;
  readonly entries: readonly PanelEntry[];
  readonly selected: string;
  readonly onSelect: (key: string) => void;
  readonly newFolderLabel: string;
  /** Left out for someone who can't make folders. */
  readonly onNewFolder?: ((trigger: HTMLElement) => void) | undefined;
  /** Handed the button a folder's menu opened from, for the keyboard to return to. */
  readonly onMenu: (trigger: HTMLElement | null) => void;
}): ReactElement {
  const { t } = useLingui();
  const top = entries.filter(
    (entry) => entry.kind === 'all' || entry.kind === 'unfiled' || entry.kind === 'folder',
  );
  const bottom = entries.filter((entry) => entry.kind === 'archived' || entry.kind === 'trash');
  const chosen = entries.find((entry) => entry.key === selected);
  const chosenLabel = chosen?.label ?? '';
  const countOf = (entry: PanelEntry): string =>
    entry.count === undefined ? '' : ` (${String(entry.count)})`;
  return (
    <>
      <nav
        aria-label={label}
        className="hidden w-56 shrink-0 flex-col gap-1 self-start rounded-card border border-border bg-card p-2 lg:flex"
      >
        <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-1">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {onNewFolder === undefined ? null : (
            <button
              type="button"
              className={iconButtonClassName}
              aria-label={newFolderLabel}
              onClick={(event) => {
                onNewFolder(event.currentTarget);
              }}
            >
              <FolderPlus aria-hidden className="size-4" strokeWidth={1.8} />
            </button>
          )}
        </div>
        <ul className="flex flex-col gap-0.5">
          {top.map((entry) => (
            <PanelItem
              key={entry.key}
              entry={entry}
              current={entry.key === selected}
              onSelect={onSelect}
              onMenu={onMenu}
            />
          ))}
        </ul>
        {bottom.length === 0 ? null : (
          <ul className="mt-1 flex flex-col gap-0.5 border-t border-border pt-2">
            {bottom.map((entry) => (
              <PanelItem
                key={entry.key}
                entry={entry}
                current={entry.key === selected}
                onSelect={onSelect}
                onMenu={onMenu}
              />
            ))}
          </ul>
        )}
      </nav>
      <div className="flex min-w-0 items-center gap-2 lg:hidden">
        <Select
          aria-label={label}
          className="min-w-0 flex-1"
          value={selected}
          onValueChange={onSelect}
        >
          {[...top, ...bottom].map((entry) => (
            <option key={entry.key} value={entry.key}>
              {`${entry.path ?? entry.label}${countOf(entry)}`}
            </option>
          ))}
        </Select>
        {chosen?.actions === undefined || chosen.actions.length === 0 ? null : (
          <RowMenu label={t`Actions for ${chosenLabel}`} actions={chosen.actions} onOpen={onMenu} />
        )}
        {onNewFolder === undefined ? null : (
          <button
            type="button"
            className={iconButtonClassName}
            aria-label={newFolderLabel}
            onClick={(event) => {
              onNewFolder(event.currentTarget);
            }}
          >
            <FolderPlus aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
        )}
      </div>
    </>
  );
}

function PanelItem({
  entry,
  current,
  onSelect,
  onMenu,
}: {
  readonly entry: PanelEntry;
  readonly current: boolean;
  readonly onSelect: (key: string) => void;
  readonly onMenu: (trigger: HTMLElement | null) => void;
}): ReactElement {
  const { t } = useLingui();
  const Icon = icons[entry.kind];
  const { label } = entry;
  return (
    <li className="group/item flex min-w-0 items-center">
      <button
        type="button"
        aria-current={current}
        className={`${entryClassName} ${indents[Math.min(entry.depth ?? 0, indents.length - 1)] ?? 'pl-2'}`}
        onClick={() => {
          onSelect(entry.key);
        }}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {entry.count === undefined ? null : (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            <span className="sr-only">, </span>
            {entry.count}
          </span>
        )}
      </button>
      {entry.actions === undefined || entry.actions.length === 0 ? null : (
        // Always reachable from the keyboard; shown on hover beside the pointer.
        <div className="shrink-0 opacity-100 lg:opacity-0 lg:group-focus-within/item:opacity-100 lg:group-hover/item:opacity-100 lg:has-[[data-popup-open]]:opacity-100">
          <RowMenu label={t`Actions for ${label}`} actions={entry.actions} onOpen={onMenu} />
        </div>
      )}
    </li>
  );
}
