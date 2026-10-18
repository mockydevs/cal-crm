// Stands in for the API behind Snippets, Trigger Links and Manual Actions:
// a small store for each, answering as the server does (search, filters, keyset pages,
// revisions), so a test reads what the page sent and what it then shows.
import type { Page, Request, Route } from '@playwright/test';
import {
  assignManualActionInput,
  closeManualActionInput,
  createSnippetFolderInput,
  createSnippetInput,
  createTriggerLinkInput,
  mergeKeyFromName,
  moveSnippetsInput,
  renameSnippetFolderInput,
  renderSnippetInput,
  triggerLinkMergeKey,
  updateSnippetInput,
  updateTriggerLinkInput,
  type ManualAction,
  type ManualActionType,
  type Snippet,
  type SnippetFolder,
  type TriggerLink,
  type TriggerLinkClick,
} from '@repo/contracts';
import { idOf } from './settings-fixtures';

const revisionOf = (number: number): string => number.toString(16).padStart(64, '0');

const conflict = (route: Route, detail: string): Promise<void> =>
  route.fulfill({
    status: 409,
    contentType: 'application/problem+json',
    json: { type: 'about:blank', title: 'Conflict', status: 409, detail },
  });

const forbidden = (route: Route): Promise<void> =>
  route.fulfill({
    status: 403,
    contentType: 'application/problem+json',
    json: { type: 'about:blank', title: 'Forbidden', status: 403 },
  });

const segments = (request: Request): string[] => new URL(request.url()).pathname.split('/');

/** A page of a keyset list: the rows after the cursor, and the cursor for the page after. */
function pageOf<Row extends { readonly id: string }>(
  rows: readonly Row[],
  query: URLSearchParams,
): { readonly items: Row[]; readonly next: string | null } {
  const limit = Number(query.get('limit') ?? '20');
  const start = query.has('after') ? rows.findIndex((row) => row.id === query.get('after')) + 1 : 0;
  const items = rows.slice(start, start + limit);
  return { items, next: start + limit < rows.length ? (items.at(-1)?.id ?? null) : null };
}

export function snippetFolderOf(number: number, name: string): SnippetFolder {
  return {
    id: idOf('snf', number),
    name,
    snippetCount: 0,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    revision: revisionOf(number),
  };
}

export function snippetOf(
  number: number,
  name: string,
  body: string,
  rest: Partial<Snippet> = {},
): Snippet {
  return {
    id: idOf('snip', number),
    type: 'text',
    name,
    subject: null,
    folderId: null,
    folderName: null,
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
    revision: revisionOf(number),
    body,
    mergeFields: [],
    ...rest,
  };
}

export interface SnippetsApi {
  snippets: Snippet[];
  folders: SnippetFolder[];
  /** The query of each list request, in order. */
  listed: URLSearchParams[];
  canManage: boolean;
  /** Answer the next save as if someone else had saved first. */
  staleNext: boolean;
  /** What a contact has for each merge field, by its path: a field not here has no value. */
  values: Record<string, string>;
  /** Each fill-in asked for, in order: which snippet, for which contact. */
  rendered: { readonly snippetId: string; readonly contactId: string }[];
}

/** Stands in for the snippets and their folders. */
export async function fakeSnippetsApi(
  page: Page,
  seed: { readonly snippets?: Snippet[]; readonly folders?: SnippetFolder[] } = {},
): Promise<SnippetsApi> {
  const api: SnippetsApi = {
    snippets: seed.snippets ?? [],
    folders: seed.folders ?? [],
    listed: [],
    canManage: true,
    staleNext: false,
    values: {},
    rendered: [],
  };
  let made = 500;
  const placed = (snippet: Snippet): Snippet => ({
    ...snippet,
    folderName: api.folders.find((folder) => folder.id === snippet.folderId)?.name ?? null,
  });
  const summary = (snippet: Snippet): Record<string, unknown> => {
    const { body, mergeFields: _fields, ...rest } = placed(snippet);
    return { ...rest, bodyPreview: body.replace(/\s+/g, ' ').slice(0, 200) };
  };

  await page.route(/\/api\/v1\/snippets(?:[/?].*)?$/, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const last = segments(request).at(-1) ?? '';
    if (request.method() === 'GET' && last === 'snippets') {
      const query = url.searchParams;
      api.listed.push(query);
      const q = (query.get('q') ?? '').toLowerCase();
      const folder = query.get('folder');
      const type = query.get('type');
      const matching = api.snippets
        .filter((snippet) => type === null || snippet.type === type)
        .filter((snippet) =>
          folder === null
            ? true
            : folder === 'none'
              ? snippet.folderId === null
              : snippet.folderId === folder,
        )
        .filter(
          (snippet) =>
            snippet.name.toLowerCase().includes(q) ||
            (snippet.subject ?? '').toLowerCase().includes(q) ||
            snippet.body.toLowerCase().includes(q),
        )
        .sort((one, other) => one.name.localeCompare(other.name));
      const { items, next } = pageOf(matching, query);
      return route.fulfill({
        json: {
          items: items.map(summary),
          total: matching.length,
          next,
          canManage: api.canManage,
        },
      });
    }
    if (request.method() === 'POST' && last === 'move') {
      const input = moveSnippetsInput.parse(request.postDataJSON());
      const moved = api.snippets.filter((snippet) => input.snippetIds.includes(snippet.id));
      for (const snippet of moved) snippet.folderId = input.folderId;
      return route.fulfill({ json: { items: moved.map(summary) } });
    }
    if (request.method() === 'POST' && last === 'render') {
      // Filled in for one contact, as the server does: every field has a value, or the
      // ones that have none are named and nothing is filled in.
      const snippet = api.snippets.find((each) => each.id === segments(request).at(-2));
      if (snippet === undefined)
        return route.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Not Found', status: 404 },
        });
      const { contactId } = renderSnippetInput.parse(request.postDataJSON());
      api.rendered.push({ snippetId: snippet.id, contactId });
      const field = /\{\{\s*([a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\}\}/g;
      const used = [
        ...new Set(
          [...`${snippet.subject ?? ''} ${snippet.body}`.matchAll(field)].map(
            (match) => match[1] ?? '',
          ),
        ),
      ];
      const missing = used.filter((path) => api.values[path] === undefined);
      if (missing.length > 0)
        return route.fulfill({ json: { ok: false, code: 'missing_values', fields: missing } });
      const fill = (text: string): string =>
        text.replace(field, (_token, path: string) => api.values[path] ?? '');
      return route.fulfill({
        json: {
          ok: true,
          type: snippet.type,
          subject: snippet.subject === null ? null : fill(snippet.subject),
          body: fill(snippet.body),
        },
      });
    }
    if (request.method() === 'POST') {
      if (!api.canManage) return forbidden(route);
      const input = createSnippetInput.parse(request.postDataJSON());
      made += 1;
      const snippet = snippetOf(made, input.name, input.body, {
        type: input.type,
        subject: input.subject,
        folderId: input.folderId,
      });
      api.snippets.push(snippet);
      return route.fulfill({ status: 201, json: placed(snippet) });
    }
    const at = api.snippets.findIndex((snippet) => snippet.id === last);
    const old = api.snippets[at];
    if (old === undefined)
      return route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: { type: 'about:blank', title: 'Not Found', status: 404 },
      });
    if (request.method() === 'GET') return route.fulfill({ json: placed(old) });
    if (request.method() === 'DELETE') {
      api.snippets.splice(at, 1);
      return route.fulfill({ status: 204 });
    }
    const input = updateSnippetInput.parse(request.postDataJSON());
    if (api.staleNext || input.revision !== old.revision) {
      api.staleNext = false;
      old.body = `${old.body} (theirs)`;
      old.revision = revisionOf(900 + at);
      return conflict(route, 'Someone else changed this snippet. Reload it and try again.');
    }
    made += 1;
    const saved: Snippet = {
      ...old,
      name: input.name,
      subject: input.subject,
      body: input.body,
      folderId: input.folderId,
      revision: revisionOf(made),
    };
    api.snippets[at] = saved;
    return route.fulfill({ json: placed(saved) });
  });

  await page.route(/\/api\/v1\/snippet-folders(?:\/[^/?]+)?$/, (route) => {
    const request = route.request();
    const last = segments(request).at(-1) ?? '';
    if (request.method() === 'GET')
      return route.fulfill({
        json: {
          items: api.folders
            .map((folder) => ({
              ...folder,
              snippetCount: api.snippets.filter((snippet) => snippet.folderId === folder.id).length,
            }))
            .sort((one, other) => one.name.localeCompare(other.name)),
          canManage: api.canManage,
        },
      });
    if (request.method() === 'POST') {
      const input = createSnippetFolderInput.parse(request.postDataJSON());
      made += 1;
      const folder = snippetFolderOf(made, input.name);
      api.folders.push(folder);
      return route.fulfill({ status: 201, json: folder });
    }
    const at = api.folders.findIndex((folder) => folder.id === last);
    const old = api.folders[at];
    if (old === undefined) throw new Error('No such folder.');
    if (request.method() === 'DELETE') {
      for (const snippet of api.snippets) if (snippet.folderId === old.id) snippet.folderId = null;
      api.folders.splice(at, 1);
      return route.fulfill({ status: 204 });
    }
    const input = renameSnippetFolderInput.parse(request.postDataJSON());
    made += 1;
    const saved = { ...old, name: input.name, revision: revisionOf(made) };
    api.folders[at] = saved;
    return route.fulfill({ json: saved });
  });
  return api;
}

export function linkOf(
  number: number,
  name: string,
  url: string,
  rest: Partial<TriggerLink> = {},
): TriggerLink {
  const key = rest.key ?? mergeKeyFromName(name, 'link');
  return {
    id: idOf('tlnk', number),
    name,
    url,
    key,
    mergeKey: triggerLinkMergeKey(key),
    clicks: 0,
    contacts: 0,
    lastClickedAt: null,
    createdAt: new Date(Date.UTC(2026, 8, 1, 10, number)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 10, number)).toISOString(),
    revision: revisionOf(number),
    ...rest,
  };
}

export function clickOf(
  number: number,
  contactName: string,
  clickedAt: string,
  clickNumber = number,
): TriggerLinkClick {
  return {
    id: `00000000-0000-4000-8000-${String(clickNumber).padStart(12, '0')}`,
    contact: { id: idOf('con', number), name: contactName, trashed: false },
    clickedAt,
  };
}

export interface TriggerLinksApi {
  links: TriggerLink[];
  /** The clicks of each link, by the link's id, newest first. */
  clicks: Record<string, TriggerLinkClick[]>;
  listed: URLSearchParams[];
  /** The query of each read of a link's clicks, in order. */
  analyzed: URLSearchParams[];
  canManage: boolean;
  staleNext: boolean;
}

/** Stands in for the trigger links and their clicks. */
export async function fakeTriggerLinksApi(
  page: Page,
  seed: {
    readonly links?: TriggerLink[];
    readonly clicks?: Record<string, TriggerLinkClick[]>;
  } = {},
): Promise<TriggerLinksApi> {
  const api: TriggerLinksApi = {
    links: seed.links ?? [],
    clicks: seed.clicks ?? {},
    listed: [],
    analyzed: [],
    canManage: true,
    staleNext: false,
  };
  let made = 500;

  await page.route(/\/api\/v1\/trigger-links(?:[/?].*)?$/, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const parts = segments(request);
    const last = parts.at(-1) ?? '';
    if (request.method() === 'GET' && last === 'trigger-links') {
      const query = url.searchParams;
      api.listed.push(query);
      const q = (query.get('q') ?? '').toLowerCase();
      const matching = api.links
        .filter(
          (link) =>
            link.name.toLowerCase().includes(q) ||
            link.key.includes(q) ||
            link.url.toLowerCase().includes(q),
        )
        .sort((one, other) => other.createdAt.localeCompare(one.createdAt));
      const { items, next } = pageOf(matching, query);
      return route.fulfill({
        json: { items, total: matching.length, next, canManage: api.canManage },
      });
    }
    if (request.method() === 'GET' && last === 'clicks') {
      const query = url.searchParams;
      api.analyzed.push(query);
      const from = query.get('from');
      const to = query.get('to');
      const matching = (api.clicks[parts.at(-2) ?? ''] ?? []).filter(
        (click) =>
          (from === null || click.clickedAt >= from) && (to === null || click.clickedAt < to),
      );
      const { items, next } = pageOf(matching, query);
      return route.fulfill({
        json: {
          items,
          clicks: matching.length,
          contacts: new Set(matching.map((click) => click.contact.id)).size,
          next,
        },
      });
    }
    if (request.method() === 'POST') {
      if (!api.canManage) return forbidden(route);
      const input = createTriggerLinkInput.parse(request.postDataJSON());
      made += 1;
      const link = linkOf(made, input.name, input.url, {
        createdAt: new Date(Date.UTC(2026, 9, 1, 10, made - 500)).toISOString(),
      });
      api.links.push(link);
      return route.fulfill({ status: 201, json: link });
    }
    const at = api.links.findIndex((link) => link.id === last);
    const old = api.links[at];
    if (old === undefined) throw new Error('No such link.');
    if (request.method() === 'GET') return route.fulfill({ json: old });
    if (request.method() === 'DELETE') {
      api.links.splice(at, 1);
      return route.fulfill({ status: 204 });
    }
    const body: unknown = request.postDataJSON();
    const checked = updateTriggerLinkInput.safeParse(body);
    if (!checked.success)
      return route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        json: {
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          errors: checked.error.issues.map((issue) => ({
            path: `/${issue.path.join('/')}`,
            code: issue.code,
            message: issue.message,
          })),
        },
      });
    const input = checked.data;
    if (api.staleNext || input.revision !== old.revision) {
      api.staleNext = false;
      old.url = `${old.url}/theirs`;
      old.revision = revisionOf(900 + at);
      return conflict(route, 'Someone else changed this link. Reload it and try again.');
    }
    made += 1;
    const saved: TriggerLink = {
      ...old,
      name: input.name,
      url: input.url,
      revision: revisionOf(made),
    };
    api.links[at] = saved;
    return route.fulfill({ json: saved });
  });
  return api;
}

export const workflows = {
  followUp: { id: idOf('aut', 10), name: 'New lead follow-up' },
  winBack: { id: idOf('aut', 11), name: 'Win back' },
} as const;

export const people = {
  dana: { id: idOf('mem', 1), name: 'Dana Brooks', you: true },
  eli: { id: idOf('mem', 2), name: 'Eli Frost', you: false },
} as const;

export function actionOf(
  number: number,
  type: ManualActionType,
  contactName: string,
  rest: Partial<ManualAction> = {},
): ManualAction {
  return {
    id: idOf('mact', number),
    type,
    status: 'pending',
    body: type === 'sms' ? `Hi ${contactName}, are you still looking?` : '',
    contact: {
      id: idOf('con', number),
      name: contactName,
      phone: `+1415555${String(number).padStart(4, '0')}`,
      trashed: false,
    },
    automation: { ...workflows.followUp },
    runId: idOf('arun', number),
    assignee: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, number)).toISOString(),
    closedAt: null,
    closedBy: null,
    revision: revisionOf(number),
    ...rest,
  };
}

export interface ManualActionsApi {
  actions: ManualAction[];
  listed: URLSearchParams[];
  canWork: boolean;
  canAssign: boolean;
  /** Answer every read of the queue as the server does someone with neither permission. */
  refused: boolean;
  staleNext: boolean;
}

/** Stands in for the manual actions queue, the workflows and the people it is filtered by. */
export async function fakeManualActionsApi(
  page: Page,
  seed: { readonly actions?: ManualAction[] } = {},
): Promise<ManualActionsApi> {
  const api: ManualActionsApi = {
    actions: seed.actions ?? [],
    listed: [],
    canWork: true,
    canAssign: true,
    refused: false,
    staleNext: false,
  };
  let made = 500;
  const person = (member: {
    id: string;
    name: string;
    you: boolean;
  }): ManualAction['assignee'] => ({
    membershipId: member.id,
    name: member.name,
    you: member.you,
  });

  await page.route(/\/api\/v1\/automations(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        canManage: false,
        items: Object.values(workflows).map((workflow) => ({
          ...workflow,
          description: '',
          status: 'active',
          draftVersion: 1,
          liveVersion: 1,
          lastRunAt: null,
          createdAt: '2026-09-01T10:00:00.000Z',
          updatedAt: '2026-09-01T10:00:00.000Z',
        })),
        nextCursor: null,
      },
    }),
  );
  await page.route(/\/api\/v1\/inbox\/assignees(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: Object.values(people), nextCursor: null } }),
  );

  await page.route(/\/api\/v1\/manual-actions(?:[/?].*)?$/, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const parts = segments(request);
    const last = parts.at(-1) ?? '';
    if (api.refused) return forbidden(route);
    if (request.method() === 'GET' && last === 'manual-actions') {
      const query = url.searchParams;
      api.listed.push(query);
      const status = query.get('status') ?? 'pending';
      const type = query.get('type');
      const automationId = query.get('automationId');
      const assignee = query.get('assignee') ?? 'anyone';
      const matching = api.actions
        .filter((action) => status === 'all' || action.status === status)
        .filter((action) => type === null || action.type === type)
        .filter((action) => automationId === null || action.automation.id === automationId)
        .filter((action) =>
          assignee === 'anyone'
            ? true
            : assignee === 'unassigned'
              ? action.assignee === null
              : assignee === 'me'
                ? action.assignee?.you === true
                : action.assignee?.membershipId === assignee,
        )
        .sort((one, other) => one.createdAt.localeCompare(other.createdAt));
      const { items, next } = pageOf(matching, query);
      return route.fulfill({
        json: {
          items,
          total: matching.length,
          next,
          canWork: api.canWork,
          canAssign: api.canAssign,
        },
      });
    }
    const id = request.method() === 'GET' ? last : (parts.at(-2) ?? '');
    const at = api.actions.findIndex((action) => action.id === id);
    const old = api.actions[at];
    if (old === undefined) throw new Error('No such action.');
    if (request.method() === 'GET') return route.fulfill({ json: old });
    const body: unknown = request.postDataJSON();
    const revision =
      last === 'assignee'
        ? assignManualActionInput.parse(body).revision
        : closeManualActionInput.parse(body).revision;
    if (api.staleNext || revision !== old.revision) {
      api.staleNext = false;
      old.assignee = person(people.eli);
      old.revision = revisionOf(900 + at);
      return conflict(route, 'Someone else changed this action. Reload it and try again.');
    }
    made += 1;
    let saved: ManualAction;
    if (last === 'assignee') {
      const { assignee } = assignManualActionInput.parse(body);
      const member =
        assignee === 'me'
          ? people.dana
          : Object.values(people).find((each) => each.id === assignee);
      saved = {
        ...old,
        assignee: member === undefined ? null : person(member),
        revision: revisionOf(made),
      };
    } else {
      saved = {
        ...old,
        status: last === 'complete' ? 'completed' : 'skipped',
        closedAt: '2026-10-11T08:00:00.000Z',
        closedBy: person(people.dana),
        revision: revisionOf(made),
      };
    }
    api.actions[at] = saved;
    return route.fulfill({ json: saved });
  });
  return api;
}
