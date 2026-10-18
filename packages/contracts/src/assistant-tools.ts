// The assistant's tools: one registry, read by the in-app assistant and by the MCP server
// for outside AI clients. A tool is one of the API's own operations, named by its operation
// id, so calling one is calling the API: the same validation, command, audit and row-level
// security, and never more than the caller's own permissions allow.
//
// Each tool says what calling it does:
//   * `read` changes nothing;
//   * `draft` makes or edits something that is not live: a draft form, a field, a tag;
//   * `confirm` makes something live. In the app the assistant never runs one: it stores a
//     proposal, and a person confirms it. Over MCP it is offered only where the operator
//     opted in (CRM_MCP_ALLOW_PUBLISH=true).
//
// Adding an area is listing its operations here (and writing its page checks).
import * as z from 'zod';

import type { Endpoint } from './endpoints.js';

export const assistantToolEffects = ['read', 'draft', 'confirm'] as const;
export type AssistantToolEffect = (typeof assistantToolEffects)[number];

/** The areas tools are grouped by. Stage 1 has forms. */
export const assistantToolGroups = [
  'forms',
  'pipelines',
  'calendars',
  'workflows',
  'contacts',
  'reports',
] as const;
export type AssistantToolGroup = (typeof assistantToolGroups)[number];

export interface AssistantTool {
  /** The API operation the tool runs (packages/contracts/openapi.json). */
  readonly operationId: string;
  readonly group: AssistantToolGroup;
  readonly effect: AssistantToolEffect;
  /**
   * Parts of the operation's body a tool may not set. They are left out of the tool's input,
   * and whoever runs the tool fills them in from what the record holds now, read with the
   * operation named by `from` and the same path parameters.
   */
  readonly preserve?: { readonly from: string; readonly body: readonly string[] };
}

/** Every tool, in the order a client lists them. */
export const assistantTools: readonly AssistantTool[] = [
  // Forms: what a form builder needs to see first.
  { operationId: 'listForms', group: 'forms', effect: 'read' },
  { operationId: 'getForm', group: 'forms', effect: 'read' },
  // What is missing on a page: the server's own checks, computed without a model.
  { operationId: 'getAssistantContext', group: 'forms', effect: 'read' },
  { operationId: 'getFormPreview', group: 'forms', effect: 'read' },
  { operationId: 'getFormAnalytics', group: 'forms', effect: 'read' },
  { operationId: 'getFields', group: 'forms', effect: 'read' },
  { operationId: 'listTags', group: 'forms', effect: 'read' },
  { operationId: 'listAutomations', group: 'forms', effect: 'read' },
  // Drafts: nothing here reaches a visitor until the form is published.
  { operationId: 'createForm', group: 'forms', effect: 'draft' },
  // The websites that may show a form apply at once, so they are not a draft: a tool never
  // sets them. They stay as the form has them.
  {
    operationId: 'updateForm',
    group: 'forms',
    effect: 'draft',
    preserve: { from: 'getForm', body: ['allowedOrigins'] },
  },
  { operationId: 'createField', group: 'forms', effect: 'draft' },
  { operationId: 'createTag', group: 'forms', effect: 'draft' },
  // Live: a person confirms.
  { operationId: 'publishForm', group: 'forms', effect: 'confirm' },
  { operationId: 'getPipelines', group: 'pipelines', effect: 'read' },
  { operationId: 'getOpportunitySettings', group: 'pipelines', effect: 'read' },
  { operationId: 'savePipelines', group: 'pipelines', effect: 'confirm' },
  { operationId: 'listCalendars', group: 'calendars', effect: 'read' },
  { operationId: 'getCalendar', group: 'calendars', effect: 'read' },
  { operationId: 'getCalendarAvailability', group: 'calendars', effect: 'read' },
  { operationId: 'listCalendarSenders', group: 'calendars', effect: 'read' },
  { operationId: 'listCalendarGroups', group: 'calendars', effect: 'read' },
  { operationId: 'listUsers', group: 'calendars', effect: 'read' },
  { operationId: 'listAppointments', group: 'calendars', effect: 'read' },
  { operationId: 'getAppointment', group: 'calendars', effect: 'read' },
  { operationId: 'createCalendar', group: 'calendars', effect: 'confirm' },
  { operationId: 'updateCalendar', group: 'calendars', effect: 'confirm' },
  { operationId: 'updateCalendarAvailability', group: 'calendars', effect: 'confirm' },
  { operationId: 'getAutomation', group: 'workflows', effect: 'read' },
  { operationId: 'getProposal', group: 'workflows', effect: 'read' },
  { operationId: 'getAutomationSchema', group: 'workflows', effect: 'read' },
  { operationId: 'getAutomationCatalog', group: 'workflows', effect: 'read' },
  { operationId: 'validateAutomation', group: 'workflows', effect: 'read' },
  { operationId: 'createAutomation', group: 'workflows', effect: 'draft' },
  { operationId: 'replaceAutomationDraft', group: 'workflows', effect: 'draft' },
  { operationId: 'patchAutomationDraft', group: 'workflows', effect: 'draft' },
  { operationId: 'createAutomationTestRun', group: 'workflows', effect: 'draft' },
  { operationId: 'getAutomationTestRun', group: 'workflows', effect: 'read' },
  { operationId: 'publishAutomation', group: 'workflows', effect: 'confirm' },
  { operationId: 'listAutomationRuns', group: 'workflows', effect: 'read' },
  { operationId: 'getAutomationRun', group: 'workflows', effect: 'read' },
  { operationId: 'listAutomationStepRuns', group: 'workflows', effect: 'read' },
  { operationId: 'listRecordAutomationRuns', group: 'workflows', effect: 'read' },
  { operationId: 'listAutomationTriggerEvaluations', group: 'workflows', effect: 'read' },
  { operationId: 'explainAutomationContact', group: 'workflows', effect: 'read' },
  { operationId: 'getContact', group: 'contacts', effect: 'read' },
  { operationId: 'listContacts', group: 'contacts', effect: 'read' },
  { operationId: 'getContactDetails', group: 'contacts', effect: 'read' },
  { operationId: 'getContactMemory', group: 'contacts', effect: 'read' },
  { operationId: 'getContactJourney', group: 'contacts', effect: 'read' },
  { operationId: 'getRecordFields', group: 'contacts', effect: 'read' },
  { operationId: 'getDeals', group: 'contacts', effect: 'read' },
  { operationId: 'getDeal', group: 'contacts', effect: 'read' },
  { operationId: 'listRecordActivity', group: 'contacts', effect: 'read' },
  { operationId: 'explainEvent', group: 'contacts', effect: 'read' },
  { operationId: 'getReportCatalog', group: 'reports', effect: 'read' },
  { operationId: 'runReportQuery', group: 'reports', effect: 'read' },
  { operationId: 'getEmailReport', group: 'reports', effect: 'read' },
  { operationId: 'getAppointmentReport', group: 'reports', effect: 'read' },
  { operationId: 'getAttributionReport', group: 'reports', effect: 'read' },
];

/** What a tool is called by a model and by an MCP client: `crm_` and the operation id. */
export const ASSISTANT_TOOL_PREFIX = 'crm_';

export function assistantToolName(operationId: string): string {
  return `${ASSISTANT_TOOL_PREFIX}${operationId}`;
}

/** The tool a name names, or undefined: a model can ask for a tool that does not exist. */
export function assistantToolByName(name: string): AssistantTool | undefined {
  if (!name.startsWith(ASSISTANT_TOOL_PREFIX)) return undefined;
  const operationId = name.slice(ASSISTANT_TOOL_PREFIX.length);
  return assistantTools.find((tool) => tool.operationId === operationId);
}

/**
 * Each tool with the endpoint it runs, from the API's own list. A tool that names an
 * operation the API does not have is a bug in the registry, and throws.
 */
export function assistantToolEndpoints(
  endpoints: readonly Endpoint[],
  tools: readonly AssistantTool[] = assistantTools,
): readonly { readonly tool: AssistantTool; readonly endpoint: Endpoint }[] {
  return tools.map((tool) => {
    const endpoint = endpoints.find((each) => each.operationId === tool.operationId);
    if (endpoint === undefined)
      throw new Error(`The assistant's tool ${tool.operationId} names no API operation.`);
    return { tool, endpoint };
  });
}

/**
 * What a tool takes: the operation's path parameters, query and body, each under its own
 * name, without the parts of the body the tool may not set.
 */
export function assistantToolInput(endpoint: Endpoint, tool?: AssistantTool): z.ZodObject {
  const kept = tool?.preserve?.body ?? [];
  const body =
    endpoint.body instanceof z.ZodObject && kept.length > 0
      ? z.strictObject(
          Object.fromEntries(
            Object.entries(endpoint.body.shape).filter(([key]) => !kept.includes(key)),
          ),
        )
      : endpoint.body;
  return z.strictObject({
    ...(endpoint.params === undefined ? {} : { params: endpoint.params }),
    ...(endpoint.query === undefined ? {} : { query: endpoint.query }),
    ...(body === undefined ? {} : { body }),
  });
}

type JsonSchema = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keywords whose value is plain data, never a schema: left exactly as they are. */
const DATA_KEYWORDS = new Set(['default', 'examples', 'const', 'enum', 'required']);
/** Keywords whose value maps names to schemas: the names are kept, whatever they are. */
const NAMED_SCHEMAS = new Set(['properties', 'patternProperties']);

/**
 * Writes every `$ref` out in place, so the schema is one document with no definitions, and
 * leaves out what only names a schema (`$schema`, and the `id` a contract gives a shape).
 */
function inlined(node: unknown, definitions: Record<string, unknown>, seen: string[]): unknown {
  if (Array.isArray(node)) return node.map((each) => inlined(each, definitions, seen));
  if (!isObject(node)) return node;
  const reference = node['$ref'];
  if (typeof reference === 'string') {
    const name = reference.replace(/^#\/\$defs\//, '');
    // A schema that contains itself cannot be written out; none of the API's does.
    if (seen.includes(name) || !Object.hasOwn(definitions, name))
      throw new Error(`The tool schema cannot write out ${reference}.`);
    const { $ref: _reference, ...rest } = node;
    const target = inlined(definitions[name], definitions, [...seen, name]);
    return { ...(isObject(target) ? target : {}), ...inlinedKeywords(rest, definitions, seen) };
  }
  return inlinedKeywords(node, definitions, seen);
}

function inlinedKeywords(
  node: Record<string, unknown>,
  definitions: Record<string, unknown>,
  seen: string[],
): Record<string, unknown> {
  const written: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$defs' || key === '$schema' || key === 'id') continue;
    if (DATA_KEYWORDS.has(key)) written[key] = value;
    else if (NAMED_SCHEMAS.has(key) && isObject(value))
      written[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, inlined(schema, definitions, seen)]),
      );
    else written[key] = inlined(value, definitions, seen);
  }
  return written;
}

/**
 * A tool's input as the JSON Schema a model provider takes: derived from the operation's
 * own contract, so a tool can never describe an input the API would not accept. It is what
 * a caller sends (before defaults), in one document without references. What JSON Schema
 * cannot say (a cross-field rule) is left to the API, which checks every call anyway.
 */
export function assistantToolJsonSchema(endpoint: Endpoint, tool?: AssistantTool): JsonSchema {
  const schema: unknown = z.toJSONSchema(assistantToolInput(endpoint, tool), {
    io: 'input',
    unrepresentable: 'any',
    target: 'draft-2020-12',
  });
  if (!isObject(schema)) throw new Error('A tool schema is not an object.');
  const definitions = isObject(schema['$defs']) ? schema['$defs'] : {};
  const written = inlined(schema, definitions, []);
  if (!isObject(written) || written['type'] !== 'object')
    throw new Error('A tool schema is not an object.');
  return written;
}
