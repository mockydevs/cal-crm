// Stands in for the API behind Merge Contacts: two Jane Does, each as the contact read, its
// details and its custom fields answer it, the merge preview and the merge, answering as the
// server does. The dialog's unit tests read the same contacts.
import type { Page, Route } from '@playwright/test';
import type {
  Contact,
  ContactDetails,
  ContactMerge,
  ContactMergePreview,
  RecordField,
  RecordFields,
} from '@repo/contracts';
import { detailsFor } from './contact-panels';
import { idOf } from './settings-fixtures';

export const janeId = idOf('con', 1);
export const janetId = idOf('con', 2);
const ownerId = idOf('mem', 1);

const revisionOf = (letter: string): string => letter.repeat(64);

/** The older Jane Doe: a lead from the website, Dana's, with a budget. */
export const jane = (): Contact => ({
  id: janeId,
  firstName: 'Jane',
  lastName: 'Doe',
  name: 'Jane Doe',
  emails: ['jane.doe@gmail.com'],
  phones: [{ number: '+12125550142', display: '(212) 555-0142' }],
  timeZone: 'America/New_York',
  doNotContact: false,
  preferencesRevision: revisionOf('a'),
  dateOfBirth: null,
  source: 'Website',
  type: 'lead',
  trashedAt: null,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
  canManage: true,
});

/** The newer one: Janet, a customer met at a trade fair, with a birthday and another budget. */
export const janet = (): Contact => ({
  id: janetId,
  firstName: 'Janet',
  lastName: 'Doe',
  name: 'Janet Doe',
  emails: ['janedoe+news@gmail.com'],
  phones: [],
  timeZone: null,
  doNotContact: false,
  preferencesRevision: revisionOf('b'),
  dateOfBirth: '1990-04-12',
  source: 'Trade fair',
  type: 'customer',
  trashedAt: null,
  createdAt: '2026-09-02T12:00:00.000Z',
  updatedAt: '2026-09-02T12:00:00.000Z',
  canManage: true,
});

export const mergeContacts = (): Contact[] => [jane(), janet()];

/** A contact's details: Jane is Dana's, Janet nobody's. */
export function mergeDetailsOf(contact: Contact): ContactDetails {
  return detailsFor(
    { ...contact, emails: contact.emails, phones: contact.phones },
    contact.id === janeId
      ? { owner: { membershipId: ownerId, name: 'Dana Brooks', you: true } }
      : {},
  );
}

const budgetOf = (value: string | null): RecordField => ({
  definition: {
    id: idOf('fld', 1),
    objectKey: 'contact',
    key: 'budget',
    label: 'Budget',
    description: 'What the client means to spend.',
    valueType: 'text',
    options: [],
    currency: null,
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    revision: revisionOf('f'),
  },
  value,
  source: value === null ? null : { kind: 'user', eventId: null, you: true },
  updatedAt: value === null ? null : '2026-09-03T12:00:00.000Z',
  confidence: null,
  confirmedAt: null,
  revision: revisionOf('c'),
});

/** A field nobody has a value in: the merge shows no row for it. */
const venueOf = (): RecordField => ({
  ...budgetOf(null),
  definition: { ...budgetOf(null).definition, id: idOf('fld', 2), key: 'venue', label: 'Venue' },
});

/** A contact's custom fields: a budget each, and a venue neither has. */
export function mergeFieldsOf(contactId: string): RecordFields {
  return {
    items: [budgetOf(contactId === janeId ? '5000' : '8000'), venueOf()],
    canManage: true,
    canConfirm: false,
  };
}

/** The preview for a master and the others, in the order the merge reads them. */
export function mergePreviewOf(
  order: readonly string[],
  rest: Partial<ContactMergePreview> = {},
): ContactMergePreview {
  return {
    contacts: order.map((id) => ({ id, revision: revisionOf(id === janeId ? '1' : '2') })),
    moved: { crm: { notes: 2, tasks: 1, timeline: 7, tags: 0 }, messaging: { conversations: 1 } },
    rows: 11,
    maxRows: 50_000,
    ...rest,
  };
}

export interface MergeApi {
  /** Each preview asked for: the master, then the others. */
  readonly previews: string[][];
  /** Each merge sent: the master and the body. */
  readonly merges: { id: string; body: unknown }[];
  /** Overrides the preview's answer. */
  preview: Partial<ContactMergePreview>;
  /** The contacts merged away, which then answer 404 with mergedInto. */
  readonly mergedInto: Map<string, string>;
}

const problem = (route: Route, status: number, rest: Record<string, unknown> = {}) =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    body: JSON.stringify({ type: 'about:blank', title: 'Not Found', status, ...rest }),
  });

/**
 * The contact reads, details, custom fields, preview and merge of the two Jane Does. A
 * merged contact's reads answer 404 with the contact it went into, as the server does.
 */
export async function fakeMergeApi(page: Page): Promise<MergeApi> {
  const api: MergeApi = { previews: [], merges: [], preview: {}, mergedInto: new Map() };
  const contacts = new Map(mergeContacts().map((each) => [each.id, each]));
  await page.route(
    /\/api\/v1\/contacts\/(con_[^/?]+)(?:\/(details|merge-preview|merge))?(?:\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      const [, id = '', action] =
        /\/contacts\/(con_[^/?]+)(?:\/([a-z-]+))?/u.exec(url.pathname) ?? [];
      const kept = api.mergedInto.get(id);
      if (kept !== undefined)
        return problem(route, 404, { detail: 'This contact was merged.', mergedInto: kept });
      const contact = contacts.get(id);
      if (contact === undefined) return route.fallback();
      if (action === undefined && route.request().method() === 'GET')
        return route.fulfill({ json: contact });
      if (action === 'details') return route.fulfill({ json: mergeDetailsOf(contact) });
      if (action === 'merge-preview') {
        const others = (url.searchParams.get('mergeIds') ?? '').split(',');
        api.previews.push([id, ...others]);
        return route.fulfill({ json: mergePreviewOf([id, ...others], api.preview) });
      }
      if (action === 'merge' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { mergeIds: string[] };
        api.merges.push({ id, body });
        for (const other of body.mergeIds) api.mergedInto.set(other, id);
        const answer: ContactMerge = {
          contact,
          mergedIds: body.mergeIds,
          moved: mergePreviewOf([id, ...body.mergeIds]).moved,
        };
        return route.fulfill({ json: answer });
      }
      return route.fallback();
    },
  );
  await page.route(/\/api\/v1\/records\/(con_[^/]+)\/fields$/, (route) => {
    const id = /records\/(con_[^/]+)\/fields/u.exec(route.request().url())?.[1] ?? '';
    return contacts.has(id) ? route.fulfill({ json: mergeFieldsOf(id) }) : route.fallback();
  });
  return api;
}
