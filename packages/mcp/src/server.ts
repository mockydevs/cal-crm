import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  assistantToolInput,
  assistantToolName,
  assistantTools,
  createBusinessInput,
  endpoints,
  type Endpoint,
} from '@repo/contracts';
import { ApiError, type Client, type RequestOptions } from '@repo/sdk';

// Authoring tools, and the few record tools authoring needs: no sending, deleting, billing
// or provider configuration.
const authoringOperations = new Set([
  'listBusinesses',
  'getApiKeyContext',
  'getAutomationCatalog',
  'getAutomationSchema',
  'listAutomations',
  'getAutomation',
  'createAutomation',
  'replaceAutomationDraft',
  'patchAutomationDraft',
  'validateAutomation',
  'createAutomationTestRun',
  'getAutomationTestRun',
  'listAutomationRuns',
  'getAutomationRun',
  // Why a workflow did, or did not, start for a contact: read-only facts the match kept,
  // so an assistant answers "why not" from the record and never from a guess. Continuing
  // or retrying a run is not offered: either can send, and sends stay a person's.
  'listAutomationTriggerEvaluations',
  'explainAutomationContact',
  'getFields',
  'createField',
  'listForms',
  'getForm',
  'listMessageTemplates',
  'getMessageTemplate',
  'createMessageTemplate',
  // The canonical, revision-checked copy of a template into a workflow's email step: the
  // server makes the copy, so the AI never rebuilds a template's content by hand.
  'copyWorkflowEmailTemplate',
  // Read the email's content and effects without sending or editing a shared template.
  'getEmailReport',
  'listTemplateWorkflowActions',
  'getWorkflowEmailStepStatistics',
  'renderEmailPreview',
  // Read-only discovery of what a document refers to, so no id is ever guessed.
  'getPipelines',
  'listTags',
  'listCalendars',
  // What a document's tag steps and field conditions need to exist: a tag by name, and a
  // field's value on a record, read first so the write carries the revision it saw.
  'createTag',
  'getRecordFields',
  'setRecordField',
]);

/** What publishes, outside the registry: offered only where the operator opted in. */
const PUBLISHING = new Set(['publishAutomation']);

function answer(value: unknown): CallToolResult {
  const structuredContent =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : { result: value ?? null };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** MCP authoring uses the same SDK contracts and API authorization as the dashboard. */
export function createCrmMcpServer(options: {
  readonly client: Client;
  /** Explicitly opt in to exposing publish; the API still checks the key's permission. */
  readonly allowPublish?: boolean;
}): McpServer {
  const server = new McpServer({ name: 'crm-authoring', version: '0.0.0' });
  const request: (
    endpoint: Endpoint,
    input: unknown,
    options?: RequestOptions,
  ) => Promise<unknown> = options.client.request.bind(options.client);
  const endpointOf = (operationId: string): Endpoint | undefined =>
    endpoints.find((each) => each.operationId === operationId);
  for (const endpoint of endpoints) {
    // The assistant's tool registry is one list for the app and for this server: what reads
    // and what drafts is offered, and what makes something live only where the operator
    // opted in. The authoring list above stays as it was.
    const tool = assistantTools.find((each) => each.operationId === endpoint.operationId);
    const publishes =
      tool === undefined ? PUBLISHING.has(endpoint.operationId) : tool.effect === 'confirm';
    if (tool === undefined && !publishes && !authoringOperations.has(endpoint.operationId))
      continue;
    if (publishes && options.allowPublish !== true) continue;
    // Preview uses POST for its bounded content/sample input, but changes nothing.
    const readOnly =
      tool === undefined
        ? endpoint.method === 'get' || endpoint.operationId === 'renderEmailPreview'
        : tool.effect === 'read';
    const preserve = tool?.preserve;
    server.registerTool(
      assistantToolName(endpoint.operationId),
      {
        title: endpoint.summary,
        description: `${endpoint.summary}. Uses the key's default scope, or the optional business slug from crm_listBusinesses; the API checks access. Read the catalog and schema before authoring; dry runs do not send messages.`,
        // The registry's own reading of a tool's input: the operation's parameters, query
        // and body, without what a tool may not set.
        inputSchema: assistantToolInput(endpoint, tool).extend({
          business: createBusinessInput.shape.slug.meta({
            description:
              "Optional business slug from crm_listBusinesses; omitted uses the key's default scope.",
          }),
        }),
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: publishes,
          idempotentHint: readOnly,
          openWorldHint: false,
        },
      },
      async (input): Promise<CallToolResult> => {
        try {
          const { business: selectedBusiness, ...apiInput } = input;
          const business = createBusinessInput.shape.slug.parse(selectedBusiness);
          // Both preservation reads and writes close over this call's target only.
          const call = (endpoint: Endpoint, input: unknown): Promise<unknown> =>
            business === undefined
              ? request(endpoint, input)
              : request(endpoint, input, { businessSlug: business });
          let sent: unknown = apiInput;
          const from = preserve === undefined ? undefined : endpointOf(preserve.from);
          if (preserve !== undefined && from !== undefined) {
            // What a tool may not set stays as the record has it now: read first, with
            // the same path parameters, and sent back unchanged.
            const current = await call(from, { params: apiInput['params'] });
            sent = {
              ...apiInput,
              body: {
                ...(isRecord(apiInput['body']) ? apiInput['body'] : {}),
                ...Object.fromEntries(
                  preserve.body.map((key) => [key, isRecord(current) ? current[key] : undefined]),
                ),
              },
            };
          }
          const result = await call(endpoint, sent);
          return answer(result);
        } catch (error) {
          if (error instanceof ApiError) return { ...answer(error.problem), isError: true };
          // Never echo a URL, request header, credential or raw transport exception.
          return {
            isError: true,
            content: [
              { type: 'text', text: 'CRM request failed. Check the connection and retry.' },
            ],
          };
        }
      },
    );
  }
  return server;
}
