import { describe, expect, it } from 'vitest';

import { allowedOrigin, canonicalWebOrigin } from './webchat-origin.js';

const allowed = ['https://example.com', 'https://xn--bcher-kva.example', 'http://localhost:4173'];

it('matches a listed origin exactly and answers with the stored value', () => {
  for (const origin of allowed) expect(allowedOrigin(origin, allowed)).toBe(origin);
});

it.each([
  ['a host that only starts with a listed one', 'https://example.com.evil.test'],
  ['a host that only ends with a listed one', 'https://evilexample.com'],
  ['a subdomain', 'https://www.example.com'],
  ['a parent domain', 'https://com'],
  ['user information hiding another host', 'https://example.com@evil.test'],
  ['another scheme', 'http://example.com'],
  ['another port', 'https://example.com:8443'],
  ['the default port written out', 'https://example.com:443'],
  ['a trailing slash', 'https://example.com/'],
  ['a path', 'https://example.com/chat'],
  ['a trailing dot', 'https://example.com.'],
  ['upper case', 'HTTPS://EXAMPLE.COM'],
  ['mixed case in the host', 'https://Example.com'],
  ['the Unicode spelling of a listed name', 'https://bücher.example'],
  ['a letter from another alphabet', 'https://exаmple.com'],
  ['a leading space', ' https://example.com'],
  ['a trailing space', 'https://example.com '],
  ['a line break', 'https://example.com\n'],
  ['two origins in one header', 'https://example.com, https://evil.test'],
  ['two origins with a space', 'https://example.com https://evil.test'],
  ['the opaque origin', 'null'],
  ['a wildcard', '*'],
  ['nothing', ''],
  ['localhost on another port', 'http://localhost:4174'],
  ['localhost without its port', 'http://localhost'],
])('refuses %s', (_why, header) => {
  expect(allowedOrigin(header, allowed)).toBeUndefined();
});

it('refuses a missing header, a repeated header and anything that is not text', () => {
  expect(allowedOrigin(undefined, allowed)).toBeUndefined();
  expect(allowedOrigin(null, allowed)).toBeUndefined();
  expect(allowedOrigin(['https://example.com', 'https://example.com'], allowed)).toBeUndefined();
  expect(allowedOrigin(['https://example.com'], allowed)).toBeUndefined();
  expect(allowedOrigin({ toString: () => 'https://example.com' }, allowed)).toBeUndefined();
});

it('allows nobody when no website is listed, and never the opaque origin or an empty entry', () => {
  expect(allowedOrigin('https://example.com', [])).toBeUndefined();
  expect(allowedOrigin('null', ['null'])).toBeUndefined();
  expect(allowedOrigin('', [''])).toBeUndefined();
  expect(allowedOrigin('*', ['https://example.com'])).toBeUndefined();
});

it('matches what canonicalWebOrigin stores against what a browser sends', () => {
  // The admin types these; a browser on that site sends the stored form.
  const stored = ['HTTPS://Example.COM/', 'https://bücher.example', 'https://example.com:443']
    .map(canonicalWebOrigin)
    .filter((origin) => origin !== undefined);
  expect(stored).toEqual([
    'https://example.com',
    'https://xn--bcher-kva.example',
    'https://example.com',
  ]);
  expect(allowedOrigin('https://example.com', stored)).toBe('https://example.com');
  expect(allowedOrigin('https://xn--bcher-kva.example', stored)).toBe(
    'https://xn--bcher-kva.example',
  );
  expect(allowedOrigin('https://example.com.evil.test', stored)).toBeUndefined();
});

describe('canonicalWebOrigin', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['HTTPS://Example.COM', 'https://example.com'],
    ['https://example.com:443', 'https://example.com'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['https://shop.example.co.ke', 'https://shop.example.co.ke'],
    ['https://bücher.example', 'https://xn--bcher-kva.example'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
    ['http://localhost:4173', 'http://localhost:4173'],
    ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    ['http://localhost:80', 'http://localhost'],
  ])('stores %s as %s', (input, stored) => {
    expect(canonicalWebOrigin(input)).toBe(stored);
  });

  it.each([
    ['plain HTTP off loopback', 'http://example.com'],
    ['a loopback look-alike', 'http://localhost.example.com'],
    ['a path', 'https://example.com/chat'],
    ['a second slash', 'https://example.com//'],
    ['a query', 'https://example.com?x=1'],
    ['an empty query', 'https://example.com/?'],
    ['a fragment', 'https://example.com#x'],
    ['user information that hides the host', 'https://example.com@evil.test'],
    ['a user and password', 'https://user:secret@example.com'],
    ['a backslash the parser reads as a slash', 'https://example.com\\@evil.test'],
    ['a wildcard', 'https://*.example.com'],
    ['a wildcard for everything', '*'],
    ['a trailing dot', 'https://example.com.'],
    ['a leading space', ' https://example.com'],
    ['a trailing space', 'https://example.com '],
    ['a space in the host', 'https://exa mple.com'],
    ['a line break the parser would drop', 'https://exam\nple.com'],
    ['a tab the parser would drop', 'https://exam\tple.com'],
    ['a NUL', 'https://example.com\u0000'],
    ['a delete character', 'https://example.com\u007f'],
    ['a control character past ASCII', 'https://exam\u0085ple.com'],
    ['a space that is not the ASCII one', 'https://exam ple.com'],
    ['a line separator', 'https://example.com '],
    ['a percent escape the parser would decode', 'https://ex%61mple.com'],
    ['another scheme', 'ftp://example.com'],
    ['a script scheme', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,hello'],
    ['no scheme', 'example.com'],
    ['a scheme-relative address', '//example.com'],
    // The URL parser repairs each of these into https://example.com; none is stored.
    ['a scheme with no slashes', 'https:example.com'],
    ['a scheme with one slash', 'https:/example.com'],
    ['a scheme with three slashes', 'https:///example.com'],
    ['the opaque origin', 'null'],
    ['nothing', ''],
    ['a scheme alone', 'https://'],
    ['a port out of range', 'https://example.com:99999'],
    ['a port that is not a number', 'https://example.com:https'],
    ['more than 255 characters', `https://${'a'.repeat(250)}.com`],
  ])('refuses %s', (_why, input) => {
    expect(canonicalWebOrigin(input)).toBeUndefined();
  });

  it('keeps a look-alike host as the different website it is', () => {
    // It can be listed, as itself; it never equals the site it imitates.
    expect(canonicalWebOrigin('https://example.com.evil.test')).toBe(
      'https://example.com.evil.test',
    );
    expect(canonicalWebOrigin('https://example.com.evil.test')).not.toBe(
      canonicalWebOrigin('https://example.com'),
    );
  });
});
