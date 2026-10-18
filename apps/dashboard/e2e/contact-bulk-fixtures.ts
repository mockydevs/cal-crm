// Stands in for the API behind Contacts → Bulk Actions: the list, one action's contacts,
// and stopping an action, answering as the server does.
import type { Page, Request, Route } from '@playwright/test';
import type { ContactBulkAction, ContactBulkItem } from '@repo/contracts';
import { idOf } from './settings-fixtures';

const segments = (request: Request): string[] => new URL(request.url()).pathname.split('/');

const forbidden = (route: Route): Promise<void> =>
  route.fulfill({
    status: 403,
    contentType: 'application/problem+json',
    json: { type: 'about:blank', title: 'Forbidden', status: 403 },
  });

export function bulkActionOf(
  number: number,
  rest: Partial<ContactBulkAction> = {},
): ContactBulkAction {
  return {
    id: idOf('bulk', number),
    name: null,
    action: 'add_tags',
    status: 'completed',
    requested: 3,
    done: 2,
    unchanged: 0,
    skipped: 1,
    actor: { kind: 'user', name: 'Dana Brooks', you: true },
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, number)).toISOString(),
    startedAt: new Date(Date.UTC(2026, 9, 1, 10, number)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 9, 1, 10, number, 30)).toISOString(),
    canCancel: false,
    drip: null,
    nextBatchAt: null,
    file: null,
    fileExpiresAt: null,
    failure: null,
    ...rest,
  };
}

export function bulkItemOf(
  number: number,
  name: string | null,
  outcome: ContactBulkItem['outcome'],
  reason: ContactBulkItem['reason'] = null,
): ContactBulkItem {
  return { contactId: idOf('con', number), name, outcome, reason };
}

export interface ContactBulkApi {
  actions: ContactBulkAction[];
  /** The contacts of each action, by the action's id. */
  contacts: Record<string, ContactBulkItem[]>;
  listed: URLSearchParams[];
  itemsListed: URLSearchParams[];
  cancelled: string[];
  /** The actions whose file a link was asked for. */
  linked: string[];
  /** Answer every read as the server does someone who may not manage contacts. */
  refused: boolean;
}

export async function fakeContactBulkApi(
  page: Page,
  seed: {
    readonly actions?: ContactBulkAction[];
    readonly contacts?: Record<string, ContactBulkItem[]>;
  } = {},
): Promise<ContactBulkApi> {
  const api: ContactBulkApi = {
    actions: seed.actions ?? [],
    contacts: seed.contacts ?? {},
    listed: [],
    itemsListed: [],
    cancelled: [],
    linked: [],
    refused: false,
  };
  await page.route(/\/api\/v1\/contacts\/bulk-actions(?:[/?].*)?$/, (route) => {
    const request = route.request();
    const query = new URL(request.url()).searchParams;
    const parts = segments(request);
    const last = parts.at(-1) ?? '';
    if (api.refused) return forbidden(route);
    if (request.method() === 'GET' && last === 'bulk-actions') {
      api.listed.push(query);
      const status = query.get('status');
      const action = query.get('action');
      const matching = api.actions
        .filter((each) => status === null || each.status === status)
        .filter((each) => action === null || each.action === action)
        .sort((one, other) => other.createdAt.localeCompare(one.createdAt));
      const limit = Number(query.get('limit') ?? '20');
      const start = query.has('after')
        ? matching.findIndex((each) => each.id === query.get('after')) + 1
        : 0;
      const items = matching.slice(start, start + limit);
      return route.fulfill({
        json: {
          items,
          next: start + limit < matching.length ? (items.at(-1)?.id ?? null) : null,
        },
      });
    }
    if (request.method() === 'GET' && last === 'items') {
      api.itemsListed.push(query);
      const id = parts.at(-2) ?? '';
      const outcome = query.get('outcome');
      const matching = (api.contacts[id] ?? []).filter((each) =>
        outcome === null
          ? true
          : outcome === 'pending'
            ? each.outcome === null
            : each.outcome === outcome,
      );
      const limit = Number(query.get('limit') ?? '20');
      const start = Number(query.get('after') ?? '0');
      return route.fulfill({
        json: {
          items: matching.slice(start, start + limit),
          next: start + limit < matching.length ? start + limit : null,
        },
      });
    }
    if (request.method() === 'POST' && last === 'file-link') {
      const id = parts.at(-2) ?? '';
      api.linked.push(id);
      return route.fulfill({
        status: 201,
        json: {
          url: `${new URL(request.url()).origin}/api/v1/files/file_export/content?signature=x`,
          expiresAt: '2026-10-11T08:15:00.000Z',
        },
      });
    }
    if (request.method() === 'POST' && last === 'cancel') {
      const id = parts.at(-2) ?? '';
      const at = api.actions.findIndex((each) => each.id === id);
      const old = api.actions[at];
      if (old === undefined) throw new Error('No such action.');
      api.cancelled.push(id);
      const stopped: ContactBulkAction = {
        ...old,
        status: 'cancelled',
        canCancel: false,
        finishedAt: '2026-10-11T08:00:00.000Z',
      };
      api.actions[at] = stopped;
      return route.fulfill({ json: stopped });
    }
    const found = api.actions.find((each) => each.id === last);
    if (found === undefined) throw new Error('No such action.');
    return route.fulfill({ json: found });
  });
  return api;
}
