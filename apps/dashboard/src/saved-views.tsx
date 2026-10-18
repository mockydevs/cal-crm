import { Trans, useLingui } from '@lingui/react/macro';
import type { SavedView } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { Ellipsis, Plus } from 'lucide-react';
import {
  lazy,
  Suspense,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { apiIn } from './api';
import { sameConfiguration, type ViewConfiguration, type ViewStep } from './saved-view-rules';

import { useBusiness } from './workspace';

export type { ViewConfiguration, ViewStep } from './saved-view-rules';

const SavedViewPanel = lazy(() => import('./saved-view-panel'));
// Who a view is shared with, in a few words: fetched with the first view chosen.
const SharingSummary = lazy(async () => ({
  default: (await import('./saved-view-sharing-summary')).SharingSummary,
}));

// The views are a row of tabs under the top bar, "All" first. Each is a button, not a tab
// of a tab list: choosing one changes what the one list below shows, and the chosen one is
// marked as the current one.
const tabClassName =
  'inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-sm font-medium whitespace-nowrap text-body -outline-offset-2 hover:text-foreground disabled:opacity-50 aria-[current=true]:border-primary aria-[current=true]:text-link lg:min-h-10';
/** As tall as a finger needs below the desktop layout, where the kit's items are 40px. */
const menuItemClassName = 'min-h-11 lg:min-h-9';

/**
 * The saved views of a list, and the way into the panel that adds one or edits one
 * (saved-view-panel.tsx). On the contacts list a saved view is called a smart list, as
 * GoHighLevel calls it.
 */
export function SavedViews({
  current,
  selectedId,
  onApply,
  actions,
  container,
  steps = [],
}: {
  readonly current: ViewConfiguration;
  readonly selectedId: string | undefined;
  readonly onApply: (configuration: ViewConfiguration | undefined, id?: string) => void;
  /** At the right of the row of views: what the page offers, such as adding a record. */
  readonly actions?: ReactNode;
  /** Where the actions menu opens, so it is inside the page's landmark. */
  readonly container: RefObject<HTMLElement | null>;
  /** The parts of the list the panel can change, in order. */
  readonly steps?: readonly ViewStep[];
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const smartLists = current.objectKey === 'contact';
  const queryKey = ['b', business.id, 'views', current.objectKey];
  const views = useQuery({
    queryKey,
    // The contract arrives with the first read, not with the page (saved-view-api.ts).
    queryFn: async () =>
      apiIn(business.id).request((await import('./saved-view-api')).listViews, {
        query: { object: current.objectKey },
      }),
  });
  // The panel is open: on the view it edits, or on none for a view being added.
  const [editor, setEditor] = useState<{ view: SavedView | undefined }>();
  // How many times the panel has been opened, so each opening starts from nothing.
  const [opening, setOpening] = useState(0);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  // Set by a menu action that opens the panel, which then has the keyboard.
  const openingRef = useRef(false);
  const selected = views.data?.items.find((item) => item.id === selectedId);
  const modified = selected !== undefined && !sameConfiguration(current, selected);
  const unavailable = views.isSuccess && selectedId !== undefined && selected === undefined;
  const waiting = views.isPending || views.isError || busy;
  const choose = (view: SavedView | undefined) => {
    onApply(view, view?.id);
    setNotice('');
  };
  /** Opens the panel: to add a view from the list as it is, or to edit the selected one. */
  const openPanel = (view: SavedView | undefined) => {
    setEditor({ view });
    setOpening((count) => count + 1);
    setNotice('');
  };
  const editable =
    selected?.canChange === true ||
    selected?.canChangeSharing === true ||
    selected?.canUnshare === true ||
    selected?.canDelete === true;
  return (
    <section aria-label={t`Saved views`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-3 border-b">
        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          <button
            type="button"
            className={tabClassName}
            aria-current={selectedId === undefined ? 'true' : undefined}
            disabled={waiting}
            onClick={() => {
              choose(undefined);
            }}
          >
            <Trans>All</Trans>
          </button>
          {views.data?.items.map((view) => (
            <button
              key={view.id}
              type="button"
              className={tabClassName}
              aria-current={view.id === selectedId ? 'true' : undefined}
              disabled={waiting}
              onClick={() => {
                choose(view);
              }}
            >
              {view.name}
            </button>
          ))}
          {views.data?.canSave !== true ? null : (
            <button
              ref={saveButtonRef}
              type="button"
              className={tabClassName}
              aria-label={smartLists ? t`Add smart list` : t`Add view`}
              title={t`Save these filters as a view`}
              disabled={busy}
              onClick={() => {
                openPanel(undefined);
              }}
            >
              <Plus aria-hidden className="size-4" strokeWidth={2} />
              <Trans>Add</Trans>
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={actionsButtonRef}
              aria-label={t`View actions`}
              disabled={busy}
              className="mb-1 flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-muted hover:text-foreground disabled:opacity-50 data-popup-open:bg-muted lg:size-8"
            >
              <Ellipsis aria-hidden className="size-5" strokeWidth={1.8} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              // Opening the panel puts the keyboard there; the other action gives it back
              // to this button.
              finalFocus={() => {
                const opened = openingRef.current;
                openingRef.current = false;
                return !opened;
              }}
              container={container}
              className="min-w-56"
            >
              {selected !== undefined && editable ? (
                <DropdownMenuItem
                  className={menuItemClassName}
                  onClick={() => {
                    openingRef.current = true;
                    openPanel(selected);
                  }}
                >
                  {smartLists ? <Trans>Edit smart list</Trans> : <Trans>Edit view</Trans>}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                className={menuItemClassName}
                disabled={views.isFetching}
                onClick={() => {
                  void views.refetch();
                }}
              >
                <Trans>Refresh saved views</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {actions === undefined ? null : (
          <div className="flex shrink-0 items-center gap-2 pb-2">{actions}</div>
        )}
      </div>
      {selected === undefined ? null : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Suspense fallback={null}>
            <SharingSummary view={selected} />
          </Suspense>
          {modified ? (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              <Trans>Modified</Trans>
            </span>
          ) : null}
        </p>
      )}
      {unavailable ? (
        <p role="status" className="text-sm">
          <Trans>This saved view is no longer available. Your current filters are kept.</Trans>
        </p>
      ) : null}
      {views.isError ? (
        <p role="alert">
          <Trans>We couldn't load saved views.</Trans>{' '}
          <Button
            variant="quiet"
            onClick={() => {
              void views.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : null}
      {editor === undefined ? null : (
        <Suspense fallback={null}>
          <SavedViewPanel
            key={opening}
            opened={editor.view}
            views={views.data}
            queryKey={queryKey}
            current={current}
            selectedId={selectedId}
            steps={steps}
            onApply={onApply}
            onNotice={setNotice}
            onBusy={setBusy}
            onClose={() => {
              setEditor(undefined);
            }}
            // Back to what opened the panel: "Add" for a new view, the menu for a change.
            returnFocus={() =>
              (editor.view === undefined ? saveButtonRef.current : null) ?? actionsButtonRef.current
            }
          />
        </Suspense>
      )}
      {notice === '' ? null : (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
