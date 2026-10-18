import type { Page } from '@playwright/test';
import type { ContactDetails } from '@repo/contracts';

/** Empty reads for contact tests whose subject is identity editing or tag assignment. */
export async function emptyContactPanels(page: Page): Promise<void> {
  await emptyCompanyLinks(page);
  await emptyRecordWork(page);
  await page.route(/\/api\/v1\/contacts\/con_[^/]+\/memory$/, (route) =>
    route.fulfill({ json: { summary: null } }),
  );
  await page.route(/\/api\/v1\/records\/con_[^/]+\/fields$/, (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route(/\/api\/v1\/records\/con_[^/]+\/activity(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  await plainContactDetails(page);
}

/** Empty notes for record tests whose subject is another feature. Override afterward. */
export async function emptyRecordNotes(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/records\/(?:con|com|deal)_[^/]+\/notes(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { canManage: false, items: [], nextCursor: null } }),
  );
}

/**
 * An empty task list for each record page, for record tests whose subject is another
 * feature. Other task reads fall through to routes added before it. Override afterward.
 */
export async function emptyRecordTasks(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
    route.request().method() === 'GET' &&
    new URL(route.request().url()).searchParams.has('recordId')
      ? route.fulfill({ json: { canManage: false, items: [], nextCursor: null } })
      : route.fallback(),
  );
}

/** A record page's notes and tasks, both empty: the work panels every record page shows. */
export async function emptyRecordWork(page: Page): Promise<void> {
  await emptyRecordNotes(page);
  await emptyRecordTasks(page);
}

/**
 * The task lists that are not a record's own, empty: the Dashboard's overdue tasks and the
 * Tasks page, for tests whose subject is another feature. A record's tasks fall through.
 * Override afterward.
 */
export async function emptyMyTasks(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, (route) =>
    route.request().method() === 'GET' &&
    !new URL(route.request().url()).searchParams.has('recordId')
      ? route.fulfill({ json: { canManage: false, items: [], nextCursor: null } })
      : route.fallback(),
  );
}

/**
 * Opens one of a contact page's sections: from the icon rail beside the panes on a wide
 * screen, and from the row of sections under the contact's summary on a narrow one. Only
 * one of the two is on the page at a time.
 */
export async function openContactSection(
  page: Page,
  name: 'Details' | 'Conversation' | 'Activity' | 'Tasks' | 'Notes' | 'Appointments' | 'Companies',
): Promise<void> {
  await page
    .getByRole('navigation', { name: /^Contact (?:panels|sections)$/ })
    .getByRole('link', { name, exact: true })
    .click();
}

export async function emptyCompanyLinks(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/contacts\/con_[^/]+\/companies(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], next: null, canManage: false } }),
  );
}

/** What a test's contact gives its details: the lists the contact itself answers. */
export interface DetailedContact {
  readonly id: string;
  readonly emails: readonly string[];
  readonly phones: readonly { readonly number: string; readonly display: string }[];
  readonly doNotContact?: boolean;
  readonly createdAt: string;
  readonly canManage: boolean;
}

// TypeID's base32: changing an id's last two characters changes only the low, random bits
// of its UUIDv7, so each address id made from a contact's id is valid too.
const base32 = '0123456789abcdefghjkmnpqrstvwxyz';

/** The id of a contact's address: the contact's own, with its last two characters changed. */
export const addressIdOf = (contactId: string, kind: 'email' | 'phone', index: number): string =>
  `cid_${contactId.slice(4, -2)}${kind === 'email' ? 'e' : 'p'}${base32.charAt(index)}`;

/**
 * A contact's details as the server would answer them for a contact nobody owns or
 * follows: its addresses in order, the first of each kind the primary, and nothing else set.
 */
export function detailsFor(
  contact: DetailedContact,
  rest: Partial<ContactDetails> = {},
): ContactDetails {
  return {
    id: contact.id,
    owner: null,
    ownerRevision: 'a'.repeat(64),
    followers: [],
    addresses: [
      ...contact.emails.map((email, index) => ({
        id: addressIdOf(contact.id, 'email', index),
        kind: 'email' as const,
        value: email,
        display: email,
        label: null,
        primary: index === 0,
        delivery: { status: 'unchecked' as const, reason: null, since: null },
      })),
      ...contact.phones.map((phone, index) => ({
        id: addressIdOf(contact.id, 'phone', index),
        kind: 'phone' as const,
        value: phone.number,
        display: phone.display,
        label: null,
        primary: index === 0,
        delivery: { status: 'unchecked' as const, reason: null, since: null },
      })),
    ],
    addressesRevision: 'a'.repeat(64),
    dnd: {
      all: contact.doNotContact ?? false,
      channels: [],
      inbound: false,
      revision: 'a'.repeat(64),
    },
    createdBy: { kind: 'user', name: 'Dana Brooks', you: true },
    createdSource: 'user',
    createdAt: contact.createdAt,
    canManage: contact.canManage,
    canReadAudit: false,
    ...rest,
  };
}

/**
 * The details of whichever contact a test's own API answers, for tests whose subject is
 * something else: read from that API through the page, so the two agree. Override afterward.
 */
export async function plainContactDetails(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/contacts\/con_[^/]+\/details$/, async (route) => {
    const request = route.request();
    const answer = await page
      .evaluate(
        async ([url, businessId]) => {
          const response = await fetch(url, { headers: { 'business-id': businessId } });
          return response.ok ? ((await response.json()) as unknown) : null;
        },
        [request.url().replace(/\/details$/, ''), request.headers()['business-id'] ?? ''] as const,
      )
      .catch(() => null);
    if (answer === null) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: { type: 'about:blank', title: 'Not Found', status: 404 },
      });
      return;
    }
    await route.fulfill({ json: detailsFor(answer as DetailedContact) });
  });
}

export interface DetailsApi {
  /** What the server holds now. */
  details: ContactDetails;
  readonly sent: { readonly method: string; readonly path: string; readonly body: unknown }[];
}

const revisionAfter = (count: number): string => base32.charAt(count % 16).repeat(64);

/**
 * Stands in for the contact-details endpoints of one contact: it keeps what is changed and
 * answers the whole shape, as the server does. `team` is who an owner or a follower can be,
 * by membership id.
 */
export async function contactDetailsApi(
  page: Page,
  initial: ContactDetails,
  team: readonly { readonly id: string; readonly name: string | null; readonly you: boolean }[],
): Promise<DetailsApi> {
  const api: DetailsApi = { details: initial, sent: [] };
  const personOf = (id: string) => {
    const person =
      id === 'me' ? team.find((each) => each.you) : team.find((each) => each.id === id);
    if (person === undefined) throw new Error(`Nobody has the membership ${id}.`);
    return { membershipId: person.id, name: person.name, you: person.you };
  };
  await page.route('**/api/v1/tasks/assignees**', (route) =>
    route.fulfill({ json: { items: team, nextCursor: null } }),
  );
  await page.route(
    new RegExp(`/api/v1/contacts/${initial.id}/(details|owner|followers|addresses(/[^/]+)?|dnd)$`),
    async (route) => {
      const request = route.request();
      const method = request.method();
      const path = new URL(request.url()).pathname.replace(`/api/v1/contacts/${initial.id}`, '');
      const body = (request.postData() === null ? {} : request.postDataJSON()) as Record<
        string,
        unknown
      >;
      if (method !== 'GET') api.sent.push({ method, path, body });
      const current = api.details;
      const next = revisionAfter(api.sent.length);
      const conflict = () =>
        route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Conflict', status: 409 },
        });
      if (path === '/owner') {
        if (body['revision'] !== current.ownerRevision) return conflict();
        const owner = body['owner'];
        api.details = {
          ...current,
          owner: typeof owner === 'string' ? personOf(owner) : null,
          ownerRevision: next,
        };
      } else if (path === '/followers') {
        const named = (body['followers'] as string[]).map(personOf);
        const ids = new Set(named.map((person) => person.membershipId));
        api.details = {
          ...current,
          followers:
            method === 'POST'
              ? [
                  ...current.followers,
                  ...named.filter(
                    (person) =>
                      !current.followers.some((each) => each.membershipId === person.membershipId),
                  ),
                ]
              : current.followers.filter((person) => !ids.has(person.membershipId ?? '')),
        };
      } else if (path === '/addresses') {
        const kind = body['kind'] === 'email' ? 'email' : 'phone';
        const value = String(body['value']).trim();
        const count = current.addresses.filter((each) => each.kind === kind).length;
        const added: ContactDetails['addresses'] = [
          {
            id: addressIdOf(initial.id, kind, count + 8),
            kind,
            value:
              kind === 'email'
                ? value.toLowerCase()
                : `+254${value.replace(/\D/g, '').replace(/^0/, '')}`,
            display: kind === 'email' ? value.toLowerCase() : value,
            label: null,
            primary: count === 0,
            delivery: { status: 'unchecked', reason: null, since: null },
          },
        ];
        api.details = {
          ...current,
          addresses: [...current.addresses, ...added].toSorted((one, other) =>
            one.kind.localeCompare(other.kind),
          ),
          addressesRevision: next,
        };
        await route.fulfill({ status: 201, json: api.details });
        return;
      } else if (path.startsWith('/addresses/')) {
        if (body['revision'] !== current.addressesRevision) return conflict();
        const id = path.replace('/addresses/', '');
        const target = current.addresses.find((each) => each.id === id);
        if (target === undefined) throw new Error(`No address ${id}.`);
        const others = current.addresses.filter((each) => each.id !== id);
        const heir = others.find((each) => each.kind === target.kind);
        api.details = {
          ...current,
          addresses:
            method === 'DELETE'
              ? others.map((each) =>
                  target.primary && each === heir ? { ...each, primary: true } : each,
                )
              : current.addresses.map((each) =>
                  each.id === id
                    ? {
                        ...each,
                        ...('label' in body
                          ? { label: body['label'] as (typeof each)['label'] }
                          : {}),
                        ...(body['primary'] === true ? { primary: true } : {}),
                      }
                    : body['primary'] === true && each.kind === target.kind
                      ? { ...each, primary: false }
                      : each,
                ),
          addressesRevision: next,
        };
      } else if (path === '/dnd') {
        if (body['revision'] !== current.dnd.revision) return conflict();
        api.details = {
          ...current,
          dnd: {
            all: body['all'] === true,
            channels: body['channels'] as ContactDetails['dnd']['channels'],
            // Left out, inbound stays as it is, as the server keeps it.
            inbound: typeof body['inbound'] === 'boolean' ? body['inbound'] : current.dnd.inbound,
            revision: next,
          },
        };
      }
      await route.fulfill({ json: api.details });
    },
  );
  return api;
}
