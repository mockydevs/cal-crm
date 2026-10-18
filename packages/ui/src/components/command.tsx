import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import { ScrollArea } from '@base-ui/react/scroll-area';
import { Search } from 'lucide-react';
import { useId, useRef, type ReactElement, type ReactNode } from 'react';

// A command bar: a search box over a list of places and records to go to, in a dialog. It
// is Base UI's autocomplete, inline in a dialog, as its own command palette example has it.
// The list's items come already filtered: the app searches, this shows. The arrow keys move
// the highlight, Enter follows the highlighted item, Escape closes.

export interface CommandGroup<Item> {
  /** The group's heading, and its key. */
  readonly label: string;
  readonly items: readonly Item[];
}

export interface CommandDialogProps<Item> {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The dialog's accessible name. */
  readonly label: string;
  /** The search box's accessible name, and its placeholder. */
  readonly inputLabel: string;
  readonly placeholder: string;
  /** What's typed. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly groups: readonly CommandGroup<Item>[];
  /** Each item's key. */
  readonly itemKey: (item: Item) => string;
  /** Each item's name, as text. */
  readonly itemText: (item: Item) => string;
  readonly renderItem: (item: Item) => ReactNode;
  /** Follows the item: by pointer or by Enter on the highlighted one. */
  readonly onSelect: (item: Item) => void;
  /** Said when nothing is listed, such as "No results". */
  readonly empty: ReactNode;
  /** Said to screen readers as results change, such as "Searching…". */
  readonly status?: ReactNode;
  /** How to work it by keyboard, read after the search box's name. */
  readonly hint: string;
  /** The hidden button that closes it, for touch screen readers. */
  readonly closeLabel: string;
}

export function CommandDialog<Item>({
  open,
  onOpenChange,
  label,
  inputLabel,
  placeholder,
  value,
  onValueChange,
  groups,
  itemKey,
  itemText,
  renderItem,
  onSelect,
  empty,
  status,
  hint,
  closeLabel,
}: CommandDialogProps<Item>): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/20 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh] pb-4">
          <Dialog.Popup
            aria-label={label}
            // On a phone too: the search box takes the keyboard straight away.
            initialFocus={inputRef}
            data-slot="command-dialog"
            className="flex max-h-[min(36rem,calc(100dvh-6rem))] w-full max-w-xl flex-col overflow-hidden rounded-card border bg-popover text-popover-foreground shadow-lg outline-none transition-[translate,opacity] duration-150 data-ending-style:-translate-y-2 data-ending-style:opacity-0 data-starting-style:-translate-y-2 data-starting-style:opacity-0"
          >
            <Autocomplete.Root
              open
              inline
              items={groups}
              filter={null}
              value={value}
              onValueChange={(next) => {
                onValueChange(next);
              }}
              itemToStringValue={itemText}
              autoHighlight="always"
              keepHighlight
            >
              <Autocomplete.InputGroup className="flex items-center gap-2.5 border-b px-4">
                <Search aria-hidden className="size-[18px] shrink-0 text-muted-foreground" />
                <Autocomplete.Input
                  ref={inputRef}
                  aria-label={inputLabel}
                  aria-describedby={hintId}
                  placeholder={placeholder}
                  className="h-13 w-full min-w-0 bg-transparent text-md outline-none placeholder:text-muted-foreground"
                />
              </Autocomplete.InputGroup>
              <span id={hintId} className="sr-only">
                {hint}
              </span>
              <Dialog.Close className="sr-only">{closeLabel}</Dialog.Close>
              <Autocomplete.Status className="sr-only">{status}</Autocomplete.Status>
              {/* Base UI's scroll area: in the tab order only while it overflows, so a keyboard
                  can scroll it in every browser; the arrow keys also scroll the highlight in. */}
              <ScrollArea.Root className="relative flex min-h-0 flex-1 overflow-hidden">
                <ScrollArea.Viewport className="min-h-0 flex-1 overscroll-contain rounded-b-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                  <ScrollArea.Content className="min-w-full p-1.5">
                    <Autocomplete.Empty className="px-3 py-6 text-center text-sm text-muted-foreground empty:hidden">
                      {empty}
                    </Autocomplete.Empty>
                    <Autocomplete.List className="flex flex-col gap-1">
                      {(group: CommandGroup<Item>) => (
                        <Autocomplete.Group key={group.label} items={group.items}>
                          <Autocomplete.GroupLabel className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                            {group.label}
                          </Autocomplete.GroupLabel>
                          <Autocomplete.Collection>
                            {(item: Item) => (
                              <Autocomplete.Item
                                key={itemKey(item)}
                                value={item}
                                onClick={() => {
                                  onSelect(item);
                                }}
                                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-3 text-md leading-[normal] outline-none select-none [scroll-margin-block:0.375rem] data-highlighted:bg-muted lg:min-h-9 [&_svg]:shrink-0"
                              >
                                {renderItem(item)}
                              </Autocomplete.Item>
                            )}
                          </Autocomplete.Collection>
                        </Autocomplete.Group>
                      )}
                    </Autocomplete.List>
                  </ScrollArea.Content>
                </ScrollArea.Viewport>
                <ScrollArea.Scrollbar className="flex w-2.5 justify-center p-0.5 opacity-0 transition-opacity data-scrolling:opacity-100 data-hovering:opacity-100">
                  <ScrollArea.Thumb className="w-full rounded-full bg-border" />
                </ScrollArea.Scrollbar>
              </ScrollArea.Root>
            </Autocomplete.Root>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
