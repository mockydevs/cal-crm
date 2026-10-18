import type { MxRecord, SrvRecord } from 'node:dns';
import { describe, expect, it, vi } from 'vitest';
import { discoverMailbox } from './index.js';

const empty = {
  resolveSrv: () => Promise.resolve([] as SrvRecord[]),
  resolveMx: () => Promise.resolve([] as MxRecord[]),
};

describe('mailbox server discovery', () => {
  it('uses RFC 6186 SRV targets and ports before known provider settings', async () => {
    const resolveSrv = vi.fn((name: string) =>
      Promise.resolve(
        name.startsWith('_submission.')
          ? [{ name: 'smtp.gmail.com.', port: 1587, priority: 0, weight: 1 }]
          : name.startsWith('_imaps.')
            ? [{ name: 'imap.gmail.com.', port: 1993, priority: 0, weight: 1 }]
            : [],
      ),
    );
    const result = await discoverMailbox('person@gmail.com', { ...empty, resolveSrv });
    expect(result.smtp).toEqual({
      host: 'smtp.gmail.com',
      port: 1587,
      security: 'starttls',
      source: 'srv',
      requiresConfirmation: false,
    });
    expect(result.imap).toEqual({
      host: 'imap.gmail.com',
      port: 1993,
      security: 'tls',
      source: 'srv',
      requiresConfirmation: false,
    });
    expect(resolveSrv).toHaveBeenCalledWith('_submission._tcp.gmail.com');
    expect(resolveSrv).toHaveBeenCalledWith('_submissions._tcp.gmail.com');
  });

  it('prefers implicit TLS at equal SRV priority and requires confirmation of an off-domain target', async () => {
    const result = await discoverMailbox('person@example.test', {
      ...empty,
      resolveSrv: (name) =>
        Promise.resolve(
          name.startsWith('_submissions.')
            ? [{ name: 'mail.hosting.test.', port: 465, priority: 0, weight: 1 }]
            : name.startsWith('_submission.')
              ? [{ name: 'smtp.example.test', port: 587, priority: 0, weight: 1 }]
              : [],
        ),
    });
    expect(result.smtp).toEqual({
      host: 'mail.hosting.test',
      port: 465,
      security: 'tls',
      source: 'srv',
      requiresConfirmation: true,
    });
  });

  it('fills in verified Gmail defaults when there are no SRV records', async () => {
    const result = await discoverMailbox('person@GMAIL.COM', empty);
    expect(result.smtp).toMatchObject({
      host: 'smtp.gmail.com',
      port: 465,
      security: 'tls',
      source: 'provider',
    });
    expect(result.imap).toMatchObject({
      host: 'imap.gmail.com',
      port: 993,
      security: 'tls',
      source: 'provider',
    });
    expect(result.detectedProvider).toBe('google');
  });

  it('uses MX only as a guess requiring confirmation for both protocols', async () => {
    const result = await discoverMailbox('person@example.test', {
      ...empty,
      resolveMx: () =>
        Promise.resolve([
          { exchange: 'backup.example.test', priority: 20 },
          { exchange: 'mail.example.test.', priority: 10 },
        ]),
    });
    expect(result.smtp).toEqual({
      host: 'mail.example.test',
      port: 587,
      security: 'starttls',
      source: 'mx',
      requiresConfirmation: true,
    });
    expect(result.imap).toEqual({
      host: 'mail.example.test',
      port: 993,
      security: 'tls',
      source: 'mx',
      requiresConfirmation: true,
    });
  });

  it('does not invent settings for an unknown domain without DNS records', async () => {
    const result = await discoverMailbox('person@example.test', empty);
    expect(result.smtp).toBeNull();
    expect(result.imap).toBeNull();
  });

  it.each(['outlook.com', 'hotmail.com', 'live.com'])(
    'offers verified %s settings with an explicit OAuth requirement',
    async (domain) => {
      const result = await discoverMailbox(`person@${domain}`, empty);
      expect(result.smtp).toMatchObject({
        host: 'smtp-mail.outlook.com',
        port: 587,
        security: 'starttls',
        source: 'provider',
      });
      expect(result.imap).toMatchObject({
        host: 'outlook.office365.com',
        port: 993,
        security: 'tls',
        source: 'provider',
      });
      expect(result.authentication).toBe('oauth_required');
      expect(result.detectedProvider).toBe('microsoft');
    },
  );

  it('honors SRV priority before preferring implicit TLS', async () => {
    const result = await discoverMailbox('person@example.test', {
      ...empty,
      resolveSrv: (name) =>
        Promise.resolve(
          name.startsWith('_submissions.')
            ? [{ name: 'tls.example.test', port: 465, priority: 10, weight: 1 }]
            : name.startsWith('_submission.')
              ? [{ name: 'starttls.example.test', port: 587, priority: 0, weight: 1 }]
              : [],
        ),
    });
    expect(result.smtp).toMatchObject({ host: 'starttls.example.test', security: 'starttls' });
  });

  it.each([0, 10])('uses the RFC 2782 inclusive weighted choice at draw %s', async (draw) => {
    const chooseInteger = vi.fn(() => draw);
    const result = await discoverMailbox('person@example.test', {
      ...empty,
      chooseInteger,
      resolveSrv: (name) =>
        Promise.resolve(
          name.startsWith('_imap.')
            ? [
                { name: 'weighted.example.test', port: 143, priority: 0, weight: 10 },
                { name: 'zero.example.test', port: 143, priority: 0, weight: 0 },
                { name: 'backup.example.test', port: 143, priority: 20, weight: 100 },
              ]
            : [],
        ),
    });
    expect(chooseInteger).toHaveBeenCalledWith(10);
    expect(result.imap?.host).toBe(draw === 0 ? 'zero.example.test' : 'weighted.example.test');
    expect(result.imap?.security).toBe('starttls');
  });

  it('respects explicit SRV service unavailability rather than guessing from MX or a provider', async () => {
    const result = await discoverMailbox('person@gmail.com', {
      ...empty,
      resolveSrv: () => Promise.resolve([{ name: '.', port: 0, priority: 0, weight: 0 }]),
      resolveMx: () => Promise.resolve([{ exchange: 'mx.example.test', priority: 10 }]),
    });
    expect(result.smtp).toBeNull();
    expect(result.imap).toBeNull();
  });

  it('treats a null MX as no usable mailbox host', async () => {
    const result = await discoverMailbox('person@example.test', {
      ...empty,
      resolveMx: () => Promise.resolve([{ exchange: '.', priority: 0 }]),
    });
    expect(result.smtp).toBeNull();
    expect(result.imap).toBeNull();
  });

  it('ignores malformed SRV ports, priorities, weights and hostnames', async () => {
    const result = await discoverMailbox('person@example.test', {
      ...empty,
      resolveSrv: () =>
        Promise.resolve([
          { name: 'mail.example.test', port: 65_536, priority: 0, weight: 0 },
          { name: 'mail.example.test', port: 993, priority: -1, weight: 0 },
          { name: 'mail.example.test', port: 993, priority: 0, weight: Number.NaN },
          { name: 'mail..example.test', port: 993, priority: 0, weight: 0 },
        ]),
    });
    expect(result.smtp).toBeNull();
    expect(result.imap).toBeNull();
  });

  it('reports temporary DNS failures without hiding known provider settings or leaking resolver details', async () => {
    const result = await discoverMailbox('person@gmail.com', {
      ...empty,
      resolveSrv: () => Promise.reject(new Error('Private resolver detail')),
    });
    expect(result.smtp?.host).toBe('smtp.gmail.com');
    expect(result.warnings).toEqual(['dns_unavailable']);
    expect(JSON.stringify(result)).not.toContain('Private resolver');
  });

  it.each(['ENODATA', 'ENOTFOUND'])('treats %s as absent DNS records', async (code) => {
    const result = await discoverMailbox('person@example.test', {
      resolveSrv: () => Promise.reject(Object.assign(new Error('Absent'), { code })),
      resolveMx: () => Promise.reject(Object.assign(new Error('Absent'), { code })),
    });
    expect(result.warnings).toEqual([]);
    expect(result.smtp).toBeNull();
  });

  it('bounds all five DNS queries in parallel', async () => {
    const result = await discoverMailbox('person@example.test', {
      timeoutMs: 20,
      resolveSrv: () => new Promise(() => undefined),
      resolveMx: () => new Promise(() => undefined),
    });
    expect(result.warnings).toEqual(['dns_unavailable']);
    expect(result.smtp).toBeNull();
    expect(result.imap).toBeNull();
  });

  it.each(['not-an-email', 'person@', 'person@mail..example.test', 'person@https://example.test'])(
    'rejects invalid address %j before DNS',
    async (email) => {
      const resolveSrv = vi.fn(empty.resolveSrv);
      await expect(discoverMailbox(email, { ...empty, resolveSrv })).rejects.toThrow(TypeError);
      expect(resolveSrv).not.toHaveBeenCalled();
    },
  );

  it('normalizes international domains before looking up records', async () => {
    const resolveMx = vi.fn(empty.resolveMx);
    const result = await discoverMailbox('person@BÜCHER.example', { ...empty, resolveMx });
    expect(result.domain).toBe('xn--bcher-kva.example');
    expect(resolveMx).toHaveBeenCalledWith('xn--bcher-kva.example');
  });
});
