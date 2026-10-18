// A list to choose from that can be searched: closed, it reads as a select does, with what
// is chosen; opened, it is a search box over the rows, under their headings, each with its
// name, a quieter second line and a short mark, the chosen one ticked. It works the same
// with five rows or five hundred: the list shows a first screenful, says how many there
// are, and narrows as the person types. The panel is a combobox over a listbox, in the
// manner of the tag chips (tag-picker.tsx): the arrow keys move, Enter chooses, Escape
// closes, and what the list holds is said aloud.
//
// The list opens in place, right under its control, not in a popup at the end of the
// page: it is used inside the builder's panels and the email editor, which are dialogs,
// and the kit's popover is drawn one layer beneath them.
//
// Its words are in the catalog of whichever part of the dashboard shows it
// (lingui.config.ts): a new place that uses it adds this file to its own catalog's list.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  isListKey,
  ownChoice,
  pickerChoices,
  stepped,
  toggled,
  type PickerItem,
} from './search-picker-rules';

const optionClassName =
  'flex min-h-11 cursor-pointer items-start gap-2 rounded-control px-2 py-1.5 text-md hover:bg-muted data-[active=true]:bg-muted lg:min-h-9';

export interface SearchPickerProps {
  readonly id?: string | undefined;
  /** What is being chosen, such as "Email template": names the closed control. */
  readonly label: string;
  /** What the closed control reads with nothing chosen, such as "Choose a template". */
  readonly placeholder: string;
  /** The name of the search box, such as "Search templates". */
  readonly searchLabel: string;
  readonly items: readonly PickerItem[];
  /** The ids chosen: one at most, unless `multiple`. */
  readonly selected: readonly string[];
  /** Several can be chosen; the list stays open, and each press ticks or unticks a row. */
  readonly multiple?: boolean;
  /** What the closed control reads for a chosen id the rows don't hold. */
  readonly unlisted?: ((id: string) => string) | undefined;
  /** Whether the rows are still on their way. */
  readonly loading?: boolean;
  /** Set when the rows could not be read: the way to ask again. */
  readonly onRetry?: (() => void) | undefined;
  /** How many rows the server has in all, when it gave only the first of them. */
  readonly total?: number | undefined;
  /** Asks the server for the rows that fit what is typed, in place of narrowing these. */
  readonly onSearch?: ((typed: string) => void) | undefined;
  /** Said when nothing fits what is typed, such as "No templates match." */
  readonly empty: string;
  /** Said when there are no rows at all, such as "There are no templates yet." */
  readonly none: string;
  /** A list that takes the person's own words as a choice: how long one may be. */
  readonly ownUpTo?: number | undefined;
  readonly onChange: (selected: string[]) => void;
  /** Links under the list, such as "Create a template" and "Manage templates". */
  readonly footer?: ReactNode;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
  /** Whether the keyboard starts here when the panel it is in opens. */
  readonly control?: boolean;
  readonly disabled?: boolean;
  /**
   * Drawn as a small button of a toolbar, with this inside it, in place of a box that
   * reads what is chosen: for a list that inserts something and holds no choice.
   */
  readonly tool?: ReactNode;
}

export function SearchPicker({
  id,
  label,
  placeholder,
  searchLabel,
  items,
  selected,
  multiple = false,
  unlisted,
  loading = false,
  onRetry,
  total,
  onSearch,
  empty,
  none,
  ownUpTo,
  onChange,
  footer,
  invalid = false,
  describedBy,
  control = false,
  disabled = false,
  tool,
}: SearchPickerProps): ReactElement {
  const { t } = useLingui();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // Whether the list hangs from the control's right edge, for one near the edge of its panel.
  const [fromRight, setFromRight] = useState(false);
  const [typed, setTyped] = useState('');
  const [active, setActive] = useState(-1);
  // The server already narrowed the rows it gave: they are not narrowed again here.
  const choices = pickerChoices(items, onSearch === undefined ? typed : '');
  const own = ownUpTo === undefined ? undefined : ownChoice(typed, items, selected, ownUpTo);
  const rows = choices.options.length + (own === undefined ? 0 : 1);
  const at = Math.min(active, rows - 1);
  const optionId = (index: number): string => `${listId}-${String(index)}`;
  const all = Math.max(total ?? 0, choices.matching);
  const shownCount = choices.options.length;

  const show = (): void => {
    const wrap = wrapRef.current;
    if (wrap !== null) {
      // The room to the right, inside the dialog the control is in, or the window.
      const edge =
        wrap.closest('[role="dialog"]')?.getBoundingClientRect().right ?? window.innerWidth;
      setFromRight(
        edge - wrap.getBoundingClientRect().left < Math.min(416, window.innerWidth - 32),
      );
    }
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
    setTyped('');
    setActive(-1);
    if (typed !== '') onSearch?.('');
  };
  const choose = (index: number): void => {
    const item = choices.options[index];
    const picked = item?.id ?? (index === choices.options.length ? own : undefined);
    if (picked === undefined) return;
    if (multiple) {
      onChange(toggled(selected, picked));
      // What was typed for a row of the person's own is spent once it is added.
      if (item === undefined) setTyped('');
      inputRef.current?.focus();
      return;
    }
    onChange([picked]);
    close();
  };

  // Opened, the keyboard is in the search box, and the list is brought into sight; a press
  // anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    inputRef.current?.closest('[data-picker-panel]')?.scrollIntoView({ block: 'nearest' });
    const outside = (event: MouseEvent): void => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target) !== true) {
        setOpen(false);
        setTyped('');
        setActive(-1);
      }
    };
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
    };
  }, [open]);

  // The row the keyboard is on stays in sight in a long list.
  useEffect(() => {
    if (at >= 0)
      document.getElementById(`${listId}-${String(at)}`)?.scrollIntoView({ block: 'nearest' });
  }, [at, listId]);

  const names = selected.map(
    (each) => items.find((item) => item.id === each)?.name ?? unlisted?.(each) ?? each,
  );
  const current = multiple || names.length === 0 ? placeholder : (names[0] ?? placeholder);
  const quiet = loading
    ? t`Loading…`
    : onRetry !== undefined
      ? null
      : rows === 0
        ? typed.trim() === ''
          ? none
          : empty
        : all > shownCount
          ? t`Showing ${shownCount} of ${all}. Type to narrow the list.`
          : null;
  const count = plural(shownCount, { one: '# choice', other: '# choices' });

  return (
    // eslint-disable-next-line jsx-a11y-x/no-static-element-interactions -- Escape closes the list from any control in it
    <div
      ref={wrapRef}
      className={tool === undefined ? 'relative min-w-0' : 'relative shrink-0'}
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return;
        // The list closes; the panel or dialog it is in stays.
        event.stopPropagation();
        event.preventDefault();
        close();
        triggerRef.current?.focus();
      }}
      onBlur={(event) => {
        // The keyboard left the list for somewhere else on the page.
        if (
          open &&
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          close();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else show();
        }}
        id={id}
        disabled={disabled}
        aria-label={tool === undefined ? `${label}: ${current}` : label}
        title={tool === undefined ? undefined : label}
        {...(tool === undefined ? {} : { 'data-tool': true })}
        data-invalid={invalid}
        aria-describedby={describedBy}
        {...(control ? { 'data-field-control': true } : {})}
        className={
          tool === undefined
            ? 'flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-control border border-input bg-card px-3 text-left text-md text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-[invalid=true]:border-destructive disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9'
            : 'inline-flex min-h-11 shrink-0 items-center gap-1 rounded-control px-2 text-sm font-medium text-body outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-8'
        }
      >
        {tool}
        <span
          hidden={tool !== undefined}
          className={`min-w-0 truncate ${multiple || names.length === 0 ? 'text-muted-foreground' : ''}`}
        >
          {current}
        </span>
        <ChevronDown
          aria-hidden
          className={`shrink-0 text-muted-foreground ${tool === undefined ? 'size-4' : 'size-3'}`}
          strokeWidth={2}
        />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={label}
          data-picker-panel
          className={`absolute top-full z-20 mt-1.5 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-3 rounded-card border bg-popover p-3 text-popover-foreground shadow-lg ${fromRight ? 'right-0' : 'left-0'}`}
        >
          <Input
            ref={inputRef}
            role="combobox"
            aria-label={searchLabel}
            aria-autocomplete="list"
            aria-expanded={rows > 0}
            aria-controls={rows > 0 ? listId : undefined}
            aria-activedescendant={at >= 0 ? optionId(at) : undefined}
            placeholder={searchLabel}
            autoComplete="off"
            maxLength={ownUpTo ?? 120}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              // The first match is ready for Enter as soon as something is typed.
              setActive(event.target.value.trim() === '' ? -1 : 0);
              onSearch?.(event.target.value);
            }}
            onKeyDown={(event) => {
              if (isListKey(event.key)) {
                event.preventDefault();
                setActive(stepped(at, rows, event.key));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (at >= 0) choose(at);
                else if (rows === 1) choose(0);
              }
            }}
          />
          {rows === 0 ? null : (
            <div
              id={listId}
              role="listbox"
              aria-label={label}
              aria-multiselectable={multiple || undefined}
              className="flex max-h-72 flex-col overflow-y-auto"
            >
              {choices.groups.map((group) => {
                const options = group.items.map((item) => {
                  const index = choices.options.indexOf(item);
                  const chosen = selected.includes(item.id);
                  return (
                    // The keyboard works the list from the search box, which names the option
                    // it is on (aria-activedescendant): an option is never focused.
                    // eslint-disable-next-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/interactive-supports-focus
                    <div
                      key={item.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={chosen}
                      data-active={index === at}
                      className={optionClassName}
                      // The keyboard stays in the box: a press is not a move of focus.
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        choose(index);
                      }}
                    >
                      <Check
                        aria-hidden
                        className={`mt-0.5 size-4 shrink-0 text-link ${chosen ? '' : 'invisible'}`}
                        strokeWidth={2.2}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="min-w-0 font-medium wrap-anywhere">{item.name}</span>
                        {item.detail === undefined || item.detail === '' ? null : (
                          <span className="min-w-0 truncate text-sm text-muted-foreground">
                            {item.detail}
                          </span>
                        )}
                      </span>
                      {item.mark === undefined ? null : (
                        <span className="mt-0.5 shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                          {item.mark}
                        </span>
                      )}
                    </div>
                  );
                });
                return group.name === undefined ? (
                  options
                ) : (
                  <div key={group.name} role="group" aria-label={group.name}>
                    <p
                      aria-hidden
                      className="px-2 pt-2 pb-0.5 text-xs font-medium text-muted-foreground"
                    >
                      {group.name}
                    </p>
                    {options}
                  </div>
                );
              })}
              {own === undefined ? null : (
                // eslint-disable-next-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/interactive-supports-focus -- as above
                <div
                  id={optionId(choices.options.length)}
                  role="option"
                  aria-selected={false}
                  data-active={at === choices.options.length}
                  className={optionClassName}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    choose(choices.options.length);
                  }}
                >
                  <Plus aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={2} />
                  <span className="min-w-0 wrap-anywhere">{t`Add “${own}”`}</span>
                </div>
              )}
            </div>
          )}
          <p role="status" className={quiet === null ? 'sr-only' : 'text-sm text-muted-foreground'}>
            {quiet ?? (onRetry === undefined ? count : '')}
          </p>
          {onRetry === undefined ? null : (
            <div role="alert" className="flex flex-col items-start gap-2 text-sm">
              <p>
                <Trans>The list couldn't be loaded.</Trans>
              </p>
              <Button variant="secondary" size="small" onClick={onRetry}>
                <Trans>Try again</Trans>
              </Button>
            </div>
          )}
          {footer === undefined || footer === null ? null : (
            <div className="-mx-3 -mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-sm">
              {footer}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
