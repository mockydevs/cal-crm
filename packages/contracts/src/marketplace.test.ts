import { describe, expect, it } from 'vitest';

import {
  createMarketplaceAppInput,
  isRedirectUri,
  listMarketplaceAppsQuery,
  marketplaceEndpoints,
  updateMarketplaceAppInput,
} from './marketplace.js';

describe('the App Marketplace contracts', () => {
  it('fills in a new app as an empty listing that asks for nothing', () => {
    expect(createMarketplaceAppInput.parse({ name: ' Harbor Sync ', developer: 'Harbor' })).toEqual(
      {
        name: 'Harbor Sync',
        tagline: '',
        description: '',
        developer: 'Harbor',
        websiteUrl: null,
        supportEmail: null,
        iconUrl: null,
        categories: [],
        scopes: [],
        readGroups: [],
        redirectUris: [],
        webhookUrl: null,
        webhookEvents: [],
      },
    );
  });

  it('lets an app ask only for what an API key may hold', () => {
    const app = { name: 'Harbor Sync', developer: 'Harbor' };
    expect(
      createMarketplaceAppInput.safeParse({ ...app, scopes: ['contacts.manage'] }).success,
    ).toBe(true);
    for (const scope of ['apps.manage', 'audit.read', 'not.a.permission']) {
      expect(createMarketplaceAppInput.safeParse({ ...app, scopes: [scope] }).success).toBe(false);
    }
    expect(
      createMarketplaceAppInput.safeParse({
        ...app,
        scopes: ['contacts.manage', 'contacts.manage'],
      }).success,
    ).toBe(false);
  });

  it('takes https addresses, known categories once each, and at most five', () => {
    const app = { name: 'Harbor Sync', developer: 'Harbor' };
    expect(
      createMarketplaceAppInput.safeParse({ ...app, websiteUrl: 'http://harbor.example' }).success,
    ).toBe(false);
    expect(
      createMarketplaceAppInput.safeParse({ ...app, iconUrl: 'https://harbor.example/icon.png' })
        .success,
    ).toBe(true);
    expect(
      createMarketplaceAppInput.safeParse({ ...app, categories: ['sales', 'sales'] }).success,
    ).toBe(false);
    expect(createMarketplaceAppInput.safeParse({ ...app, categories: ['games'] }).success).toBe(
      false,
    );
    expect(
      createMarketplaceAppInput.safeParse({
        ...app,
        categories: ['sales', 'marketing', 'payments', 'analytics', 'calendars', 'other'],
      }).success,
    ).toBe(false);
  });

  it('lets an app read only groups a key may choose, each once', () => {
    const app = { name: 'Harbor Sync', developer: 'Harbor' };
    expect(createMarketplaceAppInput.parse({ ...app, readGroups: ['Tags'] }).readGroups).toEqual([
      'Tags',
    ]);
    for (const readGroups of [['Audit log'], ['Agency'], ['Tags', 'Tags'], ['Nothing']]) {
      expect(createMarketplaceAppInput.safeParse({ ...app, readGroups }).success).toBe(false);
    }
  });

  it('needs a status to save an app, so listing it is a choice', () => {
    const app = { name: 'Harbor Sync', developer: 'Harbor' };
    expect(updateMarketplaceAppInput.safeParse(app).success).toBe(false);
    expect(updateMarketplaceAppInput.parse({ ...app, status: 'listed' }).status).toBe('listed');
  });

  it('filters the marketplace by words and a category', () => {
    expect(listMarketplaceAppsQuery.parse({ q: ' sync ', category: 'sales' })).toEqual({
      q: 'sync',
      category: 'sales',
    });
    expect(listMarketplaceAppsQuery.safeParse({ category: 'games' }).success).toBe(false);
  });

  it('puts every endpoint in the App Marketplace group, agency ones under /agency', () => {
    for (const endpoint of marketplaceEndpoints) {
      expect(endpoint.group).toBe('App Marketplace');
      const agency = endpoint.operationId.includes('Agency') || endpoint.method !== 'get';
      if (endpoint.path.startsWith('/agency/')) expect(agency).toBe(true);
    }
  });

  it('takes redirect addresses on https, or http on this computer, without a fragment', () => {
    for (const good of [
      'https://sync.example/oauth/callback',
      'https://sync.example/callback?tenant=1',
      'http://localhost:3000/callback',
      'http://127.0.0.1:8080/cb',
      'http://[::1]/cb',
    ]) {
      expect(isRedirectUri(good)).toBe(true);
    }
    for (const bad of [
      'http://sync.example/callback',
      'https://sync.example/callback#done',
      'https://sync.example/callback#',
      'https://user:pass@sync.example/callback',
      'ftp://sync.example/callback',
      '/callback',
      `https://sync.example/${'a'.repeat(2048)}`,
    ]) {
      expect(isRedirectUri(bad)).toBe(false);
    }
    const app = { name: 'Harbor Sync', developer: 'Harbor' };
    const uri = 'https://sync.example/cb';
    expect(createMarketplaceAppInput.safeParse({ ...app, redirectUris: [uri, uri] }).success).toBe(
      false,
    );
    expect(
      createMarketplaceAppInput.safeParse({
        ...app,
        redirectUris: Array.from({ length: 11 }, (_, index) => `${uri}/${String(index)}`),
      }).success,
    ).toBe(false);
  });
});
