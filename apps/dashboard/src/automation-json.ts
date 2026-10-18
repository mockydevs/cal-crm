// Reads the JSON the builder's JSON view holds. JSON.parse says only that text is wrong, in
// words that differ by browser; this says where (line and column), and where each value of
// a good document sits in the text, so a problem can point at its place.
import type { JsonValue } from '@repo/contracts';

export type JsonProblemKind = 'empty' | 'ended_early' | 'unexpected' | 'extra_text' | 'too_deep';

export interface JsonProblem {
  readonly kind: JsonProblemKind;
  /** Where in the text, counted from 0. */
  readonly offset: number;
  /** Counted from 1, as editors show them. */
  readonly line: number;
  readonly column: number;
  /** The character that doesn't belong, when there is one. */
  readonly found: string;
}

export interface JsonSpan {
  readonly start: number;
  readonly end: number;
}

export type JsonRead =
  | {
      readonly ok: true;
      readonly value: JsonValue;
      /** Where each value is in the text, by its JSON Pointer; the whole document is ''. */
      readonly spans: ReadonlyMap<string, JsonSpan>;
    }
  | { readonly ok: false; readonly problem: JsonProblem };

/** Deeper than any automation; past it the text is refused rather than risking the stack. */
export const MAX_JSON_DEPTH = 64;

// RFC 6901 section 3: "~" is written ~0 and "/" is written ~1, in that order.
export const pointerToken = (key: string): string =>
  key.replaceAll('~', '~0').replaceAll('/', '~1');

/** The parts of a JSON Pointer, unescaped: /steps/a~1b gives steps and a/b. */
export function pointerParts(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** The line and column of a place in the text, both counted from 1. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastBreak };
}

class Refusal extends Error {
  constructor(
    readonly kind: JsonProblemKind,
    readonly offset: number,
  ) {
    super(kind);
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// A string's extent: up to its closing quote, whatever is inside. What's inside is checked
// one character at a time (stringText), so a mistake is reported where it is.
const STRING = /"(?:[^"\\]|\\[\s\S])*"/y;
const ESCAPE = /^\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/;
const LITERALS: readonly (readonly [string, JsonValue])[] = [
  ['true', true],
  ['false', false],
  ['null', null],
];

/** Parses JSON as JSON.parse does, and says where it went wrong or where each value is. */
export function readJson(text: string): JsonRead {
  const spans = new Map<string, JsonSpan>();
  let at = 0;

  const skip = (): void => {
    while (WHITESPACE.has(text[at] ?? '')) at += 1;
  };
  const refuse = (): never => {
    throw new Refusal(at >= text.length ? 'ended_early' : 'unexpected', at);
  };
  const match = (pattern: RegExp): string => {
    pattern.lastIndex = at;
    const found = pattern.exec(text)?.[0];
    if (found === undefined) return refuse();
    at += found.length;
    return found;
  };
  /** A string's text. No raw control characters, and only JSON's escapes (RFC 8259 section 7). */
  const stringText = (): string => {
    const start = at;
    STRING.lastIndex = at;
    // With no closing quote, the string runs to the end of the text.
    if (!STRING.test(text)) throw new Refusal('ended_early', text.length);
    const token = match(STRING);
    for (let index = 1; index < token.length - 1; index += 1) {
      const escaped = token[index] === '\\';
      if (token.charCodeAt(index) < 0x20 || (escaped && !ESCAPE.test(token.slice(index))))
        throw new Refusal('unexpected', start + index);
      if (escaped) index += 1;
    }
    const parsed: unknown = JSON.parse(token);
    return typeof parsed === 'string' ? parsed : refuse();
  };
  const expect = (character: string): void => {
    skip();
    if (text[at] !== character) refuse();
    at += 1;
  };

  const value = (pointer: string, depth: number): JsonValue => {
    if (depth > MAX_JSON_DEPTH) throw new Refusal('too_deep', at);
    skip();
    const start = at;
    const read = ((): JsonValue => {
      const first = text[at];
      if (first === '{') {
        at += 1;
        const members: [string, JsonValue][] = [];
        skip();
        if (text[at] === '}') {
          at += 1;
          return {};
        }
        for (;;) {
          skip();
          const key = stringText();
          expect(':');
          members.push([key, value(`${pointer}/${pointerToken(key)}`, depth + 1)]);
          skip();
          if (text[at] === '}') {
            at += 1;
            // Own members whatever their names, as JSON.parse makes them.
            return Object.fromEntries(members);
          }
          expect(',');
        }
      }
      if (first === '[') {
        at += 1;
        const items: JsonValue[] = [];
        skip();
        if (text[at] === ']') {
          at += 1;
          return items;
        }
        for (;;) {
          items.push(value(`${pointer}/${String(items.length)}`, depth + 1));
          skip();
          if (text[at] === ']') {
            at += 1;
            return items;
          }
          expect(',');
        }
      }
      if (first === '"') return stringText();
      for (const [word, literal] of LITERALS) {
        if (text.startsWith(word, at)) {
          at += word.length;
          return literal;
        }
      }
      return Number(match(NUMBER));
    })();
    spans.set(pointer, { start, end: at });
    return read;
  };

  try {
    skip();
    if (at >= text.length) throw new Refusal('empty', 0);
    const parsed = value('', 0);
    skip();
    if (at < text.length) throw new Refusal('extra_text', at);
    return { ok: true, value: parsed, spans };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return {
      ok: false,
      problem: {
        kind: error.kind,
        offset: error.offset,
        ...positionOf(text, error.offset),
        found: text[error.offset] ?? '',
      },
    };
  }
}

/**
 * Where a pointer's value is in the text, or else the nearest thing around it that is
 * there: a problem at /steps/a/config/tag still points at step a when it has no tag.
 */
export function spanOf(
  spans: ReadonlyMap<string, JsonSpan>,
  pointer: string,
): JsonSpan | undefined {
  const parts = pointerParts(pointer);
  for (let length = parts.length; length >= 0; length -= 1) {
    const found = spans.get(
      parts
        .slice(0, length)
        .map((part) => `/${pointerToken(part)}`)
        .join(''),
    );
    if (found !== undefined) return found;
  }
  return undefined;
}
