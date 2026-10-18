// JSON Patch (RFC 6902) over JSON Pointer (RFC 6901), for small edits to an automation
// draft (AUTOMATIONS.md section 5, PATCH /automations/{id}/draft). A patch applies whole or
// not at all, and never changes the document it's given.
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = Record<string, JsonValue>;

export interface PatchError {
  /** The failing operation's position in the patch. */
  readonly index: number;
  readonly code:
    | 'invalid_patch'
    | 'invalid_operation'
    | 'invalid_pointer'
    | 'invalid_index'
    | 'index_out_of_range'
    | 'path_not_found'
    | 'move_into_child'
    | 'test_failed'
    | 'too_large'
    | 'too_deep'
    | 'invalid_value';
  readonly message: string;
}

export type PatchResult =
  | { readonly ok: true; readonly document: JsonValue }
  | { readonly ok: false; readonly error: PatchError };

/** The most operations one patch may hold. */
export const MAX_PATCH_OPERATIONS = 1000;

/**
 * The default size limit: the document's characters (keys and strings) plus one per value.
 * Every value a patch inserts counts against it, so a patch that copies the document into
 * itself again and again is refused long before memory runs short.
 */
export const DEFAULT_PATCH_SIZE = 2_000_000;

/** The deepest a value may sit in the document; deeper input is refused, never recursed. */
export const MAX_PATCH_DEPTH = 64;

export interface PatchOptions {
  readonly maxSize?: number;
}

// Weighs values against what's left of the limit, without recursion, and stops at the first
// excess, so the work done is never more than the limit itself. A value placed at a depth
// counts from there, so the whole document stays within MAX_PATCH_DEPTH.
class Budget {
  constructor(private remaining: number) {}

  /** Charges a value placed at this depth against the limit. */
  take(value: unknown, depth: number): asserts value is JsonValue {
    this.walk(value, depth, true);
  }

  /** Checks only that it's JSON within the depth, for a value compared but never stored. */
  check(value: unknown, depth: number): asserts value is JsonValue {
    this.walk(value, depth, false);
  }

  private walk(value: unknown, depth: number, charge: boolean): void {
    const pending: [unknown, number][] = [[value, depth]];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [current, level] = next;
      if (level > MAX_PATCH_DEPTH)
        throw new Refused(
          'too_deep',
          `Values may be nested at most ${String(MAX_PATCH_DEPTH)} deep.`,
        );
      let weight = 1;
      if (typeof current === 'string') weight += current.length;
      else if (Array.isArray(current)) for (const item of current) pending.push([item, level + 1]);
      else if (isPlainObject(current))
        for (const [key, member] of Object.entries(current)) {
          weight += key.length;
          pending.push([member, level + 1]);
        }
      // Only what JSON can hold: no undefined, no NaN or Infinity, no Dates or class instances.
      else if (
        current !== null &&
        typeof current !== 'boolean' &&
        !(typeof current === 'number' && Number.isFinite(current))
      )
        throw new Refused('invalid_value', 'Only JSON values can be stored.');
      if (charge) this.remaining -= weight;
      if (this.remaining < 0)
        throw new Refused('too_large', 'The patched document would be too large.');
    }
  }
}

class Refused extends Error {
  constructor(
    readonly code: PatchError['code'],
    message: string,
  ) {
    super(message);
  }
}

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// RFC 6901 section 3: tokens after each "/", with "~" escaped as ~0 and "/" as ~1.
function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/'))
    throw new Refused('invalid_pointer', `${pointer} must start with /.`);
  return pointer
    .slice(1)
    .split('/')
    .map((token) => {
      if (/~[^01]|~$/.test(token))
        throw new Refused('invalid_pointer', `${pointer} has a ~ that isn't ~0 or ~1.`);
      // Section 4: ~1 first, then ~0, so ~01 becomes ~1.
      const decoded = token.replaceAll('~1', '/').replaceAll('~0', '~');
      if (decoded === '__proto__')
        throw new Refused('invalid_pointer', `${pointer} names __proto__.`);
      return decoded;
    });
}

// RFC 6901 section 4: "0", or digits without a leading zero.
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

function index(array: JsonValue[], token: string, { forAdd }: { forAdd: boolean }): number {
  if (forAdd && token === '-') return array.length;
  if (token === '-') throw new Refused('path_not_found', 'There is no element after the last one.');
  if (!ARRAY_INDEX.test(token))
    throw new Refused('invalid_index', `${token} is not an array index.`);
  const value = Number(token);
  if (value > array.length || (!forAdd && value === array.length))
    throw new Refused(
      forAdd ? 'index_out_of_range' : 'path_not_found',
      `${token} is past the end of the array.`,
    );
  return value;
}

function clone(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    const copy: JsonObject = {};
    for (const [key, member] of Object.entries(value)) setMember(copy, key, clone(member));
    return copy;
  }
  return value;
}

// Own members only: a key such as __proto__ is an ordinary member, never the prototype.
function setMember(object: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function get(document: JsonValue, tokens: readonly string[]): JsonValue {
  let current = document;
  for (const token of tokens) {
    if (Array.isArray(current)) current = current[index(current, token, { forAdd: false })] ?? null;
    else if (isObject(current) && Object.hasOwn(current, token)) current = current[token] ?? null;
    else throw new Refused('path_not_found', `/${tokens.join('/')} does not exist.`);
  }
  return current;
}

function parentOf(document: JsonValue, tokens: readonly string[]): [JsonValue, string] {
  const last = tokens.at(-1);
  if (last === undefined) throw new Refused('invalid_operation', 'The root has no parent.');
  return [get(document, tokens.slice(0, -1)), last];
}

function add(document: JsonValue, tokens: readonly string[], value: JsonValue): JsonValue {
  if (tokens.length === 0) return value;
  const [parent, last] = parentOf(document, tokens);
  if (Array.isArray(parent)) parent.splice(index(parent, last, { forAdd: true }), 0, value);
  else if (isObject(parent)) setMember(parent, last, value);
  else
    throw new Refused('path_not_found', `/${tokens.join('/')} has no object or array to add to.`);
  return document;
}

function remove(document: JsonValue, tokens: readonly string[]): JsonValue {
  const [parent, last] = parentOf(document, tokens);
  if (Array.isArray(parent)) parent.splice(index(parent, last, { forAdd: false }), 1);
  else if (isObject(parent) && Object.hasOwn(parent, last)) Reflect.deleteProperty(parent, last);
  else throw new Refused('path_not_found', `/${tokens.join('/')} does not exist.`);
  return document;
}

// RFC 6902 section 4.6: same JSON type and equal value; member order doesn't matter.
function equal(left: JsonValue, right: JsonValue): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, position) => equal(item, right[position] ?? null))
    );
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equal(left[key] ?? null, right[key] ?? null))
    );
  }
  return left === right;
}

interface Operation {
  readonly op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  readonly path: string;
  readonly from?: string;
  readonly value?: unknown;
}

function operationOf(raw: unknown): Operation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Refused('invalid_operation', 'An operation is an object.');
  const { op, path } = raw as { op?: unknown; path?: unknown };
  if (typeof op !== 'string' || !['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(op))
    throw new Refused('invalid_operation', 'op must be add, remove, replace, move, copy or test.');
  if (typeof path !== 'string') throw new Refused('invalid_operation', 'path must be a string.');
  const needsValue = op === 'add' || op === 'replace' || op === 'test';
  if (needsValue && !Object.hasOwn(raw, 'value'))
    throw new Refused('invalid_operation', `${op} needs a value.`);
  const from: unknown = (raw as { from?: unknown }).from;
  if ((op === 'move' || op === 'copy') && typeof from !== 'string')
    throw new Refused('invalid_operation', `${op} needs a from pointer.`);
  return {
    op: op as Operation['op'],
    path,
    ...(typeof from === 'string' ? { from } : {}),
    ...(needsValue ? { value: (raw as { value?: unknown }).value } : {}),
  };
}

// Each inserted value is weighed before it's copied, so nothing over the limit is built.
function inserted(budget: Budget, value: unknown, depth: number): JsonValue {
  budget.take(value, depth);
  return clone(value);
}

function apply(document: JsonValue, operation: Operation, budget: Budget): JsonValue {
  const tokens = parsePointer(operation.path);
  switch (operation.op) {
    case 'add':
      return add(document, tokens, inserted(budget, operation.value, tokens.length));
    case 'remove':
      if (tokens.length === 0)
        throw new Refused('invalid_operation', 'The whole document cannot be removed.');
      return remove(document, tokens);
    case 'replace':
      get(document, tokens);
      return tokens.length === 0
        ? inserted(budget, operation.value, 0)
        : add(remove(document, tokens), tokens, inserted(budget, operation.value, tokens.length));
    case 'move': {
      const from = parsePointer(operation.from ?? '');
      if (
        from.length < tokens.length &&
        from.every((token, position) => tokens[position] === token)
      )
        throw new Refused(
          'move_into_child',
          'A value cannot be moved into one of its own children.',
        );
      const value = get(document, from);
      budget.check(value, tokens.length);
      return add(remove(document, from), tokens, value);
    }
    case 'copy':
      return add(
        document,
        tokens,
        inserted(budget, get(document, parsePointer(operation.from ?? '')), tokens.length),
      );
    case 'test': {
      const expected = operation.value;
      budget.check(expected, tokens.length);
      if (!equal(get(document, tokens), expected))
        throw new Refused('test_failed', `${operation.path} is not the value tested for.`);
      return document;
    }
  }
}

/**
 * Applies a patch to a copy of the document: all of it, or, at the first failure, none.
 * The document itself must be JSON within the limits too; an empty patch checks just that.
 */
export function applyJsonPatch(
  document: unknown,
  patch: unknown,
  { maxSize = DEFAULT_PATCH_SIZE }: PatchOptions = {},
): PatchResult {
  if (!Array.isArray(patch))
    return {
      ok: false,
      error: { index: 0, code: 'invalid_patch', message: 'A patch is an array of operations.' },
    };
  if (patch.length > MAX_PATCH_OPERATIONS)
    return {
      ok: false,
      error: {
        index: MAX_PATCH_OPERATIONS,
        code: 'invalid_patch',
        message: `A patch holds at most ${String(MAX_PATCH_OPERATIONS)} operations.`,
      },
    };
  const budget = new Budget(maxSize);
  const refusal = (index: number, error: unknown): PatchResult => {
    if (!(error instanceof Refused)) throw error;
    return { ok: false, error: { index, code: error.code, message: error.message } };
  };
  let working: JsonValue;
  try {
    working = inserted(budget, document, 0);
  } catch (error) {
    return refusal(0, error);
  }
  for (const [position, raw] of (patch as unknown[]).entries()) {
    try {
      working = apply(working, operationOf(raw), budget);
    } catch (error) {
      return refusal(position, error);
    }
  }
  return { ok: true, document: working };
}

export type JsonPatchOperation =
  | { readonly op: 'add' | 'replace'; readonly path: string; readonly value: JsonValue }
  | { readonly op: 'remove'; readonly path: string };

// RFC 6901 section 3: "~" is written ~0 and "/" is written ~1, in that order.
const tokenOf = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * The JSON Patch that turns one document into another, such as one published version into
 * the next: members compared one by one, and an array whose length changed replaced whole.
 * For stored documents, which are within MAX_PATCH_DEPTH.
 */
export function diffJson(from: JsonValue, to: JsonValue, path = ''): JsonPatchOperation[] {
  if (equal(from, to)) return [];
  if (Array.isArray(from) && Array.isArray(to) && from.length === to.length)
    return from.flatMap((item, position) =>
      diffJson(item, to[position] ?? null, `${path}/${String(position)}`),
    );
  if (isObject(from) && isObject(to))
    return [
      ...Object.entries(from).flatMap(([key, member]): JsonPatchOperation[] =>
        Object.hasOwn(to, key)
          ? diffJson(member, to[key] ?? null, `${path}/${tokenOf(key)}`)
          : [{ op: 'remove', path: `${path}/${tokenOf(key)}` }],
      ),
      ...Object.entries(to)
        .filter(([key]) => !Object.hasOwn(from, key))
        .map(([key, member]): JsonPatchOperation => ({
          op: 'add',
          path: `${path}/${tokenOf(key)}`,
          value: member,
        })),
    ];
  return [{ op: 'replace', path, value: to }];
}
