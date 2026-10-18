// A local HTTP stand-in for the Claude Messages API, for the server's tests of the AI
// gateway with the real vault, and for the whole-product suite. It never talks to
// Anthropic, and its key is made up by the test that starts it.
//
// It answers two requests, with the fixtures of packages/modules/ai/src/fixtures/anthropic
// (written from Anthropic's documentation; the folder's README names each page):
//
//   POST /v1/messages   the streamed text fixture, `text.sse`, unless a test scripted another
//   GET  /v1/models     the list of models, `models.json`: what a test of the agency's key asks
//
// A wrong `x-api-key` is answered 401 with the documented error body, and anything else
// 404. The AI module has the full stand-in and the adapter's own tests
// (packages/modules/ai/test/fake-anthropic.ts).
//
// A test scripts what the next message requests are answered with: words of its own, a
// refusal, a tool call nobody offered, an error, or a stream that stalls. In the same
// process it calls `next`; from another process (the whole-product suite's browser tests,
// whose stand-in runs in the suite's setup) it posts the same answers as JSON to
// `/__script`. That path exists on this stand-in only: no provider has it.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';

const FIXTURES = new URL('../../../packages/modules/ai/src/fixtures/anthropic/', import.meta.url);

export interface FakeClaudeRequest {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** One tool a scripted answer asks for. */
export interface FakeClaudeToolCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** The answers a message request can be given instead of the usual text. */
type ScriptedAnswer =
  /** These words, streamed as the text fixture streams its own. */
  | { readonly kind: 'text'; readonly text: string }
  /** The model declines: the `refusal.sse` fixture. */
  | { readonly kind: 'refusal' }
  /** Some text and then a call of a tool: the `tool-use.sse` fixture. */
  | { readonly kind: 'tool_use' }
  /**
   * These tools, by name and input, after these words when there are any: the events of the
   * `tool-use.sse` fixture with its names and inputs replaced (the in-app assistant). At
   * least one call.
   */
  | {
      readonly kind: 'tool_calls';
      readonly calls: readonly FakeClaudeToolCall[];
      readonly text?: string;
    }
  /** An error in the API's documented shape, such as 529 `overloaded_error`. */
  | { readonly kind: 'error'; readonly status: number; readonly type: string }
  /** The first events of an answer, then silence with the connection held open. */
  | { readonly kind: 'stall' }
  /** The whole answer, but only after this long: a slow model that does finish. */
  | { readonly kind: 'slow'; readonly text: string; readonly delayMs: number };

/** What a message request is answered with instead of the usual text. */
export type FakeClaudeAnswer = ScriptedAnswer & {
  /**
   * Only for a request whose body holds these characters, such as a phrase of the message
   * being answered. Without it the answer is for whichever request comes next. A test that
   * shares the stand-in with other traffic names its own request this way.
   */
  readonly when?: string;
};

export interface FakeClaude {
  /** Where it listens, such as http://127.0.0.1:49152. */
  readonly origin: string;
  /** As AI_LOCAL_SERVERS would list it: 127.0.0.1:49152. */
  readonly hostPort: string;
  /** Every message request so far, whether or not its key was accepted. */
  readonly requests: FakeClaudeRequest[];
  /** Every request for the list of models so far, whether or not its key was accepted. */
  readonly modelLists: FakeClaudeRequest[];
  /** Answers the next message request this way instead of the usual one. Answers queue up. */
  next(answer: FakeClaudeAnswer): void;
  /** Forgets every scripted answer that was not used. */
  reset(): void;
  stop(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A scripted answer sent as JSON, or undefined when it is not one. */
function answerOf(value: unknown): FakeClaudeAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, text, delayMs, status, type, when } = value;
  if (when !== undefined && typeof when !== 'string') return undefined;
  const only = when === undefined ? {} : { when };
  if (kind === 'refusal' || kind === 'tool_use' || kind === 'stall') return { kind, ...only };
  if (kind === 'text' && typeof text === 'string') return { kind, text, ...only };
  if (kind === 'slow' && typeof text === 'string' && typeof delayMs === 'number')
    return { kind, text, delayMs, ...only };
  if (kind === 'error' && typeof status === 'number' && typeof type === 'string')
    return { kind, status, type, ...only };
  if (kind === 'tool_calls' && Array.isArray(value['calls']) && value['calls'].length > 0) {
    const calls: FakeClaudeToolCall[] = [];
    for (const call of value['calls'] as unknown[]) {
      if (!isRecord(call) || typeof call['name'] !== 'string' || !isRecord(call['input']))
        return undefined;
      calls.push({ name: call['name'], input: call['input'] });
    }
    if (text !== undefined && typeof text !== 'string') return undefined;
    return { kind, calls, ...(text === undefined ? {} : { text }), ...only };
  }
  return undefined;
}

/**
 * A streamed answer that asks for these tools: the `tool-use.sse` fixture's own events (its
 * message start, a text block, a `tool_use` block whose input arrives as `input_json_delta`,
 * its message delta and stop) with the names, ids and inputs replaced. Every event keeps the
 * fixture's shape, which names the documentation it was written from.
 */
function toolCalls(
  fixture: string,
  calls: readonly FakeClaudeToolCall[],
  text: string,
  serial: () => number,
): string {
  const events = fixture.split(/\n\n/).filter((event) => event.trim() !== '');
  const dataOf = (event: string): Record<string, unknown> => {
    const data: unknown = JSON.parse(event.slice(event.indexOf('data: ') + 6));
    if (!isRecord(data)) throw new Error('A fixture event is not an object.');
    return data;
  };
  const one = (wanted: (data: Record<string, unknown>) => boolean): string => {
    const found = events.find((event) => wanted(dataOf(event)));
    if (found === undefined)
      throw new Error('The tool-use fixture is not the one this stand-in was written for.');
    return found;
  };
  const block = (data: Record<string, unknown>, type: string): boolean =>
    isRecord(data['content_block']) && data['content_block']['type'] === type;
  const delta = (data: Record<string, unknown>, type: string): boolean =>
    isRecord(data['delta']) && data['delta']['type'] === type;
  /** An event of the fixture with its data changed, under the fixture's own event name. */
  const made = (template: string, change: (data: Record<string, unknown>) => void): string => {
    const copy = structuredClone(dataOf(template));
    change(copy);
    return `${template.slice(0, template.indexOf('data: ') + 6)}${JSON.stringify(copy)}`;
  };
  const part = (data: Record<string, unknown>, key: string): Record<string, unknown> => {
    const found = data[key];
    if (!isRecord(found)) throw new Error('A fixture event lacks a part.');
    return found;
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
        part(data, 'delta')['text'] = text;
      }),
    );
    stopBlock();
  }
  for (const call of calls) {
    out.push(
      made(templates.toolStart, (data) => {
        data['index'] = index;
        const content = part(data, 'content_block');
        content['id'] = `toolu_01Scripted${String(serial()).padStart(12, '0')}`;
        content['name'] = call.name;
      }),
      made(templates.toolDelta, (data) => {
        data['index'] = index;
        part(data, 'delta')['partial_json'] = JSON.stringify(call.input);
      }),
    );
    stopBlock();
  }
  out.push(templates.messageDelta, templates.stop);
  return `${out.join('\n\n')}\n\n`;
}

export async function startFakeClaude(apiKey: string): Promise<FakeClaude> {
  const read = (name: string): Promise<string> => readFile(new URL(name, FIXTURES), 'utf8');
  const [text, refusal, toolUse, models] = await Promise.all([
    read('text.sse'),
    read('refusal.sse'),
    read('tool-use.sse'),
    read('models.json'),
  ]);
  const requests: FakeClaudeRequest[] = [];
  const modelLists: FakeClaudeRequest[] = [];
  const scripted: FakeClaudeAnswer[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let scriptedCalls = 0;
  const errorBody = (type: string): string =>
    JSON.stringify({ type: 'error', error: { type, message: 'A fixture error.' } });

  /** The text fixture saying these words: its two pieces of text become one. */
  const saying = (words: string): string =>
    text
      .replace('"text_delta","text":"Hello"', `"text_delta","text":${JSON.stringify(words)}`)
      .replace(/event: content_block_delta\ndata: [^\n]*"text":"!"\}\}\n\n/, '');

  const streamed = (response: ServerResponse, events: string): void => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events);
  };

  function answer(response: ServerResponse, scriptedAnswer: FakeClaudeAnswer | undefined): void {
    if (scriptedAnswer === undefined) {
      streamed(response, text);
      return;
    }
    switch (scriptedAnswer.kind) {
      case 'text':
        streamed(response, saying(scriptedAnswer.text));
        return;
      case 'refusal':
        streamed(response, refusal);
        return;
      case 'tool_use':
        streamed(response, toolUse);
        return;
      case 'tool_calls':
        streamed(
          response,
          toolCalls(
            toolUse,
            scriptedAnswer.calls,
            scriptedAnswer.text ?? '',
            () => ++scriptedCalls,
          ),
        );
        return;
      case 'error':
        response.writeHead(scriptedAnswer.status, { 'content-type': 'application/json' });
        response.end(errorBody(scriptedAnswer.type));
        return;
      case 'stall':
        // The start of an answer, and then nothing: the connection stays open and silent.
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(text.split('\n\n').slice(0, 2).join('\n\n').concat('\n\n'));
        return;
      case 'slow': {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        const timer = setTimeout(() => {
          timers.delete(timer);
          response.end(saying(scriptedAnswer.text));
        }, scriptedAnswer.delayMs);
        timers.add(timer);
      }
    }
  }

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0];
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'GET' && path === '/v1/models') {
        modelLists.push({ headers: request.headers, body: '' });
        const accepted = request.headers['x-api-key'] === apiKey;
        response.writeHead(accepted ? 200 : 401, { 'content-type': 'application/json' });
        response.end(accepted ? models : errorBody('authentication_error'));
        return;
      }
      // The stand-in's own door, for a test in another process: what to answer next.
      if (request.method === 'POST' && path === '/__script') {
        let wanted: unknown;
        try {
          wanted = JSON.parse(body);
        } catch {
          wanted = undefined;
        }
        const answers = Array.isArray(wanted) ? wanted.map(answerOf) : [undefined];
        if (answers.includes(undefined)) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'Send a list of scripted answers.' }));
          return;
        }
        // Added to what is already scripted: two tests may each be waiting for their own.
        for (const each of answers) if (each !== undefined) scripted.push(each);
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== 'POST' || path !== '/v1/messages') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(errorBody('not_found_error'));
        return;
      }
      requests.push({ headers: request.headers, body });
      if (request.headers['x-api-key'] !== apiKey) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(errorBody('authentication_error'));
        return;
      }
      // The first answer written for this request, or for any: the rest keep their turn.
      const mine = scripted.findIndex(
        (each) => each.when === undefined || body.includes(each.when),
      );
      answer(response, mine < 0 ? undefined : scripted.splice(mine, 1)[0]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The stand-in has no port.');
  const hostPort = `127.0.0.1:${String(address.port)}`;
  return {
    origin: `http://${hostPort}`,
    hostPort,
    requests,
    modelLists,
    next: (wanted) => {
      scripted.push(wanted);
    },
    reset: () => {
      scripted.length = 0;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
