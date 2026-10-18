import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox';
import { Check, ChevronDown, X } from 'lucide-react';
import { useMemo, type ReactElement, type ReactNode, type Ref } from 'react';
import { cn } from '../lib/utils';

// A select you can type into, for lists too long to scroll, such as time zones. It is Base
// UI's Combobox (Base UI's parts stay inside this package): the box is a combobox
// that filters a listbox, the arrow keys move the highlight, Enter chooses it, Escape
// closes, and only a listed option can be chosen. Pressing the box or the down arrow shows
// the whole list. Inside a Field, the field's label, description and error are wired to
// the box.

export interface ComboboxOption {
  /** What choosing it gives. */
  readonly value: string;
  /** Its name: in the list, and in the box once chosen. */
  readonly label: string;
  /** A quieter second line, such as an offset. */
  readonly detail?: string;
  /** Other words it can be found by, for the caller's own matching. They aren't shown. */
  readonly keywords?: readonly string[];
}

export interface ComboboxProps {
  readonly options: readonly ComboboxOption[];
  /** The chosen option's value, or null for none. */
  readonly value: string | null;
  readonly onValueChange: (value: string | null) => void;
  /** Whether an option fits what is typed. Without it, an option fits when its label has it. */
  readonly matches?: (option: ComboboxOption, typed: string) => boolean;
  /** Said in place of the list when nothing fits, such as "No time zones match." */
  readonly empty: ReactNode;
  /** The name of the button that empties the box, such as "Clear time zone". */
  readonly clearLabel: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly name?: string;
  readonly className?: string;
  /** The box people type into. */
  readonly ref?: Ref<HTMLInputElement>;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string;
}

const buttonClassName =
  'flex size-9 shrink-0 items-center justify-center rounded-control text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed lg:size-8';

export function Combobox({
  options,
  value,
  onValueChange,
  matches,
  empty,
  clearLabel,
  placeholder,
  disabled = false,
  id,
  name,
  className,
  ref,
  ...aria
}: ComboboxProps): ReactElement {
  // Selection is by value; the list still gets each option whole, to show its detail.
  const items = useMemo(
    () =>
      ComboboxPrimitive.createItems(options, {
        getValue: (option) => option.value,
        getLabel: (option) => option.label,
      }),
    [options],
  );
  return (
    <ComboboxPrimitive.Root
      items={items}
      value={value}
      onValueChange={(next) => {
        onValueChange(next);
      }}
      {...(matches === undefined
        ? {}
        : { filter: (option: ComboboxOption, typed: string) => matches(option, typed) })}
      autoHighlight
      disabled={disabled}
      name={name}
    >
      <ComboboxPrimitive.InputGroup
        data-slot="combobox"
        className={cn(
          'flex min-h-11 w-full min-w-0 items-center gap-0.5 rounded-control border border-input bg-card pr-1 transition-colors focus-within:ring-2 focus-within:ring-ring has-data-invalid:border-destructive data-disabled:cursor-not-allowed data-disabled:opacity-50 lg:min-h-9',
          className,
        )}
      >
        <ComboboxPrimitive.Input
          ref={ref}
          id={id}
          placeholder={placeholder}
          aria-label={aria['aria-label']}
          aria-describedby={aria['aria-describedby']}
          data-slot="combobox-input"
          className="min-h-10.5 w-full min-w-0 flex-1 rounded-control bg-transparent pl-3 text-md text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed lg:min-h-8.5"
        />
        <ComboboxPrimitive.Clear aria-label={clearLabel} className={buttonClassName}>
          <X aria-hidden className="size-4" />
        </ComboboxPrimitive.Clear>
        <ComboboxPrimitive.Icon className="flex size-9 shrink-0 items-center justify-center text-muted-foreground lg:size-8">
          <ChevronDown aria-hidden className="size-[18px]" strokeWidth={1.8} />
        </ComboboxPrimitive.Icon>
      </ComboboxPrimitive.InputGroup>
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner
          align="start"
          sideOffset={6}
          className="isolate z-[70] max-w-(--available-width) outline-none"
        >
          <ComboboxPrimitive.Popup
            data-slot="combobox-popup"
            className="flex max-h-[min(22rem,var(--available-height))] w-(--anchor-width) max-w-(--available-width) flex-col overflow-hidden rounded-card border bg-popover text-popover-foreground shadow-lg outline-none"
          >
            <ComboboxPrimitive.Empty className="px-3 py-4 text-sm text-muted-foreground empty:hidden">
              {empty}
            </ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 outline-none data-empty:p-0">
              {(option: ComboboxOption) => (
                <ComboboxPrimitive.Item
                  key={option.value}
                  value={option.value}
                  data-value={option.value}
                  className="relative flex min-h-11 cursor-pointer flex-col justify-center rounded-control py-1.5 pr-9 pl-3 text-md outline-none select-none [scroll-margin-block:0.375rem] data-highlighted:bg-accent data-highlighted:text-accent-foreground lg:min-h-9"
                >
                  <span className="min-w-0 wrap-break-word">{option.label}</span>
                  {option.detail === undefined ? null : (
                    <span className="min-w-0 text-sm wrap-break-word text-muted-foreground">
                      {option.detail}
                    </span>
                  )}
                  <ComboboxPrimitive.ItemIndicator className="absolute top-1/2 right-3 -translate-y-1/2 text-primary">
                    <Check aria-hidden className="size-4" />
                  </ComboboxPrimitive.ItemIndicator>
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}

export interface ComboboxMenuOption extends ComboboxOption {
  /** Before its name, such as an avatar. Decorative. */
  readonly leading?: ReactNode;
}

export interface ComboboxMenuProps {
  /** What the button shows: usually the chosen option. */
  readonly children: ReactNode;
  /** The button's name. A combobox isn't named by what it shows, so this says it. */
  readonly label: string;
  readonly options: readonly ComboboxMenuOption[];
  /** The option that is current, which carries the check mark; null for none. */
  readonly value: string | null;
  /** Called with the option someone chose. */
  readonly onChoose: (value: string) => void;
  /** The name of the box that filters the list, such as "Find a business". */
  readonly searchLabel: string;
  /** Said in place of the list when nothing fits. */
  readonly empty: ReactNode;
  /** Where the popup renders, such as an element in the landmark the button is in. */
  readonly container?: ComboboxPrimitive.Portal.Props['container'];
  /** The button's classes. */
  readonly className?: string;
  readonly popupClassName?: string;
  readonly title?: string;
  /** Whether the list is open when the button first appears. */
  readonly defaultOpen?: boolean;
}

/**
 * A button that opens a list to choose from, with a box above the list that filters it as
 * you type (Base UI's combobox with its input inside the popup, so the button is announced
 * as a combobox that opens a dialog): for a choice among many that is made from one place, such as which business to
 * work in. The keyboard starts in the box; the arrow keys move through the list, Enter
 * chooses, and Escape closes and gives the keyboard back to the button.
 */
export function ComboboxMenu({
  children,
  label,
  options,
  value,
  onChoose,
  searchLabel,
  empty,
  container,
  className,
  popupClassName,
  title,
  defaultOpen = false,
}: ComboboxMenuProps): ReactElement {
  const items = useMemo(
    () =>
      ComboboxPrimitive.createItems(options, {
        getValue: (option) => option.value,
        getLabel: (option) => option.label,
      }),
    [options],
  );
  return (
    <ComboboxPrimitive.Root
      items={items}
      value={value}
      defaultOpen={defaultOpen}
      onValueChange={(next) => {
        if (next !== null) onChoose(next);
      }}
      autoHighlight
    >
      <ComboboxPrimitive.Trigger
        data-slot="combobox-menu-trigger"
        aria-label={label}
        className={className}
        title={title}
      >
        {children}
      </ComboboxPrimitive.Trigger>
      <ComboboxPrimitive.Portal container={container}>
        <ComboboxPrimitive.Positioner
          align="start"
          sideOffset={6}
          className="isolate z-[70] max-w-(--available-width) outline-none"
        >
          <ComboboxPrimitive.Popup
            data-slot="combobox-menu-popup"
            aria-label={searchLabel}
            className={cn(
              'flex max-h-[min(60vh,var(--available-height))] w-80 max-w-(--available-width) flex-col overflow-hidden rounded-card border bg-popover text-popover-foreground shadow-lg outline-none',
              popupClassName,
            )}
          >
            <div className="border-b p-1.5">
              <ComboboxPrimitive.Input
                aria-label={searchLabel}
                placeholder={searchLabel}
                data-slot="combobox-menu-input"
                className="min-h-11 w-full min-w-0 rounded-control border border-input bg-card px-3 text-md text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring lg:min-h-9"
              />
            </div>
            <ComboboxPrimitive.Empty className="px-3 py-4 text-sm text-muted-foreground empty:hidden">
              {empty}
            </ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 outline-none data-empty:p-0">
              {(option: ComboboxMenuOption) => (
                <ComboboxPrimitive.Item
                  key={option.value}
                  value={option.value}
                  data-value={option.value}
                  className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-control px-2 py-1 text-md outline-none select-none [scroll-margin-block:0.375rem] data-highlighted:bg-muted"
                >
                  {option.leading}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-foreground">{option.label}</span>
                    {option.detail === undefined ? null : (
                      <span className="truncate text-xs text-muted-foreground">
                        {option.detail}
                      </span>
                    )}
                  </span>
                  <ComboboxPrimitive.ItemIndicator className="shrink-0 text-foreground">
                    <Check aria-hidden className="size-4" />
                  </ComboboxPrimitive.ItemIndicator>
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
