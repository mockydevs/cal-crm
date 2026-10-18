// The OpenAI-compatible adapter: the Chat Completions API over HTTP, as OpenAI's OpenAPI
// specification documents it, for OpenAI itself and for any server that speaks the same API
// (Ollama, llama.cpp, vLLM, LM Studio).
//
//   POST {base}/chat/completions   Authorization: Bearer <key>, when there is a key
//   GET  {base}/models
//
// It asks for as little as it can, because each server supports its own subset:
//   * no `tool_choice` (Ollama does not support it; `auto` is the default with tools);
//   * no sampling or reasoning parameters;
//   * a stream only when the caller listens for text, and then with
//     `stream_options: {"include_usage": true}`.
// And it takes what comes back as it is: no usage means unknown usage, never zero; a tool
// call without an id is given one; a server that never says why it stopped is taken at its
// word that it did.
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
  ModelList,
  ProviderErrorCode,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from './provider.js';
import { readSse } from './sse.js';
import { readBody, type AiHttpAnswer, type AiTransport } from './transport.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiOptions {
  /** Left out for a server of one's own that asks for no key. */
  readonly apiKey?: string;
  /** Up to and including the version, such as http://ollama:11434/v1. */
  readonly baseUrl: string;
  readonly transport: AiTransport;
  /**
   * The name of the output limit. OpenAI has deprecated `max_tokens` for
   * `max_completion_tokens`; the servers that copy its API document `max_tokens`.
   */
  readonly tokenLimitField?: 'max_tokens' | 'max_completion_tokens';
}

function messagesOf(request: ProviderRequest): JsonRecord[] {
  const sent: JsonRecord[] = [];
  if (request.system !== '') sent.push({ role: 'system', content: request.system });
  const add = (message: AiMessage): void => {
    if (message.role === 'user') sent.push({ role: 'user', content: message.text });
    else if (message.role === 'tool')
      for (const result of message.results)
        sent.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.text });
    else {
      const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
      const calls = message.parts
        .filter((part) => part.type === 'tool_call')
        .map((part) => ({
          id: part.id,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        }));
      if (calls.length > 0)
        sent.push({ role: 'assistant', content: text === '' ? null : text, tool_calls: calls });
      else if (text !== '') sent.push({ role: 'assistant', content: text });
    }
  };
  request.messages.forEach(add);
  return sent;
}

/** The request body, as text; tools by name and schemas with their keys in order. */
export function openAiBody(
  request: ProviderRequest,
  options: { readonly limitField: string; readonly stream: boolean },
): string {
  const tools = [...(request.tools ?? [])]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sortKeys(tool.inputSchema),
      },
    }));
  return JSON.stringify({
    model: request.model,
    [options.limitField]: request.maxOutputTokens,
    ...(options.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    messages: messagesOf(request),
    ...(tools.length === 0 ? {} : { tools }),
  });
}

// https://developers.openai.com/api/docs/guides/error-codes: a 429 with one of these codes,
// or of this type, is about money, and waiting does not help.
const BILLING_CODES = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);
const isBilling = (error: JsonRecord | undefined): boolean =>
  stringAt(error, 'type') === 'insufficient_quota' ||
  BILLING_CODES.has(stringAt(error, 'code') ?? '');

async function statusFailure(answer: AiHttpAnswer): Promise<ProviderFailure> {
  const { status } = answer;
  const wait = retryAfterMs(answer.header('retry-after'));
  if (status === 401 || status === 403) return failure('authentication');
  if (status === 402) return failure('billing');
  if (status === 429) {
    // Only the error's type and code are read; its message stays here.
    const error = recordAt(parseJson(await readBody(answer, SMALL_BODY_BYTES)), 'error');
    return isBilling(error) ? failure('billing') : failure('rate_limited', null, wait);
  }
  if (status >= 500) return failure('unavailable', null, wait);
  // A model the provider does not have, or an address with nothing behind its path.
  if (status === 404) return failure('not_found');
  if (status >= 400) return failure('invalid_request');
  return failure('invalid_response');
}

const STREAM_ERRORS: Readonly<Record<string, ProviderErrorCode>> = {
  rate_limit_error: 'rate_limited',
  invalid_request_error: 'invalid_request',
  authentication_error: 'authentication',
};

class Malformed extends Error {}

function usageOf(reported: JsonRecord | undefined): TokenUsage | null {
  const prompt = countAt(reported, 'prompt_tokens');
  const completion = countAt(reported, 'completion_tokens');
  if (prompt === undefined || completion === undefined) return null;
  // Cached tokens are part of the prompt's count, not on top of it.
  const cached = Math.min(
    countAt(recordAt(reported, 'prompt_tokens_details'), 'cached_tokens') ?? 0,
    prompt,
  );
  return {
    inputTokens: prompt - cached,
    outputTokens: completion,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

interface Turn {
  readonly text: string;
  readonly refusal: string;
  readonly calls: readonly {
    readonly id: string | undefined;
    readonly name: string | undefined;
    readonly arguments: string;
  }[];
  /** Null or missing when the server did not say. */
  readonly finishReason: string | undefined;
  readonly usage: TokenUsage | null;
}

function responseOf(turn: Turn): ProviderResponse {
  const { finishReason, usage } = turn;
  if (turn.refusal !== '' || finishReason === 'content_filter')
    return { status: 'refused', category: null, usage };
  const text: AssistantPart[] = turn.text === '' ? [] : [{ type: 'text', text: turn.text }];
  if (finishReason === 'length') return { status: 'ok', parts: text, stop: 'max_tokens', usage };
  if (finishReason !== undefined && finishReason !== 'stop' && finishReason !== 'tool_calls')
    throw new Malformed();
  const calls = turn.calls.map((call, index): AssistantPart => {
    if (call.name === undefined) throw new Malformed();
    // A function with no parameters may come with no arguments at all.
    const input = call.arguments.trim() === '' ? {} : parseJson(call.arguments);
    if (!isRecord(input)) throw new Malformed();
    return { type: 'tool_call', id: call.id ?? `call_${String(index)}`, name: call.name, input };
  });
  if (calls.length === 0 && finishReason === 'tool_calls') throw new Malformed();
  return {
    status: 'ok',
    parts: [...text, ...calls],
    stop: calls.length > 0 ? 'tool_calls' : 'end',
    usage,
  };
}

function readCompletion(text: string): ProviderResponse {
  const body = parseJson(text);
  const [choice] = listAt(body, 'choices') ?? [];
  const message = recordAt(choice, 'message');
  if (message === undefined) throw new Malformed();
  return responseOf({
    text: stringAt(message, 'content') ?? '',
    refusal: stringAt(message, 'refusal') ?? '',
    calls: (listAt(message, 'tool_calls') ?? []).map((call) => {
      if (!isRecord(call)) throw new Malformed();
      const called = recordAt(call, 'function');
      return {
        id: stringAt(call, 'id'),
        name: stringAt(called, 'name'),
        arguments: stringAt(called, 'arguments') ?? '',
      };
    }),
    finishReason: stringAt(choice, 'finish_reason'),
    usage: usageOf(recordAt(body, 'usage')),
  });
}

async function readStream(
  answer: AiHttpAnswer,
  onTextDelta: (text: string) => void,
): Promise<ProviderResponse> {
  let text = '';
  let refusal = '';
  let finishReason: string | undefined;
  let usage: TokenUsage | null = null;
  const calls = new Map<
    number,
    { id: string | undefined; name: string | undefined; arguments: string }
  >();

  for await (const event of readSse(answer.body)) {
    if (event.data === '[DONE]') break;
    const chunk = parseJson(event.data);
    if (!isRecord(chunk)) throw new Malformed();
    const error = recordAt(chunk, 'error');
    if (error !== undefined) {
      if (isBilling(error)) return failure('billing', usage);
      return failure(STREAM_ERRORS[stringAt(error, 'type') ?? ''] ?? 'unavailable', usage);
    }
    usage = usageOf(recordAt(chunk, 'usage')) ?? usage;
    const [choice] = listAt(chunk, 'choices') ?? [];
    finishReason = stringAt(choice, 'finish_reason') ?? finishReason;
    const delta = recordAt(choice, 'delta');
    const piece = stringAt(delta, 'content') ?? '';
    if (piece !== '') {
      text += piece;
      onTextDelta(piece);
    }
    refusal += stringAt(delta, 'refusal') ?? '';
    for (const part of listAt(delta, 'tool_calls') ?? []) {
      const index = countAt(part, 'index');
      if (index === undefined) throw new Malformed();
      const call = calls.get(index) ?? { id: undefined, name: undefined, arguments: '' };
      const called = recordAt(part, 'function');
      call.id = stringAt(part, 'id') ?? call.id;
      call.name = stringAt(called, 'name') ?? call.name;
      call.arguments += stringAt(called, 'arguments') ?? '';
      calls.set(index, call);
    }
  }
  // Without a reason to stop, the stream ended before the model did.
  if (finishReason === undefined) return failure('unavailable', usage);
  return responseOf({
    text,
    refusal,
    calls: [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call),
    finishReason,
    usage,
  });
}

function modelsOf(text: string): ModelList {
  const ids = listAt(parseJson(text), 'data')?.map((model) => stringAt(model, 'id'));
  if (ids === undefined) return failure('invalid_response');
  const models = ids.filter((id) => id !== undefined);
  return models.length === ids.length ? { status: 'ok', models } : failure('invalid_response');
}

export function createOpenAiProvider(options: OpenAiOptions): AiProvider {
  const authorization =
    options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` };
  const limitField = options.tokenLimitField ?? 'max_tokens';

  return {
    async generate(request, call = {}) {
      const { onTextDelta } = call;
      let answer: AiHttpAnswer;
      try {
        answer = await options.transport({
          method: 'POST',
          url: joinUrl(options.baseUrl, '/chat/completions'),
          headers: { ...authorization, 'content-type': 'application/json' },
          body: openAiBody(request, { limitField, stream: onTextDelta !== undefined }),
          timeoutMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        });
      } catch (error) {
        return transportFailure(error);
      }
      try {
        if (answer.status !== 200) return await statusFailure(answer);
        return onTextDelta === undefined
          ? readCompletion(await readBody(answer, SMALL_BODY_BYTES))
          : await readStream(answer, onTextDelta);
      } catch (error) {
        if (error instanceof Malformed) return failure('invalid_response');
        return transportFailure(error);
      } finally {
        answer.close();
      }
    },

    async listModels(call = {}) {
      try {
        const answer = await options.transport({
          method: 'GET',
          url: joinUrl(options.baseUrl, '/models'),
          headers: authorization,
          timeoutMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        try {
          if (answer.status !== 200) return await statusFailure(answer);
          return modelsOf(await readBody(answer, SMALL_BODY_BYTES));
        } finally {
          answer.close();
        }
      } catch (error) {
        return transportFailure(error);
      }
    },
  };
}
