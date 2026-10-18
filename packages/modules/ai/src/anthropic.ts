// The Claude adapter: the Messages API over HTTP, as Anthropic's API reference documents
// it.
//
//   POST {base}/v1/messages   headers x-api-key, anthropic-version: 2023-06-01
//   GET  {base}/v1/models
//
// Every message is streamed (`stream: true`), which is what Anthropic recommends for long
// requests: an answer of many minutes then keeps its connection alive, and the adapter puts
// the events back together into one turn.
//
// What it deliberately does not send: `temperature`, `top_p` and `top_k` (current models
// refuse them), `thinking` (current models think by default and some refuse it being turned
// off), `tool_choice` (current models refuse a forced tool; the default is `auto`), and any
// beta header.
import {
  DEFAULT_TIMEOUT_MS,
  failure,
  joinUrl,
  retryAfterMs,
  SMALL_BODY_BYTES,
  transportFailure,
  type ProviderFailure,
} from './adapter-common.js';
import {
  countAt,
  isRecord,
  listAt,
  parseJson,
  recordAt,
  sortKeys,
  stringAt,
  type JsonRecord,
} from './json.js';
import type {
  AiMessage,
  AiProvider,
  AssistantPart,
  CacheTtl,
  ModelList,
  ProviderErrorCode,
  ProviderRequest,
  ProviderResponse,
  StopReason,
  TokenUsage,
} from './provider.js';
import { readSse } from './sse.js';
import { readBody, type AiHttpAnswer, type AiTransport } from './transport.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly transport: AiTransport;
  /**
   * Trusted composition only (a test's stand-in): never a value from the database or from
   * a person. A Claude key goes to Anthropic's address and nowhere else.
   */
  readonly baseUrl?: string;
}

/**
 * The cache breakpoint. Five minutes is the API's default and is sent as it always was,
 * with no `ttl`; an hour is `"ttl": "1h"`, and needs no beta header
 * (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, "1-hour cache
 * duration"). A request has one breakpoint, so the rule that a longer lifetime must come
 * before a shorter one is never in play.
 */
function cacheControl(ttl: CacheTtl | undefined): JsonRecord {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/** A thinking block exactly as Claude wrote it, or nothing when it is not one. */
function thinkingBlock(data: JsonRecord): JsonRecord | undefined {
  if (
    data['type'] === 'thinking' &&
    typeof data['thinking'] === 'string' &&
    typeof data['signature'] === 'string'
  )
    return data;
  if (data['type'] === 'redacted_thinking' && typeof data['data'] === 'string') return data;
  return undefined;
}

function assistantBlocks(parts: readonly AssistantPart[]): JsonRecord[] {
  const blocks: JsonRecord[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      // The API refuses an empty text block.
      if (part.text !== '') blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'tool_call') {
      blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input });
    } else if (part.provider === 'anthropic') {
      const block = thinkingBlock(part.data);
      if (block !== undefined) blocks.push(block);
    }
  }
  return blocks;
}

function messagesOf(messages: readonly AiMessage[]): JsonRecord[] {
  const sent: JsonRecord[] = [];
  for (const message of messages) {
    if (message.role === 'user') sent.push({ role: 'user', content: message.text });
    else if (message.role === 'tool')
      sent.push({
        role: 'user',
        content: message.results.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: result.text,
          ...(result.isError === true ? { is_error: true } : {}),
        })),
      });
    else {
      const content = assistantBlocks(message.parts);
      if (content.length > 0) sent.push({ role: 'assistant', content });
    }
  }
  return sent;
}

/**
 * The request body, as text. The prefix a prompt cache matches on is `tools`, then
 * `system`: both are written the same way every time (tools by name, every schema with its
 * keys in order), and the cache breakpoint sits at the end of that prefix, so everything a
 * business adds comes after it.
 *
 * The messages are written as they were given. An earlier turn of the model's must come
 * back as the model wrote it, so nothing in a message is reordered.
 */
export function anthropicBody(request: ProviderRequest): string {
  const control = cacheControl(request.cacheTtl);
  const tools = [...(request.tools ?? [])]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((tool, index, all) => ({
      name: tool.name,
      description: tool.description,
      input_schema: sortKeys(tool.inputSchema),
      // With no system prompt, the tool list is the whole shared prefix.
      ...(request.system === '' && index === all.length - 1 ? { cache_control: control } : {}),
    }));
  return JSON.stringify({
    model: request.model,
    max_tokens: request.maxOutputTokens,
    stream: true,
    ...(request.system === ''
      ? {}
      : { system: [{ type: 'text', text: request.system, cache_control: control }] }),
    ...(tools.length === 0 ? {} : { tools }),
    messages: messagesOf(request.messages),
  });
}

// https://platform.claude.com/docs/en/api/errors, "HTTP errors".
function statusFailure(answer: AiHttpAnswer): ProviderFailure {
  const { status } = answer;
  const wait = retryAfterMs(answer.header('retry-after'));
  if (status === 401 || status === 403) return failure('authentication');
  if (status === 402) return failure('billing');
  if (status === 429) return failure('rate_limited', null, wait);
  if (status >= 500) return failure('unavailable', null, wait);
  // A model the provider does not have, or an address with nothing behind its path.
  if (status === 404) return failure('not_found');
  if (status >= 400) return failure('invalid_request');
  // Not an error and not the answer: a redirect, which is never followed.
  return failure('invalid_response');
}

// The `error.type` values of the same page, for an error that arrives inside a stream.
const STREAM_ERRORS: Readonly<Record<string, ProviderErrorCode>> = {
  authentication_error: 'authentication',
  permission_error: 'authentication',
  billing_error: 'billing',
  rate_limit_error: 'rate_limited',
  invalid_request_error: 'invalid_request',
  not_found_error: 'not_found',
  request_too_large: 'invalid_request',
};

type Draft =
  | { readonly kind: 'text'; text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; json: string }
  | { readonly kind: 'thinking'; thinking: string; signature: string }
  | { readonly kind: 'opaque'; readonly block: JsonRecord }
  | { readonly kind: 'ignored' };

interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The one-hour part of the writes, when the API broke them down by lifetime. */
  cacheWrite1h: number | undefined;
}

class Malformed extends Error {}

function startBlock(block: JsonRecord | undefined): Draft {
  const type = stringAt(block, 'type');
  if (type === 'text') return { kind: 'text', text: stringAt(block, 'text') ?? '' };
  if (type === 'thinking')
    return {
      kind: 'thinking',
      thinking: stringAt(block, 'thinking') ?? '',
      signature: stringAt(block, 'signature') ?? '',
    };
  if (type === 'redacted_thinking' && block !== undefined && typeof block['data'] === 'string')
    return { kind: 'opaque', block };
  if (type === 'tool_use') {
    const id = stringAt(block, 'id');
    const name = stringAt(block, 'name');
    if (id === undefined || name === undefined) throw new Malformed();
    return { kind: 'tool', id, name, json: '' };
  }
  // A block this adapter never asks for, such as a server tool's.
  return { kind: 'ignored' };
}

function applyDelta(draft: Draft, delta: JsonRecord | undefined): string | undefined {
  const type = stringAt(delta, 'type');
  if (draft.kind === 'text' && type === 'text_delta') {
    const text = stringAt(delta, 'text') ?? '';
    draft.text += text;
    return text;
  }
  if (draft.kind === 'tool' && type === 'input_json_delta')
    draft.json += stringAt(delta, 'partial_json') ?? '';
  else if (draft.kind === 'thinking' && type === 'thinking_delta')
    draft.thinking += stringAt(delta, 'thinking') ?? '';
  else if (draft.kind === 'thinking' && type === 'signature_delta')
    draft.signature = stringAt(delta, 'signature') ?? '';
  return undefined;
}

function partOf(draft: Draft, cutOff: boolean): AssistantPart | undefined {
  if (draft.kind === 'text')
    return draft.text === '' ? undefined : { type: 'text', text: draft.text };
  if (draft.kind === 'thinking')
    return {
      type: 'reasoning',
      provider: 'anthropic',
      data: { type: 'thinking', thinking: draft.thinking, signature: draft.signature },
    };
  if (draft.kind === 'opaque')
    return { type: 'reasoning', provider: 'anthropic', data: draft.block };
  if (draft.kind === 'ignored' || cutOff) return undefined;
  // A tool with no arguments streams no input at all.
  const input = draft.json === '' ? {} : parseJson(draft.json);
  if (!isRecord(input)) throw new Malformed();
  return { type: 'tool_call', id: draft.id, name: draft.name, input };
}

const STOPS: Readonly<Record<string, StopReason>> = {
  end_turn: 'end',
  stop_sequence: 'end',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  tool_use: 'tool_calls',
};

/**
 * Puts a stream's events back together into one turn. `ttl` is the cache lifetime the
 * request asked for, which is what its writes were when the API does not say.
 */
async function readMessage(
  answer: AiHttpAnswer,
  onTextDelta: ((text: string) => void) | undefined,
  ttl: CacheTtl | undefined,
): Promise<ProviderResponse> {
  const drafts = new Map<number, Draft>();
  let counts: Counts | undefined;
  let stopReason: string | undefined;
  let category: string | null = null;
  let finished = false;
  const usage = (): TokenUsage | null => {
    if (counts === undefined) return null;
    // The request has one breakpoint, so without a breakdown every write is of its lifetime.
    const write1h = Math.min(
      counts.cacheWrite1h ?? (ttl === '1h' ? counts.cacheWrite : 0),
      counts.cacheWrite,
    );
    return {
      inputTokens: counts.input,
      outputTokens: counts.output,
      cacheReadTokens: counts.cacheRead,
      cacheWriteTokens: counts.cacheWrite,
      ...(write1h > 0 ? { cacheWrite1hTokens: write1h } : {}),
    };
  };
  // Counts are cumulative: a later event replaces what an earlier one said. Only the
  // message's own usage (message_start) has `cache_creation`, the writes by lifetime
  // (https://platform.claude.com/docs/en/api/messages, `Usage` and `MessageDeltaUsage`).
  const count = (reported: JsonRecord | undefined): void => {
    if (reported === undefined) return;
    counts = {
      input: countAt(reported, 'input_tokens') ?? counts?.input ?? 0,
      output: countAt(reported, 'output_tokens') ?? counts?.output ?? 0,
      cacheRead: countAt(reported, 'cache_read_input_tokens') ?? counts?.cacheRead ?? 0,
      cacheWrite: countAt(reported, 'cache_creation_input_tokens') ?? counts?.cacheWrite ?? 0,
      cacheWrite1h:
        countAt(recordAt(reported, 'cache_creation'), 'ephemeral_1h_input_tokens') ??
        counts?.cacheWrite1h,
    };
  };

  try {
    for await (const event of readSse(answer.body)) {
      const data = parseJson(event.data);
      if (!isRecord(data)) throw new Malformed();
      const type = stringAt(data, 'type');
      if (type === 'message_start') count(recordAt(recordAt(data, 'message'), 'usage'));
      else if (type === 'content_block_start') {
        const index = countAt(data, 'index');
        if (index === undefined) throw new Malformed();
        drafts.set(index, startBlock(recordAt(data, 'content_block')));
      } else if (type === 'content_block_delta') {
        const draft = drafts.get(countAt(data, 'index') ?? -1);
        if (draft === undefined) throw new Malformed();
        const text = applyDelta(draft, recordAt(data, 'delta'));
        if (text !== undefined && text !== '') onTextDelta?.(text);
      } else if (type === 'message_delta') {
        const delta = recordAt(data, 'delta');
        stopReason = stringAt(delta, 'stop_reason') ?? stopReason;
        category = stringAt(recordAt(delta, 'stop_details'), 'category') ?? category;
        count(recordAt(data, 'usage'));
      } else if (type === 'message_stop') {
        finished = true;
        break;
      } else if (type === 'error') {
        const kind = stringAt(recordAt(data, 'error'), 'type') ?? '';
        return failure(STREAM_ERRORS[kind] ?? 'unavailable', usage());
      }
      // Anything else (ping, content_block_stop, an event added since) changes nothing.
    }
    // The stream ended before the message did: the connection was lost on the way.
    if (!finished) return failure('unavailable', usage());
    if (stopReason === 'refusal') return { status: 'refused', category, usage: usage() };
    const stop = STOPS[stopReason ?? ''];
    if (stop === undefined) throw new Malformed();
    const parts = [...drafts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, draft]) => partOf(draft, stop === 'max_tokens'))
      .filter((part) => part !== undefined);
    if (stop === 'tool_calls' && !parts.some((part) => part.type === 'tool_call'))
      throw new Malformed();
    return { status: 'ok', parts, stop, usage: usage() };
  } catch (error) {
    if (error instanceof Malformed) return failure('invalid_response', usage());
    return transportFailure(error, usage());
  }
}

function modelsOf(text: string): ModelList {
  const ids = listAt(parseJson(text), 'data')?.map((model) => stringAt(model, 'id'));
  if (ids === undefined) return failure('invalid_response');
  const models = ids.filter((id) => id !== undefined);
  return models.length === ids.length ? { status: 'ok', models } : failure('invalid_response');
}

export function createAnthropicProvider(options: AnthropicOptions): AiProvider {
  const baseUrl = options.baseUrl ?? ANTHROPIC_BASE_URL;
  const headers = { 'x-api-key': options.apiKey, 'anthropic-version': ANTHROPIC_VERSION };

  return {
    async generate(request, call = {}) {
      let answer: AiHttpAnswer;
      try {
        answer = await options.transport({
          method: 'POST',
          url: joinUrl(baseUrl, '/v1/messages'),
          headers: { ...headers, 'content-type': 'application/json' },
          body: anthropicBody(request),
          timeoutMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        });
      } catch (error) {
        return transportFailure(error);
      }
      try {
        // An error's body is never read: its status and headers say all that is passed on.
        if (answer.status !== 200) return statusFailure(answer);
        return await readMessage(answer, call.onTextDelta, request.cacheTtl);
      } finally {
        answer.close();
      }
    },

    async listModels(call = {}) {
      try {
        const answer = await options.transport({
          method: 'GET',
          // The most one page holds; an account can use far fewer models than that.
          url: joinUrl(baseUrl, '/v1/models?limit=1000'),
          headers,
          timeoutMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        if (answer.status !== 200) {
          answer.close();
          return statusFailure(answer);
        }
        return modelsOf(await readBody(answer, SMALL_BODY_BYTES));
      } catch (error) {
        return transportFailure(error);
      }
    },
  };
}
