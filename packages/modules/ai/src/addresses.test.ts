// Where a model provider may be reached. No test here opens a connection.
import { describe, expect, it } from 'vitest';

import {
  checkBaseUrl,
  checkServerUrl,
  isPublicAddress,
  parseLocalServers,
  resolveServerAddress,
  type ServerLookup,
} from './addresses.js';

const lookupOf =
  (...addresses: readonly string[]): ServerLookup =>
  () =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );

describe('the install’s list of its own model servers', () => {
  it('reads host and port pairs, and nothing when unset', () => {
    expect(parseLocalServers(undefined)).toEqual([]);
    expect(parseLocalServers('  ')).toEqual([]);
    expect(
      parseLocalServers('ollama:11434, 192.168.1.20:8080 ,[::1]:1234,LMStudio.lan:1234'),
    ).toEqual([
      { host: 'ollama', port: 11434 },
      { host: '192.168.1.20', port: 8080 },
      { host: '[::1]', port: 1234 },
      { host: 'lmstudio.lan', port: 1234 },
    ]);
  });

  it('writes an address the way a URL does, so one server has one spelling', () => {
    expect(parseLocalServers('0x7f.1:11434,[0:0:0:0:0:0:0:1]:8000')).toEqual([
      { host: '127.0.0.1', port: 11434 },
      { host: '[::1]', port: 8000 },
    ]);
  });

  it.each([
    'ollama',
    'ollama:',
    ':11434',
    'ollama:0',
    'ollama:65536',
    'ollama:11434x',
    'http://ollama:11434',
    'user@ollama:11434',
    'ollama:11434/v1',
    'two words:80',
    '::1:11434',
    '*:11434',
    'ollama:11434,,lan:1',
  ])('refuses %j rather than guess what was meant', (value) => {
    expect(() => parseLocalServers(value)).toThrow(RangeError);
  });

  it('never repeats the setting in its error', () => {
    expect(() => parseLocalServers('secret-host:notaport')).toThrow(
      /^AI_LOCAL_SERVERS: entry 1 is not host:port\.$/,
    );
  });
});

describe('a provider’s address', () => {
  const local = parseLocalServers('ollama:11434,192.168.1.20:443');

  it('may be any https address on port 443', () => {
    const checked = checkServerUrl('https://api.example.com/v1/chat/completions?x=1', local);
    expect(checked).toMatchObject({ ok: true, port: 443, local: false, secure: true });
    expect(checkServerUrl('https://API.Example.com:443/v1', [])).toMatchObject({
      ok: true,
      local: false,
    });
  });

  it('may be http, or another port, only for a server the install lists', () => {
    expect(checkServerUrl('http://ollama:11434/v1', local)).toMatchObject({
      ok: true,
      port: 11434,
      local: true,
      secure: false,
    });
    expect(checkServerUrl('http://OLLAMA:11434/v1', local)).toMatchObject({
      ok: true,
      local: true,
    });
    expect(checkServerUrl('https://192.168.1.20/v1', local)).toMatchObject({
      ok: true,
      port: 443,
      local: true,
      secure: true,
    });
    expect(checkServerUrl('http://ollama:11434/v1', [])).toEqual({
      ok: false,
      reason: 'not_https',
    });
    expect(checkServerUrl('http://ollama:11435/v1', local)).toEqual({
      ok: false,
      reason: 'not_https',
    });
    expect(checkServerUrl('https://api.example.com:8443/v1', local)).toEqual({
      ok: false,
      reason: 'port_not_allowed',
    });
    // The same host on a port that was not listed is not the listed server.
    expect(checkServerUrl('https://ollama:8443/v1', local)).toEqual({
      ok: false,
      reason: 'port_not_allowed',
    });
  });

  it('is refused when it is not an address, or carries a user name or password', () => {
    expect(checkServerUrl('ollama/v1', local)).toEqual({ ok: false, reason: 'not_a_url' });
    expect(checkServerUrl('', local)).toEqual({ ok: false, reason: 'not_a_url' });
    // Without a scheme, a URL reads "ollama:" as one.
    expect(checkServerUrl('ollama:11434', local)).toEqual({ ok: false, reason: 'not_https' });
    expect(checkServerUrl('ftp://ollama:11434/v1', local)).toEqual({
      ok: false,
      reason: 'not_https',
    });
    expect(checkServerUrl('https://key@api.example.com/v1', [])).toEqual({
      ok: false,
      reason: 'has_credentials',
    });
    expect(checkServerUrl('https://user:pass@api.example.com/v1', [])).toEqual({
      ok: false,
      reason: 'has_credentials',
    });
  });
});

describe('a model server\u2019s address, as Settings takes it', () => {
  const local = parseLocalServers('ollama:11434');

  it('follows the same rules, and carries no query or fragment', () => {
    expect(checkBaseUrl('http://ollama:11434/v1', local)).toMatchObject({ ok: true, local: true });
    expect(checkBaseUrl('https://api.example.com/v1/', local)).toMatchObject({
      ok: true,
      local: false,
    });
    expect(checkBaseUrl('https://api.example.com/v1?key=1', local)).toEqual({
      ok: false,
      reason: 'has_query',
    });
    expect(checkBaseUrl('http://ollama:11434/v1#x', local)).toEqual({
      ok: false,
      reason: 'has_query',
    });
    expect(checkBaseUrl('http://ollama:11435/v1', local)).toEqual({
      ok: false,
      reason: 'not_https',
    });
    expect(checkBaseUrl('nonsense', local)).toEqual({ ok: false, reason: 'not_a_url' });
  });
});

describe('public addresses', () => {
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '%s is on the public internet',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.20',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    'fe80::1%eth0',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '2002:7f00:1::',
    '2001:db8::1',
    '64:ff9b::7f00:1',
    'ollama',
    '',
  ])('%s is not', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('finding where to connect', () => {
  const local = parseLocalServers('ollama:11434');
  const checked = (url: string) => {
    const result = checkServerUrl(url, local);
    if (!result.ok) throw new Error(result.reason);
    return result;
  };

  it('connects a public name to its first address when every address is public', async () => {
    expect(
      await resolveServerAddress(
        checked('https://api.example.com/v1'),
        lookupOf('93.184.216.34', '2606:4700:4700::1111'),
      ),
    ).toEqual({ ok: true, address: '93.184.216.34', family: 4 });
  });

  it('refuses a public name that also answers with a private address', async () => {
    expect(
      await resolveServerAddress(
        checked('https://api.example.com/v1'),
        lookupOf('93.184.216.34', '10.0.0.5'),
      ),
    ).toEqual({ ok: false, code: 'blocked_address' });
    expect(
      await resolveServerAddress(
        checked('https://api.example.com/v1'),
        lookupOf('169.254.169.254'),
      ),
    ).toEqual({ ok: false, code: 'blocked_address' });
  });

  it('refuses a private address written straight into an https address', async () => {
    const never: ServerLookup = () => Promise.reject(new Error('must not be asked'));
    expect(await resolveServerAddress(checked('https://10.0.0.5/v1'), never)).toEqual({
      ok: false,
      code: 'blocked_address',
    });
    expect(await resolveServerAddress(checked('https://[::1]/v1'), never)).toEqual({
      ok: false,
      code: 'blocked_address',
    });
    expect(await resolveServerAddress(checked('https://8.8.8.8/v1'), never)).toEqual({
      ok: true,
      address: '8.8.8.8',
      family: 4,
    });
  });

  it('connects a listed server wherever its name points, since the install vouched for it', async () => {
    expect(
      await resolveServerAddress(checked('http://ollama:11434/v1'), lookupOf('172.18.0.7')),
    ).toEqual({ ok: true, address: '172.18.0.7', family: 4 });
    expect(
      await resolveServerAddress(checked('http://ollama:11434/v1'), lookupOf('fd00::7')),
    ).toEqual({ ok: true, address: 'fd00::7', family: 6 });
  });

  it('says so when a name has no address', async () => {
    expect(await resolveServerAddress(checked('https://api.example.com/v1'), lookupOf())).toEqual({
      ok: false,
      code: 'network',
    });
    const failing: ServerLookup = () => Promise.reject(new Error('ENOTFOUND'));
    expect(await resolveServerAddress(checked('http://ollama:11434/v1'), failing)).toEqual({
      ok: false,
      code: 'network',
    });
  });
});
