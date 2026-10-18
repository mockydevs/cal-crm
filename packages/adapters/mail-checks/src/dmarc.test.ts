import { describe, expect, it } from 'vitest';

import { checkDmarc } from './dmarc.js';
import { fixtureResolver } from './fixture-resolver.js';

const from = 'example.test';

describe('the DMARC record', () => {
  it('rejects malformed resolver TXT answers instead of accepting an apparent policy', async () => {
    const results = await checkDmarc({ fromDomain: from }, () =>
      Promise.resolve(['v=DMARC1; p=reject']),
    );
    expect(results.every((result) => result.status === 'could_not_check')).toBe(true);
  });
  it('uses the non-existent subdomain policy instead of claiming sp is enforced', async () => {
    const results = await checkDmarc(
      { fromDomain: 'missing.example.test' },
      fixtureResolver({
        '_dmarc.example.test': { TXT: ['v=DMARC1; p=reject; sp=reject; np=none'] },
      }),
    );
    expect(results[0]).toMatchObject({ status: 'pass', found: { policy: 'none', np: 'none' } });
    expect(results[1]).toMatchObject({ status: 'fail', reason: 'inherited_policy' });
    expect(results[1]).not.toHaveProperty('fix');
  });
  it('could not check enforcement when DNS cannot distinguish sp from np', async () => {
    const results = await checkDmarc(
      { fromDomain: 'missing.example.test' },
      fixtureResolver({
        'missing.example.test': { error: 'ETIMEOUT' },
        '_dmarc.example.test': { TXT: ['v=DMARC1; p=reject; sp=reject; np=none'] },
      }),
    );
    expect(results.every((result) => result.status === 'could_not_check')).toBe(true);
  });
  it("passes when the From domain's own record is found, which says nothing yet about alignment", async () => {
    const record = 'v=DMARC1; p=none; rua=mailto:reports@example.test';
    const [dmarc] = await checkDmarc(
      { fromDomain: from },
      fixtureResolver({ [`_dmarc.${from}`]: { TXT: [record] } }),
    );
    expect(dmarc).toEqual({
      key: 'dmarc',
      status: 'pass',
      reason: 'record_found',
      found: {
        domain: from,
        record,
        policyDomain: from,
        organizationalDomain: from,
        policy: 'none',
        p: 'none',
        sp: 'none',
        testMode: false,
      },
    });
  });

  it("passes a subdomain covered by its organizational domain's record, found by the Tree Walk (RFC 9989)", async () => {
    const [dmarc] = await checkDmarc(
      { fromDomain: 'news.example.test' },
      fixtureResolver({
        '_dmarc.example.test': { TXT: ['v=DMARC1; p=reject; sp=quarantine'] },
        'news.example.test': { A: ['192.0.2.1'] },
      }),
    );
    expect(dmarc).toMatchObject({
      status: 'pass',
      found: { domain: 'news.example.test', policyDomain: 'example.test', policy: 'quarantine' },
    });
  });

  it('fails without a record, fixing it with p=none and the report address when one is given', async () => {
    const zone = fixtureResolver({ [from]: { A: ['192.0.2.1'] } });
    const [plain] = await checkDmarc({ fromDomain: from }, zone);
    expect(plain).toEqual({
      key: 'dmarc',
      status: 'fail',
      reason: 'no_record',
      found: { domain: from },
      fix: { kind: 'record', type: 'TXT', name: `_dmarc.${from}`, value: 'v=DMARC1; p=none' },
    });
    const [reporting] = await checkDmarc(
      { fromDomain: from, dmarcReportUri: 'mailto:dmarc@reports.example.test' },
      zone,
    );
    expect(reporting).toMatchObject({
      fix: { value: 'v=DMARC1; p=none; rua=mailto:dmarc@reports.example.test' },
    });
    const [ignored] = await checkDmarc(
      { fromDomain: from, dmarcReportUri: 'https://reports.example.test' },
      zone,
    );
    expect(ignored).toMatchObject({ fix: { value: 'v=DMARC1; p=none' } });
  });

  it('fails a record that is there but invalid, without inventing a replacement', async () => {
    const record = 'v=DMARC1; p=bogus';
    const results = await checkDmarc(
      { fromDomain: from },
      fixtureResolver({ [`_dmarc.${from}`]: { TXT: [record] } }),
    );
    expect(results).toEqual([
      { key: 'dmarc', status: 'fail', reason: 'invalid_record', found: { domain: from, record } },
      {
        key: 'dmarc_enforcement',
        status: 'fail',
        reason: 'invalid_record',
        found: { domain: from, record },
      },
    ]);
  });

  it("couldn't check either when DNS fails", async () => {
    const results = await checkDmarc(
      { fromDomain: from },
      fixtureResolver({ [`_dmarc.${from}`]: { error: 'ESERVFAIL' } }),
    );
    expect(results).toEqual([
      {
        key: 'dmarc',
        status: 'could_not_check',
        reason: 'dns_error',
        found: { domain: from, code: 'ESERVFAIL' },
      },
      {
        key: 'dmarc_enforcement',
        status: 'could_not_check',
        reason: 'dns_error',
        found: { domain: from, code: 'ESERVFAIL' },
      },
    ]);
  });
});

describe('DMARC enforcement', () => {
  it.each(['quarantine', 'reject'])('passes when the policy that applies is %s', async (p) => {
    const [, enforcement] = await checkDmarc(
      { fromDomain: from },
      fixtureResolver({ [`_dmarc.${from}`]: { TXT: [`v=DMARC1; p=${p}`] } }),
    );
    expect(enforcement).toMatchObject({ status: 'pass', reason: 'enforced', found: { policy: p } });
  });

  it("fails p=none on the domain's own record, fixing that record's p and keeping its other tags", async () => {
    const record = 'v=DMARC1;p=none; rua=mailto:r@example.test;adkim=s';
    const [, enforcement] = await checkDmarc(
      { fromDomain: from },
      fixtureResolver({ [`_dmarc.${from}`]: { TXT: [record] } }),
    );
    expect(enforcement).toEqual({
      key: 'dmarc_enforcement',
      status: 'fail',
      reason: 'p_none',
      found: { domain: from, record, policyDomain: from, policy: 'none', testMode: false },
      fix: {
        kind: 'record',
        type: 'TXT',
        name: `_dmarc.${from}`,
        value: 'v=DMARC1; p=quarantine; rua=mailto:r@example.test; adkim=s',
      },
    });
  });

  it("never changes a parent's record for a subdomain whose sp says none", async () => {
    const [, enforcement] = await checkDmarc(
      { fromDomain: 'news.example.test' },
      fixtureResolver({
        '_dmarc.example.test': { TXT: ['v=DMARC1; p=reject; sp=none'] },
        'news.example.test': { A: ['192.0.2.1'] },
      }),
    );
    expect(enforcement).toEqual({
      key: 'dmarc_enforcement',
      status: 'fail',
      reason: 'inherited_policy',
      found: {
        domain: 'news.example.test',
        record: 'v=DMARC1; p=reject; sp=none',
        policyDomain: 'example.test',
        policy: 'none',
        testMode: false,
      },
    });
  });

  it('fails a record in test mode (t=y) without an exact fix', async () => {
    const [, enforcement] = await checkDmarc(
      { fromDomain: from },
      fixtureResolver({ [`_dmarc.${from}`]: { TXT: ['v=DMARC1; p=quarantine; t=y'] } }),
    );
    expect(enforcement).toMatchObject({
      status: 'fail',
      reason: 'test_mode',
      found: { testMode: true },
    });
    expect(enforcement).not.toHaveProperty('fix');
  });

  it('fails without a record, leaving the fix to the DMARC check (start with p=none)', async () => {
    const [, enforcement] = await checkDmarc({ fromDomain: from }, fixtureResolver({}));
    expect(enforcement).toEqual({
      key: 'dmarc_enforcement',
      status: 'fail',
      reason: 'no_record',
      found: { domain: from },
    });
  });

  it("couldn't check a From domain that isn't a domain", async () => {
    const results = await checkDmarc({ fromDomain: 'not a domain' }, fixtureResolver({}));
    expect(results.map((result) => [result.status, result.reason])).toEqual([
      ['could_not_check', 'invalid_domain'],
      ['could_not_check', 'invalid_domain'],
    ]);
  });
});
