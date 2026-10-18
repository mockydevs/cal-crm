// The in-app assistant's tools, as the server's own routes. A tool call is not a second
// implementation of anything: it finds the route the API serves for that operation and runs
// it in process, with the invocation it is given. So a tool validates as the API does, runs
// the command the API runs, is audited as that command is, and reads and writes under the
// same row-level security. Whatever the route refuses, the tool refuses.
//
// What this file adds is only what a model needs around a route:
//   * the tool's name, description and input schema, derived from the operation's contract;
//   * the tool's input checked against that schema before the route sees it, so a wrong
//     call is an answer the model reads;
//   * what a tool may not set (the registry's `preserve`) filled in from the record as it
//     is now;
//   * a refusal or a failure turned into text for the model, and never thrown;
//   * a sentence for the thread about what the tool did, written here from what the route
//     answered: never the model's own account.
import type { ApiRoute, Invocation, Services } from '@repo/commands';
import {
  assistantToolInput,
  assistantToolJsonSchema,
  assistantToolName,
  assistantTools,
  type AssistantTarget,
  type AssistantTool,
  type AssistantToolEffect,
} from '@repo/contracts';
import { AppError, ForbiddenError, ValidationError } from '@repo/kernel';

import { assistantData, type LoopTool } from './assistant-loop.js';
import { isRecord, type JsonRecord } from './json.js';
import type { JsonObject } from './provider.js';

/** The most of a tool's answer a model is given. A longer one is cut, and says so. */
export const TOOL_RESULT_MAX_LENGTH = 24_000;

/** What running a tool came to. */
export interface ToolRun {
  readonly ok: boolean;
  /** What the model reads. */
  readonly text: string;
  /** What the thread says of it, and what it links to. */
  readonly activity: { readonly text: string; readonly target: AssistantTarget | null };
  /** For a refusal: its category, such as forbidden. */
  readonly code: string | null;
}

export interface AssistantToolbox {
  /** The tools this install can offer: the registry's, where the API serves the operation. */
  readonly tools: readonly LoopTool[];
  /** Runs a tool that reads or drafts, as the invocation. Never throws for a refusal. */
  run(tool: LoopTool, input: JsonObject, invocation: Invocation): Promise<ToolRun>;
  /**
   * A confirm tool's input, checked as the tool takes it: the operation's path parameters
   * and body, for whoever stores the proposal. A refusal says why in `text`.
   */
  check(
    tool: LoopTool,
    input: JsonObject,
  ):
    | { readonly ok: true; readonly params: JsonRecord; readonly body: JsonRecord }
    | { readonly ok: false; readonly text: string };
}

export interface AssistantToolboxOptions {
  /** Every route the API serves. A tool whose operation is not among them is not offered. */
  readonly routes: readonly ApiRoute[];
  readonly services: Services;
  /** The registry. The product's own unless a test hands another. */
  readonly registry?: readonly AssistantTool[];
  /** A fault of the server while a tool ran: for the log. The model is told only that it failed. */
  readonly onFault?: (operationId: string, error: unknown) => void;
}

const EFFECT_NOTES: Readonly<Record<AssistantToolEffect, string>> = {
  read: 'Reads only: it changes nothing.',
  draft: 'Makes or edits a draft. Nothing it changes is live.',
  confirm:
    'Does not run: it puts a card in front of the person, who decides. Call it only when they asked for it.',
};

const quoted = (name: unknown): string =>
  typeof name === 'string' && name.trim() !== '' ? ` “${name.trim().slice(0, 120)}”` : '';
const idOf = (value: unknown): string | null =>
  isRecord(value) && typeof value['id'] === 'string' ? value['id'] : null;
const target = (
  kind: AssistantTarget['kind'],
  id: string | null,
  section: string | null = null,
): AssistantTarget => ({ kind, id, section, path: null });
const countOf = (value: unknown): number =>
  isRecord(value) && Array.isArray(value['items']) ? value['items'].length : 0;
const many = (count: number, one: string, more: string): string =>
  `${String(count)} ${count === 1 ? one : more}`;

type Describe = (
  input: { readonly params: JsonRecord; readonly body: unknown },
  output: unknown,
) => ToolRun['activity'];

/**
 * What the thread says a tool did, by operation. Names come from what the route answered:
 * they are the business's own words, shown as text. An operation with no sentence of its
 * own gets its summary from the contract.
 */
const DESCRIBE: Readonly<Record<string, Describe>> = {
  listForms: (_input, output) => ({
    text: `Looked at the forms (${many(countOf(output), 'form', 'forms')})`,
    target: null,
  }),
  getForm: (_input, output) => ({
    text: `Read the form${quoted(isRecord(output) ? output['name'] : undefined)}`,
    target: target('form', idOf(output)),
  }),
  getAssistantContext: () => ({ text: 'Checked what is missing on the page', target: null }),
  getFormPreview: ({ params }) => ({
    text: 'Made a preview link for the form',
    target: target('form', typeof params['id'] === 'string' ? params['id'] : null),
  }),
  getFormAnalytics: ({ params }) => ({
    text: 'Read the form’s numbers',
    target: target('form', typeof params['id'] === 'string' ? params['id'] : null, 'analytics'),
  }),
  getFields: () => ({ text: 'Looked at the custom fields', target: null }),
  listTags: (_input, output) => ({
    text: `Looked at the tags (${many(countOf(output), 'tag', 'tags')})`,
    target: null,
  }),
  listAutomations: (_input, output) => ({
    text: `Looked at the workflows (${many(countOf(output), 'workflow', 'workflows')})`,
    target: null,
  }),
  createForm: (_input, output) => ({
    text: `Created the draft form${quoted(isRecord(output) ? output['name'] : undefined)}`,
    target: target('form', idOf(output)),
  }),
  updateForm: (_input, output) => ({
    text: `Saved the draft of the form${quoted(isRecord(output) ? output['name'] : undefined)}`,
    target: target('form', idOf(output)),
  }),
  createField: (_input, output) => ({
    text: `Added the field${quoted(isRecord(output) ? output['label'] : undefined)}`,
    target: target('field', idOf(output)),
  }),
  createTag: (_input, output) => ({
    text: `Created the tag${quoted(isRecord(output) ? output['name'] : undefined)}`,
    target: target('tag', idOf(output)),
  }),
};

/** What a refusal is called for programs, by the kind of error. */
const CODES: Readonly<Record<AppError['name'], string>> = {
  ValidationError: 'invalid',
  NotFoundError: 'not_found',
  ConflictError: 'conflict',
  ForbiddenError: 'forbidden',
  ContentTooLargeError: 'too_large',
};

/** A refusal as the model reads it: what the API's problem document would say. */
export function refusalText(error: AppError): string {
  return assistantData({
    error: CODES[error.name],
    message: error.message,
    ...(error instanceof ValidationError
      ? {
          issues: error.issues.map(({ path, code, message }) => ({ path, code, message })),
        }
      : {}),
    ...(error instanceof ForbiddenError && error.permission !== undefined
      ? { needs: error.permission }
      : {}),
  });
}

/** A route's answer as the model reads it: escaped as data, and cut when it is very long. */
function resultText(output: unknown): string {
  const text = assistantData(output === undefined ? { done: true } : output);
  return text.length <= TOOL_RESULT_MAX_LENGTH
    ? text
    : `${text.slice(0, TOOL_RESULT_MAX_LENGTH)}\n… (cut: the result was longer than a tool result may be)`;
}

/** The tools of this install and the way to run one. */
export function createAssistantToolbox(options: AssistantToolboxOptions): AssistantToolbox {
  const { routes, services } = options;
  const routeOf = (operationId: string): ApiRoute | undefined =>
    routes.find((route) => route.endpoint.operationId === operationId);

  const offered = (options.registry ?? assistantTools).flatMap((entry) => {
    const route = routeOf(entry.operationId);
    // An upload or a download is not something a model can send or read.
    if (
      route === undefined ||
      route.endpoint.upload !== undefined ||
      route.endpoint.download !== undefined
    )
      return [];
    // What a tool may not set is read from the record: without that route there is no tool.
    if (entry.preserve !== undefined && routeOf(entry.preserve.from) === undefined) return [];
    const tool: LoopTool = {
      ...(route.command === undefined ? {} : { commandName: route.command.name }),
      operationId: entry.operationId,
      effect: entry.effect,
      definition: {
        name: assistantToolName(entry.operationId),
        description: `${route.endpoint.summary}. ${EFFECT_NOTES[entry.effect]}`,
        inputSchema: assistantToolJsonSchema(route.endpoint, entry),
      },
    };
    return [{ entry, route, tool }];
  });
  const found = (tool: LoopTool) => {
    const one = offered.find((each) => each.entry.operationId === tool.operationId);
    if (one === undefined) throw new Error(`The assistant has no tool ${tool.operationId}.`);
    return one;
  };

  /** The tool's input as the operation takes it, or the reason it does not fit. */
  const parsed = (
    tool: LoopTool,
    input: JsonObject,
  ):
    | {
        readonly ok: true;
        readonly params: JsonRecord;
        readonly query: JsonRecord;
        readonly body: unknown;
      }
    | { readonly ok: false; readonly text: string } => {
    const { entry, route } = found(tool);
    const { endpoint } = route;
    // A model often leaves out a part that takes nothing: an empty object stands in for it.
    const given: JsonRecord = {
      ...input,
      ...(endpoint.params !== undefined && input['params'] === undefined ? { params: {} } : {}),
      ...(endpoint.query !== undefined && input['query'] === undefined ? { query: {} } : {}),
    };
    const checked = assistantToolInput(endpoint, entry).safeParse(given);
    if (!checked.success)
      return {
        ok: false,
        text: assistantData({
          error: 'invalid_input',
          message: 'The input does not fit this tool. Nothing was done.',
          issues: checked.error.issues.map((issue) => ({
            path: `/${issue.path.map(String).join('/')}`,
            message: issue.message,
          })),
        }),
      };
    // As the model sent it, not as the schema read it: the route validates for itself, and
    // applies its own defaults, exactly as it does for a request.
    return {
      ok: true,
      params: isRecord(given['params']) ? given['params'] : {},
      query: isRecord(given['query']) ? given['query'] : {},
      body: given['body'],
    };
  };

  return {
    tools: offered.map((each) => each.tool),

    check(tool, input) {
      const call = parsed(tool, input);
      if (!call.ok) return call;
      return { ok: true, params: call.params, body: isRecord(call.body) ? call.body : {} };
    },

    async run(tool, input, invocation) {
      const { entry, route } = found(tool);
      const failed = (text: string, code: string, words: string): ToolRun => ({
        ok: false,
        text,
        code,
        activity: { text: words, target: null },
      });
      const call = parsed(tool, input);
      if (!call.ok)
        return failed(call.text, 'invalid_input', `Could not use “${route.endpoint.summary}”`);
      try {
        let { body } = call;
        const { preserve } = entry;
        if (preserve !== undefined) {
          // What the tool may not set stays as the record has it, read as this person.
          const current: unknown = await routeOf(preserve.from)?.run(
            { invocation, params: call.params, query: {}, body: undefined },
            services,
          );
          body = {
            ...(isRecord(body) ? body : {}),
            ...Object.fromEntries(
              preserve.body.map((key) => [key, isRecord(current) ? current[key] : undefined]),
            ),
          };
        }
        const output: unknown = await route.run(
          { invocation, params: call.params, query: call.query, body },
          services,
        );
        const describe = DESCRIBE[entry.operationId];
        return {
          ok: true,
          text: resultText(output),
          code: null,
          activity: describe?.({ params: call.params, body }, output) ?? {
            text: route.endpoint.summary,
            target: null,
          },
        };
      } catch (error) {
        if (error instanceof AppError)
          return failed(
            refusalText(error),
            CODES[error.name],
            error instanceof ForbiddenError
              ? `Was not allowed to: ${route.endpoint.summary.toLowerCase()}`
              : `Could not: ${route.endpoint.summary.toLowerCase()}`,
          );
        // A fault of the server's own: the model is told nothing of what it was.
        options.onFault?.(entry.operationId, error);
        return failed(
          assistantData({
            error: 'failed',
            message: 'Something went wrong running this tool. Nothing can be said of its result.',
          }),
          'failed',
          `Could not: ${route.endpoint.summary.toLowerCase()}`,
        );
      }
    },
  };
}
