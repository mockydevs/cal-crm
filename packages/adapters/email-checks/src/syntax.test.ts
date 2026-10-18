import { describe, expect, it } from 'vitest';

import { checkSyntax } from './syntax.js';

describe('checkSyntax', () => {
  it.each([
    ['john@example.com', 'john', 'example.com'],
    ['John.Smith@Example.COM', 'John.Smith', 'example.com'],
    ['  padded@example.com  ', 'padded', 'example.com'],
    ['first.last+tag@sub.example.co.uk', 'first.last+tag', 'sub.example.co.uk'],
    ["o'brien@example.ie", "o'brien", 'example.ie'],
    ['a!#$%&*/=?^_`{|}~-z@example.com', 'a!#$%&*/=?^_`{|}~-z', 'example.com'],
    ['user@münchen.de', 'user', 'xn--mnchen-3ya.de'],
    ['user@xn--mnchen-3ya.de', 'user', 'xn--mnchen-3ya.de'],
    ['user@例え.テスト', 'user', 'xn--r8jz45g.xn--zckzah'],
    ['user@ab--cd.example', 'user', 'ab--cd.example'],
    ['user@1example.com', 'user', '1example.com'],
  ])('accepts %s', (input, local, domain) => {
    expect(checkSyntax(input)).toEqual({
      kind: 'ok',
      local,
      domain,
      address: `${local}@${domain}`,
    });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['john.example.com', 'no_at'],
    ['@example.com', 'bad_local_part'],
    ['john@', 'bad_domain'],
    ['.john@example.com', 'bad_local_part'],
    ['john.@example.com', 'bad_local_part'],
    ['jo..hn@example.com', 'bad_local_part'],
    ['jo hn@example.com', 'bad_local_part'],
    ['jo(hn)@example.com', 'bad_local_part'],
    ['a@b@example.com', 'bad_local_part'],
    ['jo\u0000hn@example.com', 'bad_local_part'],
    ['john@exa mple.com', 'bad_domain'],
    ['john@ex%41.com', 'bad_domain'],
    ['john@a_b.com', 'bad_domain'],
    ['john@-example.com', 'bad_domain'],
    ['john@example-.com', 'bad_domain'],
    ['john@example..com', 'bad_domain'],
    ['john@.example.com', 'bad_domain'],
    ['john@example.com.', 'bad_domain'],
    ['john@xn--zz.com', 'bad_domain'],
    [`john@${'a'.repeat(64)}.com`, 'bad_domain'],
    ['john@localhost', 'single_label_domain'],
    ['john@1.2.3.4', 'numeric_top_level_domain'],
    ['john@0x7f.1', 'numeric_top_level_domain'],
    [`${'a'.repeat(65)}@example.com`, 'local_too_long'],
    [
      `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.com`,
      'address_too_long',
    ],
  ])('refuses %j as %s', (input, problem) => {
    expect(checkSyntax(input)).toEqual({ kind: 'invalid', problem });
  });

  it('takes 64 octets of local part and 254 of address, the RFC 5321 and RFC 3696 limits', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    expect(`${local}@${domain}`).toHaveLength(254);
    expect(checkSyntax(`${local}@${domain}`).kind).toBe('ok');
  });

  it.each([
    ['"john smith"@example.com', 'quoted_local_part'],
    ['"a@b"@example.com', 'quoted_local_part'],
    ['jöhn@example.com', 'non_ascii_local_part'],
    ['john@[192.0.2.1]', 'address_literal'],
    ['john@[IPv6:2001:db8::1]', 'address_literal'],
  ])(
    'leaves %j unchecked as %s, which the RFCs allow but this check does not read',
    (input, problem) => {
      expect(checkSyntax(input)).toEqual({ kind: 'unsupported', problem });
    },
  );
});
