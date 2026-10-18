import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { endpoints } from './api.js';
import {
  assistantToolByName,
  assistantToolEndpoints,
  assistantToolInput,
  assistantToolJsonSchema,
  assistantToolName,
  assistantTools,
} from './assistant-tools.js';
import { defineEndpoint } from './endpoints.js';
import { openApiDocument } from './openapi.js';

/** Every operation id the OpenAPI document has, read as the JSON it is published as. */
const operationIds = (): Set<string> => {
  const document: unknown = JSON.parse(JSON.stringify(openApiDocument()));
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'operationId' && typeof value === 'string') ids.add(value);
      else walk(value);
    }
  };
  walk(document);
  return ids;
};

const byEffect = (effect: string): string[] =>
  assistantTools
    .filter((tool) => tool.group === 'forms' && tool.effect === effect)
    .map((tool) => tool.operationId);

describe('the assistant’s tool registry', () => {
  it('offers canonical CRM reads, workflow drafts and confirmation-only live configuration', () => {
    for (const operationId of [
      'getPipelines',
      'listCalendars',
      'getContact',
      'getDeals',
      'getEmailReport',
      'explainAutomationContact',
      'listRecordActivity',
    ])
      expect(
        assistantTools.find((tool) => tool.operationId === operationId)?.effect,
        operationId,
      ).toBe('read');
    for (const operationId of [
      'createAutomation',
      'replaceAutomationDraft',
      'patchAutomationDraft',
      'createAutomationTestRun',
    ])
      expect(
        assistantTools.find((tool) => tool.operationId === operationId)?.effect,
        operationId,
      ).toBe('draft');
    for (const operationId of [
      'savePipelines',
      'createCalendar',
      'updateCalendar',
      'updateCalendarAvailability',
      'publishAutomation',
    ])
      expect(
        assistantTools.find((tool) => tool.operationId === operationId)?.effect,
        operationId,
      ).toBe('confirm');
  });
  it('names only operations the OpenAPI document has, each once', () => {
    const known = operationIds();
    for (const tool of assistantTools)
      expect(known.has(tool.operationId), tool.operationId).toBe(true);
    expect(new Set(assistantTools.map((tool) => tool.operationId)).size).toBe(
      assistantTools.length,
    );
  });

  it('lists the forms tools of stage 1 by what each does', () => {
    expect(assistantTools.filter((tool) => tool.group === 'forms')).not.toHaveLength(0);
    expect(byEffect('read')).toEqual([
      'listForms',
      'getForm',
      'getAssistantContext',
      'getFormPreview',
      'getFormAnalytics',
      'getFields',
      'listTags',
      'listAutomations',
    ]);
    expect(byEffect('draft')).toEqual(['createForm', 'updateForm', 'createField', 'createTag']);
    // Only publishing makes anything live, and it is the one tool a person confirms.
    expect(byEffect('confirm')).toEqual(['publishForm']);
  });

  it('never offers what sends, deletes or withdraws', () => {
    const offered = assistantTools.map((tool) => tool.operationId);
    for (const operationId of [
      'unpublishForm',
      'archiveForm',
      'discardFormSubmission',
      'deleteField',
      'sendConversationReply',
      'applyProposal',
      'setAutonomy',
    ])
      expect(offered).not.toContain(operationId);
  });

  it('names a tool crm_ and its operation, and finds it again by that name', () => {
    expect(assistantToolName('getForm')).toBe('crm_getForm');
    expect(assistantToolByName('crm_publishForm')).toMatchObject({ effect: 'confirm' });
    expect(assistantToolByName('crm_deleteField')).toBeUndefined();
    expect(assistantToolByName('getForm')).toBeUndefined();
    expect(assistantToolByName('crm_')).toBeUndefined();
  });

  it('pairs every tool with its endpoint, and refuses a tool that names none', () => {
    const paired = assistantToolEndpoints(endpoints);
    expect(paired.map(({ endpoint }) => endpoint.operationId)).toEqual(
      assistantTools.map((tool) => tool.operationId),
    );
    expect(() =>
      assistantToolEndpoints(endpoints, [
        { operationId: 'inventedOperation', group: 'forms', effect: 'read' },
      ]),
    ).toThrow('names no API operation');
  });
});

describe('a tool’s input', () => {
  const schemaOf = (operationId: string) => {
    const [found] = assistantToolEndpoints(
      endpoints,
      assistantTools.filter((tool) => tool.operationId === operationId),
    );
    if (found === undefined) throw new Error(`No tool ${operationId}.`);
    return {
      json: assistantToolJsonSchema(found.endpoint, found.tool),
      input: assistantToolInput(found.endpoint, found.tool),
    };
  };

  it('is an object schema with no references for every tool', () => {
    for (const { tool, endpoint } of assistantToolEndpoints(endpoints)) {
      const schema = assistantToolJsonSchema(endpoint, tool);
      const text = JSON.stringify(schema);
      expect(schema['type'], tool.operationId).toBe('object');
      expect(text, tool.operationId).not.toContain('$ref');
      expect(text, tool.operationId).not.toContain('$defs');
      expect(text, tool.operationId).not.toContain('$schema');
      expect(schema['additionalProperties'], tool.operationId).toBe(false);
    }
  });

  it('carries the path parameters, the query and the body under their own names', () => {
    const { json } = schemaOf('getFormAnalytics');
    expect(json['required']).toEqual(['params', 'query']);
    expect(json).toHaveProperty('properties.params.properties.id.type', 'string');
    expect(json).toHaveProperty('properties.query.properties.from');
    expect(schemaOf('createForm').json).toHaveProperty(
      'properties.body.properties.name.type',
      'string',
    );
    // An operation that takes nothing takes an empty object.
    expect(schemaOf('getFields').json).toMatchObject({ type: 'object', properties: {} });
  });

  it('writes a shared shape out where it is used, with its description and its defaults', () => {
    const { json } = schemaOf('updateForm');
    expect(json).toHaveProperty(
      'properties.body.properties.definition.properties.fields.items.properties.target.default',
      { kind: 'none' },
    );
    // A property called `id` is a property, not a schema's name.
    expect(schemaOf('getForm').json).toHaveProperty('properties.params.properties.id');
    expect(JSON.stringify(json)).toContain('A field id.');
  });

  it('leaves the websites that may show a form out of what a tool may send', () => {
    const { json, input } = schemaOf('updateForm');
    expect(json).toHaveProperty('properties.body.properties.name');
    expect(json).not.toHaveProperty('properties.body.properties.allowedOrigins');
    expect(json).toHaveProperty('properties.body.required', ['name', 'definition', 'revision']);
    const sent = {
      params: { id: 'form_01h455vb4pex5vsknk084sn02q' },
      body: { name: 'Wedding enquiry', definition: { fields: [] }, revision: 'a'.repeat(64) },
    };
    expect(input.safeParse(sent).success).toBe(true);
    expect(
      input.safeParse({ ...sent, body: { ...sent.body, allowedOrigins: ['https://evil.example'] } })
        .success,
    ).toBe(false);
  });

  it('keeps a body that is not an object, and one with nothing to leave out, whole', () => {
    const listed = defineEndpoint({
      operationId: 'exampleList',
      method: 'post',
      path: '/examples',
      summary: 'An example',
      group: 'Examples',
      body: z.array(z.string()),
      response: { status: 200, description: 'Done.' },
    });
    const tool = {
      operationId: 'exampleList',
      group: 'forms',
      effect: 'draft',
      preserve: { from: 'exampleRead', body: ['anything'] },
    } as const;
    expect(assistantToolJsonSchema(listed, tool)).toHaveProperty('properties.body.type', 'array');
    expect(assistantToolJsonSchema(listed)).toHaveProperty('properties.body.type', 'array');
  });

  it('refuses a shape that contains itself, which cannot be written out', () => {
    interface Node {
      readonly children: Node[];
    }
    const node: z.ZodType<Node> = z
      .strictObject({
        get children() {
          return z.array(node);
        },
      })
      .meta({ id: 'ExampleNode' });
    const recursive = defineEndpoint({
      operationId: 'exampleTree',
      method: 'post',
      path: '/examples/tree',
      summary: 'An example',
      group: 'Examples',
      body: node,
      response: { status: 200, description: 'Done.' },
    });
    expect(() => assistantToolJsonSchema(recursive)).toThrow('cannot write out');
  });
});
