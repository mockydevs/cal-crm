// The panel that adds a saved view or edits one: a name, the list's Filters, Sort and
// Fields as steps where the page gives them, then Duplicate, Sharing & permissions and
// Delete, which wait until the view exists. On the contacts list a saved view is called a
// smart list, as GoHighLevel calls it. What a step applies, it applies to the list, which
// shows behind the panel; the view is saved as the list then is, and closing without saving
// puts the list back as the panel found it. Fetched when it first opens.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createView,
  createViewInput,
  deleteView,
  updateView,
  updateViewInput,
  type SavedView,
  type ViewList,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { sidePanelBodyClassName, sidePanelFooterClassName } from './list-toolbar';
import { sameConfiguration, type ViewConfiguration, type ViewStep } from './saved-view-rules';
import { ViewSharing } from './saved-view-sharing';
import { SharingSummary } from './saved-view-sharing-summary';
import { useBusiness } from './workspace';

interface ViewDraft {
  readonly view: SavedView | undefined;
  readonly configuration: ViewConfiguration;
  readonly name: string;
}

/** What a view keeps of a list, without what makes it a saved one: to save a copy of it. */
function configurationOf(view: SavedView): ViewConfiguration {
  return view.objectKey === 'contact'
    ? {
        objectKey: view.objectKey,
        state: view.state,
        columns: view.columns,
        // What the view has none of (null) is left out of the copy, as a new view has it.
        ...(view.tableColumns === undefined || view.tableColumns === null
          ? {}
          : { tableColumns: view.tableColumns }),
        ...(view.columnLayout === undefined || view.columnLayout === null
          ? {}
          : { columnLayout: view.columnLayout }),
        ...(view.columnWidths === undefined || view.columnWidths === null
          ? {}
          : { columnWidths: view.columnWidths }),
      }
    : {
        objectKey: view.objectKey,
        state: view.state,
        columns: view.columns,
        ...(view.tableColumns === undefined || view.tableColumns === null
          ? {}
          : { tableColumns: view.tableColumns }),
      };
}

const NAME_MAX = 80;

/** A row of the panel that leads to a step, or does something to the saved view. */
const rowClassName =
  'flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-control px-2 text-left text-sm text-body -outline-offset-2 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50';

type Confirmation = 'delete';

/** The address that opens the list this panel is over with a view chosen. */
function linkTo(id: string): string {
  const address = new URL(window.location.href);
  address.search = new URLSearchParams({ view: id }).toString();
  return address.toString();
}

export default function SavedViewPanel({
  opened,
  views,
  queryKey,
  current,
  selectedId,
  steps,
  onApply,
  onClose,
  onNotice,
  onBusy,
  returnFocus,
}: {
  /** The view the panel opened to edit, or undefined to add one. */
  readonly opened: SavedView | undefined;
  /** The saved views as last read: what may be done to each, and each one's revision. */
  readonly views: ViewList | undefined;
  readonly queryKey: readonly string[];
  /** The list as it is now: what is saved. */
  readonly current: ViewConfiguration;
  readonly selectedId: string | undefined;
  readonly steps: readonly ViewStep[];
  readonly onApply: (configuration: ViewConfiguration | undefined, id?: string) => void;
  readonly onClose: () => void;
  /** What was done, for the page to say once the panel has closed. */
  readonly onNotice: (notice: string) => void;
  /** Whether a request is on its way: nothing else about the views can start meanwhile. */
  readonly onBusy: (busy: boolean) => void;
  /** Where the keyboard goes when the panel closes. */
  readonly returnFocus: () => HTMLElement | null;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const smartLists = current.objectKey === 'contact';
  // The version of the view the draft is based on: replaced only by "Review latest view".
  const [view, setView] = useState(opened);
  const [name, setName] = useState(
    () => opened?.name ?? (smartLists ? t`New smart list` : t`New view`),
  );
  const [stepKey, setStepKey] = useState<string>();
  const [confirming, setConfirming] = useState<{ action: Confirmation; view: SavedView }>();
  // The Sharing & permissions step is open, and whether its change is on its way.
  const [sharing, setSharing] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const confirmActionRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  // The panel, and the row of it whose step is open: Back gives that row the keyboard again.
  const popupRef = useRef<HTMLDivElement>(null);
  const openRowRef = useRef<string>(undefined);
  const activeRef = useRef(true);
  const currentRef = useRef(current);
  // The list as it was when the panel opened: closing without saving puts it back.
  const [openedWith] = useState(current);
  useLayoutEffect(() => {
    currentRef.current = current;
  }, [current]);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (confirming !== undefined) confirmActionRef.current?.focus();
  }, [confirming]);
  // A step opens in place of the panel's first page, and takes the keyboard to its way
  // back; leaving it gives the keyboard to the row that opened it.
  useEffect(() => {
    if (stepKey !== undefined || sharing) backRef.current?.focus();
  }, [stepKey, sharing]);
  const inStep = stepKey !== undefined || confirming !== undefined || sharing;
  useEffect(() => {
    if (inStep || openRowRef.current === undefined) return;
    popupRef.current
      ?.querySelector<HTMLElement>(`[data-view-row="${openRowRef.current}"]`)
      ?.focus();
    openRowRef.current = undefined;
  }, [inStep]);

  const latestConfirmation = views?.items.find((item) => item.id === confirming?.view.id);
  const confirmedName = confirming?.view.name;
  const confirmationAllowed = latestConfirmation?.canDelete === true;
  const latestEdit = views?.items.find((item) => item.id === view?.id);
  const newerEdit = latestEdit !== undefined && latestEdit.revision !== view?.revision;
  const canSave = view === undefined ? views?.canSave === true : latestEdit?.canChange === true;
  const refreshAfter = async (error: unknown) => {
    if (error instanceof ApiError && [403, 404, 409].includes(error.status))
      await cache.invalidateQueries({ queryKey });
  };
  const save = useMutation({
    mutationFn: (draft: ViewDraft) =>
      draft.view === undefined
        ? apiIn(business.id).request(createView, {
            body: createViewInput.parse({ ...draft.configuration, name: draft.name }),
          })
        : apiIn(business.id).request(updateView, {
            params: { id: draft.view.id },
            body: updateViewInput.parse({
              name: draft.name,
              state: draft.configuration.state,
              columns: draft.configuration.columns,
              // Left out, the view keeps the table columns it has.
              ...(Array.isArray(draft.configuration.tableColumns)
                ? { tableColumns: draft.configuration.tableColumns }
                : {}),
              // A contact list's whole layout and its widths are what the list shows now:
              // no widths left means none are kept.
              ...(draft.configuration.objectKey === 'contact' &&
              Array.isArray(draft.configuration.columnLayout)
                ? {
                    columnLayout: draft.configuration.columnLayout,
                    columnWidths: draft.configuration.columnWidths ?? null,
                  }
                : {}),
              revision: draft.view.revision,
            }),
          }),
    onSuccess: async (created, draft) => {
      await cache.invalidateQueries({ queryKey });
      if (!activeRef.current) return;
      onApply(
        sameConfiguration(currentRef.current, draft.configuration) ? created : currentRef.current,
        created.id,
      );
      onNotice(draft.view === undefined ? t`View saved.` : t`View updated.`);
      onClose();
    },
    onError: refreshAfter,
  });
  const duplicate = useMutation({
    mutationFn: (original: SavedView) => {
      const originalName = original.name;
      return apiIn(business.id).request(createView, {
        body: createViewInput.parse({
          ...configurationOf(original),
          name: t`Copy of ${originalName}`.slice(0, NAME_MAX),
        }),
      });
    },
    onSuccess: async (created) => {
      await cache.invalidateQueries({ queryKey });
      if (!activeRef.current) return;
      onApply(created, created.id);
      onNotice(t`View duplicated.`);
      onClose();
    },
    onError: refreshAfter,
  });
  const publish = useMutation({
    mutationFn: (input: NonNullable<typeof confirming>) =>
      apiIn(business.id).request(deleteView, {
        params: { id: input.view.id },
        body: { revision: input.view.revision },
      }),
    onSuccess: async (_, input) => {
      await cache.invalidateQueries({ queryKey });
      if (!activeRef.current) return;
      if (selectedId === input.view.id) onApply(currentRef.current);
      onNotice(t`View deleted.`);
      onClose();
    },
    onError: refreshAfter,
  });
  const busy = save.isPending || publish.isPending || duplicate.isPending || sharingBusy;
  useEffect(() => {
    onBusy(busy);
    return () => {
      onBusy(false);
    };
  }, [busy, onBusy]);

  /** Closes the panel with nothing saved: the list goes back to how the panel found it. */
  const cancel = () => {
    if (!sameConfiguration(currentRef.current, openedWith)) onApply(openedWith, selectedId);
    onClose();
  };
  /** Opens the confirmation of a change to the view being edited, as a step of the panel. */
  const confirm = (action: Confirmation, target: SavedView) => {
    openRowRef.current = action;
    setConfirming({ action, view: target });
    setStepKey(undefined);
    publish.reset();
  };
  const back = () => {
    setStepKey(undefined);
    setConfirming(undefined);
    setSharing(false);
    publish.reset();
  };
  const step = steps.find((each) => each.key === stepKey);
  const edited = view === undefined ? undefined : (latestEdit ?? view);
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !busy) cancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          ref={popupRef}
          initialFocus={nameInputRef}
          finalFocus={() => returnFocus() ?? true}
          className="fixed inset-y-0 right-0 z-60 flex w-[min(440px,100%)] flex-col bg-card text-card-foreground shadow-xl outline-none"
        >
          <div className="flex min-w-0 items-center justify-between gap-3 border-b px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3">
            <Dialog.Title className="text-base font-medium wrap-break-word">
              {view === undefined
                ? smartLists
                  ? t`Add smart list`
                  : t`Add view`
                : smartLists
                  ? t`Edit smart list`
                  : t`Edit view`}
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          {inStep ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-1 border-b px-2 py-1.5">
                <Button
                  ref={backRef}
                  variant="quiet"
                  size="small"
                  className="px-2.5"
                  aria-label={t`Back`}
                  disabled={busy}
                  onClick={back}
                >
                  <ArrowLeft aria-hidden className="size-[18px]" strokeWidth={2} />
                </Button>
                <h3 className="text-sm font-medium">
                  {step !== undefined ? (
                    step.label
                  ) : confirming?.action === 'delete' ? (
                    smartLists ? (
                      <Trans>Delete list</Trans>
                    ) : (
                      <Trans>Delete view</Trans>
                    )
                  ) : (
                    <Trans>Sharing & permissions</Trans>
                  )}
                </h3>
              </div>
              {step !== undefined ? (
                step.render(back)
              ) : sharing && edited !== undefined ? (
                <ViewSharing
                  view={edited}
                  queryKey={queryKey}
                  link={linkTo(edited.id)}
                  onBusy={setSharingBusy}
                  onCancel={back}
                  onDone={(notice) => {
                    if (!activeRef.current) return;
                    onNotice(notice);
                    onClose();
                  }}
                />
              ) : confirming === undefined ? null : (
                <div
                  className={sidePanelBodyClassName}
                  role="group"
                  aria-label={t`Confirm view change`}
                >
                  <p className="text-sm">
                    <Trans>
                      Delete “{confirmedName}”? This removes the saved view, keeping your current
                      filters.
                    </Trans>
                  </p>
                  {latestConfirmation !== undefined &&
                  latestConfirmation.revision !== confirming.view.revision ? (
                    <p role="alert">
                      <Trans>This view changed. Review the latest version before confirming.</Trans>{' '}
                      <Button
                        variant="quiet"
                        disabled={busy}
                        onClick={() => {
                          setConfirming({ ...confirming, view: latestConfirmation });
                          publish.reset();
                        }}
                      >
                        <Trans>Review latest view</Trans>
                      </Button>
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      ref={confirmActionRef}
                      disabled={
                        busy ||
                        !confirmationAllowed ||
                        latestConfirmation.revision !== confirming.view.revision
                      }
                      onClick={() => {
                        publish.mutate(confirming);
                      }}
                    >
                      <Trans>Confirm deleting view</Trans>
                    </Button>
                    <Button variant="quiet" disabled={busy} onClick={back}>
                      <Trans>Cancel</Trans>
                    </Button>
                  </div>
                  {publish.isError ? (
                    <p role="alert">
                      <Trans>
                        We couldn't change the view. Refresh saved views and check your access
                        before trying again.
                      </Trans>
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                if (canSave && !newerEdit && !busy && name.trim() !== '')
                  save.mutate({ view, configuration: current, name });
              }}
            >
              <div className={sidePanelBodyClassName}>
                <Field>
                  <FieldLabel>
                    {smartLists ? <Trans>Smart list name</Trans> : <Trans>View name</Trans>}
                  </FieldLabel>
                  <Input
                    ref={nameInputRef}
                    disabled={busy || !canSave}
                    value={name}
                    maxLength={NAME_MAX}
                    required
                    onFocus={(event) => {
                      // A name to type over, as "New smart list" is.
                      if (view === undefined) event.currentTarget.select();
                    }}
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                </Field>
                {steps.length === 0 ? null : (
                  <ul className="flex flex-col">
                    {steps.map((each) => (
                      <li key={each.key}>
                        <button
                          data-view-row={each.key}
                          type="button"
                          className={rowClassName}
                          disabled={busy || !canSave}
                          onClick={() => {
                            openRowRef.current = each.key;
                            setStepKey(each.key);
                          }}
                        >
                          <span className="min-w-0 wrap-break-word">{each.label}</span>
                          <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                            {each.summary}
                            <ChevronRight aria-hidden className="size-4" strokeWidth={1.8} />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="flex flex-col border-t pt-3">
                  <li>
                    <button
                      data-view-row="duplicate"
                      type="button"
                      className={rowClassName}
                      disabled={busy || edited === undefined || views?.canSave !== true}
                      onClick={() => {
                        if (edited !== undefined) duplicate.mutate(edited);
                      }}
                    >
                      <Trans>Duplicate</Trans>
                    </button>
                  </li>
                  <li>
                    <button
                      data-view-row="sharing"
                      type="button"
                      className={rowClassName}
                      disabled={
                        busy ||
                        edited === undefined ||
                        !(edited.canChangeSharing || edited.canUnshare)
                      }
                      onClick={() => {
                        if (edited === undefined) return;
                        openRowRef.current = 'sharing';
                        setConfirming(undefined);
                        setStepKey(undefined);
                        setSharing(true);
                      }}
                    >
                      <span className="min-w-0 wrap-break-word">
                        <Trans>Sharing & permissions</Trans>
                      </span>
                      <span className="flex min-w-0 shrink items-center gap-2 text-right text-muted-foreground">
                        {edited === undefined ? null : <SharingSummary view={edited} />}
                        <ChevronRight aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
                      </span>
                    </button>
                  </li>
                  <li>
                    <button
                      data-view-row="delete"
                      type="button"
                      className={`${rowClassName} text-destructive hover:text-destructive`}
                      disabled={busy || edited?.canDelete !== true}
                      onClick={() => {
                        if (edited !== undefined) confirm('delete', edited);
                      }}
                    >
                      {smartLists ? <Trans>Delete list</Trans> : <Trans>Delete view</Trans>}
                    </button>
                  </li>
                </ul>
                {view === undefined ? (
                  <p className="text-sm text-muted-foreground">
                    <Trans>
                      Duplicate, sharing and delete are available once it has been created.
                    </Trans>
                  </p>
                ) : null}
                {newerEdit ? (
                  <p role="alert">
                    <Trans>
                      This view changed. Your draft is kept. Review the latest version before
                      saving.
                    </Trans>{' '}
                    <Button
                      variant="quiet"
                      disabled={busy}
                      onClick={() => {
                        setView(latestEdit);
                        save.reset();
                      }}
                    >
                      <Trans>Review latest view</Trans>
                    </Button>
                  </p>
                ) : null}
                {save.isError || !canSave ? (
                  <p role="alert">
                    {!canSave || (save.error instanceof ApiError && save.error.status === 403)
                      ? t`You no longer have permission to save this view. Your draft is kept.`
                      : save.error instanceof ApiError && save.error.status === 409
                        ? t`This view changed. Your draft is kept. Review the latest version before saving.`
                        : save.error instanceof ApiError
                          ? (save.error.problem.errors?.find((issue) => issue.message.trim() !== '')
                              ?.message ??
                            t`We couldn't save the view. Your name is kept; try again.`)
                          : t`We couldn't save the view. Your name is kept; try again.`}
                  </p>
                ) : null}
                {duplicate.isError ? (
                  <p role="alert">
                    <Trans>We couldn't duplicate the view. Try again.</Trans>
                  </p>
                ) : null}
              </div>
              <div className={sidePanelFooterClassName}>
                <Button variant="secondary" disabled={busy} onClick={cancel}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  type="submit"
                  disabled={busy || name.trim() === '' || !canSave || newerEdit}
                >
                  {view === undefined ? <Trans>Create</Trans> : <Trans>Save changes</Trans>}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
