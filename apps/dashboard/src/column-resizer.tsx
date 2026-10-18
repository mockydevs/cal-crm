// The edge of a table's column header that sets the column's width: dragged by mouse, pen
// or touch, or, once focused, moved with the arrow keys, Home and End, as a slider is. A
// double click, or Delete, puts the column back to its content's width. Beside the
// column's name, a menu does the same with single clicks: Wider, Narrower, Fit to content.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { ChevronsLeftRight } from 'lucide-react';
import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from './list-columns';

/** How far one arrow key moves the edge, and with Shift held. */
const STEP = 16;
const LONG_STEP = 64;

export function clampWidth(width: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
}

/** The width a key moves the edge to from `width`, or undefined for any other key. */
export function widthAfterKey(key: string, shift: boolean, width: number): number | undefined {
  const step = shift ? LONG_STEP : STEP;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampWidth(width - step);
    case 'ArrowRight':
    case 'ArrowUp':
      return clampWidth(width + step);
    case 'Home':
      return MIN_COLUMN_WIDTH;
    case 'End':
      return MAX_COLUMN_WIDTH;
    default:
      return undefined;
  }
}

export function ColumnResizer({
  label,
  width,
  describedBy,
  onPreview,
  onResize,
}: {
  /** The column's name, for the edge's own. */
  readonly label: string;
  /** The element that says how an edge is moved, one for the whole table (ResizeHint). */
  readonly describedBy: string;
  /** The width the column was given, or undefined while it is as wide as its content. */
  readonly width: number | undefined;
  /** Shows a width while the edge is dragged, or undefined once it is let go. */
  readonly onPreview: (width: number | undefined) => void;
  /** Keeps a width, or undefined to put the column back to its content's width. */
  readonly onResize: (width: number | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const edgeRef = useRef<HTMLDivElement>(null);
  // Where a drag started: the pointer's place and the column's width then.
  const startRef = useRef<{ readonly x: number; readonly width: number }>(undefined);
  // The width the column has on screen: what the edge says it is until one is given.
  const [measured, setMeasured] = useState(MIN_COLUMN_WIDTH);
  const widthNow = (): number =>
    width ?? edgeRef.current?.parentElement?.getBoundingClientRect().width ?? MIN_COLUMN_WIDTH;
  useLayoutEffect(() => {
    const header = edgeRef.current?.parentElement;
    if (header === null || header === undefined) return;
    setMeasured(clampWidth(header.getBoundingClientRect().width));
    // The column's content can widen it as rows arrive.
    const observer = new ResizeObserver(() => {
      setMeasured(clampWidth(header.getBoundingClientRect().width));
    });
    observer.observe(header);
    return () => {
      observer.disconnect();
    };
  }, []);
  const shown = Math.round(width ?? measured);
  // The width the pointer has dragged the edge to; a press that hasn't moved changes nothing.
  const follow = (event: PointerEvent<HTMLDivElement>): number | undefined =>
    startRef.current === undefined || event.clientX === startRef.current.x
      ? undefined
      : clampWidth(startRef.current.width + event.clientX - startRef.current.x);
  return (
    <div
      ref={edgeRef}
      role="slider"
      aria-orientation="horizontal"
      aria-label={t`Width of the ${label} column`}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      aria-valuenow={shown}
      aria-valuetext={t`${shown} pixels`}
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End Delete"
      aria-describedby={describedBy}
      tabIndex={0}
      title={t`Drag to resize. Double-click to fit the content.`}
      // A 24px target inside the column at its right edge, transparent, with a thin line on
      // the edge. Inside, so the last column's edge can be taken too: past the table it
      // would be outside the region that scrolls it.
      className="absolute inset-y-0 right-0 z-10 flex w-6 cursor-col-resize touch-none justify-end outline-none select-none after:h-full after:w-0.5 after:bg-transparent hover:after:bg-primary focus-visible:after:bg-primary"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        startRef.current = { x: event.clientX, width: widthNow() };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const next = follow(event);
        if (next !== undefined) onPreview(next);
      }}
      onPointerUp={(event) => {
        const next = follow(event);
        startRef.current = undefined;
        onPreview(undefined);
        if (next !== undefined && next !== width) onResize(next);
      }}
      onPointerCancel={() => {
        startRef.current = undefined;
        onPreview(undefined);
      }}
      onDoubleClick={() => {
        onResize(undefined);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          onResize(undefined);
          return;
        }
        const next = widthAfterKey(event.key, event.shiftKey, widthNow());
        if (next === undefined) return;
        event.preventDefault();
        onResize(next);
      }}
    />
  );
}

/**
 * How a column's edge is moved, said once for the whole table: each edge points to it, and
 * no header's own text gains it.
 */
export function ResizeHint({ id }: { readonly id: string }): ReactElement {
  return (
    <p id={id} className="sr-only">
      <Trans>
        Arrow keys change the width, with Shift by more; Home and End go to the narrowest and the
        widest; Delete, or a double click, fits the content.
      </Trans>
    </p>
  );
}

/** How far "Wider" and "Narrower" move a column's edge. */
const MENU_STEP = LONG_STEP;

/**
 * A column's width without dragging: a button in its header with Wider, Narrower and Fit
 * to content, for a single tap or click, as the edge's keys do from the keyboard.
 */
export function ColumnWidthMenu({
  label,
  width,
  onResize,
}: {
  readonly label: string;
  readonly width: number | undefined;
  readonly onResize: (width: number | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const widthNow = (): number =>
    width ?? triggerRef.current?.closest('th')?.getBoundingClientRect().width ?? MIN_COLUMN_WIDTH;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label={t`Change the width of the ${label} column`}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-muted-foreground -outline-offset-2 hover:bg-muted hover:text-foreground data-popup-open:bg-muted"
      >
        <ChevronsLeftRight aria-hidden className="size-3.5" strokeWidth={1.8} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem
          className="min-h-11 lg:min-h-9"
          onClick={() => {
            onResize(clampWidth(widthNow() + MENU_STEP));
          }}
        >
          <Trans>Wider</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-11 lg:min-h-9"
          onClick={() => {
            onResize(clampWidth(widthNow() - MENU_STEP));
          }}
        >
          <Trans>Narrower</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-11 lg:min-h-9"
          disabled={width === undefined}
          onClick={() => {
            onResize(undefined);
          }}
        >
          <Trans>Fit to content</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
