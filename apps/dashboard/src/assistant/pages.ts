// What the assistant is told about the page it is asked from: ids, never the page's text.
// The address says where the person is and which record is open; the server reads that
// record again under the person's own permissions. Pure functions, with tests beside them.
import {
  ASSISTANT_LIMITS,
  type AssistantPageContext,
  type AssistantSubjectKind,
} from '@repo/contracts';

/** Where the person is, as the router has it. */
export interface Place {
  /** The page's path inside the business: what follows /b/{slug}, "/" for the Dashboard. */
  readonly path: string;
  /** The address's own parameters, such as a contact's id. */
  readonly params: Readonly<Record<string, unknown>>;
  /** The address's search, such as the opportunity open over the list. */
  readonly search: Readonly<Record<string, unknown>>;
}

// A public id's shape: a prefix, then a UUIDv7 in TypeID's base32. The server decides
// whether it names a record; this only keeps other text ("new") out of requests.
const PUBLIC_ID = /^[a-z][a-z_]{0,30}_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

interface RecordPage {
  /** The pages it is true of, by their path inside the business. */
  readonly at: RegExp;
  readonly kind: AssistantSubjectKind;
  /** Where the address keeps the record's id. */
  readonly id: (place: Place) => unknown;
}

// Every page that is about one record, the most specific address first.
const recordPages: readonly RecordPage[] = [
  {
    at: /^\/contacts\/companies\/[^/]+/,
    kind: 'company',
    id: ({ params }) => params['companyId'],
  },
  { at: /^\/contacts\/[^/]+/, kind: 'contact', id: ({ params }) => params['contactId'] },
  { at: /^\/deals\/pipelines$/, kind: 'pipeline', id: ({ search }) => search['pipeline'] },
  { at: /^\/deals$/, kind: 'deal', id: ({ search }) => search['deal'] },
  { at: /^\/inbox$/, kind: 'conversation', id: ({ search }) => search['conversation'] },
  { at: /^\/automations$/, kind: 'automation', id: ({ search }) => search['automation'] },
  {
    at: /^\/settings\/calendars\/[^/]+/,
    kind: 'calendar',
    id: ({ params }) => params['calendarId'],
  },
  { at: /^\/settings\/forms$/, kind: 'form', id: ({ search }) => search['form'] },
];

// Forms are under Settings' address here; the server knows the page as /forms.
const FORMS = '/settings/forms';

/** The page's path inside the business named `slug`, from the whole path of the address. */
export function pathInBusiness(pathname: string, slug: string): string {
  const prefix = `/b/${slug}`;
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
  const path = rest.replace(/\/+$/, '');
  return path.startsWith('/') ? path : `/${path}`;
}

/** The record a page is about, when its address names one. */
export function recordOf(place: Place): AssistantPageContext['record'] {
  for (const page of recordPages) {
    if (!page.at.test(place.path)) continue;
    const id = page.id(place);
    return typeof id === 'string' && PUBLIC_ID.test(id) ? { kind: page.kind, id } : undefined;
  }
  return undefined;
}

/** What a message says of the page it was sent from. */
export function pageContextOf(place: Place): AssistantPageContext {
  const record = recordOf(place);
  const path =
    place.path === FORMS ? (record === undefined ? '/forms' : `/forms/${record.id}`) : place.path;
  return {
    route: path.replaceAll(/\s/g, '').slice(0, ASSISTANT_LIMITS.routeLength),
    ...(record === undefined ? {} : { record }),
    // No page hands its selected rows to the shell yet, so none are named.
    selection: [],
  };
}

/** The expanded view's own page, for a message typed there with no page behind it. */
export const assistantPageItself: AssistantPageContext = { route: '/assistant', selection: [] };
