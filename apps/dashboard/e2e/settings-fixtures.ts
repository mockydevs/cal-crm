// Stands in for the API behind Settings → Custom Fields, Custom Values and Import Data: a
// small store for each, answering as the server does (filters, keyset pages, revisions), so
// a test reads what the page sent and what it then shows.
import type { Page, Request, Route } from '@playwright/test';
import {
  createCustomValueFolderInput,
  createCustomValueInput,
  createFieldFolderInput,
  createFieldInput,
  customValueMergeKey,
  fieldMergeKey,
  mergeKeyFromName,
  moveCustomValuesInput,
  moveFieldsInput,
  renameCustomValueFolderInput,
  renameFieldFolderInput,
  updateCustomValueInput,
  updateFieldInput,
  type CustomField,
  type CustomValue,
  type CustomValueFolder,
  type FieldFolder,
  type ImportJob,
} from '@repo/contracts';

/** An id the contracts accept: each wraps a UUIDv7. */
export const idOf = (prefix: string, number: number): string =>
  `${prefix}_01k8e2wzr0e008000000000${String(number).padStart(3, '0')}`;

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

const lastSegment = (request: Request): string =>
  new URL(request.url()).pathname.split('/').at(-1) ?? '';

export const systemFolders = {
  contact: idOf('ffld', 1),
  deal: idOf('ffld', 2),
} as const;

export function folderOf(
  number: number,
  name: string,
  objectKey: string,
  system = false,
): FieldFolder {
  return {
    id: idOf('ffld', number),
    objectKey,
    name,
    system,
    position: number,
    fieldCount: 0,
    createdAt: '2026-09-01T10:00:00.000Z',
    revision: revisionOf(number),
  };
}

export function fieldOf(
  number: number,
  label: string,
  rest: Partial<CustomField> = {},
): CustomField {
  const objectKey = rest.objectKey ?? 'contact';
  const key = rest.key ?? mergeKeyFromName(label, 'field');
  return {
    id: idOf('fld', number),
    objectKey,
    key,
    label,
    description: `What ${label} means.`,
    valueType: 'text',
    currency: null,
    options: [],
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    revision: revisionOf(number),
    folderId: objectKey === 'deal' ? systemFolders.deal : systemFolders.contact,
    folderName: 'Additional Info',
    placeholder: '',
    mergeKey: fieldMergeKey(objectKey, key),
    // Later numbers are newer, a minute apart; all of them long before any test runs.
    createdAt: new Date(Date.UTC(2024, 8, 1, 10, number)).toISOString(),
    source: 'user',
    ...rest,
  };
}

export interface FieldsApi {
  readonly fields: CustomField[];
  readonly folders: FieldFolder[];
  /** The query of every read of the field list, in order. */
  readonly listed: URLSearchParams[];
  canManage: boolean;
  /** Answers the next rename of a folder, or save of a field, as one made on a stale revision. */
  staleNext: boolean;
}

/** Stands in for the fields, their folders and the paged list of both objects. */
export async function fakeFieldsApi(
  page: Page,
  seed: { readonly fields?: CustomField[]; readonly folders?: FieldFolder[] } = {},
): Promise<FieldsApi> {
  const api: FieldsApi = {
    fields: seed.fields ?? [],
    folders: seed.folders ?? [
      folderOf(1, 'Additional Info', 'contact', true),
      folderOf(2, 'Additional Info', 'deal', true),
    ],
    listed: [],
    canManage: true,
    staleNext: false,
  };
  let made = 500;
  const objects = [
    { key: 'contact', label: 'Contact' },
    { key: 'deal', label: 'Opportunity' },
  ];
  const counted = (): FieldFolder[] =>
    api.folders.map((folder) => ({
      ...folder,
      fieldCount: api.fields.filter((field) => field.folderId === folder.id && !field.archived)
        .length,
    }));
  const folderName = (id: string): string =>
    api.folders.find((folder) => folder.id === id)?.name ?? '';

  await page.route(/\/api\/v1\/custom-fields(?:\?.*)?$/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    api.listed.push(query);
    const archived = query.get('archived') ?? 'exclude';
    const q = (query.get('q') ?? '').toLowerCase();
    const matching = api.fields
      .filter((field) => !query.has('objectKey') || field.objectKey === query.get('objectKey'))
      .filter((field) => !query.has('valueType') || field.valueType === query.get('valueType'))
      .filter((field) => !query.has('source') || field.source === query.get('source'))
      .filter((field) => field.createdAt >= (query.get('createdFrom') ?? ''))
      .filter((field) =>
        archived === 'include' ? true : archived === 'only' ? field.archived : !field.archived,
      )
      .filter((field) => field.label.toLowerCase().includes(q) || field.key.includes(q))
      .sort((one, other) =>
        query.get('sort') === 'created_asc'
          ? one.createdAt.localeCompare(other.createdAt)
          : other.createdAt.localeCompare(one.createdAt),
      );
    const limit = Number(query.get('limit') ?? '20');
    const start = query.has('after')
      ? matching.findIndex((field) => field.id === query.get('after')) + 1
      : 0;
    const items = matching.slice(start, start + limit);
    return route.fulfill({
      json: {
        items: items.map((field) => ({ ...field, folderName: folderName(field.folderId) })),
        total: matching.length,
        next: start + limit < matching.length ? (items.at(-1)?.id ?? null) : null,
        objects: objects.map((object) => ({
          ...object,
          fields: api.fields.filter((field) => field.objectKey === object.key && !field.archived)
            .length,
          folders: api.folders.filter((folder) => folder.objectKey === object.key).length,
        })),
        canManage: api.canManage,
      },
    });
  });

  await page.route(/\/api\/v1\/fields(?:\/[^/?]+)?$/, (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({ json: { items: api.fields, objects, canManage: api.canManage } });
    if (request.method() === 'POST') {
      const input = createFieldInput.parse(request.postDataJSON());
      made += 1;
      const field = fieldOf(made, input.label, {
        ...input,
        folderId:
          input.folderId ??
          (input.objectKey === 'deal' ? systemFolders.deal : systemFolders.contact),
        placeholder: input.placeholder ?? '',
        createdAt: new Date(Date.UTC(2024, 9, 1, 10, made - 500)).toISOString(),
      });
      api.fields.push(field);
      return route.fulfill({ status: 201, json: field });
    }
    const input = updateFieldInput.parse(request.postDataJSON());
    const at = api.fields.findIndex((field) => field.id === lastSegment(request));
    const old = api.fields[at];
    if (old === undefined) throw new Error('No such field.');
    if (api.staleNext || input.revision !== old.revision) {
      api.staleNext = false;
      old.label = `${old.label} (theirs)`;
      old.revision = revisionOf(900 + at);
      return conflict(route, 'Someone else changed this field. Reload it and try again.');
    }
    made += 1;
    const saved: CustomField = {
      ...old,
      ...input,
      folderId: input.folderId ?? old.folderId,
      placeholder: input.placeholder ?? old.placeholder,
      revision: revisionOf(made),
    };
    api.fields[at] = saved;
    return route.fulfill({ json: saved });
  });

  await page.route(/\/api\/v1\/field-folders(?:[/?].*)?$/, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET')
      return route.fulfill({ json: { items: counted(), canManage: api.canManage } });
    if (request.method() === 'POST' && path.endsWith('/fields')) {
      const { fieldIds } = moveFieldsInput.parse(request.postDataJSON());
      const folderId = path.split('/').at(-2) ?? '';
      for (const field of api.fields) if (fieldIds.includes(field.id)) field.folderId = folderId;
      const folder = counted().find((each) => each.id === folderId);
      if (folder === undefined) throw new Error('No such folder.');
      return route.fulfill({ json: folder });
    }
    if (request.method() === 'POST') {
      const input = createFieldFolderInput.parse(request.postDataJSON());
      made += 1;
      const folder = folderOf(made, input.name, input.objectKey);
      api.folders.push(folder);
      return route.fulfill({ status: 201, json: folder });
    }
    const at = api.folders.findIndex((folder) => folder.id === lastSegment(request));
    const old = api.folders[at];
    if (old === undefined) throw new Error('No such folder.');
    if (request.method() === 'DELETE') {
      const system = api.folders.find(
        (folder) => folder.system && folder.objectKey === old.objectKey,
      );
      for (const field of api.fields)
        if (field.folderId === old.id && system !== undefined) field.folderId = system.id;
      api.folders.splice(at, 1);
      return route.fulfill({ status: 204 });
    }
    const input = renameFieldFolderInput.parse(request.postDataJSON());
    if (api.staleNext || input.revision !== old.revision) {
      api.staleNext = false;
      old.name = `${old.name} (theirs)`;
      old.revision = revisionOf(900 + at);
      return conflict(route, 'Someone else changed this folder. Reload it and try again.');
    }
    made += 1;
    const saved = { ...old, name: input.name, revision: revisionOf(made) };
    api.folders[at] = saved;
    return route.fulfill({ json: saved });
  });
  return api;
}

export function valueOf(
  number: number,
  name: string,
  value: string,
  folder: CustomValueFolder | null = null,
): CustomValue {
  const key = mergeKeyFromName(name, 'value');
  return {
    id: idOf('cval', number),
    key,
    mergeKey: customValueMergeKey(key),
    name,
    value,
    folderId: folder?.id ?? null,
    folderName: folder?.name ?? null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    revision: revisionOf(number),
  };
}

export function valueFolderOf(number: number, name: string): CustomValueFolder {
  return {
    id: idOf('cvf', number),
    name,
    valueCount: 0,
    createdAt: '2026-09-01T10:00:00.000Z',
    revision: revisionOf(number),
  };
}

export interface ValuesApi {
  readonly values: CustomValue[];
  readonly folders: CustomValueFolder[];
  readonly listed: URLSearchParams[];
  canManage: boolean;
  staleNext: boolean;
}

/** Stands in for the custom values and their folders. */
export async function fakeValuesApi(
  page: Page,
  seed: { readonly values?: CustomValue[]; readonly folders?: CustomValueFolder[] } = {},
): Promise<ValuesApi> {
  const api: ValuesApi = {
    values: seed.values ?? [],
    folders: seed.folders ?? [],
    listed: [],
    canManage: true,
    staleNext: false,
  };
  let made = 500;
  const placed = (value: CustomValue): CustomValue => ({
    ...value,
    folderName: api.folders.find((folder) => folder.id === value.folderId)?.name ?? null,
  });

  await page.route(/\/api\/v1\/custom-values(?:[/?].*)?$/, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      const query = url.searchParams;
      api.listed.push(query);
      const q = (query.get('q') ?? '').toLowerCase();
      const folder = query.get('folder');
      const matching = api.values
        .filter((value) =>
          folder === null
            ? true
            : folder === 'none'
              ? value.folderId === null
              : value.folderId === folder,
        )
        .filter(
          (value) =>
            value.name.toLowerCase().includes(q) ||
            value.key.includes(q) ||
            value.value.toLowerCase().includes(q),
        )
        .sort((one, other) => one.name.localeCompare(other.name));
      const limit = Number(query.get('limit') ?? '20');
      const start = query.has('after')
        ? matching.findIndex((value) => value.id === query.get('after')) + 1
        : 0;
      const items = matching.slice(start, start + limit);
      return route.fulfill({
        json: {
          items: items.map(placed),
          total: matching.length,
          next: start + limit < matching.length ? (items.at(-1)?.id ?? null) : null,
          canManage: api.canManage,
        },
      });
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/move')) {
      const input = moveCustomValuesInput.parse(request.postDataJSON());
      const moved = api.values.filter((value) => input.valueIds.includes(value.id));
      for (const value of moved) value.folderId = input.folderId;
      return route.fulfill({ json: { items: moved.map(placed) } });
    }
    if (request.method() === 'POST') {
      const input = createCustomValueInput.parse(request.postDataJSON());
      made += 1;
      const value: CustomValue = {
        ...valueOf(made, input.name, input.value),
        folderId: input.folderId,
      };
      api.values.push(value);
      return route.fulfill({ status: 201, json: placed(value) });
    }
    const at = api.values.findIndex((value) => value.id === lastSegment(request));
    const old = api.values[at];
    if (old === undefined) throw new Error('No such value.');
    if (request.method() === 'DELETE') {
      api.values.splice(at, 1);
      return route.fulfill({ status: 204 });
    }
    const input = updateCustomValueInput.parse(request.postDataJSON());
    if (api.staleNext || input.revision !== old.revision) {
      api.staleNext = false;
      old.value = `${old.value} (theirs)`;
      old.revision = revisionOf(900 + at);
      return conflict(route, 'Someone else changed this value. Reload it and try again.');
    }
    made += 1;
    const saved: CustomValue = {
      ...old,
      name: input.name,
      value: input.value,
      folderId: input.folderId,
      revision: revisionOf(made),
    };
    api.values[at] = saved;
    return route.fulfill({ json: placed(saved) });
  });

  await page.route(/\/api\/v1\/custom-value-folders(?:\/[^/?]+)?$/, (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({
        json: {
          items: api.folders
            .map((folder) => ({
              ...folder,
              valueCount: api.values.filter((value) => value.folderId === folder.id).length,
            }))
            .sort((one, other) => one.name.localeCompare(other.name)),
          canManage: api.canManage,
        },
      });
    if (request.method() === 'POST') {
      const input = createCustomValueFolderInput.parse(request.postDataJSON());
      made += 1;
      const folder = valueFolderOf(made, input.name);
      api.folders.push(folder);
      return route.fulfill({ status: 201, json: folder });
    }
    const at = api.folders.findIndex((folder) => folder.id === lastSegment(request));
    const old = api.folders[at];
    if (old === undefined) throw new Error('No such folder.');
    if (request.method() === 'DELETE') {
      for (const value of api.values) if (value.folderId === old.id) value.folderId = null;
      api.folders.splice(at, 1);
      return route.fulfill({ status: 204 });
    }
    const input = renameCustomValueFolderInput.parse(request.postDataJSON());
    made += 1;
    const saved = { ...old, name: input.name, revision: revisionOf(made) };
    api.folders[at] = saved;
    return route.fulfill({ json: saved });
  });
  return api;
}

export function importOf(number: number, rest: Partial<ImportJob> = {}): ImportJob {
  return {
    id: idOf('imp', number),
    source: 'csv',
    objects: ['contact'],
    status: 'completed',
    fileName: `contacts-${String(number)}.csv`,
    mode: 'create_and_update',
    mapping: [],
    tagIds: [],
    counts: { found: 3, processed: 3, created: 2, updated: 1, skipped: 0, failed: 0 },
    hasErrorFile: false,
    error: null,
    cancelRequested: false,
    startedBy: { kind: 'user', name: 'Dana Brooks', you: true },
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, number)).toISOString(),
    startedAt: new Date(Date.UTC(2026, 9, 1, 10, number, 1)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 9, 1, 10, number, 30)).toISOString(),
    canCancel: false,
    ...rest,
  };
}

export interface ImportsApi {
  readonly imports: ImportJob[];
  readonly listed: URLSearchParams[];
  /** False for someone without the permission to import contacts: every answer is 403. */
  allowed: boolean;
}

/** Stands in for the history of imports. The steps of an import are routed by their test. */
export async function fakeImportsApi(page: Page, imports: ImportJob[] = []): Promise<ImportsApi> {
  const api: ImportsApi = { imports, listed: [], allowed: true };
  await page.route(/\/api\/v1\/imports(?:\?.*)?$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (!api.allowed) return forbidden(route);
    const query = new URL(route.request().url()).searchParams;
    api.listed.push(query);
    const matching = api.imports
      .filter((job) => !query.has('status') || job.status === query.get('status'))
      .sort((one, other) => other.createdAt.localeCompare(one.createdAt));
    const limit = Number(query.get('limit') ?? '20');
    const start = query.has('after')
      ? matching.findIndex((job) => job.id === query.get('after')) + 1
      : 0;
    const items = matching.slice(start, start + limit);
    return route.fulfill({
      json: {
        items,
        total: matching.length,
        next: start + limit < matching.length ? (items.at(-1)?.id ?? null) : null,
      },
    });
  });
  return api;
}
