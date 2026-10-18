import { expect, it } from 'vitest';

import { visitorSource } from './visitor-source.js';

it('counts one IPv4 address as one source', () => {
  expect(visitorSource('203.0.113.10')).toEqual({
    key: '203.0.113.10',
    network: '203.0.113.10/32',
  });
  expect(visitorSource('203.0.113.11').key).not.toBe(visitorSource('203.0.113.10').key);
});

it('counts an IPv4 address written as IPv6 as the IPv4 address', () => {
  expect(visitorSource('::ffff:203.0.113.10')).toEqual(visitorSource('203.0.113.10'));
  expect(visitorSource('::FFFF:cb00:710a')).toEqual(visitorSource('203.0.113.10'));
});

it('counts every address of one IPv6 /64, which one household or phone holds, as one source', () => {
  const home = visitorSource('2001:db8:aa:bb:1:2:3:4');
  expect(home).toEqual({ key: '2001:db8:aa:bb::/64', network: '2001:db8:aa:bb::/64' });
  expect(visitorSource('2001:0db8:00aa:00bb:ffff:ffff:ffff:ffff')).toEqual(home);
  expect(visitorSource('2001:db8:aa:bb::')).toEqual(home);
  expect(visitorSource('2001:db8:aa:bc::1').key).not.toBe(home.key);
  expect(visitorSource('::1')).toEqual({ key: '::/64', network: '::/64' });
  expect(visitorSource('fe80::')).toEqual({ key: 'fe80::/64', network: 'fe80::/64' });
  expect(visitorSource('1:2:3:4::')).toEqual({ key: '1:2:3:4::/64', network: '1:2:3:4::/64' });
  expect(visitorSource('1:0:0:4::9').key).toBe('1:0:0:4::/64');
  expect(visitorSource('0:0:0:0:0:0:0:0').key).toBe('::/64');
});

it('refuses what is not an address', () => {
  for (const given of ['', 'example.com', '203.0.113', '2001:db8::g', '1::2::3'])
    expect(() => visitorSource(given)).toThrow('Not an IP address.');
});
