// What the Custom Fields, Custom Values and Import Data pages share on screen, in
// GoHighLevel's forms: the table's looks, a merge key with its copy button, a folder chip,
// the footer that walks a keyset list, the row menu, and the small centred dialogs that ask
// for a name or for a yes.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Select } from '@repo/ui/components/select';
import { ApiError } from '@repo/sdk';
import { Check, Copy, EllipsisVertical, Folder, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { iconButtonClassName, returnTo } from './list-table';
import { rejection, type Rejection } from './problems';

import { pageSizes, type PageSize, type Range } from './settings-rules';

export {
  cellClassName,
  headerCellClassName,
  iconButtonClassName,
  listCardClassName,
  ListProblem,
  tableClassName,
  returnTo,
  tableRegionClassName,
  useSettled,
} from './list-table';

export const sortButtonClassName =
  '-mx-1.5 inline-flex min-h-11 items-center gap-1 rounded-control px-1.5 font-medium -outline-offset-2 hover:text-foreground lg:min-h-8';

/**
 * A merge key as a message holds it, such as {{contact.event_date}}, with the button that
 * copies it. The page says "Copied" once, for everyone: `onCopied` tells it.
 */
export function MergeToken({
  token,
  onCopied,
}: {
  readonly token: string;
  readonly onCopied: (token: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <code className="min-w-0 truncate rounded-control bg-muted px-1.5 py-0.5 font-mono text-xs text-body">
        {token}
      </code>
      <button
        type="button"
        className={iconButtonClassName}
        aria-label={t`Copy ${token}`}
        onClick={() => {
          void navigator.clipboard.writeText(token).then(
            () => {
              setCopied(true);
              onCopied(token);
            },
            () => undefined,
          );
        }}
      >
        {copied ? (
          <Check aria-hidden className="size-4 text-success" strokeWidth={2} />
        ) : (
          <Copy aria-hidden className="size-4" strokeWidth={1.8} />
        )}
      </button>
    </span>
  );
}

/** The folder something is in, as a chip. */
export function FolderChip({ name }: { readonly name: string }): ReactElement {
  return (
    <span className="inline-flex max-w-48 items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
      <Folder aria-hidden className="size-3.5 shrink-0" strokeWidth={1.8} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * The foot of a list: how many rows a page holds, which rows show of how many, and the way
 * to the pages before and after. The list is a keyset list, so there is one page number,
 * the page showing, and no jumping ahead.
 */
export function ListFooter({
  perPageLabel,
  pageSize,
  onPageSize,
  range,
  number,
  previous,
  next,
  busy,
  onPrevious,
  onNext,
}: {
  /** What the page-size choice is called, such as "Fields per page". */
  readonly perPageLabel: string;
  readonly pageSize: PageSize;
  readonly onPageSize: (size: PageSize) => void;
  readonly range: Range;
  /** The page showing, from 1. */
  readonly number: number;
  readonly previous: boolean;
  readonly next: boolean;
  readonly busy: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}): ReactElement {
  const { t } = useLingui();
  const { from, to, total } = range;
  return (
    <nav
      aria-label={t`Pages`}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-body"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-muted-foreground">
          {perPageLabel}
        </span>
        <Select
          aria-label={perPageLabel}
          className="w-20"
          value={String(pageSize)}
          onValueChange={(value) => {
            const size = pageSizes.find((each) => String(each) === value);
            if (size !== undefined) onPageSize(size);
          }}
        >
          {pageSizes.map((size) => (
            <option key={size} value={String(size)}>
              {size}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" aria-busy={busy}>
          <Trans>
            {from} - {to} of {total}
          </Trans>
        </p>
        <Button
          variant="quiet"
          size="small"
          aria-label={t`Previous page`}
          disabled={!previous || busy}
          onClick={onPrevious}
        >
          <Trans>Previous</Trans>
        </Button>
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-control border border-primary font-medium text-link"
        >
          {number}
        </span>
        <Button
          variant="quiet"
          size="small"
          aria-label={t`Next page`}
          disabled={!next || busy}
          onClick={onNext}
        >
          <Trans>Next</Trans>
        </Button>
      </div>
    </nav>
  );
}

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

const smallDialogClassName =
  'fixed top-1/2 left-1/2 z-[65] flex max-h-[calc(100dvh-32px)] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-card bg-card p-5 text-card-foreground shadow-xl outline-none';

/** A small centred dialog, as GoHighLevel's "Add custom value": a title, a form, two buttons. */
export function SmallDialog({
  open,
  onClose,
  title,
  description,
  returnFocus,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        <Dialog.Popup className={smallDialogClassName} finalFocus={returnTo(returnFocus)}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="text-lg font-medium wrap-anywhere">{title}</Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="text-md text-muted-foreground">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Asks before something that is not undone with one press, and says why it did not happen. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy,
  problem,
  returnFocus,
  onConfirm,
  onClose,
}: {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly busy: boolean;
  /** Why the last try failed, in the server's words or the page's. */
  readonly problem: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <SmallDialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      returnFocus={returnFocus}
    >
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            onClose();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button
          variant={destructive ? 'secondary' : 'primary'}
          className={destructive ? 'border-destructive text-destructive' : undefined}
          disabled={busy}
          onClick={() => {
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </SmallDialog>
  );
}

/** Two or three views of one page, as a segmented switch: the one showing is pressed. */
export function ViewSwitch<View extends string>({
  label,
  views,
  value,
  onChange,
}: {
  readonly label: string;
  readonly views: readonly { readonly value: View; readonly label: ReactNode }[];
  readonly value: View;
  readonly onChange: (view: View) => void;
}): ReactElement {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg bg-muted p-1">
      {views.map((view) => (
        <button
          key={view.value}
          type="button"
          aria-pressed={view.value === value}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-[13px] font-medium text-body -outline-offset-2 hover:text-foreground aria-pressed:bg-card aria-pressed:text-link aria-pressed:shadow-[0_1px_2px_rgb(16_24_40/0.05)] lg:min-h-7"
          onClick={() => {
            onChange(view.value);
          }}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}

/** Why a save was refused, sorted for its form: under the fields it names, or above the buttons. */
export function savingProblem(error: unknown, fallback: string): Rejection {
  return error instanceof ApiError && error.problem.errors !== undefined
    ? rejection(error.problem.errors)
    : {
        fields: {},
        form: error instanceof ApiError ? (error.problem.detail ?? fallback) : fallback,
      };
}

/**
 * Whether a list is asked for again after it failed: twice for a fault of the server or the
 * connection, never for an answer that would be the same again, such as "you may not".
 */
export function retryFaults(failures: number, error: unknown): boolean {
  return !(error instanceof ApiError && error.status < 500) && failures < 2;
}

/** Whether a save was refused because someone else saved first. */
export const isStale = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409;

/** What went wrong with a form as a whole, and the way to the saved version when it is stale. */
export function FormProblem({
  problem,
  stale,
  busy,
  onReload,
}: {
  readonly problem: Rejection;
  readonly stale: boolean;
  readonly busy: boolean;
  readonly onReload: () => void;
}): ReactElement | null {
  return problem.form === undefined ? null : (
    <div className="flex flex-col items-start gap-2">
      <p role="alert" className="text-sm font-medium text-destructive">
        {problem.form}
      </p>
      {stale ? (
        <Button variant="secondary" size="small" disabled={busy} onClick={onReload}>
          <Trans>Reload saved version</Trans>
        </Button>
      ) : null}
    </div>
  );
}
