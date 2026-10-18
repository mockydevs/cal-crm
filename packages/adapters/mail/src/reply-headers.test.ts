import { describe, expect, it } from 'vitest';

import { REPLY_HEADER_LIMITS, msgIdOf, replyHeadersOf, safeReplyHeaders } from './reply-headers.js';

const id = (name: string) => `<${name}@mail.example.test>`;
const sized = (length: number) => `<${'a'.repeat(length - '<@x.test>'.length)}@x.test>`;
const headerLength = (references: readonly string[]) =>
  `References: ${references.join(' ')}`.length;

describe('msgIdOf', () => {
  it.each([
    '<a@b>',
    '<CAL+abc=def_123@mail.gmail.com>',
    '<DB7PR04MB4521.9F3A$x@DB7PR04MB4521.eurprd04.prod.outlook.com>',
    "<!#$%&'*+-/=?^_`{|}~.x@host.example>",
    '<1234@[192.0.2.1]>',
    '<1234@[IPv6:2001:db8::1]>',
    '<crm-outbound.019283a4-7b1c-7def-8abc-0123456789ab@crm.invalid>',
  ])('keeps %s exactly as it is', (value) => {
    expect(msgIdOf(value)).toBe(value);
  });

  it.each([
    ['nothing', ''],
    ['no angle brackets', 'a@b'],
    ['no right-hand side', '<a@>'],
    ['no left-hand side', '<@b>'],
    ['no at sign', '<ab>'],
    ['two at signs', '<a@b@c>'],
    ['a space inside', '<a b@c>'],
    ['a space before', ' <a@b>'],
    ['a space after', '<a@b> '],
    ['a tab inside', '<a\t@b>'],
    ['a line feed', '<a@b>\n'],
    ['a carriage return and a smuggled header', '<a@b>\r\nBcc: someone@example.test'],
    ['a folded smuggled header', '<a@b\r\n Bcc: someone@example.test>'],
    ['a NUL', '<a\u0000@b>'],
    ['a DEL', '<a\u007f@b>'],
    ['a character outside ASCII', '<é@b>'],
    ['an encoded word', '<=?utf-8?q?a?= @b>'],
    ['a comment', '<a(comment)@b>'],
    ['a quoted string, the obsolete form', '<"a b"@c>'],
    ['a leading dot', '<.a@b>'],
    ['a trailing dot', '<a.@b>'],
    ['two dots in a row', '<a..b@c>'],
    ['a dot ending the right-hand side', '<a@b.>'],
    ['an unclosed literal', '<a@[192.0.2.1>'],
    ['a bracket inside a literal', '<a@[[x]]>'],
    ['a backslash inside a literal', '<a@[x\\y]>'],
    ['two ids', '<a@b> <c@d>'],
    ['two ids without a space', '<a@b><c@d>'],
    ['a nested bracket', '<<a@b>>'],
    ['a comma', '<a,b@c>'],
    ['a semicolon', '<a@b;c>'],
    ['a colon outside a literal', '<a:b@c>'],
  ])('drops an id with %s', (_why, value) => {
    expect(msgIdOf(value)).toBeNull();
  });

  it('keeps an id of the greatest length and drops a longer one', () => {
    expect(msgIdOf(sized(REPLY_HEADER_LIMITS.msgIdChars))).toBe(
      sized(REPLY_HEADER_LIMITS.msgIdChars),
    );
    expect(msgIdOf(sized(REPLY_HEADER_LIMITS.msgIdChars + 1))).toBeNull();
  });
});

describe('replyHeadersOf', () => {
  it("answers the parent: its Message-ID, after the parent's own References", () => {
    expect(
      replyHeadersOf({
        messageId: id('c'),
        inReplyTo: [id('b')],
        references: [id('a'), id('b')],
      }),
    ).toEqual({ inReplyTo: id('c'), references: [id('a'), id('b'), id('c')] });
  });

  it("uses the parent's In-Reply-To when it has no References and names one message", () => {
    expect(replyHeadersOf({ messageId: id('b'), inReplyTo: [id('a')], references: [] })).toEqual({
      inReplyTo: id('b'),
      references: [id('a'), id('b')],
    });
  });

  it("leaves out the parent's In-Reply-To when it names more than one message", () => {
    expect(
      replyHeadersOf({ messageId: id('c'), inReplyTo: [id('a'), id('b')], references: [] }),
    ).toEqual({ inReplyTo: id('c'), references: [id('c')] });
  });

  it('starts a thread at a parent that answered nothing', () => {
    expect(replyHeadersOf({ messageId: id('a'), inReplyTo: [], references: [] })).toEqual({
      inReplyTo: id('a'),
      references: [id('a')],
    });
  });

  it('has no In-Reply-To for a parent without a Message-ID, and keeps its References', () => {
    expect(
      replyHeadersOf({ messageId: null, inReplyTo: [id('b')], references: [id('a')] }),
    ).toEqual({ inReplyTo: null, references: [id('a')] });
  });

  it('has neither header for a parent with none of the three', () => {
    expect(replyHeadersOf({ messageId: null, inReplyTo: [], references: [] })).toEqual({
      inReplyTo: null,
      references: [],
    });
  });

  it('never guesses at a malformed Message-ID: the reply names no parent', () => {
    expect(
      replyHeadersOf({
        messageId: '<a@b>\r\nBcc: someone@example.test',
        inReplyTo: [],
        references: [id('a')],
      }),
    ).toEqual({ inReplyTo: null, references: [id('a')] });
  });

  it('drops each malformed reference and keeps the others in their order', () => {
    expect(
      replyHeadersOf({
        messageId: id('d'),
        inReplyTo: [],
        references: [id('a'), '<b@c>\r\nX-Injected: 1', 'plain text', id('c'), '<é@x>'],
      }),
    ).toEqual({ inReplyTo: id('d'), references: [id('a'), id('c'), id('d')] });
  });

  it('names the parent once, and last, when its References already hold its own id', () => {
    expect(
      replyHeadersOf({
        messageId: id('b'),
        inReplyTo: [],
        references: [id('b'), id('a'), id('b')],
      }),
    ).toEqual({ inReplyTo: id('b'), references: [id('a'), id('b')] });
  });

  it('keeps a long thread whole while the header fits in one line of 998 characters', () => {
    // "References: ", 29 ids of 32 characters, one of 29, and 29 spaces: 12 + 928 + 29 + 29.
    const fits = Array.from({ length: 29 }, (_, index) =>
      sized(32).replace('aaa', `a${String(index).padStart(2, '0')}`),
    );
    const made = replyHeadersOf({ messageId: sized(29), inReplyTo: [], references: fits });
    expect(made.references).toEqual([...fits, sized(29)]);
    expect(headerLength(made.references)).toBe(REPLY_HEADER_LIMITS.headerChars);
  });

  it('trims a thread that would not fit: the first id and the newest stay, the oldest after the first go', () => {
    const thread = Array.from({ length: 60 }, (_, index) =>
      id(`m${String(index).padStart(3, '0')}`),
    );
    const made = replyHeadersOf({ messageId: id('parent'), inReplyTo: [], references: thread });
    const kept = made.references;
    expect(headerLength(kept)).toBeLessThanOrEqual(REPLY_HEADER_LIMITS.headerChars);
    // The thread's root, then an unbroken run of the newest ids ending with the parent.
    expect(kept[0]).toBe(thread[0]);
    const all = [...thread, id('parent')];
    expect(kept.slice(1)).toEqual(all.slice(all.length - (kept.length - 1)));
    expect(kept.at(-1)).toBe(id('parent'));
    // Nothing more could have been kept: the next older id would not have fitted.
    const next = all[all.length - kept.length] ?? '';
    expect(headerLength(kept) + 1 + next.length).toBeGreaterThan(REPLY_HEADER_LIMITS.headerChars);
  });

  it('always has room for the first id and the last two, whatever their length', () => {
    const longest = (name: string) =>
      sized(REPLY_HEADER_LIMITS.msgIdChars).replace('aaa', name.padEnd(3, 'x'));
    const references = [longest('one'), longest('two'), longest('thr'), longest('fou')];
    const made = replyHeadersOf({ messageId: longest('par'), inReplyTo: [], references });
    expect(made.references).toEqual([longest('one'), longest('fou'), longest('par')]);
    expect(headerLength(made.references)).toBeLessThanOrEqual(REPLY_HEADER_LIMITS.headerChars);
  });
});

describe('safeReplyHeaders', () => {
  it('passes well-formed headers through unchanged', () => {
    expect(safeReplyHeaders({ inReplyTo: id('b'), references: [id('a'), id('b')] })).toEqual({
      inReplyTo: id('b'),
      references: [id('a'), id('b')],
    });
  });

  it('drops what is malformed, whoever handed it over', () => {
    expect(
      safeReplyHeaders({
        inReplyTo: '<a@b>\r\nBcc: someone@example.test',
        references: [id('a'), 'x', '<b@c> <d@e>'],
      }),
    ).toEqual({ inReplyTo: null, references: [id('a')] });
  });

  it('holds a thread handed over too long to the same bound', () => {
    const thread = Array.from({ length: 80 }, (_, index) =>
      id(`m${String(index).padStart(3, '0')}`),
    );
    const made = safeReplyHeaders({ inReplyTo: thread.at(-1) ?? null, references: thread });
    expect(headerLength(made.references)).toBeLessThanOrEqual(REPLY_HEADER_LIMITS.headerChars);
    expect(made.references[0]).toBe(thread[0]);
    expect(made.references.at(-1)).toBe(thread.at(-1));
  });

  it('has nothing to say for nothing', () => {
    expect(safeReplyHeaders({ inReplyTo: null, references: [] })).toEqual({
      inReplyTo: null,
      references: [],
    });
  });
});
