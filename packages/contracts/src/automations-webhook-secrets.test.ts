// Headers on a webhook.call step and the stored secrets they send (tasks/edge-cases/
// automation.md, finding 15).
import { describe, expect, it } from 'vitest';

import { automationStepTypes } from './automations-catalog.js';
import { validateAutomation } from './automations-validate.js';
import { harborLights } from './automations-validate.test.js';
import { isAllowedWebhookHeader } from './automations-webhook-header-names.js';
import { putAutomationWebhookSecretInput } from './automations-webhook-secrets-api.js';

const config = automationStepTypes['webhook.call'].config;

const documentWith = (step: Record<string, unknown>) => ({
  name: 'Tell the warehouse',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'tell',
  steps: {
    tell: {
      type: 'webhook.call',
      config: { url: 'https://hooks.example.test/crm', ...step },
    },
  },
});

const setup = { ...harborLights, webhookSecrets: ['crm_key', 'warehouse_token'] };

describe('the webhook step config', () => {
  it('takes headers with a written value or a stored secret', () => {
    expect(
      config.parse({
        url: 'https://hooks.example.test/crm',
        headers: [
          { name: 'Authorization', secret: 'crm_key' },
          { name: 'X-Customer', value: '{{contact.email}}' },
        ],
      }),
    ).toMatchObject({ headers: [{ secret: 'crm_key' }, { value: '{{contact.email}}' }] });
  });

  // The names the engine sets or the connection owns are the validator's to refuse, so the
  // builder's canvas need not carry the list.
  it.each([
    ['a header the engine sets', { name: 'Content-Type', value: 'text/plain' }],
    ['the signature', { name: 'x-crm-signature', value: 'v1=0' }],
    ['the delivery id', { name: 'X-CRM-Delivery', value: 'mine' }],
    ['the host', { name: 'Host', value: 'internal.example.test' }],
    ['a hop-by-hop header', { name: 'Transfer-Encoding', value: 'chunked' }],
    ['a proxy header', { name: 'Proxy-Authorization', value: 'Basic x' }],
  ])('refuses %s when it is validated', (_case, header) => {
    const result = validateAutomation(documentWith({ headers: [header] }), harborLights);
    expect(result.errors.map((issue) => issue.code)).toContain('reserved_header');
  });

  it.each([
    ['a name with a space', { name: 'Api Key', value: 'x' }],
    ['a name with a colon', { name: 'X-Key:', value: 'x' }],
    ['a name too long', { name: 'X'.repeat(101), value: 'x' }],
    ['a value with a line break', { name: 'X-Key', value: 'a\r\nX-Evil: 1' }],
    ['a value too long', { name: 'X-Key', value: 'x'.repeat(1001) }],
    ['both a value and a secret', { name: 'X-Key', value: 'x', secret: 'crm_key' }],
    ['a secret name that is not a key', { name: 'X-Key', secret: 'Crm Key' }],
  ])('refuses %s', (_case, header) => {
    expect(
      config.safeParse({ url: 'https://hooks.example.test/crm', headers: [header] }).success,
    ).toBe(false);
  });

  it('takes at most ten headers', () => {
    const headers = Array.from({ length: 11 }, (_, index) => ({
      name: `X-Key-${String(index)}`,
      value: 'x',
    }));
    expect(config.safeParse({ url: 'https://hooks.example.test/crm', headers }).success).toBe(
      false,
    );
    expect(
      config.safeParse({ url: 'https://hooks.example.test/crm', headers: headers.slice(0, 10) })
        .success,
    ).toBe(true);
  });

  it('allows ordinary header names, whatever their capitals', () => {
    expect(isAllowedWebhookHeader('Authorization')).toBe(true);
    expect(isAllowedWebhookHeader('X-Api-Key')).toBe(true);
    expect(isAllowedWebhookHeader('CONTENT-LENGTH')).toBe(false);
    expect(isAllowedWebhookHeader('X-Crm-Timestamp')).toBe(false);
  });

  it('is version 2 of the step type', () => {
    expect(automationStepTypes['webhook.call'].version).toBe(2);
  });
});

describe('validating a webhook step with headers', () => {
  it('passes headers that name stored secrets', () => {
    const result = validateAutomation(
      documentWith({
        headers: [
          { name: 'Authorization', secret: 'crm_key' },
          { name: 'X-Customer', value: '{{contact.email}}' },
        ],
      }),
      setup,
    );
    expect(result).toMatchObject({ valid: true, errors: [], warnings: [] });
    expect(result.document?.steps['tell']).toMatchObject({
      typeVersion: 2,
      config: {
        headers: [
          { name: 'Authorization', secret: 'crm_key' },
          { name: 'X-Customer', value: '{{contact.email}}' },
        ],
      },
    });
  });

  it('refuses a secret the business does not have', () => {
    const result = validateAutomation(
      documentWith({ headers: [{ name: 'Authorization', secret: 'crm_kye' }] }),
      setup,
    );
    expect(result.errors).toEqual([
      {
        path: '/steps/tell/config/headers/0/secret',
        code: 'unknown_secret',
        message: 'There is no webhook secret named crm_kye.',
        suggestion: 'Did you mean crm_key?',
      },
    ]);
  });

  it("doesn't check secrets when the setup can't tell", () => {
    expect(
      validateAutomation(
        documentWith({ headers: [{ name: 'Authorization', secret: 'anything' }] }),
        harborLights,
      ).valid,
    ).toBe(true);
  });

  it('refuses a header named twice, whatever the capitals', () => {
    const result = validateAutomation(
      documentWith({
        headers: [
          { name: 'Authorization', secret: 'crm_key' },
          { name: 'authorization', value: 'Bearer x' },
        ],
      }),
      setup,
    );
    expect(result.errors).toEqual([
      {
        path: '/steps/tell/config/headers/1/name',
        code: 'duplicate_header',
        message: 'The header authorization is set twice.',
      },
    ]);
  });

  it("checks a written value's merge fields", () => {
    const result = validateAutomation(
      documentWith({ headers: [{ name: 'X-Customer', value: '{{contact.nope}}' }] }),
      setup,
    );
    expect(result.errors).toMatchObject([
      { path: '/steps/tell/config/headers/0/value', code: 'unknown_merge_field' },
    ]);
  });

  it.each([
    'https://hooks.example.test/in?api_key=sk_live_123',
    'https://hooks.example.test/in?a=1&Token=abc',
    'https://hooks.example.test/in?SIG=abc',
    'https://hooks.example.test/in?access_token=abc',
    'https://hooks.example.test/in?password=abc',
  ])('warns of a secret in the URL: %s', (url) => {
    const result = validateAutomation(documentWith({ url }), setup);
    expect(result.valid).toBe(true);
    expect(result.warnings).toMatchObject([
      {
        path: '/steps/tell/config/url',
        code: 'secret_in_url',
        message: expect.stringContaining(
          'Store it as a webhook secret and send it in a header',
        ) as string,
      },
    ]);
  });

  it('says nothing of an ordinary query string', () => {
    expect(
      validateAutomation(
        documentWith({ url: 'https://hooks.example.test/in?list=leads&keyword=x' }),
        setup,
      ).warnings,
    ).toEqual([]);
  });
});

describe('putting a webhook secret', () => {
  it('takes a value and refuses an empty one, a line break or one too long', () => {
    expect(putAutomationWebhookSecretInput.safeParse({ value: 'Bearer sk_123' }).success).toBe(
      true,
    );
    for (const value of ['', 'a\nb', 'x'.repeat(4001)])
      expect(putAutomationWebhookSecretInput.safeParse({ value }).success).toBe(false);
  });
});
