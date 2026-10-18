// What the Emails libraries share around their rows: the slim toolbar (search, filters,
// sort and the list or grid switch), a labelled tick box, the bar of bulk actions while
// rows are ticked, and the looks of a compact row, whose Open shows as the pointer passes.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Select } from './select';
import { LayoutGrid, List, X } from 'lucide-react';
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { ListSearch } from '../list-toolbar';

/** A compact table: rows of about 48px, so a dozen show on a laptop. */
export const compactCellClassName = 'h-12 border-t border-border px-3 py-1 align-middle';
export const compactHeaderClassName =
  'h-9 bg-muted px-3 py-0 text-left align-middle text-xs font-medium whitespace-nowrap text-body';
/** Shown from the medium width up: a column a phone can do without. */
export const wideOnlyClassName = 'hidden md:table-cell';
/** A row's Open: always there for the keyboard, shown to the pointer on hover. */
export const hoverOpenClassName =
  'lg:opacity-0 lg:group-hover/row:opacity-100 lg:focus-visible:opacity-100 lg:group-focus-within/row:opacity-100';
export const rowClassName = 'group/row hover:bg-muted/60 data-ticked:bg-accent';
export const nameButtonClassName =
  'block max-w-full min-w-0 truncate rounded-control text-left font-medium text-foreground -outline-offset-2 hover:text-link hover:underline';

export interface ToolbarChoice {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** Handed one of the options' values. */
  readonly onChange: (value: string) => void;
  /** Narrower boxes for short choices. */
  readonly width?: string;
}

function Choice({ choice }: { readonly choice: ToolbarChoice }): ReactElement {
  return (
    <Select
      aria-label={choice.label}
      className={choice.width ?? 'w-40'}
      value={choice.value}
      onValueChange={(next) => {
        const found = choice.options.find((option) => option.value === next);
        if (found !== undefined) choice.onChange(found.value);
      }}
    >
      {choice.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

/** The one row above the table: search at the left, the choices and the view at the right. */
export function LibraryToolbar({
  searchLabel,
  search,
  onSearch,
  choices,
  layout,
  onLayout,
}: {
  readonly searchLabel: string;
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly choices: readonly ToolbarChoice[];
  readonly layout?: 'list' | 'grid' | undefined;
  readonly onLayout?: ((layout: 'list' | 'grid') => void) | undefined;
}): ReactElement {
  const { t } = useLingui();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ListSearch label={searchLabel} value={search} onChange={onSearch} />
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto">
        {choices.map((choice) => (
          <Choice key={choice.label} choice={choice} />
        ))}
        {layout === undefined || onLayout === undefined ? null : (
          <div role="group" aria-label={t`View`} className="inline-flex rounded-lg bg-muted p-1">
            {(
              [
                ['list', t`List view`, List],
                ['grid', t`Grid view`, LayoutGrid],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                aria-label={label}
                aria-pressed={layout === value}
                className="inline-flex size-11 items-center justify-center rounded-control text-body -outline-offset-2 hover:text-foreground aria-pressed:bg-card aria-pressed:text-link aria-pressed:shadow-[0_1px_2px_rgb(16_24_40/0.05)] lg:size-7"
                onClick={() => {
                  onLayout(value);
                }}
              >
                <Icon aria-hidden className="size-4" strokeWidth={1.8} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A tick box with its own name for a screen reader; "some" shows the mixed state. */
export function TickBox({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  readonly label: string;
  readonly checked: boolean | 'some';
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = checked === 'some';
  }, [checked]);
  return (
    // The box's own 16px, inside a 44px (32px on a desktop) place to press.
    <label className="inline-flex size-11 cursor-pointer items-center justify-center lg:size-8">
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={checked === true}
        disabled={disabled}
        className="size-4 cursor-pointer accent-primary"
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
    </label>
  );
}

export interface BulkAction {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onSelect: (trigger: HTMLElement) => void;
}

/**
 * While rows are ticked: how many, what can be done to all of them, and a way out. Ticks
 * belong to the page showing: another page starts with none.
 */
export function BulkBar({
  count,
  actions,
  busy,
  onClear,
}: {
  readonly count: number;
  readonly actions: readonly BulkAction[];
  readonly busy: boolean;
  readonly onClear: () => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <section
      aria-label={t`Bulk actions`}
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-accent px-3 py-1.5"
    >
      <p className="mr-auto text-sm font-medium text-link" aria-live="polite">
        <Trans>{count} selected on this page</Trans>
      </p>
      {actions.map((action) => (
        <Button
          key={action.label}
          size="small"
          variant="secondary"
          disabled={busy}
          className={action.destructive === true ? 'text-destructive' : undefined}
          onClick={(event) => {
            action.onSelect(event.currentTarget);
          }}
        >
          {action.label}
        </Button>
      ))}
      <Button size="small" variant="quiet" disabled={busy} onClick={onClear}>
        <X aria-hidden className="size-4" strokeWidth={1.8} />
        <Trans>Clear selection</Trans>
      </Button>
    </section>
  );
}

/** A type or state as a small grey pill. */
export function Tag({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <span className="inline-flex w-fit shrink-0 items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium whitespace-nowrap text-secondary-foreground">
      {children}
    </span>
  );
}
