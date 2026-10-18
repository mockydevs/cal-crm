import { describe, expect, it } from 'vitest';

import { endpoints } from './api.js';
import type { Endpoint } from './endpoints.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';
import {
  bulkMessageTemplates,
  bulkMessageTemplatesResult,
  contactMergeFields,
  deleteMessageTemplate,
  duplicateMessageTemplate,
  listMessageTemplates,
  MESSAGE_TEMPLATE_BULK_LIMIT,
  mergeTokens,
  messageTemplate,
  messageTemplateEndpoints,
  messageTemplateInput,
  messageTemplateList,
  messageTemplatePreview,
  messageTemplateRevisionInput,
  messageTemplateSummary,
  previewMessageTemplate,
  restoreMessageTemplate,
  previewMessageTemplateInput,
  renderMessageTemplate,
  requiredMergeTokens,
  updateMessageTemplateInput,
} from './message-templates.js';
import { openApiDocument } from './openapi.js';

const template = {
  subject: 'Your guide, {{contact.firstName}}',
  body: 'Hi {{ contact.firstName }},\nWe cover {{contact.custom.services}}. {{values.sample_reel_url}}',
};
const values = {
  'contact.firstName': 'Ada',
  'contact.custom.services': ['Video', 'Lighting'],
  'values.sample_reel_url': 'https://example.test/reel',
};

describe('rendering', () => {
  it('fills merge fields in the subject and body, as plain text', () => {
    expect(renderMessageTemplate(template, values)).toEqual({
      ok: true,
      subject: 'Your guide, Ada',
      body: 'Hi Ada,\nWe cover Video, Lighting. https://example.test/reel',
    });
  });

  it('keeps a value as written: plain text is never markup', () => {
    const result = renderMessageTemplate(template, {
      ...values,
      'contact.firstName': '<b>Ada</b> & co',
    });
    expect(result.ok && result.body).toContain('Hi <b>Ada</b> & co,');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['an empty list', []],
  ])('refuses to send when a merge value is %s, naming each one', (_, value) => {
    const given: Record<string, unknown> = { ...values };
    if (value === undefined) delete given['contact.firstName'];
    else given['contact.firstName'] = value;
    expect(
      renderMessageTemplate(template, {
        ...(given as typeof values),
        'values.sample_reel_url': null,
      }),
    ).toEqual({
      ok: false,
      code: 'missing_values',
      fields: ['contact.firstName', 'values.sample_reel_url'],
    });
  });

  it('refuses a subject that a value would break onto a second line, never rewriting it', () => {
    for (const name of ['Ada\r\nBcc: victim@example.test', 'Ada\nX', 'Ada\rX'])
      expect(renderMessageTemplate(template, { ...values, 'contact.firstName': name })).toEqual({
        ok: false,
        code: 'subject_line_break',
        fields: ['contact.firstName'],
      });
  });

  it('keeps line breaks a value brings into the body', () => {
    const result = renderMessageTemplate(template, {
      ...values,
      'contact.custom.services': 'Video\nLighting',
    });
    expect(result.ok && result.body).toContain('We cover Video\nLighting.');
  });

  it('leaves text that only looks like a merge field alone', () => {
    expect(
      renderMessageTemplate({ subject: 'S', body: 'Use {{ not a token }} or {single}' }, {}),
    ).toEqual({ ok: true, subject: 'S', body: 'Use {{ not a token }} or {single}' });
  });
});

describe('merge tokens', () => {
  it('lists each distinct field a template uses, in order', () => {
    expect(mergeTokens(template)).toEqual([
      'contact.firstName',
      'contact.custom.services',
      'values.sample_reel_url',
    ]);
  });
});

describe('the input', () => {
  it('takes a plain-text template and refuses a subject with a line break', () => {
    expect(
      messageTemplateInput.safeParse({ name: 'Guide', subject: 'Hi', body: 'Hello' }).success,
    ).toBe(true);
    expect(
      messageTemplateInput.safeParse({ name: 'Guide', subject: 'Hi\nBcc: x', body: 'Hello' })
        .success,
    ).toBe(false);
  });

  it('has no HTML body', () => {
    expect(
      messageTemplateInput.safeParse({
        name: 'Guide',
        subject: 'Hi',
        body: 'Hello',
        bodyHtml: '<p>Hello</p>',
      }).success,
    ).toBe(false);
  });
});

const revision = 'a'.repeat(64);
const saved = {
  id: 'tmpl_01h455vb4pex5vsknk084sn02q',
  name: 'Pricing guide',
  subject: 'Your guide, {{contact.firstName}}',
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:30:00.000Z',
  archivedAt: null,
  revision,
  // What a picker shows beside the name.
  format: 'text',
  preheader: null,
  folder: null,
  preview: 'Hi {{contact.firstName}}',
};

describe('an edit', () => {
  const edit = { name: ' Guide ', subject: ' Hi ', body: 'Hello\n', revision };

  it('carries the revision it was read at, and saves the name and subject trimmed', () => {
    expect(updateMessageTemplateInput.parse(edit)).toEqual({
      name: 'Guide',
      subject: 'Hi',
      body: 'Hello\n',
      revision,
    });
  });

  it.each([
    ['no revision', { name: 'Guide', subject: 'Hi', body: 'Hello' }],
    ['a revision that is not one', { ...edit, revision: 'latest' }],
    ['a subject with a line break', { ...edit, subject: 'Hi\rBcc: x' }],
    ['a subject over 255 characters', { ...edit, subject: 'x'.repeat(256) }],
    ['a name over 120 characters', { ...edit, name: 'x'.repeat(121) }],
    ['an empty body', { ...edit, body: '' }],
    ['a body over 100000 characters', { ...edit, body: 'x'.repeat(100_001) }],
    ['an HTML body', { ...edit, bodyHtml: '<p>Hello</p>' }],
    ['an archive flag', { ...edit, archivedAt: null }],
  ])('is refused with %s', (_, input) => {
    expect(updateMessageTemplateInput.safeParse(input).success).toBe(false);
  });

  it('takes the longest subject, name and body the database does', () => {
    expect(
      updateMessageTemplateInput.safeParse({
        name: 'n'.repeat(120),
        subject: 's'.repeat(255),
        body: 'b'.repeat(100_000),
        revision,
      }).success,
    ).toBe(true);
  });

  it('archives and restores with a revision and nothing else', () => {
    expect(messageTemplateRevisionInput.parse({ revision })).toEqual({ revision });
    expect(messageTemplateRevisionInput.safeParse({}).success).toBe(false);
    expect(messageTemplateRevisionInput.safeParse({ revision, name: 'Other' }).success).toBe(false);
  });
});

describe('what the API answers', () => {
  it('is a template with its revision, who may change it and what sends it', () => {
    const answer = {
      ...saved,
      body: 'Hi {{contact.firstName}}',
      content: { format: 'text', text: 'Hi {{contact.firstName}}' },
      mergeFields: ['contact.firstName'],
      unfillableFields: [],
      canManage: true,
      usedBy: [{ id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Welcome', status: 'active' }],
    };
    expect(messageTemplate.parse(answer)).toEqual(answer);
    expect(messageTemplate.parse({ ...answer, usedBy: null }).usedBy).toBeNull();
    expect(
      messageTemplate.parse({ ...answer, unfillableFields: null }).unfillableFields,
    ).toBeNull();
    for (const missing of [
      'revision',
      'canManage',
      'usedBy',
      'mergeFields',
      'unfillableFields',
      'archivedAt',
    ]) {
      const { [missing]: _left, ...rest } = answer as Record<string, unknown>;
      expect(messageTemplate.safeParse(rest).success, missing).toBe(false);
    }
  });

  it('names an automation that sends it only as active or paused', () => {
    const use = { id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Welcome' };
    const answer = {
      ...saved,
      body: 'Hi',
      content: { format: 'text', text: 'Hi' },
      mergeFields: [],
      unfillableFields: null,
      canManage: false,
    };
    expect(
      messageTemplate.safeParse({ ...answer, usedBy: [{ ...use, status: 'draft' }] }).success,
    ).toBe(false);
    expect(
      messageTemplate.safeParse({ ...answer, usedBy: [{ ...use, id: saved.id, status: 'active' }] })
        .success,
    ).toBe(false);
  });

  it('keeps formatted text inside content, and a list leaves the bodies out', () => {
    // HTML is only ever the `html` of a content pairing: no field of its own.
    const fields = [
      ...Object.keys(messageTemplate.shape),
      ...Object.keys(messageTemplateSummary.shape),
      ...Object.keys(messageTemplateInput.shape),
      ...Object.keys(updateMessageTemplateInput.shape),
      ...Object.keys(previewMessageTemplateInput.shape),
    ];
    expect(fields.filter((field) => /html/i.test(field))).toEqual([]);
    const summary = [
      'archivedAt',
      'createdAt',
      'deletedAt',
      'folder',
      'format',
      'id',
      'name',
      'preheader',
      'preview',
      'revision',
      'subject',
      'updatedAt',
      'workflowUses',
    ];
    expect(Object.keys(messageTemplateSummary.shape).sort()).toEqual(summary);
    expect(Object.keys(messageTemplate.shape).sort()).toEqual(
      [
        ...summary,
        'body',
        'canManage',
        'content',
        'mergeFields',
        'unfillableFields',
        'usedBy',
      ].sort(),
    );
    const formatted = {
      ...saved,
      format: 'html',
      preheader: 'A peek',
      folder: {
        id: 'tfld_01h455vb4pex5vsknk084sn02q',
        name: 'Pricing',
        path: ['Guides', 'Pricing'],
      },
    };
    expect(messageTemplateSummary.parse(formatted)).toEqual(formatted);
    expect(messageTemplateSummary.safeParse({ ...saved, format: 'blocks' }).success).toBe(false);
    for (const missing of ['format', 'preheader', 'folder', 'preview']) {
      const { [missing]: _left, ...rest } = saved as Record<string, unknown>;
      expect(messageTemplateSummary.safeParse(rest).success, missing).toBe(false);
    }
    expect(Object.keys(messageTemplateInput.shape).sort()).toEqual([
      'body',
      'content',
      'name',
      'preheader',
      'subject',
    ]);
    const list = { canManage: false, items: [saved], nextCursor: saved.id };
    expect(messageTemplateList.parse(list)).toEqual(list);
    expect(messageTemplateList.safeParse({ ...list, nextCursor: 'task_x' }).success).toBe(false);
    expect(messageTemplateList.safeParse({ items: [saved], nextCursor: null }).success).toBe(false);
  });
});

describe('the list query', () => {
  const defaults = { archived: 'exclude', deleted: 'exclude', sort: 'name' };

  it('leaves archived templates out unless asked, and takes only a template id as cursor', () => {
    expect(listMessageTemplates.query.parse({})).toEqual(defaults);
    expect(listMessageTemplates.query.parse({ archived: 'only', after: saved.id })).toEqual({
      ...defaults,
      archived: 'only',
      after: saved.id,
    });
    expect(listMessageTemplates.query.safeParse({ archived: 'yes' }).success).toBe(false);
    expect(
      listMessageTemplates.query.safeParse({ after: 'task_01h455vb4pex5vsknk084sn02q' }).success,
    ).toBe(false);
    expect(listMessageTemplates.query.safeParse({ channel: 'sms' }).success).toBe(false);
  });

  it('reads the trash, filters by format and use, and sorts by name, last update or use', () => {
    const query = { deleted: 'only', format: 'html', used: 'no', sort: 'uses' } as const;
    expect(listMessageTemplates.query.parse(query)).toEqual({ ...defaults, ...query });
    expect(listMessageTemplates.query.parse({ sort: 'updated', used: 'yes' })).toEqual({
      ...defaults,
      sort: 'updated',
      used: 'yes',
    });
    for (const wrong of [
      { deleted: 'include' },
      { deleted: 'yes' },
      { format: 'blocks' },
      { used: 'maybe' },
      { used: true },
      { sort: 'created' },
      { sort: 'name desc' },
    ])
      expect(listMessageTemplates.query.safeParse(wrong).success, JSON.stringify(wrong)).toBe(
        false,
      );
  });
});

describe('the trash', () => {
  it('says when a template was moved there, and an older answer without it still reads', () => {
    const deletedAt = '2026-10-10T08:00:00.000Z';
    const inTrash = { ...saved, archivedAt: deletedAt, deletedAt };
    expect(messageTemplateSummary.parse(inTrash)).toEqual(inTrash);
    expect(messageTemplateSummary.parse({ ...saved, deletedAt: null }).deletedAt).toBeNull();
    expect(messageTemplateSummary.parse(saved)).toEqual(saved);
    expect(messageTemplateSummary.safeParse({ ...saved, deletedAt: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('is where a delete moves a template, with the revision it was read at', () => {
    expect(deleteMessageTemplate).toMatchObject({
      operationId: 'deleteMessageTemplate',
      method: 'delete',
      path: '/message-templates/{id}',
      response: { status: 200, schema: messageTemplate },
    });
    expect(deleteMessageTemplate.body.parse({ revision })).toEqual({ revision });
    expect(deleteMessageTemplate.body.safeParse({}).success).toBe(false);
    expect(deleteMessageTemplate.body.safeParse({ revision, purge: true }).success).toBe(false);
    expect(restoreMessageTemplate.body.parse({ revision })).toEqual({ revision });
  });
});

describe('a duplicate', () => {
  it('takes an optional name under the same rule as a template name, and nothing else', () => {
    expect(duplicateMessageTemplate).toMatchObject({
      operationId: 'duplicateMessageTemplate',
      method: 'post',
      path: '/message-templates/{id}/duplicate',
      response: { status: 201, schema: messageTemplate },
    });
    expect(duplicateMessageTemplate.body.parse({})).toEqual({});
    expect(duplicateMessageTemplate.body.parse({ name: '  Guide copy  ' })).toEqual({
      name: 'Guide copy',
    });
    expect(duplicateMessageTemplate.body.safeParse({ name: 'n'.repeat(120) }).success).toBe(true);
    for (const wrong of [
      { name: 'n'.repeat(121) },
      { name: '   ' },
      { name: null },
      { name: 'Guide', folderId: null },
      { name: 'Guide', subject: 'Hi' },
    ])
      expect(duplicateMessageTemplate.body.safeParse(wrong).success, JSON.stringify(wrong)).toBe(
        false,
      );
  });
});

describe('a bulk action', () => {
  // Distinct template ids: the last two characters count up in the ids' own alphabet.
  const digits = '0123456789abcdefghjkmnpqrstvwxyz';
  const ids = (count: number): string[] =>
    Array.from(
      { length: count },
      (_, index) =>
        `tmpl_01h455vb4pex5vsknk084sn0${digits.charAt(Math.floor(index / 32))}${digits.charAt(index % 32)}`,
    );

  it('moves, archives, deletes or restores up to 100 templates, each named once', () => {
    expect(bulkMessageTemplates).toMatchObject({
      operationId: 'bulkMessageTemplates',
      method: 'post',
      path: '/message-templates/bulk',
      response: { status: 200, schema: bulkMessageTemplatesResult },
    });
    expect(MESSAGE_TEMPLATE_BULK_LIMIT).toBe(100);
    const folderId = 'tfld_01h455vb4pex5vsknk084sn02q';
    for (const input of [
      { action: 'move', ids: ids(1), folderId },
      { action: 'move', ids: ids(2), folderId: null },
      { action: 'archive', ids: ids(100) },
      { action: 'delete', ids: ids(3) },
      { action: 'restore', ids: ids(1) },
    ])
      expect(bulkMessageTemplates.body.parse(input)).toEqual(input);
    for (const wrong of [
      { action: 'archive', ids: [] },
      { action: 'archive', ids: ids(101) },
      { action: 'delete', ids: [saved.id, saved.id] },
      { action: 'delete', ids: ['tfld_01h455vb4pex5vsknk084sn02q'] },
      { action: 'move', ids: ids(1) },
      { action: 'move', ids: ids(1), folderId: saved.id },
      { action: 'archive', ids: ids(1), folderId: null },
      { action: 'purge', ids: ids(1) },
      { ids: ids(1) },
    ])
      expect(bulkMessageTemplates.body.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    const messages = (input: unknown) =>
      bulkMessageTemplates.body.safeParse(input).error?.issues.map((issue) => issue.message);
    expect(messages({ action: 'archive', ids: [] })).toEqual(['Select at least one template.']);
    expect(messages({ action: 'archive', ids: ids(101) })).toEqual([
      'Select at most 100 templates at a time.',
    ]);
    expect(messages({ action: 'archive', ids: [saved.id, saved.id] })).toEqual([
      'Name each template once.',
    ]);
  });

  it('answers what became of each template, in the order named, with a reason for a skip', () => {
    const result = {
      action: 'delete',
      results: [
        { id: saved.id, outcome: 'done', reason: null },
        {
          id: 'tmpl_01h455vb4pex5vsknk084sn02r',
          outcome: 'skipped',
          reason: { code: 'in_use', message: '"Welcome" sends this template.' },
        },
        { id: 'tmpl_01h455vb4pex5vsknk084sn02s', outcome: 'unchanged', reason: null },
      ],
      done: 1,
      unchanged: 1,
      skipped: 1,
    };
    expect(bulkMessageTemplatesResult.parse(result)).toEqual(result);
    for (const code of ['not_found', 'in_use', 'in_trash', 'name_taken'])
      expect(
        bulkMessageTemplatesResult.safeParse({
          ...result,
          results: [{ id: saved.id, outcome: 'skipped', reason: { code, message: 'Why.' } }],
        }).success,
        code,
      ).toBe(true);
    expect(
      bulkMessageTemplatesResult.safeParse({
        ...result,
        results: [{ id: saved.id, outcome: 'skipped', reason: { code: 'other', message: 'x' } }],
      }).success,
    ).toBe(false);
    expect(bulkMessageTemplatesResult.safeParse({ ...result, action: 'trash' }).success).toBe(
      false,
    );
  });
});

describe('a preview', () => {
  it('is the text a send would produce', () => {
    expect(previewMessageTemplate(template, values)).toEqual(
      renderMessageTemplate(template, values),
    );
    expect(messageTemplatePreview.parse(previewMessageTemplate(template, values))).toEqual({
      ok: true,
      subject: 'Your guide, Ada',
      body: 'Hi Ada,\nWe cover Video, Lighting. https://example.test/reel',
    });
  });

  it('names the fields with no value instead of leaving blanks', () => {
    const preview = previewMessageTemplate(template, { 'contact.firstName': 'Ada' });
    expect(messageTemplatePreview.parse(preview)).toEqual({
      ok: false,
      code: 'missing_values',
      fields: ['contact.custom.services', 'values.sample_reel_url'],
    });
  });

  it('says when a sample value would break the subject onto a second line', () => {
    expect(previewMessageTemplate(template, { ...values, 'contact.firstName': 'A\nB' })).toEqual({
      ok: false,
      code: 'subject_line_break',
      fields: ['contact.firstName'],
    });
  });

  it('takes unsaved text and bounded sample values, and still no HTML or line-broken subject', () => {
    expect(previewMessageTemplateInput.parse({ subject: '', body: '' })).toEqual({
      subject: '',
      body: '',
      values: {},
    });
    const input = { subject: 'Hi', body: 'Hello', values: { 'contact.tags': ['VIP', 3], n: 1 } };
    expect(previewMessageTemplateInput.parse(input)).toEqual(input);
    for (const refused of [
      { ...input, subject: 'Hi\nBcc: x' },
      { ...input, subject: 'x'.repeat(256) },
      { ...input, body: 'x'.repeat(100_001) },
      { ...input, bodyHtml: '<p>Hello</p>' },
      { ...input, values: { nested: { a: 1 } } },
      { ...input, values: { long: 'x'.repeat(10_001) } },
      {
        ...input,
        values: Object.fromEntries(Array.from({ length: 201 }, (_, at) => [`k${String(at)}`, 'v'])),
      },
    ])
      expect(previewMessageTemplateInput.safeParse(refused).success).toBe(false);
  });
});

describe('the contact fields offered to an author', () => {
  const setup: AutomationSetup = {
    fields: { contact: [], deal: [] },
    forms: [],
    emailTemplates: [],
    whatsappTemplates: [],
    mailboxes: [],
    phoneNumbers: [],
    calendars: [],
    pipelines: [],
    lostReasons: [],
    tags: [{ id: 'tag_vip', name: 'VIP' }],
    users: [],
    automations: [],
    values: [],
    channels: { email: true, sms: false, whatsapp: false },
    ai: false,
    webhooks: false,
    unavailableSteps: [],
    unavailableTriggers: [],
  };
  const fieldErrors = (field: string) =>
    validateAutomation(
      {
        name: 'Check',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'check',
        steps: {
          check: {
            type: 'condition',
            config: { if: { field, operator: 'is_set' } },
            next: { yes: 'done', no: 'done' },
          },
          done: { type: 'tag.add', config: { tag: 'VIP' } },
        },
      },
      setup,
    ).errors;

  // The validator's built-in contact fields aren't exported, so each is checked through it.
  it.each(contactMergeFields)('%s is a field automations know', (field) => {
    expect(fieldErrors(field)).toEqual([]);
  });

  it('would fail for a field automations do not know', () => {
    expect(fieldErrors('contact.nickname')).toMatchObject([{ message: /is not a field/ }]);
  });

  it('are contact fields only, each once', () => {
    expect(new Set(contactMergeFields).size).toBe(contactMergeFields.length);
    expect(contactMergeFields.every((field) => /^contact\.[A-Za-z]+$/.test(field))).toBe(true);
  });
});

describe('the endpoints', () => {
  it('each have an operation in an OpenAPI document, under ids nothing else uses', () => {
    const document = openApiDocument(messageTemplateEndpoints);
    for (const endpoint of messageTemplateEndpoints)
      expect(document.paths?.[endpoint.path]?.[endpoint.method]).toMatchObject({
        operationId: endpoint.operationId,
      });
    const own: readonly Endpoint[] = messageTemplateEndpoints;
    const ids = own.map((endpoint) => endpoint.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const routes = own.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    // Until they join the API's list, nothing there may already use an id or a route.
    const others = endpoints.filter((endpoint) => !own.includes(endpoint));
    expect(others.filter((endpoint) => ids.includes(endpoint.operationId))).toEqual([]);
    expect(
      others.filter((endpoint) => routes.includes(`${endpoint.method} ${endpoint.path}`)),
    ).toEqual([]);
  });

  it('take a template id in the path, and a revision on every change to a saved template', () => {
    for (const endpoint of messageTemplateEndpoints.filter((each) => 'params' in each)) {
      expect(endpoint.params.safeParse({ id: saved.id }).success).toBe(true);
      expect(endpoint.params.safeParse({ id: 'task_01h455vb4pex5vsknk084sn02q' }).success).toBe(
        false,
      );
    }
    const changes = messageTemplateEndpoints.filter(
      (endpoint) => endpoint.method !== 'get' && 'params' in endpoint,
    );
    expect(changes.map((endpoint) => endpoint.operationId)).toEqual([
      'updateMessageTemplate',
      'archiveMessageTemplate',
      'restoreMessageTemplate',
      'deleteMessageTemplate',
      'duplicateMessageTemplate',
    ]);
    // A duplicate changes nothing of the template it copies, so it needs no revision.
    expect(duplicateMessageTemplate.body.safeParse({ revision }).success).toBe(false);
    for (const endpoint of changes)
      expect(endpoint.body.safeParse({ name: 'Guide', subject: 'Hi', body: 'Hello' }).success).toBe(
        false,
      );
  });
});

describe('a merge field with a fallback', () => {
  const template = {
    subject: 'Hi {{contact.firstName | default: "there"}}',
    body: 'Dear {{ contact.firstName|default:"friend" }}, from {{contact.lastName}}',
  };

  it('writes the fallback when the record has no value, and the value when it has one', () => {
    expect(renderMessageTemplate(template, { 'contact.lastName': 'Ng' })).toEqual({
      ok: true,
      subject: 'Hi there',
      body: 'Dear friend, from Ng',
    });
    expect(
      renderMessageTemplate(template, { 'contact.firstName': '  ', 'contact.lastName': 'Ng' }),
    ).toMatchObject({ subject: 'Hi there' });
    expect(
      renderMessageTemplate(template, { 'contact.firstName': 'Ada', 'contact.lastName': 'Ng' }),
    ).toEqual({ ok: true, subject: 'Hi Ada', body: 'Dear Ada, from Ng' });
  });

  it('still stops at a field used anywhere without one', () => {
    expect(renderMessageTemplate(template, {})).toEqual({
      ok: false,
      code: 'missing_values',
      fields: ['contact.lastName'],
    });
    const mixed = {
      subject: '{{contact.firstName | default: "x"}}',
      body: '{{contact.firstName}}',
    };
    expect(renderMessageTemplate(mixed, {})).toMatchObject({ fields: ['contact.firstName'] });
    expect(requiredMergeTokens(mixed)).toEqual(['contact.firstName']);
    expect(requiredMergeTokens(template)).toEqual(['contact.lastName']);
    expect(mergeTokens(template)).toEqual(['contact.firstName', 'contact.lastName']);
  });

  it('takes plain words only, so a fallback is never markup or a second line', () => {
    for (const written of [
      '{{contact.firstName | default: "<b>x</b>"}}',
      '{{contact.firstName | default: "a\nb"}}',
      '{{contact.firstName | default: "a & b"}}',
      `{{contact.firstName | default: "${'x'.repeat(101)}"}}`,
      "{{contact.firstName | default: 'there'}}",
    ])
      expect(renderMessageTemplate({ subject: '', body: written }, {})).toEqual({
        ok: true,
        subject: '',
        body: written,
      });
  });
});
