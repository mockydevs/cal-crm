import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { assistantTools, automationCatalog, automationJsonSchema } from '@repo/contracts';
import { ApiError, type Client as CrmClient } from '@repo/sdk';
import { afterEach, expect, it, vi } from 'vitest';

import { createCrmMcpServer } from './server.js';

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
});
async function connect(request: CrmClient['request'], allowPublish = false): Promise<Client> {
  const server = createCrmMcpServer({ client: { request }, allowPublish });
  const client = new Client({ name: 'acceptance-ai', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closing.push(
    () => client.close(),
    () => server.close(),
  );
  return client;
}

it('offers discoverable authoring, schema, validation and dry-run tools without publishing by default', async () => {
  const client = await connect(vi.fn());
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining([
      'crm_getAutomationCatalog',
      'crm_getAutomationSchema',
      'crm_createAutomation',
      'crm_replaceAutomationDraft',
      'crm_validateAutomation',
      'crm_createAutomationTestRun',
      'crm_getAutomationTestRun',
      'crm_createField',
      'crm_createMessageTemplate',
    ]),
  );
  expect(names).not.toContain('crm_publishAutomation');
  expect(names).not.toContain('crm_sendMessage');
  // Why a workflow did not start is a read; moving a run on is a person's to do.
  for (const name of ['crm_listAutomationTriggerEvaluations', 'crm_explainAutomationContact']) {
    expect(names).toContain(name);
    expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
  }
  expect(names).not.toContain('crm_continueAutomationRun');
  expect(names).not.toContain('crm_retryAutomationRun');
  expect(
    tools.find((tool) => tool.name === 'crm_getAutomationCatalog')?.annotations?.readOnlyHint,
  ).toBe(true);
});

it.each([false, true])(
  'offers only read-only email inspection even with publish opt-in: %s',
  async (allowPublish) => {
    const request = vi.fn();
    const client = await connect(request, allowPublish);
    const { tools } = await client.listTools();
    for (const operation of [
      'getEmailReport',
      'listTemplateWorkflowActions',
      'getWorkflowEmailStepStatistics',
      'renderEmailPreview',
    ]) {
      expect(tools.find(({ name }) => name === `crm_${operation}`)).toMatchObject({
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      });
    }
    for (const operation of ['enableWorkflowEmailSync', 'saveSyncedWorkflowEmail', 'sendMessage'])
      expect(tools.some(({ name }) => name === `crm_${operation}`)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  },
);

it('offers canonical read-only business discovery so the model can choose an account by name and slug', async () => {
  const request = vi.fn();
  const client = await connect(request);
  const { tools } = await client.listTools();
  expect(tools.find(({ name }) => name === 'crm_listBusinesses')).toMatchObject({
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  });
  expect(tools.find(({ name }) => name === 'crm_getApiKeyContext')).toMatchObject({
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  });
  expect(request).not.toHaveBeenCalled();
});

it('previews unsaved email through the canonical API without making a send tool available', async () => {
  const preview = {
    subject: 'Hello',
    preheader: null,
    html: null,
    text: 'Welcome',
    mergeFields: [],
    missingFields: [],
    subjectLineBreak: [],
  };
  const request = vi.fn().mockResolvedValue(preview);
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_renderEmailPreview',
    arguments: { body: { subject: 'Hello', content: { format: 'text', text: 'Welcome' } } },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ operationId: 'renderEmailPreview', method: 'post' }),
    {
      body: {
        subject: 'Hello',
        content: { format: 'text', text: 'Welcome' },
        values: {},
        footer: true,
      },
    },
  );
  expect(result.structuredContent).toEqual(preview);
});

it('refuses malformed email preview input before invoking the API', async () => {
  const request = vi.fn();
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_renderEmailPreview',
    arguments: {
      body: { subject: 'Hello\r\nBcc: injected', content: { format: 'text', text: 'Hi' } },
    },
  });
  expect(result.isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it('keeps canonical permission refusals when reading workflow email statistics', async () => {
  const request = vi.fn().mockRejectedValue(
    new ApiError({
      type: 'about:blank',
      status: 403,
      title: 'Forbidden',
      detail: 'Not permitted.',
    }),
  );
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_getWorkflowEmailStepStatistics',
    arguments: { params: { id: 'aut_01m4p04990ezka4pdakzx29dsc', step: 'send' }, query: {} },
  });
  expect(request).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 403 } });
});

it('passes a document and revision to the canonical SDK through a real MCP tools/call', async () => {
  const request = vi.fn().mockResolvedValue({ automation: { id: 'example', draftVersion: 2 } });
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_replaceAutomationDraft',
    arguments: {
      params: { id: 'aut_01m4p04990ezka4pdakzx29dsc' },
      body: { baseDraftVersion: 1, document: { name: 'Wedding education', steps: {} } },
    },
  });
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: 'replaceAutomationDraft' }),
    {
      params: { id: 'aut_01m4p04990ezka4pdakzx29dsc' },
      body: { baseDraftVersion: 1, document: { name: 'Wedding education', steps: {} } },
    },
  );
  expect(result.structuredContent).toEqual({ automation: { id: 'example', draftVersion: 2 } });
});

it('rejects invalid input before reaching the API', async () => {
  const request = vi.fn();
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_replaceAutomationDraft',
    arguments: { body: { baseDraftVersion: 0 } },
  });
  expect(result.isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it('selects a business per concurrent tool call and strips it from canonical API input', async () => {
  const request = vi.fn().mockResolvedValue({ automation: { id: 'example', draftVersion: 2 } });
  const client = await connect(request);
  const argumentsForApi = {
    params: { id: 'aut_01m4p04990ezka4pdakzx29dsc' },
    body: { baseDraftVersion: 1, document: { name: 'Wedding education', steps: {} } },
  };
  const results = await Promise.all(
    ['harbor-lights', 'bluebird'].map((business) =>
      client.callTool({
        name: 'crm_replaceAutomationDraft',
        arguments: { ...argumentsForApi, business },
      }),
    ),
  );
  expect(results.every((result) => result.isError !== true)).toBe(true);
  for (const businessSlug of ['harbor-lights', 'bluebird']) {
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'replaceAutomationDraft' }),
      argumentsForApi,
      { businessSlug },
    );
  }
  expect(request).toHaveBeenCalledTimes(2);
  await client.callTool({ name: 'crm_replaceAutomationDraft', arguments: argumentsForApi });
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({ operationId: 'replaceAutomationDraft' }),
    argumentsForApi,
  );
});

it('describes the optional native business slug on every offered tool', async () => {
  const request = vi.fn();
  const client = await connect(request, true);
  for (const tool of (await client.listTools()).tools) {
    expect(tool.inputSchema.properties?.['business'], tool.name).toMatchObject({
      type: 'string',
      pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$',
    });
    expect(tool.inputSchema.required ?? [], tool.name).not.toContain('business');
  }
  expect(request).not.toHaveBeenCalled();
});

it.each([
  '',
  'Uppercase',
  '-leading',
  'trailing-',
  'two words',
  'a'.repeat(64),
  'a\r\nb',
  12,
  null,
])('refuses an invalid business slug before any API request: %j', async (business) => {
  const request = vi.fn();
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_getAutomationSchema',
    arguments: { business },
  });
  expect(result.isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it.each(['a', '0', 'harbor--lights', 'a'.repeat(63)])(
  'accepts the native business slug boundary: %s',
  async (business) => {
    const request = vi.fn().mockResolvedValue({});
    const client = await connect(request);
    const result = await client.callTool({
      name: 'crm_getAutomationSchema',
      arguments: { business },
    });
    expect(result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operationId: 'getAutomationSchema' }),
      {},
      { businessSlug: business },
    );
  },
);

it('keeps a selected-business 403 structured without retrying at the default scope', async () => {
  const request = vi.fn().mockRejectedValue(
    new ApiError({
      type: 'about:blank',
      status: 403,
      title: 'Forbidden',
      detail: 'Not permitted.',
    }),
  );
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_getAutomationSchema',
    arguments: { business: 'other-agency' },
  });
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { status: 403, detail: 'Not permitted.' },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ operationId: 'getAutomationSchema' }),
    {},
    { businessSlug: 'other-agency' },
  );
});

it('preserves canonical permission and conflict feedback for the AI', async () => {
  const request = vi.fn().mockRejectedValue(
    new ApiError({
      type: 'about:blank',
      status: 409,
      title: 'Conflict',
      detail: 'Read the latest draft version before saving.',
    }),
  );
  const client = await connect(request, true);
  const result = await client.callTool({
    name: 'crm_publishAutomation',
    arguments: { params: { id: 'aut_01m4p04990ezka4pdakzx29dsc' }, body: { baseDraftVersion: 1 } },
  });
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {
      status: 409,
      title: 'Conflict',
      detail: 'Read the latest draft version before saving.',
    },
  });
});

it('does not expose raw transport errors that might contain credentials', async () => {
  const client = await connect(
    vi.fn().mockRejectedValue(new Error('secret credential in transport failure')),
  );
  const result = await client.callTool({ name: 'crm_getAutomationSchema', arguments: {} });
  expect(result).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: 'CRM request failed. Check the connection and retry.' }],
  });
  expect(JSON.stringify(result)).not.toContain('secret credential');
});

it('offers the canonical template copy and read-only discovery of pipelines, tags and calendars', async () => {
  const client = await connect(vi.fn());
  const { tools } = await client.listTools();
  const tool = (name: string) => tools.find((each) => each.name === name);
  for (const name of ['crm_getPipelines', 'crm_listTags', 'crm_listCalendars'])
    expect(tool(name)?.annotations, name).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  expect(tool('crm_copyWorkflowEmailTemplate')?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  // Its schema is the endpoint's own: the draft version and the template's revision.
  expect(JSON.stringify(tool('crm_copyWorkflowEmailTemplate')?.inputSchema)).toEqual(
    expect.stringMatching(/"baseDraftVersion".*"revision"|"revision".*"baseDraftVersion"/),
  );
  // Nothing that changes pipelines or calendars came with them (a tag can be made, never
  // renamed or deleted), and publish stays gated.
  const names = tools.map((each) => each.name);
  expect(names.filter((name) => /Pipeline|Tag|Calendar/.test(name)).sort()).toEqual([
    'crm_createTag',
    'crm_getCalendar',
    'crm_getCalendarAvailability',
    'crm_getPipelines',
    'crm_listCalendarGroups',
    'crm_listCalendarSenders',
    'crm_listCalendars',
    'crm_listTags',
  ]);
  expect(names).not.toContain('crm_publishAutomation');
});

const copyArguments = {
  params: { id: 'aut_01m4p04990ezka4pdakzx29dsc' },
  body: {
    baseDraftVersion: 3,
    step: 'send_guide',
    template: 'tmpl_01m4p04990ezka4pdakzx29dsc',
    revision: 'a'.repeat(64),
  },
};

it('forwards the template revision and draft version of a copy to the canonical command', async () => {
  const request = vi.fn().mockResolvedValue({ automation: { id: 'example', draftVersion: 4 } });
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_copyWorkflowEmailTemplate',
    arguments: copyArguments,
  });
  expect(result.isError ?? false).toBe(false);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ operationId: 'copyWorkflowEmailTemplate', method: 'post' }),
    copyArguments,
  );
  expect(result.structuredContent).toEqual({ automation: { id: 'example', draftVersion: 4 } });
});

it('refuses a copy without the revisions before it reaches the API', async () => {
  const request = vi.fn();
  const client = await connect(request);
  const { revision: _revision, ...withoutRevision } = copyArguments.body;
  const result = await client.callTool({
    name: 'crm_copyWorkflowEmailTemplate',
    arguments: { params: copyArguments.params, body: withoutRevision },
  });
  expect(result.isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("keeps the API's refusal of a copy, and of a read, as the API gave it", async () => {
  const denied = new ApiError({
    type: 'about:blank',
    status: 403,
    title: 'Forbidden',
    detail: 'This key may not manage automations.',
  });
  const client = await connect(vi.fn().mockRejectedValue(denied));
  for (const call of [
    { name: 'crm_copyWorkflowEmailTemplate', arguments: copyArguments },
    { name: 'crm_getPipelines', arguments: {} },
    { name: 'crm_listTags', arguments: {} },
    { name: 'crm_listCalendars', arguments: { query: {} } },
  ])
    expect(await client.callTool(call), call.name).toMatchObject({
      isError: true,
      structuredContent: { status: 403, title: 'Forbidden' },
    });
});

it('reads pipelines, tags and calendars through their canonical read operations', async () => {
  const request = vi.fn().mockResolvedValue({ items: [] });
  const client = await connect(request);
  // A list that pages takes its query, with the endpoint's own default page size.
  for (const [name, operationId, given, forwarded] of [
    ['crm_getPipelines', 'getPipelines', {}, {}],
    ['crm_listTags', 'listTags', {}, {}],
    ['crm_listCalendars', 'listCalendars', { query: {} }, { query: { limit: 25 } }],
  ] as const) {
    const result = await client.callTool({ name, arguments: given });
    expect(result.structuredContent, name).toEqual({ items: [] });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ operationId, method: 'get' }),
      forwarded,
    );
  }
});

it('hands the catalog and the schema to the AI whole: the new steps, their outputs and choices', async () => {
  // What the API serves for these two operations is built from the same contracts.
  const request = vi.fn((endpoint: { operationId: string }) =>
    Promise.resolve(
      endpoint.operationId === 'getAutomationCatalog'
        ? automationCatalog()
        : automationJsonSchema(),
    ),
  );
  const client = await connect(request as unknown as CrmClient['request']);
  const catalog = (await client.callTool({ name: 'crm_getAutomationCatalog', arguments: {} }))
    .structuredContent as ReturnType<typeof automationCatalog>;
  const step = (type: string) => catalog.steps.find((each) => each.type === type);
  expect(step('automation.run')?.outputs.map((output) => output.key)).toEqual([
    'enrolmentId',
    'outcome',
  ]);
  expect(step('automation.remove')).toMatchObject({
    label: 'Remove from automations',
    outputs: [{ key: 'removed', type: 'number' }],
  });
  const removal = JSON.stringify(step('automation.remove')?.config);
  for (const word of ['current', 'automations', 'all_others', 'all', 'except'])
    expect(removal).toContain(`"${word}"`);
  expect(JSON.stringify(step('team.notify')?.config)).toContain('"owner_or_everyone"');
  expect(
    JSON.stringify(catalog.triggers.find((each) => each.type === 'message.received')?.config),
  ).toContain('"repliedTo"');

  const schema = JSON.stringify(
    (await client.callTool({ name: 'crm_getAutomationSchema', arguments: {} })).structuredContent,
  );
  for (const word of ['automation.remove', 'owner_or_everyone', 'repliedTo', 'all_others'])
    expect(schema).toContain(`"${word}"`);
});

it('creates a tag and sets a record field through their canonical operations, schema first', async () => {
  const request = vi.fn().mockResolvedValue({ id: 'tag_example', name: 'Booked Consultation' });
  const client = await connect(request);
  const { tools } = await client.listTools();
  const tool = (name: string) => tools.find((each) => each.name === name);
  expect(tool('crm_createTag')?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  expect(tool('crm_getRecordFields')?.annotations).toMatchObject({ readOnlyHint: true });
  expect(tool('crm_setRecordField')?.annotations).toMatchObject({ readOnlyHint: false });
  // No tool that renames, merges or deletes a tag came with it.
  expect(
    tools
      .map((each) => each.name)
      .filter((name) => name.includes('Tag'))
      .sort(),
  ).toEqual(['crm_createTag', 'crm_listTags']);

  const made = await client.callTool({
    name: 'crm_createTag',
    arguments: { body: { name: 'Booked Consultation' } },
  });
  expect(made.structuredContent).toEqual({ id: 'tag_example', name: 'Booked Consultation' });
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({ operationId: 'createTag', method: 'post' }),
    // With the endpoint's own defaults filled in.
    { body: expect.objectContaining({ name: 'Booked Consultation' }) as unknown },
  );
  // A tag without a name never reaches the API.
  expect((await client.callTool({ name: 'crm_createTag', arguments: { body: {} } })).isError).toBe(
    true,
  );
  expect(request).toHaveBeenCalledTimes(1);

  const setting = {
    params: {
      id: 'con_01m4p04990ezka4pdakzx29dsc',
      fieldId: 'fld_01m4p04990ezka4pdakzx29dsc',
    },
    body: { value: ['dj', 'photo'], revision: 'b'.repeat(64) },
  };
  await client.callTool({ name: 'crm_setRecordField', arguments: setting });
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({ operationId: 'setRecordField', method: 'put' }),
    setting,
  );
  // The revision the value was read at is required: a write is never blind.
  const blind = await client.callTool({
    name: 'crm_setRecordField',
    arguments: { params: setting.params, body: { value: ['dj'] } },
  });
  expect(blind.isError).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});

// The assistant's tool registry: one list for the app and for this server.
const FORM = 'form_01h455vb4pex5vsknk084sn02q';
const REVISION = 'a'.repeat(64);

it('offers every tool of the assistant registry that reads or drafts, and publishing only where the operator opted in', async () => {
  const { tools } = await (await connect(vi.fn())).listTools();
  const names = tools.map((tool) => tool.name);
  for (const tool of assistantTools.filter((each) => each.effect !== 'confirm'))
    expect(names, tool.operationId).toContain(`crm_${tool.operationId}`);
  expect(names).not.toContain('crm_publishForm');
  // What a tool does comes from the registry, not from the HTTP method: reading what is
  // missing on a page is a POST that changes nothing.
  const hints = (name: string) => tools.find((tool) => tool.name === name)?.annotations;
  expect(hints('crm_getAssistantContext')).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
  });
  expect(hints('crm_createForm')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  // What the registry does not list is still not offered.
  for (const name of ['crm_unpublishForm', 'crm_archiveForm', 'crm_applyProposal'])
    expect(names).not.toContain(name);

  const opted = (await (await connect(vi.fn(), true)).listTools()).tools;
  expect(opted.find((tool) => tool.name === 'crm_publishForm')?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  expect(opted.map((tool) => tool.name)).toContain('crm_publishAutomation');
});

it('saves a form with the websites it already has: a tool never sets them', async () => {
  const request = vi
    .fn()
    .mockImplementation((endpoint: { operationId: string }) =>
      Promise.resolve(
        endpoint.operationId === 'getForm'
          ? { id: FORM, name: 'Old name', allowedOrigins: ['https://www.example.com'] }
          : { id: FORM, name: 'Wedding enquiry' },
      ),
    );
  const client = await connect(request);
  const { tools } = await client.listTools();
  const schema = JSON.stringify(tools.find((tool) => tool.name === 'crm_updateForm')?.inputSchema);
  expect(schema).toContain('definition');
  expect(schema).not.toContain('allowedOrigins');

  const body = { name: 'Wedding enquiry', definition: { fields: [] }, revision: REVISION };
  const result = await client.callTool({
    name: 'crm_updateForm',
    arguments: { params: { id: FORM }, body },
  });
  expect(result.isError).not.toBe(true);
  // Read first, with the same path, then saved with what the form already held.
  const calls = request.mock.calls as [{ readonly operationId: string }, unknown][];
  expect(calls.map(([endpoint]) => endpoint.operationId)).toEqual(['getForm', 'updateForm']);
  expect(calls[0]?.[1]).toEqual({ params: { id: FORM } });
  expect(calls[1]?.[1]).toMatchObject({
    params: { id: FORM },
    body: {
      name: 'Wedding enquiry',
      revision: REVISION,
      allowedOrigins: ['https://www.example.com'],
    },
  });

  // Sending them is refused before the API is reached.
  request.mockClear();
  const refused = await client.callTool({
    name: 'crm_updateForm',
    arguments: {
      params: { id: FORM },
      body: { ...body, allowedOrigins: ['https://evil.example'] },
    },
  });
  expect(refused.isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it('publishes a form through its canonical operation once the operator opted in', async () => {
  const request = vi.fn().mockResolvedValue({ id: FORM, status: 'published' });
  const client = await connect(request, true);
  const result = await client.callTool({
    name: 'crm_publishForm',
    arguments: { params: { id: FORM }, body: { revision: REVISION } },
  });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'publishForm' }), {
    params: { id: FORM },
    body: { revision: REVISION },
  });
  expect(result.structuredContent).toEqual({ id: FORM, status: 'published' });
});

it('keeps the API’s refusal when the form to save cannot be read first', async () => {
  const request = vi.fn().mockRejectedValue(
    new ApiError({
      type: 'about:blank',
      status: 404,
      title: 'Not found',
      detail: 'No such form.',
    }),
  );
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_updateForm',
    arguments: {
      params: { id: FORM },
      body: { name: 'A form', definition: { fields: [] }, revision: REVISION },
    },
  });
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 404 } });
  expect(request).toHaveBeenCalledTimes(1);
});

it('preserves each business form scope across overlapping read-before-write calls', async () => {
  let releaseHarbor: (() => void) | undefined;
  const harborWaiting = new Promise<void>((resolve) => {
    releaseHarbor = resolve;
  });
  let observeHarborRead: (() => void) | undefined;
  const harborReading = new Promise<void>((resolve) => {
    observeHarborRead = resolve;
  });
  const request = vi.fn(
    async (
      endpoint: { operationId: string },
      _input: unknown,
      options?: { businessSlug?: string },
    ) => {
      if (endpoint.operationId === 'getForm') {
        if (options?.businessSlug === 'harbor-lights') {
          observeHarborRead?.();
          await harborWaiting;
        }
        return {
          id: FORM,
          allowedOrigins: [
            options?.businessSlug === 'harbor-lights'
              ? 'https://harbor.example'
              : 'https://bluebird.example',
          ],
        };
      }
      return { id: FORM };
    },
  );
  const client = await connect(request as unknown as CrmClient['request']);
  const body = { name: 'Wedding enquiry', definition: { fields: [] }, revision: REVISION };
  const update = (business: string) =>
    client.callTool({
      name: 'crm_updateForm',
      arguments: { business, params: { id: FORM }, body },
    });
  const harbor = update('harbor-lights');
  await harborReading;
  const bluebird = await update('bluebird');
  releaseHarbor?.();
  expect((await harbor).isError).not.toBe(true);
  expect(bluebird.isError).not.toBe(true);
  expect(
    request.mock.calls.map(([endpoint, , options]) => [
      endpoint.operationId,
      options?.businessSlug,
    ]),
  ).toEqual([
    ['getForm', 'harbor-lights'],
    ['getForm', 'bluebird'],
    ['updateForm', 'bluebird'],
    ['updateForm', 'harbor-lights'],
  ]);
  expect(request.mock.calls[2]?.[1]).toMatchObject({
    params: { id: FORM },
    body: { ...body, allowedOrigins: ['https://bluebird.example'] },
  });
  expect(request.mock.calls[3]?.[1]).toMatchObject({
    params: { id: FORM },
    body: { ...body, allowedOrigins: ['https://harbor.example'] },
  });
  for (const [, input] of request.mock.calls) expect(input).not.toHaveProperty('business');
});

it('does not write or switch scope when the selected form preservation read is forbidden', async () => {
  const request = vi.fn().mockRejectedValue(
    new ApiError({
      type: 'about:blank',
      status: 403,
      title: 'Forbidden',
      detail: 'Not permitted.',
    }),
  );
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_updateForm',
    arguments: {
      business: 'other-agency',
      params: { id: FORM },
      body: { name: 'Wedding enquiry', definition: { fields: [] }, revision: REVISION },
    },
  });
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 403 } });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ operationId: 'getForm' }),
    { params: { id: FORM } },
    { businessSlug: 'other-agency' },
  );
});

it('refuses protected form fields even with an explicit business target', async () => {
  const request = vi.fn();
  const client = await connect(request);
  const result = await client.callTool({
    name: 'crm_updateForm',
    arguments: {
      business: 'harbor-lights',
      params: { id: FORM },
      body: {
        name: 'Wedding enquiry',
        definition: { fields: [] },
        revision: REVISION,
        allowedOrigins: ['https://evil.example'],
      },
    },
  });
  expect(result.isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});
