// What the composer's snippet picker works out before it draws: where a typed "/" starts a
// search, which snippets a channel takes, how the list is grouped, where the chosen text
// goes, and which merge fields a text still holds.
import type { ReplyChannel, SnippetSummary, SnippetType } from '@repo/contracts';

// A merge field as a message holds it, as the API reads one (message-templates.ts).
const MERGE_FIELD = /\{\{\s*[a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\s*\}\}/g;

/** The longest search a typed "/" carries: past it, what is typed is not a search. */
const QUERY_MAX = 40;

export interface TextPiece {
  /** Where the piece starts in the text. */
  readonly at: number;
  readonly text: string;
  /** True for a merge field, such as {{contact.first_name}}. */
  readonly field: boolean;
}

/** A text as its words and its merge fields, in order, so the fields can be shown as such. */
export function mergePieces(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(MERGE_FIELD)) {
    if (match.index > at) pieces.push({ at, text: text.slice(at, match.index), field: false });
    pieces.push({ at: match.index, text: match[0], field: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) pieces.push({ at, text: text.slice(at), field: false });
  return pieces;
}

/** The merge fields a text still holds, each once, as written. A reply sends them as they are. */
export function unfilledFields(text: string): string[] {
  return [...new Set(text.match(MERGE_FIELD) ?? [])];
}

/** The snippets a channel takes: email snippets for an email, text snippets for the rest. */
export function snippetTypeFor(channel: ReplyChannel): SnippetType {
  return channel === 'email' ? 'email' : 'text';
}

/** The part of the message a chosen snippet takes the place of. */
export interface PickerRange {
  readonly from: number;
  readonly to: number;
}

export interface SlashQuery extends PickerRange {
  /** What is typed after the "/", to search for. */
  readonly query: string;
}

/**
 * The search a "/" starts, if the caret is in one: a "/" at the start of a word, then
 * anything but a space or a second "/" (which makes it a path or a date, not a search), up
 * to the caret.
 */
export function slashQueryAt(text: string, caret: number): SlashQuery | undefined {
  const to = Math.max(0, Math.min(caret, text.length));
  let from = to;
  while (from > 0 && !/\s/.test(text.charAt(from - 1))) from -= 1;
  const word = text.slice(from, to);
  if (!word.startsWith('/')) return undefined;
  const query = word.slice(1);
  if (query.includes('/') || query.length > QUERY_MAX) return undefined;
  return { from, to, query };
}

/** The picker as the composer holds it: what it replaces, and what its search starts as. */
export interface PickerState extends SlashQuery {
  /** How it was opened: by the button, or by a typed "/". */
  readonly by: 'button' | 'slash';
}

/**
 * The picker after the message changed. A "/" at the start of a word opens it; typing on
 * moves what it replaces; a space, or a "/" that is gone, closes one a "/" opened. A "/" the
 * person closed the picker on (`dismissed`, where it is) stays closed while it is the word
 * being typed. The button's picker is not the message's to close.
 */
export function pickerAfterTyping(
  current: PickerState | undefined,
  found: SlashQuery | undefined,
  dismissed: number | undefined,
): PickerState | undefined {
  if (current?.by === 'button') return current;
  if (found === undefined || found.from === dismissed) return undefined;
  return { ...found, by: 'slash' };
}

export type Inserted =
  | { readonly ok: true; readonly text: string; readonly caret: number }
  /** The message would be longer than the channel takes. Nothing changed. */
  | { readonly ok: false };

/** The message with a snippet put in place of a range, and where the caret goes next. */
export function insertSnippet(
  text: string,
  range: PickerRange,
  body: string,
  maxLength: number,
): Inserted {
  const from = Math.max(0, Math.min(range.from, text.length));
  const to = Math.max(from, Math.min(range.to, text.length));
  const next = text.slice(0, from) + body + text.slice(to);
  if (next.length > maxLength) return { ok: false };
  return { ok: true, text: next, caret: from + body.length };
}

export interface SnippetGroup {
  /** The folder's id, or "none" for the snippets in no folder. */
  readonly key: string;
  /** The folder's name; null for the snippets in no folder. */
  readonly name: string | null;
  readonly items: readonly SnippetSummary[];
}

/**
 * The snippets by folder: those in no folder first, then each folder by name. The list
 * arrives in name order and keeps it inside a group.
 */
export function groupByFolder(items: readonly SnippetSummary[], locale: string): SnippetGroup[] {
  const groups = new Map<string, { name: string | null; items: SnippetSummary[] }>();
  for (const item of items) {
    const key = item.folderId ?? 'none';
    const group = groups.get(key) ?? { name: item.folderName, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort((one, other) =>
      one.name === null
        ? -1
        : other.name === null
          ? 1
          : one.name.localeCompare(other.name, locale, { sensitivity: 'base' }),
    );
}

/** Where the highlight goes for an arrow key: it stops at the ends, as a listbox does. */
export function highlightAfter(
  key: 'ArrowDown' | 'ArrowUp',
  current: number,
  count: number,
): number {
  if (count === 0) return -1;
  return key === 'ArrowDown' ? Math.min(current + 1, count - 1) : Math.max(current - 1, 0);
}
