// The builder's controls on a saved report's page (report-page.tsx): the buttons in each
// widget's corner that move, open, resize, duplicate and delete it, the "Add widget" menu,
// and the question asked before something is dropped. Fetched when a report is first put
// into edit mode: someone who only reads reports never downloads the menus and dialogs.
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReportWidgetKind } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { ChevronLeft, ChevronRight, GripVertical, Pencil, Plus } from 'lucide-react';
import { useRef, type DragEvent, type ReactElement, type RefObject } from 'react';
import { ConfirmDialog, iconButtonClassName, RowMenu } from '../settings-list';
import { useReportWords } from './words';

export interface WidgetToolsProps {
  /** What the widget is called, for the names of its buttons. */
  readonly name: string;
  readonly first: boolean;
  readonly last: boolean;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onEdit: (trigger: HTMLElement) => void;
  readonly onResize: (change: { readonly w?: number; readonly h?: number }) => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}

/**
 * A widget's controls while the report is being changed. Everything works from the
 * keyboard; the grip is for a pointer, and does what "earlier" and "later" do.
 */
export function WidgetTools({
  name,
  first,
  last,
  onDragStart,
  onDragEnd,
  onMove,
  onEdit,
  onResize,
  onDuplicate,
  onDelete,
}: WidgetToolsProps): ReactElement {
  const { t } = useLingui();
  return (
    <div className="flex shrink-0 items-center">
      <span
        draggable
        aria-hidden
        title={t`Drag to move`}
        className="hidden size-8 cursor-grab items-center justify-center text-muted-foreground lg:inline-flex"
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <GripVertical className="size-4" strokeWidth={1.8} />
      </span>
      <button
        type="button"
        className={iconButtonClassName}
        aria-label={t`Move ${name} earlier`}
        disabled={first}
        onClick={() => {
          onMove(-1);
        }}
      >
        <ChevronLeft aria-hidden className="size-5" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className={iconButtonClassName}
        aria-label={t`Move ${name} later`}
        disabled={last}
        onClick={() => {
          onMove(1);
        }}
      >
        <ChevronRight aria-hidden className="size-5" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className={iconButtonClassName}
        aria-label={t`Edit ${name}`}
        onClick={(event) => {
          onEdit(event.currentTarget);
        }}
      >
        <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
      </button>
      <RowMenu
        label={t`More for ${name}`}
        onOpen={() => undefined}
        actions={[
          {
            label: t`Wider`,
            immediate: true,
            onSelect: () => {
              onResize({ w: 1 });
            },
          },
          {
            label: t`Narrower`,
            immediate: true,
            onSelect: () => {
              onResize({ w: -1 });
            },
          },
          {
            label: t`Taller`,
            immediate: true,
            onSelect: () => {
              onResize({ h: 1 });
            },
          },
          {
            label: t`Shorter`,
            immediate: true,
            onSelect: () => {
              onResize({ h: -1 });
            },
          },
          { label: t`Duplicate`, immediate: true, onSelect: onDuplicate },
          { label: t`Delete`, destructive: true, immediate: true, onSelect: onDelete },
        ]}
      />
    </div>
  );
}

/** The kinds of widget there are to add, in the order the menu lists them. */
const addable: readonly ReportWidgetKind[] = [
  'stat',
  'line',
  'area',
  'bar',
  'hbar',
  'donut',
  'table',
  'funnel',
  'text',
];

/** "Add widget": the kinds there are, each added to the foot of the page and opened. */
export function AddWidget({
  disabled,
  onAdd,
}: {
  readonly disabled: boolean;
  readonly onAdd: (kind: ReportWidgetKind, trigger: HTMLElement | null) => void;
}): ReactElement {
  const words = useReportWords();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={triggerRef}
        disabled={disabled}
        render={<Button variant="secondary" />}
      >
        <Plus aria-hidden className="size-4" strokeWidth={2} />
        <Trans>Add widget</Trans>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {addable.map((kind) => (
          <DropdownMenuItem
            key={kind}
            onClick={() => {
              onAdd(kind, triggerRef.current);
            }}
          >
            {words.kind(kind)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Asks before a page with widgets is deleted, and before unsaved changes are dropped. */
export function AskDialog({
  about,
  returnFocus,
  onConfirm,
  onClose,
}: {
  readonly about: 'remove-page' | 'leave';
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const removing = about === 'remove-page';
  return (
    <ConfirmDialog
      open
      title={removing ? <Trans>Delete this page?</Trans> : <Trans>Leave without saving?</Trans>}
      description={
        removing ? (
          <Trans>Its widgets go with it. Nothing is final until you save the report.</Trans>
        ) : (
          <Trans>Your changes to this report have not been saved, and will be lost.</Trans>
        )
      }
      confirmLabel={removing ? t`Delete page` : t`Discard changes`}
      destructive
      busy={false}
      problem={undefined}
      returnFocus={returnFocus}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
