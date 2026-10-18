// What Marketing → Emails → Templates keeps in its address: the place in the library (a
// folder, Archived or Trash), the search, the type and workflow filters, the order and the
// view. Apart from the page because the route reads its address before the page's code
// arrives: only this much is in the first load, and no contract schema is read here.

export interface TemplatesSearch {
  /** A folder's id, or root for the templates in no folder; left out for every template. */
  readonly folder?: string;
  /** Archived or Trash instead of the library itself. */
  readonly show?: 'archived' | 'trash';
  readonly q?: string;
  /** html: designed emails; text: plain text. */
  readonly type?: 'html' | 'text';
  /** Whether a workflow uses it. */
  readonly used?: 'yes' | 'no';
  /** Left out: by name. */
  readonly sort?: 'updated' | 'uses';
  /** Left out: the list. */
  readonly layout?: 'grid';
}

const FOLDER_ID = /^tfld_[0-9a-z]{26}$/;

const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T | undefined =>
  choices.find((choice) => choice === value);

export function templatesSearchOf(search: Record<string, unknown>): TemplatesSearch {
  const show = oneOf(search['show'], ['archived', 'trash'] as const);
  const folder =
    show === undefined &&
    typeof search['folder'] === 'string' &&
    (search['folder'] === 'root' || FOLDER_ID.test(search['folder']))
      ? search['folder']
      : undefined;
  const q = typeof search['q'] === 'string' ? search['q'].trim().slice(0, 120) : '';
  const type = oneOf(search['type'], ['html', 'text'] as const);
  const used = oneOf(search['used'], ['yes', 'no'] as const);
  const sort = oneOf(search['sort'], ['updated', 'uses'] as const);
  const layout = oneOf(search['layout'], ['grid'] as const);
  return {
    ...(folder === undefined ? {} : { folder }),
    ...(show === undefined ? {} : { show }),
    ...(q === '' ? {} : { q }),
    ...(type === undefined ? {} : { type }),
    ...(used === undefined ? {} : { used }),
    ...(sort === undefined ? {} : { sort }),
    ...(layout === undefined ? {} : { layout }),
  };
}
