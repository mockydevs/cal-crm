// A local stand-in for the Claude Messages API, for tests of the real adapter over a real
// socket. It never talks to Anthropic, and its key is made up.
//
// It answers the two requests the adapter makes, with the fixtures of src/fixtures/anthropic
// (each names the documentation page it was written from):
//
//   POST /v1/messages   a streamed message, `text.sse` unless a test scripts another
//   GET  /v1/models     `models.json`
//
// It refuses what the documentation says the API refuses: a wrong `x-api-key` (401), a
// missing `anthropic-version: 2023-06-01` header, and a body without `model`, `max_tokens`,
// `messages` or `stream: true` (400).
//
// Prompt caching is imitated as https://platform.claude.com/docs/en/build-with-claude/
// prompt-caching describes it: the prefix is `tools`, then `system`, up to the last block
// marked with `cache_control`. The first request with a prefix reports its tokens as
// `cache_creation_input_tokens`, later ones as `cache_read_input_tokens`. A write is also
// broken down by lifetime in `cache_creation` (`ephemeral_5m_input_tokens`,
// `ephemeral_1h_input_tokens`), by the breakpoint's `ttl`: "5m" when it has none, "1h", and
// a 400 for any other value (the API reference's `CacheControlEphemeral`). Token counts here
// are a quarter of the bytes: a stand-in's arithmetic, not Anthropic's tokenizer.
import {
  fixture,
  json,
  startFakeProvider,
  stream,
  type FakeAnswer,
  type FakeProvider,
  type FakeRequest,
} from './fake-provider.js';

export const FAKE_ANTHROPIC_KEY = 'sk-ant-fixture-0000000000000000a1f3';

const errorBody = (type: string): unknown => ({
  type: 'error',
  error: { type, message: 'A fixture error.' },
  request_id: 'req_011CFixture00000000000000',
});

/** An error answer in the API's documented shape. */
export function anthropicError(
  status: number,
  type: string,
  headers: Record<string, string> = {},
): FakeAnswer {
  return json(status, errorBody(type), headers);
}

/**
 * A streamed answer of these words: the `text.sse` fixture with its two pieces of text
 * replaced by one. The events and their order are the fixture's own.
 */
export function anthropicText(text: string): FakeAnswer {
  const fixtureText = fixture('anthropic', 'text.sse');
  const said = fixtureText
    .replace('"text_delta","text":"Hello"', `"text_delta","text":${JSON.stringify(text)}`)
    .replace(/event: content_block_delta\ndata: [^\n]*"text":"!"\}\}\n\n/, '');
  if (said === fixtureText || said.includes('"text":"!"'))
    throw new Error('The text fixture is not the one this helper was written for.');
  return stream(said);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const tokens = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 4);

interface Prefix {
  /** What a cache entry is keyed on. */
  readonly key: string;
  /** The lifetime the breakpoint asks for, or undefined for one the API refuses. */
  readonly ttl: '5m' | '1h' | undefined;
}

/** The part of a request a cache entry is keyed on, or undefined when nothing is marked. */
function cachedPrefix(body: Record<string, unknown>): Prefix | undefined {
  const blocks: unknown[] = [
    ...(Array.isArray(body['tools']) ? (body['tools'] as unknown[]) : []),
    ...(Array.isArray(body['system']) ? (body['system'] as unknown[]) : []),
  ];
  const last = blocks.findLastIndex((block) => isRecord(block) && isRecord(block['cache_control']));
  if (last === -1) return undefined;
  const marked = blocks[last] as Record<string, Record<string, unknown>>;
  const asked = marked['cache_control']?.['ttl'];
  // The key leaves the lifetime out: a lifetime is how long an entry lasts, not which it is.
  const unmarked = blocks
    .slice(0, last + 1)
    .map((block) =>
      isRecord(block) && isRecord(block['cache_control'])
        ? { ...block, cache_control: { type: block['cache_control']['type'] } }
        : block,
    );
  return {
    key: JSON.stringify([body['model'], unmarked]),
    ttl: asked === undefined || asked === '5m' ? '5m' : asked === '1h' ? '1h' : undefined,
  };
}

export async function startFakeAnthropic(apiKey = FAKE_ANTHROPIC_KEY): Promise<FakeProvider> {
  const text = fixture('anthropic', 'text.sse');
  const models: unknown = JSON.parse(fixture('anthropic', 'models.json'));
  const cached = new Set<string>();

  const message = (body: Record<string, unknown>): FakeAnswer => {
    const prefix = cachedPrefix(body);
    if (prefix !== undefined && prefix.ttl === undefined)
      return anthropicError(400, 'invalid_request_error');
    const prefixTokens = prefix === undefined ? 0 : tokens(prefix.key);
    const hit = prefix !== undefined && cached.has(prefix.key);
    if (prefix !== undefined) cached.add(prefix.key);
    const written = hit ? 0 : prefixTokens;
    const usage = {
      input_tokens: tokens(body['messages']),
      cache_creation_input_tokens: written,
      cache_read_input_tokens: hit ? prefixTokens : 0,
      cache_creation: {
        ephemeral_5m_input_tokens: prefix?.ttl === '1h' ? 0 : written,
        ephemeral_1h_input_tokens: prefix?.ttl === '1h' ? written : 0,
      },
      output_tokens: 1,
    };
    return stream(
      text.replace(/"usage":\{"input_tokens":25[^}]*\}/, `"usage":${JSON.stringify(usage)}`),
    );
  };

  return startFakeProvider((request: FakeRequest) => {
    if (request.headers['x-api-key'] !== apiKey) return anthropicError(401, 'authentication_error');
    if (request.headers['anthropic-version'] !== '2023-06-01')
      return anthropicError(400, 'invalid_request_error');
    if (request.method === 'GET' && request.path.startsWith('/v1/models')) return json(200, models);
    if (request.method !== 'POST' || request.path !== '/v1/messages')
      return anthropicError(404, 'not_found_error');
    const body = request.json;
    if (
      request.headers['content-type'] !== 'application/json' ||
      !isRecord(body) ||
      typeof body['model'] !== 'string' ||
      !Number.isInteger(body['max_tokens']) ||
      !Array.isArray(body['messages']) ||
      body['messages'].length === 0 ||
      body['stream'] !== true
    )
      return anthropicError(400, 'invalid_request_error');
    return message(body);
  });
}

/** One tool the scripted model asks for. */
export interface ScriptedToolCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

let scriptedCalls = 0;

/**
 * A streamed answer that asks for these tools, after these words when there are any: the
 * `tool-use.sse` fixture's own events (its message start, a text block, a `tool_use` block
 * with its input sent as `input_json_delta`, its message delta and stop), with the names
 * and inputs replaced. Every event's shape is the fixture's, which names the documentation
 * it was written from; nothing here is another reading of the API.
 */
export function anthropicToolCalls(calls: readonly ScriptedToolCall[], text = ''): FakeAnswer {
  const events = fixture('anthropic', 'tool-use.sse')
    .split(/\n\n/)
    .filter((event) => event.trim() !== '');
  const one = (wanted: (data: Record<string, unknown>) => boolean): string => {
    const found = events.find((event) => {
      const data: unknown = JSON.parse(event.slice(event.indexOf('data: ') + 6));
      return isRecord(data) && wanted(data);
    });
    if (found === undefined)
      throw new Error('The tool-use fixture is not the one this helper was written for.');
    return found;
  };
  const block = (data: Record<string, unknown>, type: string): boolean =>
    isRecord(data['content_block']) && data['content_block']['type'] === type;
  const delta = (data: Record<string, unknown>, type: string): boolean =>
    isRecord(data['delta']) && data['delta']['type'] === type;
  /** An event of the fixture with its data changed, under the fixture's own event name. */
  const made = (template: string, change: (data: Record<string, unknown>) => void): string => {
    const at = template.indexOf('data: ') + 6;
    const data: unknown = JSON.parse(template.slice(at));
    if (!isRecord(data)) throw new Error('A fixture event is not an object.');
    const copy = structuredClone<Record<string, unknown>>(data);
    change(copy);
    return `${template.slice(0, at)}${JSON.stringify(copy)}`;
  };
  const templates = {
    start: one((data) => data['type'] === 'message_start'),
    textStart: one((data) => data['type'] === 'content_block_start' && block(data, 'text')),
    textDelta: one((data) => data['type'] === 'content_block_delta' && delta(data, 'text_delta')),
    toolStart: one((data) => data['type'] === 'content_block_start' && block(data, 'tool_use')),
    toolDelta: one(
      (data) => data['type'] === 'content_block_delta' && delta(data, 'input_json_delta'),
    ),
    blockStop: one((data) => data['type'] === 'content_block_stop'),
    messageDelta: one((data) => data['type'] === 'message_delta'),
    stop: one((data) => data['type'] === 'message_stop'),
  };
  const out: string[] = [templates.start];
  let index = 0;
  const stopBlock = (): void => {
    out.push(
      made(templates.blockStop, (data) => {
        data['index'] = index;
      }),
    );
    index += 1;
  };
  if (text !== '') {
    out.push(
      made(templates.textStart, (data) => {
        data['index'] = index;
      }),
      made(templates.textDelta, (data) => {
        data['index'] = index;
        (data['delta'] as Record<string, unknown>)['text'] = text;
      }),
    );
    stopBlock();
  }
  for (const call of calls) {
    scriptedCalls += 1;
    out.push(
      made(templates.toolStart, (data) => {
        data['index'] = index;
        const content = data['content_block'] as Record<string, unknown>;
        content['id'] = `toolu_01Scripted${String(scriptedCalls).padStart(12, '0')}`;
        content['name'] = call.name;
      }),
      made(templates.toolDelta, (data) => {
        data['index'] = index;
        (data['delta'] as Record<string, unknown>)['partial_json'] = JSON.stringify(call.input);
      }),
    );
    stopBlock();
  }
  out.push(templates.messageDelta, templates.stop);
  return stream(`${out.join('\n\n')}\n\n`);
}

/** The tool results a request to the stand-in carried back, in order, as its body holds them. */
export function toolResultsOf(request: FakeRequest): {
  readonly id: string;
  readonly content: string;
  readonly isError: boolean;
}[] {
  const body = request.json;
  const messages = isRecord(body) && Array.isArray(body['messages']) ? body['messages'] : [];
  return messages.flatMap((message: unknown) =>
    isRecord(message) && message['role'] === 'user' && Array.isArray(message['content'])
      ? message['content'].flatMap((part: unknown) =>
          isRecord(part) && part['type'] === 'tool_result'
            ? [
                {
                  id: String(part['tool_use_id']),
                  content: String(part['content']),
                  isError: part['is_error'] === true,
                },
              ]
            : [],
        )
      : [],
  );
}
