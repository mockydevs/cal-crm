import {
  BLANK_REPORT_DEFINITION,
  REPORT_LIMITS,
  reportDefinition,
  type ReportDefinition,
  type ReportWidget,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { pipelineTemplate } from '../../e2e/reporting-fixtures';
import {
  builderReducer,
  canAddPage,
  canAddWidget,
  freeWidgetId,
  isDirty,
  startOf,
  type BuilderAction,
  type BuilderState,
  type Saved,
} from './builder-state';

const saved: Saved = {
  name: 'Pipeline & Attribution Report',
  definition: pipelineTemplate.definition,
  revision: 3,
};
const start = startOf(saved);
const run = (state: BuilderState, ...actions: BuilderAction[]): BuilderState =>
  actions.reduce(builderReducer, state);
const ids = (state: BuilderState, page = state.page): string[] =>
  state.definition.pages[page]?.widgets.map((widget) => widget.id) ?? [];
const stat = (id: string): ReportWidget => ({
  id,
  kind: 'stat',
  title: 'Leads',
  query: { source: 'contacts', measures: ['count'], groupBy: [] },
  w: 3,
  h: 2,
});
const valid = (state: BuilderState): boolean =>
  reportDefinition.safeParse(state.definition).success;

describe('starting', () => {
  it('starts as what was saved, on a page the report has', () => {
    expect(start).toMatchObject({ name: saved.name, page: 0, editing: null });
    expect(isDirty(start)).toBe(false);
    expect(startOf(saved, 1).page).toBe(1);
    expect(startOf(saved, 9).page).toBe(1);
    expect(startOf(saved, -2).page).toBe(0);
  });

  it('is dirty once the name or the definition differs, and clean again when put back', () => {
    const renamed = run(start, { type: 'rename', name: 'Mine' });
    expect(isDirty(renamed)).toBe(true);
    expect(isDirty(run(renamed, { type: 'rename', name: saved.name }))).toBe(false);
    expect(isDirty(run(start, { type: 'compare', compare: null }))).toBe(true);
    expect(isDirty(run(start, { type: 'range', range: { preset: 'today' } }))).toBe(true);
    expect(run(start, { type: 'range', range: { preset: 'today' } }).definition.range).toEqual({
      preset: 'today',
    });
  });

  it('takes a save as the new starting point and keeps the page and the open widget', () => {
    const changed = run(
      start,
      { type: 'show-page', page: 1 },
      { type: 'edit', id: 'leads_by_source' },
      { type: 'rename', name: 'Mine' },
    );
    const after = run(changed, {
      type: 'saved',
      saved: { name: 'Mine', definition: changed.definition, revision: 4 },
    });
    expect(after).toMatchObject({ page: 1, editing: 'leads_by_source', name: 'Mine' });
    expect(after.saved.revision).toBe(4);
    expect(isDirty(after)).toBe(false);
  });

  it('discards back to what was saved, and loads another saved version on the same page', () => {
    const changed = run(
      start,
      { type: 'show-page', page: 1 },
      { type: 'rename', name: 'Mine' },
      { type: 'remove-widget', id: 'leads_by_source' },
    );
    const discarded = run(changed, { type: 'discard' });
    expect(discarded).toMatchObject({ name: saved.name, page: 1, editing: null });
    expect(isDirty(discarded)).toBe(false);
    const theirs: Saved = { name: 'Theirs', definition: BLANK_REPORT_DEFINITION, revision: 9 };
    const loaded = run(changed, { type: 'loaded', saved: theirs });
    // Their version has one page: the second no longer exists.
    expect(loaded).toMatchObject({ name: 'Theirs', page: 0 });
    expect(loaded.saved.revision).toBe(9);
  });
});

describe('pages', () => {
  it('shows a page the report has, and closes the open widget', () => {
    const editing = run(start, { type: 'edit', id: 'open' });
    expect(run(editing, { type: 'show-page', page: 1 })).toMatchObject({ page: 1, editing: null });
    expect(run(editing, { type: 'show-page', page: 5 })).toBe(editing);
    expect(run(editing, { type: 'show-page', page: -1 })).toBe(editing);
  });

  it('adds a page at the end and shows it', () => {
    const added = run(start, { type: 'add-page', name: 'Page 3' });
    expect(added.definition.pages.map((page) => page.name)).toEqual([
      'Pipeline',
      'Attribution',
      'Page 3',
    ]);
    expect(added.page).toBe(2);
    expect(valid(added)).toBe(true);
  });

  it('stops at the most pages a report holds', () => {
    let state = startOf({ ...saved, definition: BLANK_REPORT_DEFINITION });
    for (let index = 1; index < REPORT_LIMITS.pages; index += 1)
      state = run(state, { type: 'add-page', name: `Page ${String(index + 1)}` });
    expect(state.definition.pages).toHaveLength(REPORT_LIMITS.pages);
    expect(canAddPage(state.definition)).toBe(false);
    expect(run(state, { type: 'add-page', name: 'One more' })).toBe(state);
    expect(valid(state)).toBe(true);
  });

  it('renames a page', () => {
    const renamed = run(start, { type: 'rename-page', page: 1, name: 'Sources' });
    expect(renamed.definition.pages.map((page) => page.name)).toEqual(['Pipeline', 'Sources']);
  });

  it('removes a page and shows the one before it, but never the last page', () => {
    const second = run(start, { type: 'show-page', page: 1 });
    const removed = run(second, { type: 'remove-page', page: 1 });
    expect(removed.definition.pages.map((page) => page.name)).toEqual(['Pipeline']);
    expect(removed.page).toBe(0);
    expect(run(removed, { type: 'remove-page', page: 0 })).toBe(removed);
    expect(run(start, { type: 'remove-page', page: 7 })).toBe(start);
    // Removing the first page while on it leaves the next one showing, as the first.
    const first = run(start, { type: 'remove-page', page: 0 });
    expect(first.definition.pages.map((page) => page.name)).toEqual(['Attribution']);
    expect(first.page).toBe(0);
    // Removing a later page leaves the one showing where it is.
    const three = run(start, { type: 'add-page', name: 'Three' }, { type: 'show-page', page: 0 });
    expect(run(three, { type: 'remove-page', page: 2 }).page).toBe(0);
  });
});

describe('widgets', () => {
  it('adds a widget at the foot of the page showing, and opens it', () => {
    const added = run(start, { type: 'add-widget', widget: stat('leads') });
    expect(ids(added)).toEqual(['open', 'won', 'funnel', 'leads']);
    expect(added.editing).toBe('leads');
    expect(valid(added)).toBe(true);
  });

  it('stops at the most widgets a page holds', () => {
    let state = startOf({ ...saved, definition: BLANK_REPORT_DEFINITION });
    for (let index = 0; index < REPORT_LIMITS.widgetsPerPage; index += 1)
      state = run(state, { type: 'add-widget', widget: stat(`w${String(index)}`) });
    expect(ids(state)).toHaveLength(REPORT_LIMITS.widgetsPerPage);
    expect(canAddWidget(state.definition, 0)).toBe(false);
    expect(canAddWidget(state.definition, 4)).toBe(false);
    expect(run(state, { type: 'add-widget', widget: stat('more') })).toBe(state);
    expect(run(state, { type: 'duplicate-widget', id: 'w0', title: 'Copy' })).toBe(state);
  });

  it('opens and closes a widget’s settings', () => {
    expect(run(start, { type: 'edit', id: 'won' }).editing).toBe('won');
    expect(run(start, { type: 'edit', id: 'won' }, { type: 'edit', id: null }).editing).toBeNull();
  });

  it('changes a widget where it stands, and keeps its id', () => {
    const changed = run(start, {
      type: 'change-widget',
      id: 'won',
      widget: { ...stat('something-else'), title: 'Won deals' },
    });
    expect(ids(changed)).toEqual(['open', 'won', 'funnel']);
    expect(changed.definition.pages[0]?.widgets[1]).toMatchObject({
      id: 'won',
      title: 'Won deals',
    });
    expect(run(start, { type: 'change-widget', id: 'nothing', widget: stat('x') })).toBe(start);
  });

  it('changes a widget on a page that is not the one showing', () => {
    const changed = run(start, {
      type: 'resize-widget',
      id: 'leads_by_source',
      w: 12,
    });
    expect(changed.definition.pages[1]?.widgets[0]).toMatchObject({ w: 12, h: 4 });
    expect(changed.definition.pages[0]).toBe(start.definition.pages[0]);
  });

  it('moves a widget one place earlier or later, and not past either end', () => {
    expect(ids(run(start, { type: 'move-widget', id: 'won', by: -1 }))).toEqual([
      'won',
      'open',
      'funnel',
    ]);
    expect(ids(run(start, { type: 'move-widget', id: 'won', by: 1 }))).toEqual([
      'open',
      'funnel',
      'won',
    ]);
    expect(ids(run(start, { type: 'move-widget', id: 'open', by: -1 }))).toEqual(ids(start));
    expect(ids(run(start, { type: 'move-widget', id: 'funnel', by: 1 }))).toEqual(ids(start));
  });

  it('places a dragged widget before another, or at the end', () => {
    expect(ids(run(start, { type: 'place-widget', id: 'funnel', before: 'open' }))).toEqual([
      'funnel',
      'open',
      'won',
    ]);
    expect(ids(run(start, { type: 'place-widget', id: 'open', before: null }))).toEqual([
      'won',
      'funnel',
      'open',
    ]);
    expect(ids(run(start, { type: 'place-widget', id: 'open', before: 'open' }))).toEqual(
      ids(start),
    );
    // A widget of another page is not somewhere to drop: it goes to the end of its own.
    expect(
      ids(run(start, { type: 'place-widget', id: 'open', before: 'leads_by_source' })),
    ).toEqual(['won', 'funnel', 'open']);
  });

  it('resizes within the grid', () => {
    const wide = run(start, { type: 'resize-widget', id: 'open', w: 40, h: 0 });
    expect(wide.definition.pages[0]?.widgets[0]).toMatchObject({ w: 12, h: 1 });
    const same = run(start, { type: 'resize-widget', id: 'open' });
    expect(same.definition.pages[0]?.widgets[0]).toMatchObject({ w: 4, h: 2 });
    expect(valid(wide)).toBe(true);
  });

  it('duplicates a widget just after itself, under an id of its own', () => {
    const copied = run(start, { type: 'duplicate-widget', id: 'won', title: 'Won (copy)' });
    expect(ids(copied)).toEqual(['open', 'won', 'won_2', 'funnel']);
    expect(copied.definition.pages[0]?.widgets[2]).toMatchObject({
      title: 'Won (copy)',
      kind: 'stat',
    });
    expect(copied.editing).toBeNull();
    expect(valid(copied)).toBe(true);
    const again = run(
      copied,
      { type: 'edit', id: 'won' },
      { type: 'duplicate-widget', id: 'won', title: 'Again' },
    );
    expect(ids(again)).toEqual(['open', 'won', 'won_3', 'won_2', 'funnel']);
    // With a widget's settings open, the copy's open in their place.
    expect(again.editing).toBe('won_3');
    expect(run(start, { type: 'duplicate-widget', id: 'nothing', title: 'x' })).toBe(start);
  });

  it('removes a widget, and closes its settings if they were open', () => {
    const removed = run(start, { type: 'edit', id: 'won' }, { type: 'remove-widget', id: 'won' });
    expect(ids(removed)).toEqual(['open', 'funnel']);
    expect(removed.editing).toBeNull();
    const other = run(start, { type: 'edit', id: 'open' }, { type: 'remove-widget', id: 'won' });
    expect(other.editing).toBe('open');
  });
});

describe('freeWidgetId', () => {
  const definition: ReportDefinition = pipelineTemplate.definition;

  it('gives the base when it is free, else the base with the first free number', () => {
    expect(freeWidgetId(definition, 'bar')).toBe('bar');
    expect(freeWidgetId(definition, 'won')).toBe('won_2');
    // Ids are unique over the whole report, not only one page.
    expect(freeWidgetId(definition, 'leads_by_source')).toBe('leads_by_source_2');
  });

  it('makes an id the contract accepts from anything', () => {
    expect(freeWidgetId(definition, 'Won Deals!')).toBe('won_deals_');
    expect(freeWidgetId(definition, '__x')).toBe('x');
    expect(freeWidgetId(definition, '***')).toBe('widget');
    expect(freeWidgetId(definition, 'a'.repeat(60))).toBe('a'.repeat(32));
  });
});
