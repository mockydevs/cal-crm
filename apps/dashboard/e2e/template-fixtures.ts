// A stand-in for the message template API, holding templates in memory and
// answering as the server does: names unique among live templates, a stale revision
// refused with 409, archive and restore, delete to the trash (archive and delete refused
// while a workflow sends it), duplicate, bulk actions, and the list's filters, orders and counts.
// What the real server enforces is tested against Postgres in packages/modules/messaging.
import type { Page, Route } from '@playwright/test';
import {
  bulkMessageTemplatesInput,
  duplicateMessageTemplateInput,
  emailPreviewLine,
  mergeTokens,
  messageTemplateInput,
  messageTemplateFolderList,
  messageTemplateRevisionInput,
  renderEmailPreviewInput,
  templateContentOf,
  updateMessageTemplateInput,
  type BulkMessageTemplatesResult,
  type MessageTemplate,
  type MessageTemplateList,
  type RenderedEmailPreview,
  type TemplateWorkflowActionList,
} from '@repo/contracts';
import { harbor } from './session';

export const templateId = (suffix: string): string => `tmpl_01h455vb4pex5vsknk084sn0${suffix}`;

/** The text a stand-in writes from formatted content: its tags taken off, as words. */
const textOfHtml = (html: string): string =>
  html
    .replace(/<\/(?:p|h[1-6]|li|div)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();

/** A template; give `content` for a formatted one, `body` for plain text. */
export function templateOf(patch: Partial<MessageTemplate> = {}): MessageTemplate {
  const body =
    patch.content?.text ?? patch.body ?? 'Hi {{contact.firstName}},\nHere is our pricing guide.';
  const content = patch.content ?? { format: 'text' as const, text: body };
  const text = {
    subject: patch.subject ?? 'Your guide, {{contact.firstName}}',
    body,
  };
  return {
    id: templateId('2q'),
    name: 'Pricing guide',
    mergeFields: mergeTokens({
      ...text,
      html: content.format === 'html' ? content.html : null,
      preheader: patch.preheader ?? null,
    }),
    unfillableFields: [],
    createdAt: '2026-10-09T09:00:00.000Z',
    updatedAt: '2026-10-09T09:30:00.000Z',
    archivedAt: null,
    revision: 'a'.repeat(64),
    canManage: true,
    usedBy: [],
    preheader: null,
    folder: null,
    ...patch,
    ...text,
    content,
    format: content.format,
    preview: emailPreviewLine(body),
  };
}

/** What a template input says its message is, stored as the server stores it. */
function storedContent(input: {
  readonly body?: string | undefined;
  readonly content?: Parameters<typeof templateContentOf>[0]['content'];
}): MessageTemplate['content'] {
  const given = templateContentOf(input);
  if ('code' in given) throw new Error(given.code);
  return given.format === 'text'
    ? given
    : {
        format: 'html',
        html: given.html,
        text: given.text === undefined || given.text === '' ? textOfHtml(given.html) : given.text,
      };
}

export interface TemplateServer {
  /** The workflow actions that use each template, by its id: what the inventory answers. */
  readonly uses: Record<string, TemplateWorkflowActionList['items']>;
  /** Each preview the page asked for, in order. */
  readonly previews: unknown[];
  readonly templates: MessageTemplate[];
  /** Each change the page asked for, in order. */
  readonly requests: { method: string; path: string; body: unknown }[];
  /** Saves another person's edit behind the page's back, moving the revision. */
  editElsewhere(id: string, patch: Partial<MessageTemplate>): void;
}

const problem = (
  route: Route,
  status: number,
  detail: string,
  errors?: readonly { path: string; code: string; message: string }[],
): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    json: { type: 'about:blank', title: 'Refused', status, detail, ...(errors ? { errors } : {}) },
  });

export async function templateServer(
  page: Page,
  initial: readonly MessageTemplate[],
  canManage = true,
): Promise<TemplateServer> {
  const templates = initial.map((template) => ({ ...template, canManage }));
  const requests: TemplateServer['requests'] = [];
  const uses: TemplateServer['uses'] = {};
  const previews: unknown[] = [];
  let saves = 0;
  const trashed = (each: MessageTemplate): boolean =>
    each.deletedAt !== null && each.deletedAt !== undefined;
  await page.route('**/api/v1/message-template-folders', (route) =>
    route.fulfill({
      json: messageTemplateFolderList.parse({
        canManage,
        items: [],
        counts: {
          all: templates.filter((each) => each.archivedAt === null).length,
          unfiled: templates.filter((each) => each.archivedAt === null && each.folder === null)
            .length,
          archived: templates.filter((each) => each.archivedAt !== null && !trashed(each)).length,
          deleted: templates.filter(trashed).length,
        },
      }),
    }),
  );
  /** How many workflows use a template: the distinct workflows of its inventory. */
  const useCount = (id: string): number =>
    new Set((uses[id] ?? []).map((action) => action.automation.id)).size;
  const nextRevision = (): string => {
    saves += 1;
    return saves.toString(16).padStart(64, 'b');
  };
  const taken = (name: string, except?: string): boolean =>
    templates.some(
      (each) =>
        each.id !== except &&
        each.archivedAt === null &&
        each.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
  const nameTaken = (route: Route, name: string, path: string): Promise<void> =>
    problem(route, 422, 'Invalid', [
      {
        path,
        code: 'taken',
        message: `A template is already named "${name}". Choose another name.`,
      },
    ]);

  // The business's own fields: one contact field, and a deal field that must not be offered.
  await page.route('**/api/v1/fields', (route) =>
    route.fulfill({
      json: {
        canManage: false,
        objects: [
          { key: 'contact', label: 'Contacts' },
          { key: 'deal', label: 'Deals' },
        ],
        items: [
          {
            id: 'fld_01h455vb4pex5vsknk084sn02q',
            objectKey: 'contact',
            key: 'services',
            label: 'Services',
            description: 'What they asked about.',
            valueType: 'text',
            currency: null,
            options: [],
            aiFillSources: [],
            aiOverwrite: 'ask',
            archived: false,
            revision: 'a'.repeat(64),
          },
          {
            id: 'fld_01h455vb4pex5vsknk084sn02r',
            objectKey: 'deal',
            key: 'budget',
            label: 'Budget',
            description: 'What they can spend.',
            valueType: 'text',
            currency: null,
            options: [],
            aiFillSources: [],
            aiOverwrite: 'ask',
            archived: false,
            revision: 'a'.repeat(64),
          },
        ],
      },
    }),
  );

  await page.route(/\/api\/v1\/message-templates(?:[/?].*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const [, id, action] =
      /\/message-templates(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname) ?? [];
    if (request.headers()['business-id'] !== harbor.id) {
      await problem(route, 400, 'No business was named.');
      return;
    }
    // A preview: the merge fields a sample contact has are filled in, the rest stay as
    // written and are listed, and a workflow email's footer follows the message.
    if (id === 'render' && method === 'POST') {
      const input = renderEmailPreviewInput.parse(request.postDataJSON());
      previews.push(input);
      const template = templates.find((each) => each.id === input.template);
      const content = input.content ?? template?.content ?? { format: 'text' as const, text: '' };
      const values: Record<string, string> =
        input.contact === undefined
          ? {}
          : { 'contact.firstName': 'Ada', 'contact.name': 'Ada Lovelace' };
      const missing = new Set<string>();
      const fill = (text: string): string =>
        text.replace(/\{\{\s*([a-zA-Z_.]+)\s*\}\}/g, (token, path: string) => {
          const value = values[path];
          if (value === undefined) missing.add(path);
          return value ?? token;
        });
      const subject =
        input.subject === undefined || input.subject === ''
          ? (template?.subject ?? '')
          : input.subject;
      const footer = '<p style="font-size:12px;color:#666666">Unsubscribe · 12 Harbor Road</p>';
      const answer: RenderedEmailPreview = {
        subject: fill(subject),
        preheader:
          input.preheader === undefined ? (template?.preheader ?? null) : fill(input.preheader),
        html: content.format === 'html' ? `${fill(content.html)}${footer}` : null,
        text: fill(
          content.format === 'html' ? (content.text ?? textOfHtml(content.html)) : content.text,
        ),
        mergeFields: mergeTokens({ subject, body: content.text ?? '' }),
        missingFields: [],
        subjectLineBreak: [],
      };
      await route.fulfill({ json: { ...answer, missingFields: [...missing] } });
      return;
    }
    if (action === 'workflow-actions' && method === 'GET') {
      const list: TemplateWorkflowActionList = { items: uses[id ?? ''] ?? [], nextCursor: null };
      await route.fulfill({ json: list });
      return;
    }
    if (method !== 'GET')
      requests.push({ method, path: url.pathname, body: request.postDataJSON() as unknown });

    if (id === undefined && method === 'GET') {
      const archived = url.searchParams.get('archived') ?? 'exclude';
      const deleted = url.searchParams.get('deleted') ?? 'exclude';
      const format = url.searchParams.get('format');
      const used = url.searchParams.get('used');
      const sort = url.searchParams.get('sort') ?? 'name';
      const folder = url.searchParams.get('folder');
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const after = url.searchParams.get('after');
      const byName = (left: MessageTemplate, right: MessageTemplate): number =>
        left.name.toLowerCase().localeCompare(right.name.toLowerCase());
      const matching = templates
        // The trash is its own place; Archived and the library never show what is in it.
        .filter((each) =>
          deleted === 'only'
            ? trashed(each)
            : !trashed(each) &&
              (archived === 'include'
                ? true
                : (each.archivedAt !== null) === (archived === 'only')),
        )
        .filter((each) => folder === null || each.folder?.id === folder)
        .filter((each) => format === null || each.format === format)
        .filter((each) => used === null || useCount(each.id) > 0 === (used === 'yes'))
        // As the server: the name or the subject holds what was typed.
        .filter(
          (each) =>
            q === '' ||
            each.name.toLowerCase().includes(q) ||
            each.subject.toLowerCase().includes(q),
        )
        .sort((left, right) =>
          sort === 'updated'
            ? right.updatedAt.localeCompare(left.updatedAt) || byName(left, right)
            : sort === 'uses'
              ? useCount(right.id) - useCount(left.id) || byName(left, right)
              : byName(left, right),
        );
      const from = after === null ? 0 : matching.findIndex((each) => each.id === after) + 1;
      const page = matching.slice(from, from + limit);
      const list: MessageTemplateList = {
        canManage,
        items: page.map(
          ({
            body: _body,
            content: _content,
            mergeFields: _fields,
            unfillableFields: _unfillable,
            canManage: _may,
            usedBy: _uses,
            ...summary
          }) => ({ ...summary, workflowUses: useCount(summary.id) }),
        ),
        nextCursor: from + limit < matching.length ? (page.at(-1)?.id ?? null) : null,
        total: matching.length,
      };
      await route.fulfill({ json: list });
      return;
    }
    // Many at once: each one done or skipped with its reason, in the order named.
    if (id === 'bulk' && method === 'POST') {
      const input = bulkMessageTemplatesInput.parse(request.postDataJSON());
      const results: BulkMessageTemplatesResult['results'] = input.ids.map((each) => {
        const at = templates.findIndex((template) => template.id === each);
        const current = templates[at];
        if (current === undefined)
          return {
            id: each,
            outcome: 'skipped',
            reason: { code: 'not_found', message: 'No such template here.' },
          };
        const sending = current.usedBy ?? [];
        if ((input.action === 'delete' || input.action === 'archive') && sending.length > 0)
          return {
            id: each,
            outcome: 'skipped',
            reason: {
              code: 'in_use',
              message: `${sending.map((use) => `“${use.name}”`).join(', ')} send it.`,
            },
          };
        const stamp = '2026-10-09T12:00:00.000Z';
        const next: MessageTemplate =
          input.action === 'move'
            ? {
                ...current,
                folder:
                  input.folderId === null
                    ? null
                    : { id: input.folderId, name: 'Folder', path: ['Folder'] },
              }
            : input.action === 'archive'
              ? { ...current, archivedAt: current.archivedAt ?? stamp }
              : input.action === 'delete'
                ? {
                    ...current,
                    archivedAt: current.archivedAt ?? stamp,
                    deletedAt: current.deletedAt ?? stamp,
                  }
                : { ...current, archivedAt: null, deletedAt: null };
        templates[at] = { ...next, revision: nextRevision() };
        return { id: each, outcome: 'done', reason: null };
      });
      const count = (outcome: string): number =>
        results.filter((each) => each.outcome === outcome).length;
      const answer: BulkMessageTemplatesResult = {
        action: input.action,
        results,
        done: count('done'),
        unchanged: count('unchanged'),
        skipped: count('skipped'),
      };
      await route.fulfill({ json: answer });
      return;
    }
    if (id === undefined && method === 'POST') {
      const input = messageTemplateInput.parse(request.postDataJSON());
      if (taken(input.name)) {
        await nameTaken(route, input.name, '/name');
        return;
      }
      const created = templateOf({
        name: input.name,
        subject: input.subject,
        content: storedContent(input),
        preheader: input.preheader ?? null,
        // Two characters, whatever the library holds: with up to nine templates the
        // same ids as before (30 to 39), and letters after that.
        id: templateId(`3${'0123456789abcdefghjkmnpqrstvwxyz'[templates.length % 32] ?? '0'}`),
        revision: nextRevision(),
        canManage,
      });
      templates.push(created);
      await route.fulfill({ status: 201, json: created });
      return;
    }
    const at = templates.findIndex((each) => each.id === id);
    const current = templates[at];
    if (current === undefined) {
      await problem(route, 404, `Template ${id ?? ''} was not found.`);
      return;
    }
    if (method === 'GET') {
      await route.fulfill({ json: current });
      return;
    }
    const stale = (revision: string): boolean => revision !== current.revision;
    const conflict = (): Promise<void> =>
      problem(
        route,
        409,
        'This template changed after you opened it. Read it again before saving, archiving or restoring it.',
      );
    if (action === 'duplicate' && method === 'POST') {
      const input = duplicateMessageTemplateInput.parse(request.postDataJSON());
      if (trashed(current))
        return problem(route, 409, 'This template is in the trash. Restore it first.');
      const base = `Copy of ${current.name}`;
      let name = input.name ?? base;
      for (let number = 2; input.name === undefined && taken(name); number += 1)
        name = `${base} (${String(number)})`;
      const copy = templateOf({
        ...current,
        id: templateId(`4${'0123456789abcdefghjkmnpqrstvwxyz'[templates.length % 32] ?? '0'}`),
        name,
        archivedAt: null,
        deletedAt: null,
        usedBy: [],
        revision: nextRevision(),
      });
      templates.push(copy);
      await route.fulfill({ status: 201, json: copy });
      return;
    }
    if (method === 'DELETE') {
      const { revision } = messageTemplateRevisionInput.parse(request.postDataJSON());
      if (stale(revision)) return conflict();
      const sending = current.usedBy ?? [];
      if (sending.length > 0)
        return problem(
          route,
          409,
          `${sending.map((use) => `“${use.name}”`).join(', ')} send this template. Take it out of their Send email step, then delete it.`,
        );
      templates[at] = {
        ...current,
        archivedAt: current.archivedAt ?? '2026-10-09T12:00:00.000Z',
        deletedAt: '2026-10-09T12:00:00.000Z',
        revision: nextRevision(),
      };
      await route.fulfill({ json: templates[at] });
      return;
    }
    if (method === 'PUT') {
      const { revision, ...input } = updateMessageTemplateInput.parse(request.postDataJSON());
      if (stale(revision)) return conflict();
      if (taken(input.name, current.id)) return nameTaken(route, input.name, '/name');
      templates[at] = templateOf({
        ...current,
        name: input.name,
        subject: input.subject,
        content: storedContent(input),
        preheader: input.preheader ?? null,
        revision: nextRevision(),
      });
    } else {
      const { revision } = messageTemplateRevisionInput.parse(request.postDataJSON());
      if (stale(revision)) return conflict();
      if (action === 'restore' && taken(current.name, current.id))
        return nameTaken(route, current.name, '');
      const sending = current.usedBy ?? [];
      if (action === 'archive' && sending.length > 0)
        return problem(
          route,
          409,
          `${sending.map((use) => `“${use.name}”`).join(', ')} send this template. Take it out of their Send email step, then archive it.`,
        );
      templates[at] = {
        ...current,
        archivedAt: action === 'archive' ? '2026-10-09T12:00:00.000Z' : null,
        // Restoring brings a template back from the trash as well.
        deletedAt: action === 'archive' ? (current.deletedAt ?? null) : null,
        revision: nextRevision(),
      };
    }
    await route.fulfill({ json: templates[at] });
  });

  return {
    templates,
    requests,
    uses,
    previews,
    editElsewhere(id, patch) {
      const at = templates.findIndex((each) => each.id === id);
      const current = templates[at];
      if (current === undefined) throw new Error(`No template ${id}.`);
      templates[at] = { ...current, ...patch, revision: nextRevision() };
    },
  };
}
