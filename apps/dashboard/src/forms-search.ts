// What the Forms page's address says: which form is open. On its own, and importing
// nothing, so the route can validate an address without loading the page (the route file
// is in the first download, and anything it imports is too).

export interface FormsSearch {
  /** The open form's id. */
  readonly form?: string;
}

// A form's public id: its prefix, then a UUIDv7 in TypeID's base32. The server decides
// whether it names a form; this only keeps other text out of requests.
const FORM_ID = /^form_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** The page's search parameters, for the route to validate: anything else is dropped. */
export function formsSearch(search: Record<string, unknown>): FormsSearch {
  const form = search['form'];
  return typeof form === 'string' && FORM_ID.test(form) ? { form } : {};
}
