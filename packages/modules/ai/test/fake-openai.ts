// A local stand-in for a server that speaks the OpenAI Chat Completions API (OpenAI itself,
// Ollama, llama.cpp, vLLM, LM Studio), for tests of the real adapter over a real socket. It
// never talks to OpenAI, and its key is made up.
//
// It answers the two requests the adapter makes, with the fixtures of src/fixtures/openai
// (written from OpenAI's OpenAPI specification; each names its schema):
//
//   POST /v1/chat/completions   `chat-completion.json`, or `stream-text.sse` for `stream: true`
//   GET  /v1/models             `models.json`
//
// With a key it refuses any other `Authorization: Bearer` value (401). Without one it
// accepts a request with no Authorization header at all, as a local server does. A streamed
// answer carries its usage chunk only when the request asked for it with
// `stream_options: {"include_usage": true}`, as the specification describes.
import {
  fixture,
  json,
  startFakeProvider,
  stream,
  type FakeAnswer,
  type FakeProvider,
  type FakeRequest,
} from './fake-provider.js';

export const FAKE_OPENAI_KEY = 'sk-fixture-0000000000000000b2e4';

/** An error answer in the specification's `ErrorResponse` shape. */
export function openAiError(
  status: number,
  type: string,
  code: string | null = null,
  headers: Record<string, string> = {},
): FakeAnswer {
  return json(status, { error: { message: 'A fixture error.', type, param: null, code } }, headers);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `apiKey: null` is a server that asks for no key. */
export async function startFakeOpenAi(
  apiKey: string | null = FAKE_OPENAI_KEY,
): Promise<FakeProvider> {
  const completion: unknown = JSON.parse(fixture('openai', 'chat-completion.json'));
  const models: unknown = JSON.parse(fixture('openai', 'models.json'));
  const streamed = fixture('openai', 'stream-text.sse');
  const withoutUsage = streamed
    .split('\n\n')
    .filter((event) => !event.includes('"choices":[]'))
    .join('\n\n');

  return startFakeProvider((request: FakeRequest) => {
    const authorization = request.headers.authorization;
    if (apiKey === null ? authorization !== undefined : authorization !== `Bearer ${apiKey}`)
      return openAiError(401, 'invalid_request_error');
    if (request.method === 'GET' && request.path === '/v1/models') return json(200, models);
    if (request.method !== 'POST' || request.path !== '/v1/chat/completions')
      return openAiError(404, 'invalid_request_error');
    const body = request.json;
    if (
      request.headers['content-type'] !== 'application/json' ||
      !isRecord(body) ||
      typeof body['model'] !== 'string' ||
      !Array.isArray(body['messages']) ||
      body['messages'].length === 0
    )
      return openAiError(400, 'invalid_request_error');
    if (body['stream'] !== true) return json(200, completion);
    const options = body['stream_options'];
    return stream(isRecord(options) && options['include_usage'] === true ? streamed : withoutUsage);
  });
}
