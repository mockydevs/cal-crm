// The classes a side panel's parts are drawn with, on their own: a form that only needs the
// classes doesn't carry the panel and the list toolbar in its chunk (bundle budgets).

/** The scrolling middle of a side panel. */
export const sidePanelBodyClassName =
  'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4';

/** The buttons pinned at the foot of a side panel. */
export const sidePanelFooterClassName =
  'flex flex-wrap items-center justify-end gap-2 border-t px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]';

/** The classes of a form that fills a panel: its body scrolls and its buttons stay put. */
export const panelFormClassName = 'min-h-0 flex-1 gap-0';
