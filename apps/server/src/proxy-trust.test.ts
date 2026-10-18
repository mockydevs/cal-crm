import { describe, expect, it } from 'vitest';

import { proxyTrustWarning } from './proxy-trust.js';

describe('what the server says at start about the proxies in front', () => {
  it('warns a production install that trusts no proxy: every visitor would share one limit', () => {
    for (const role of ['app', 'all'] as const) {
      const warning = proxyTrustWarning({ nodeEnv: 'production', role, trustProxy: [] });
      expect(warning).toMatch(/^TRUST_PROXY is empty\./);
      expect(warning).toContain('share one rate limit and one sign-in limit');
      expect(warning).toContain('docs/HOSTING.md');
    }
  });

  it('says nothing once a proxy is trusted, whichever way it is named', () => {
    for (const trustProxy of [
      ['10.0.1.0/24'],
      ['loopback'],
      ['172.18.0.5', '173.245.48.0/20'],
      ['172.18.0.0/16', 'cloudflare'],
    ])
      expect(proxyTrustWarning({ nodeEnv: 'production', role: 'app', trustProxy })).toBeUndefined();
  });

  it('warns when cloudflare is named without the reverse proxy it arrives through', () => {
    const warning = proxyTrustWarning({
      nodeEnv: 'production',
      role: 'app',
      trustProxy: ['cloudflare'],
    });
    expect(warning).toMatch(/^TRUST_PROXY names cloudflare and no reverse proxy\./);
    expect(warning).toContain('docs/HOSTING.md');
  });

  it('says nothing to a worker, which counts nobody, or outside production', () => {
    expect(
      proxyTrustWarning({ nodeEnv: 'production', role: 'worker', trustProxy: [] }),
    ).toBeUndefined();
    for (const nodeEnv of ['development', 'test'] as const)
      expect(proxyTrustWarning({ nodeEnv, role: 'all', trustProxy: [] })).toBeUndefined();
  });
});
