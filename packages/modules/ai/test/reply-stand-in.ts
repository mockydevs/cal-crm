// A local stand-in that "answers" the replies suite: for each prompt it is sent it gives
// back the answer a person wrote for that case (evals/stand-in/replies/answers.json). It is
// a server that speaks the OpenAI Chat Completions API as the module's other stand-in does
// (fake-openai.ts, whose fixtures were written from OpenAI's specification), so the suite
// runs through the real adapter over a real socket, with no key and no provider.
//
// It evaluates nothing. Its only use is to run the job's own code end to end, and to make
// a recording the suite can be replayed from.
import {
  json,
  startFakeProvider,
  type FakeAnswer,
  type FakeProvider,
  type FakeRequest,
} from './fake-provider.js';

/** What a run against this server is named: no model has this name. */
export const STAND_IN_MODEL = 'stand-in';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A quarter of the bytes: a stand-in's arithmetic, not a tokenizer. */
const tokens = (text: string): number => Math.ceil(text.length / 4);

const chunk = (delta: unknown, finish: string | null, usage: unknown): string =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-stand-in',
    object: 'chat.completion.chunk',
    created: 1_760_000_000,
    model: STAND_IN_MODEL,
    choices:
      delta === undefined ? [] : [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    usage,
  })}\n\n`;

/**
 * Starts the stand-in. `answers` maps the text of a request's last message, exactly as the
 * job sent it, to what to say. A prompt nobody wrote an answer for gets a sentence that
 * says so, which fails that case's checks rather than passing them by accident.
 */
export function startReplyStandIn(answers: ReadonlyMap<string, string>): Promise<FakeProvider> {
  return startFakeProvider((request: FakeRequest): FakeAnswer => {
    const body = request.json;
    if (request.method !== 'POST' || request.path !== '/v1/chat/completions' || !isRecord(body))
      return json(404, {
        error: {
          message: 'A fixture error.',
          type: 'invalid_request_error',
          param: null,
          code: null,
        },
      });
    const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
    const last = messages.at(-1);
    const asked = isRecord(last) && typeof last['content'] === 'string' ? last['content'] : '';
    const content = answers.get(asked) ?? 'The stand-in has no answer written for this prompt.';
    const usage = {
      prompt_tokens: tokens(request.body),
      completion_tokens: tokens(content),
      total_tokens: tokens(request.body) + tokens(content),
    };
    if (body['stream'] !== true)
      return json(200, {
        id: 'chatcmpl-stand-in',
        object: 'chat.completion',
        created: 1_760_000_000,
        model: STAND_IN_MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content, refusal: null },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
        usage,
      });
    const options = body['stream_options'];
    const withUsage = isRecord(options) && options['include_usage'] === true;
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      pieces: [
        chunk({ role: 'assistant', content: '' }, null, null),
        chunk({ content }, null, null),
        chunk({}, 'stop', null),
        ...(withUsage ? [chunk(undefined, null, usage)] : []),
        'data: [DONE]\n\n',
      ],
    };
  });
}
