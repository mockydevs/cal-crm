// Server-sent events, as both the Claude Messages API and the OpenAI Chat Completions API
// stream them (WHATWG HTML, "Server-sent events": lines end in LF, CRLF or CR; a blank
// line ends an event; `data:` lines of one event join with a line feed; a line starting
// with a colon is a comment).

export interface SseEvent {
  /** The `event:` field, when the event has one. */
  readonly event: string | undefined;
  readonly data: string;
}

/** The events of a stream, as they complete. An event cut off by the end is dropped. */
export async function* readSse(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  function* lines(final: boolean): Generator<string> {
    for (;;) {
      const end = buffer.search(/[\r\n]/);
      if (end === -1) return;
      // A CR at the very end may be the first half of a CRLF still on its way.
      if (buffer[end] === '\r' && end === buffer.length - 1 && !final) return;
      const width = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + width);
      yield line;
    }
  }

  function* take(final: boolean): Generator<SseEvent> {
    for (const line of lines(final)) {
      if (line === '') {
        if (data.length > 0) yield { event, data: data.join('\n') };
        event = undefined;
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const name = colon === -1 ? line : line.slice(0, colon);
      const rest = colon === -1 ? '' : line.slice(colon + 1);
      const value = rest.startsWith(' ') ? rest.slice(1) : rest;
      if (name === 'data') data.push(value);
      else if (name === 'event') event = value;
    }
  }

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* take(false);
  }
  buffer += decoder.decode();
  yield* take(true);
}
