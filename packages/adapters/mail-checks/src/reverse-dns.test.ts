import { describe, expect, it } from 'vitest';

import { fixtureResolver } from './fixture-resolver.js';
import { checkReverseDns } from './reverse-dns.js';

const ptr = '10.2.0.192.in-addr.arpa';

describe('the reverse DNS check', () => {
  it("doesn't apply to the servers of a provider the connector detected", async () => {
    expect(
      await checkReverseDns(
        { sendingIp: '192.0.2.10', detectedProvider: 'google' },
        fixtureResolver({}),
      ),
    ).toEqual({
      key: 'reverse_dns',
      status: 'not_applicable',
      reason: 'provider_managed',
      found: { provider: 'google' },
    });
  });

  it("couldn't check without a sending IP, or with one that isn't an address", async () => {
    expect(await checkReverseDns({}, fixtureResolver({}))).toEqual({
      key: 'reverse_dns',
      status: 'could_not_check',
      reason: 'no_sending_ip',
      found: {},
    });
    expect(await checkReverseDns({ sendingIp: 'mail.example.test' }, fixtureResolver({}))).toEqual({
      key: 'reverse_dns',
      status: 'could_not_check',
      reason: 'invalid_ip',
      found: { ip: 'mail.example.test' },
    });
  });

  it("passes when the IP's PTR name resolves back to it", async () => {
    const resolve = fixtureResolver({
      [ptr]: { PTR: ['Mail.Example.Test.'] },
      'mail.example.test': { A: ['192.0.2.9', '192.0.2.10'] },
    });
    expect(await checkReverseDns({ sendingIp: '192.0.2.10' }, resolve)).toEqual({
      key: 'reverse_dns',
      status: 'pass',
      reason: 'forward_confirmed',
      found: { ip: '192.0.2.10', ptr: ['mail.example.test'], confirmed: 'mail.example.test' },
    });
  });

  it('confirms an IPv6 sending address through AAAA, comparing addresses by value', async () => {
    const resolve = fixtureResolver({
      '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa': {
        PTR: ['mail.example.test'],
      },
      'mail.example.test': { AAAA: ['2001:db8:0:0::1'] },
    });
    expect(await checkReverseDns({ sendingIp: '2001:DB8::1' }, resolve)).toMatchObject({
      status: 'pass',
      found: { ip: '2001:db8::1', confirmed: 'mail.example.test' },
    });
  });

  it("fails without a PTR record, asking the IP's owner, naming the SMTP host only when it resolves to the IP", async () => {
    const proven = fixtureResolver({ 'smtp.example.test': { A: ['192.0.2.10'] } });
    expect(
      await checkReverseDns({ sendingIp: '192.0.2.10', smtpHost: 'SMTP.Example.Test.' }, proven),
    ).toEqual({
      key: 'reverse_dns',
      status: 'fail',
      reason: 'no_ptr',
      found: { ip: '192.0.2.10' },
      fix: { kind: 'ask', who: 'ip_owner', ip: '192.0.2.10', ptr: 'smtp.example.test' },
    });

    const elsewhere = fixtureResolver({ 'smtp.example.test': { A: ['198.51.100.7'] } });
    expect(
      await checkReverseDns({ sendingIp: '192.0.2.10', smtpHost: 'smtp.example.test' }, elsewhere),
    ).toMatchObject({ reason: 'no_ptr', fix: { kind: 'ask', who: 'ip_owner', ip: '192.0.2.10' } });
    expect(
      (await checkReverseDns({ sendingIp: '192.0.2.10', smtpHost: 'smtp.example.test' }, elsewhere))
        .fix,
    ).not.toHaveProperty('ptr');
  });

  it('fails when no PTR name resolves back to the IP, saying what each name resolves to', async () => {
    const resolve = fixtureResolver({
      [ptr]: { PTR: ['host.isp.test', 'other.isp.test'] },
      'host.isp.test': { A: ['198.51.100.1'] },
    });
    expect(await checkReverseDns({ sendingIp: '192.0.2.10' }, resolve)).toEqual({
      key: 'reverse_dns',
      status: 'fail',
      reason: 'ptr_mismatch',
      found: {
        ip: '192.0.2.10',
        ptr: ['host.isp.test', 'other.isp.test'],
        forward: { 'host.isp.test': ['198.51.100.1'], 'other.isp.test': [] },
      },
      fix: { kind: 'ask', who: 'ip_owner', ip: '192.0.2.10' },
    });
  });

  it("couldn't check when the PTR lookup fails", async () => {
    const resolve = fixtureResolver({ [ptr]: { error: 'ESERVFAIL' } });
    expect(await checkReverseDns({ sendingIp: '192.0.2.10' }, resolve)).toEqual({
      key: 'reverse_dns',
      status: 'could_not_check',
      reason: 'dns_error',
      found: { ip: '192.0.2.10', code: 'ESERVFAIL' },
    });
  });

  it("couldn't check when a forward lookup fails and no other name confirms the IP", async () => {
    const resolve = fixtureResolver({
      [ptr]: { PTR: ['host.isp.test'] },
      'host.isp.test': { error: 'ETIMEOUT' },
    });
    expect(await checkReverseDns({ sendingIp: '192.0.2.10' }, resolve)).toEqual({
      key: 'reverse_dns',
      status: 'could_not_check',
      reason: 'dns_error',
      found: { ip: '192.0.2.10', ptr: ['host.isp.test'], code: 'ETIMEOUT' },
    });
  });

  it("passes when one name confirms the IP even if another name's lookup fails", async () => {
    const resolve = fixtureResolver({
      [ptr]: { PTR: ['broken.isp.test', 'mail.example.test'] },
      'broken.isp.test': { error: 'ETIMEOUT' },
      'mail.example.test': { A: ['192.0.2.10'] },
    });
    expect(await checkReverseDns({ sendingIp: '192.0.2.10' }, resolve)).toMatchObject({
      status: 'pass',
      found: { confirmed: 'mail.example.test' },
    });
  });
});
