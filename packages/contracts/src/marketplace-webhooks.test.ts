import { describe, expect, it } from 'vitest';

import { apiKeySelectableReadGroups } from './api-keys.js';
import { createMarketplaceAppInput } from './marketplace.js';
import {
  appWebhookBody,
  appWebhookEventGroups,
  marketplaceWebhookEndpoints,
  webhookEventsProblem,
} from './marketplace-webhooks.js';

describe('webhooks to installed apps', () => {
  it('puts every event in a group an app may be allowed to read', () => {
    for (const group of Object.values(appWebhookEventGroups))
      expect(apiKeySelectableReadGroups).toContain(group);
  });

  it('lets an app want only events of groups it may read', () => {
    expect(webhookEventsProblem(['contact.created', 'tag.assigned'], ['Contacts', 'Tags'])).toBe(
      undefined,
    );
    expect(webhookEventsProblem(['deal.won'], ['Contacts'])).toBe(
      'To send deal.won, let the app read Deals.',
    );
    expect(webhookEventsProblem([], [])).toBe(undefined);
  });

  it('takes an https address and known events, each once', () => {
    const app = { name: 'Harbor Sync', developer: 'Harbor' };
    expect(
      createMarketplaceAppInput.parse({
        ...app,
        webhookUrl: 'https://sync.example/hooks',
        webhookEvents: ['contact.created'],
      }),
    ).toMatchObject({
      webhookUrl: 'https://sync.example/hooks',
      webhookEvents: ['contact.created'],
    });
    expect(createMarketplaceAppInput.parse(app)).toMatchObject({
      webhookUrl: null,
      webhookEvents: [],
    });
    for (const values of [
      { webhookUrl: 'http://sync.example/hooks' },
      { webhookEvents: ['contact.deleted_forever'] },
      { webhookEvents: ['contact.created', 'contact.created'] },
    ])
      expect(createMarketplaceAppInput.safeParse({ ...app, ...values }).success).toBe(false);
  });

  it('describes the thin body every delivery sends', () => {
    expect(
      appWebhookBody.parse({
        type: 'contact.created',
        occurredAt: '2026-10-17T09:00:00.000Z',
        appId: 'mapp_01k8e2wzr0e008000000000001',
        installId: 'mins_01k8e2wzr0e008000000000001',
        businessId: 'biz_01k8e2wzr0e008000000000001',
        subject: { kind: 'contact', id: 'con_01k8e2wzr0e008000000000001' },
      }).subject,
    ).toEqual({ kind: 'contact', id: 'con_01k8e2wzr0e008000000000001' });
  });

  it('puts its endpoints in the marketplace group, under /agency', () => {
    for (const endpoint of marketplaceWebhookEndpoints) {
      expect(endpoint.group).toBe('App Marketplace');
      expect(endpoint.path.startsWith('/agency/')).toBe(true);
    }
  });
});
