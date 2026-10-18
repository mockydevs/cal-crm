// A report while it is being changed: its name and its definition as the builder holds
// them, what was last saved, and every change the builder can make as a pure step. A widget
// flows after the one before it on a 12-column grid, so moving one is changing its place in
// its page's list.
import {
  REPORT_LIMITS,
  type ReportCompareMode,
  type ReportDefinition,
  type ReportRangeInput,
  type ReportWidget,
} from '@repo/contracts';

type ReportPage = ReportDefinition['pages'][number];

export interface Saved {
  readonly name: string;
  readonly definition: ReportDefinition;
  readonly revision: number;
}

export interface BuilderState {
  readonly name: string;
  readonly definition: ReportDefinition;
  readonly saved: Saved;
  /** The page showing, from 0. */
  readonly page: number;
  /** The widget whose settings are open, if any. */
  readonly editing: string | null;
}

export type BuilderAction =
  | { readonly type: 'loaded'; readonly saved: Saved }
  | { readonly type: 'saved'; readonly saved: Saved }
  | { readonly type: 'discard' }
  | { readonly type: 'rename'; readonly name: string }
  | { readonly type: 'range'; readonly range: ReportRangeInput }
  | { readonly type: 'compare'; readonly compare: ReportCompareMode | null }
  | { readonly type: 'show-page'; readonly page: number }
  | { readonly type: 'add-page'; readonly name: string }
  | { readonly type: 'rename-page'; readonly page: number; readonly name: string }
  | { readonly type: 'remove-page'; readonly page: number }
  | { readonly type: 'add-widget'; readonly widget: ReportWidget }
  | { readonly type: 'edit'; readonly id: string | null }
  | { readonly type: 'change-widget'; readonly id: string; readonly widget: ReportWidget }
  | { readonly type: 'move-widget'; readonly id: string; readonly by: -1 | 1 }
  | { readonly type: 'place-widget'; readonly id: string; readonly before: string | null }
  | {
      readonly type: 'resize-widget';
      readonly id: string;
      readonly w?: number;
      readonly h?: number;
    }
  | { readonly type: 'duplicate-widget'; readonly id: string; readonly title: string }
  | { readonly type: 'remove-widget'; readonly id: string };

export function startOf(saved: Saved, page = 0): BuilderState {
  return {
    name: saved.name,
    definition: saved.definition,
    saved,
    page: Math.min(Math.max(page, 0), saved.definition.pages.length - 1),
    editing: null,
  };
}

/** Whether anything differs from what was saved. */
export function isDirty(state: BuilderState): boolean {
  return (
    state.name !== state.saved.name ||
    JSON.stringify(state.definition) !== JSON.stringify(state.saved.definition)
  );
}

const clamp = (value: number, least: number, most: number): number =>
  Math.min(Math.max(Math.round(value), least), most);

const everyId = (definition: ReportDefinition): Set<string> =>
  new Set(definition.pages.flatMap((page) => page.widgets.map((widget) => widget.id)));

/** An id no widget of the report has: the base, or the base with the first free number. */
export function freeWidgetId(definition: ReportDefinition, base: string): string {
  const taken = everyId(definition);
  const stem =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 32) || 'widget';
  if (!taken.has(stem)) return stem;
  for (let number = 2; ; number += 1) {
    const id = `${stem}_${String(number)}`;
    if (!taken.has(id)) return id;
  }
}

export const canAddPage = (definition: ReportDefinition): boolean =>
  definition.pages.length < REPORT_LIMITS.pages;

export const canAddWidget = (definition: ReportDefinition, page: number): boolean =>
  (definition.pages[page]?.widgets.length ?? REPORT_LIMITS.widgetsPerPage) <
  REPORT_LIMITS.widgetsPerPage;

function onPage(
  state: BuilderState,
  page: number,
  change: (page: ReportPage) => ReportPage,
): BuilderState {
  return {
    ...state,
    definition: {
      ...state.definition,
      pages: state.definition.pages.map((each, index) => (index === page ? change(each) : each)),
    },
  };
}

/** The page a widget is on, or none. */
function pageOf(definition: ReportDefinition, id: string): number {
  return definition.pages.findIndex((page) => page.widgets.some((widget) => widget.id === id));
}

function onWidgets(
  state: BuilderState,
  id: string,
  change: (widgets: readonly ReportWidget[], index: number) => readonly ReportWidget[],
): BuilderState {
  const page = pageOf(state.definition, id);
  if (page === -1) return state;
  return onPage(state, page, (each) => {
    const index = each.widgets.findIndex((widget) => widget.id === id);
    return { ...each, widgets: [...change(each.widgets, index)] };
  });
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case 'loaded':
      return startOf(action.saved, state.page);
    case 'saved':
      // What was saved is what the server holds; the page and the open widget stay.
      return {
        ...state,
        name: action.saved.name,
        definition: action.saved.definition,
        saved: action.saved,
      };
    case 'discard':
      return { ...startOf(state.saved, state.page) };
    case 'rename':
      return { ...state, name: action.name };
    case 'range':
      return { ...state, definition: { ...state.definition, range: action.range } };
    case 'compare':
      return { ...state, definition: { ...state.definition, compare: action.compare } };
    case 'show-page':
      return action.page >= 0 && action.page < state.definition.pages.length
        ? { ...state, page: action.page, editing: null }
        : state;
    case 'add-page': {
      if (!canAddPage(state.definition)) return state;
      const pages = [...state.definition.pages, { name: action.name, widgets: [] }];
      return {
        ...state,
        definition: { ...state.definition, pages },
        page: pages.length - 1,
        editing: null,
      };
    }
    case 'rename-page':
      return onPage(state, action.page, (page) => ({ ...page, name: action.name }));
    case 'remove-page': {
      // A report has at least one page.
      if (state.definition.pages.length <= 1 || state.definition.pages[action.page] === undefined)
        return state;
      const pages = state.definition.pages.filter((_, index) => index !== action.page);
      return {
        ...state,
        definition: { ...state.definition, pages },
        page: Math.min(
          action.page <= state.page ? Math.max(state.page - 1, 0) : state.page,
          pages.length - 1,
        ),
        editing: null,
      };
    }
    case 'add-widget':
      if (!canAddWidget(state.definition, state.page)) return state;
      return {
        ...onPage(state, state.page, (page) => ({
          ...page,
          widgets: [...page.widgets, action.widget],
        })),
        editing: action.widget.id,
      };
    case 'edit':
      return { ...state, editing: action.id };
    case 'change-widget':
      return onWidgets(state, action.id, (widgets, index) =>
        // A widget keeps its id: it is how the report's other parts name it.
        widgets.map((widget, place) =>
          place === index ? { ...action.widget, id: action.id } : widget,
        ),
      );
    case 'move-widget':
      return onWidgets(state, action.id, (widgets, index) => {
        const to = index + action.by;
        const moving = widgets[index];
        if (moving === undefined || to < 0 || to >= widgets.length) return widgets;
        const rest = widgets.filter((_, place) => place !== index);
        return [...rest.slice(0, to), moving, ...rest.slice(to)];
      });
    case 'place-widget':
      return onWidgets(state, action.id, (widgets, index) => {
        const moving = widgets[index];
        if (moving === undefined || action.before === action.id) return widgets;
        const rest = widgets.filter((_, place) => place !== index);
        const at = action.before === null ? -1 : rest.findIndex((w) => w.id === action.before);
        return at === -1 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)];
      });
    case 'resize-widget':
      return onWidgets(state, action.id, (widgets, index) =>
        widgets.map((widget, place) =>
          place === index
            ? {
                ...widget,
                w: clamp(action.w ?? widget.w, 1, 12),
                h: clamp(action.h ?? widget.h, 1, 12),
              }
            : widget,
        ),
      );
    case 'duplicate-widget': {
      const page = pageOf(state.definition, action.id);
      if (page === -1 || !canAddWidget(state.definition, page)) return state;
      const id = freeWidgetId(state.definition, action.id);
      return {
        ...onWidgets(state, action.id, (widgets, index) => {
          const original = widgets[index];
          if (original === undefined) return widgets;
          return [
            ...widgets.slice(0, index + 1),
            { ...original, id, title: action.title },
            ...widgets.slice(index + 1),
          ];
        }),
        editing: state.editing === null ? null : id,
      };
    }
    case 'remove-widget':
      return {
        ...onWidgets(state, action.id, (widgets) =>
          widgets.filter((widget) => widget.id !== action.id),
        ),
        editing: state.editing === action.id ? null : state.editing,
      };
  }
}
