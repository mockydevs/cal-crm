import { expect, it, vi } from 'vitest';
import { getAutomationSchema } from '@repo/contracts';

import { configuration } from './config.js';

// Exercise current SDK source without emitting shared dist during another lane's run.
vi.mock('@repo/sdk', () => vi.importActual<typeof import('@repo/sdk')>('../../sdk/src/index.js'));

it.each([
  {},
  { CRM_API_URL: 'https://crm.example.test/api/v1' },
  { CRM_API_URL: 'https://crm.example.test/api/v1', CRM_API_KEY: ' ' },
])('requires credentials without echoing them', (environment) => {
  expect(() => configuration(environment)).toThrow('Set CRM_API_URL and CRM_API_KEY');
});

it.each([
  'invalid',
  'http://remote.example.test/api/v1',
  'https://user:secret@crm.example.test/api/v1',
  'https://crm.example.test/api/v1?key=secret',
  'https://crm.example.test/api/v1#secret',
  'https://crm.example.test/other',
])('refuses unsafe or incorrect API addresses', (CRM_API_URL) => {
  expect(() => configuration({ CRM_API_URL, CRM_API_KEY: 'test-only-key' })).toThrow(
    'CRM_API_URL must be',
  );
});

it.each([
  'https://crm.example.test/api/v1',
  'http://localhost:5173/api/v1',
  'http://127.0.0.1:3000/api/v1/',
  'http://[::1]:3000/api/v1',
])('accepts HTTPS and local development with publishing disabled', (CRM_API_URL) => {
  expect(configuration({ CRM_API_URL, CRM_API_KEY: 'test-only-key' }).allowPublish).toBe(false);
});

it('requires an explicit boolean publish opt-in', () => {
  const environment = {
    CRM_API_URL: 'https://crm.example.test/api/v1',
    CRM_API_KEY: 'test-only-key',
  };
  expect(configuration({ ...environment, CRM_MCP_ALLOW_PUBLISH: 'true' }).allowPublish).toBe(true);
  expect(configuration({ ...environment, CRM_MCP_ALLOW_PUBLISH: 'false' }).allowPublish).toBe(
    false,
  );
  expect(() => configuration({ ...environment, CRM_MCP_ALLOW_PUBLISH: 'yes' })).toThrow(
    'must be true or false',
  );
});

it('sends the key and business as canonical API headers, never in the URL or tool inputs', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  try {
    const { client } = configuration({
      CRM_API_URL: 'https://crm.example.test/api/v1',
      CRM_API_KEY: 'test-only-key',
      CRM_BUSINESS_ID: 'biz_example',
    });
    await client.request(getAutomationSchema, {});
    const [address, request] = send.mock.calls[0] ?? [];
    expect(address).toBe('https://crm.example.test/api/v1/automations/schema');
    expect(request?.headers).toMatchObject({
      authorization: 'Bearer test-only-key',
      'business-id': 'biz_example',
    });
    expect(request?.redirect).toBe('error');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  } finally {
    send.mockRestore();
  }
});

it('requires only URL and key and sends no business selector by default', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  try {
    const { client, allowPublish } = configuration({
      CRM_API_URL: 'https://crm.example.test/api/v1',
      CRM_API_KEY: 'test-only-key',
    });
    await client.request(getAutomationSchema, {});
    const headers = new Headers(send.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-only-key');
    expect(headers.has('business-id')).toBe(false);
    expect(headers.has('business-slug')).toBe(false);
    expect(allowPublish).toBe(false);
  } finally {
    send.mockRestore();
  }
});

it('lets a call select a slug without the legacy override leaking into it or later calls', async () => {
  const send = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
  try {
    const { client } = configuration({
      CRM_API_URL: 'https://crm.example.test/api/v1',
      CRM_API_KEY: 'test-only-key',
      CRM_BUSINESS_ID: 'biz_legacy',
    });
    await client.request(getAutomationSchema, {}, { businessSlug: 'harbor-lights' });
    await client.request(getAutomationSchema, {});
    const selected = new Headers(send.mock.calls[0]?.[1]?.headers);
    const defaulted = new Headers(send.mock.calls[1]?.[1]?.headers);
    expect(selected.get('business-slug')).toBe('harbor-lights');
    expect(selected.has('business-id')).toBe(false);
    expect(defaulted.get('business-id')).toBe('biz_legacy');
    expect(defaulted.has('business-slug')).toBe(false);
  } finally {
    send.mockRestore();
  }
});

it('captures the legacy override at configuration time rather than sharing a mutable target', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  try {
    const environment = {
      CRM_API_URL: 'https://crm.example.test/api/v1',
      CRM_API_KEY: 'test-only-key',
      CRM_BUSINESS_ID: 'biz_legacy',
    };
    const { client } = configuration(environment);
    environment.CRM_BUSINESS_ID = 'biz_changed';
    await client.request(getAutomationSchema, {});
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get('business-id')).toBe('biz_legacy');
  } finally {
    send.mockRestore();
  }
});
