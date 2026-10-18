import { i18n } from '@lingui/core';
import {
  apiKeyScopes,
  marketplaceAppStatuses,
  marketplaceCategories,
  type AgencyMarketplaceApp,
  type MarketplaceApp,
} from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  appDraftOf,
  appInputOf,
  authorizationUrlOf,
  redirectUrisOf,
  categoryNames,
  matchesApp,
  scopeName,
  statusActions,
  statusChangeOf,
  statusNames,
} from './marketplace-rules';
import { marketplaceCategoryNames, marketplaceSearchOf } from './marketplace-search';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const appOf = (patch: Partial<MarketplaceApp> = {}): MarketplaceApp => ({
  id: 'mapp_01k8e2wzr0e008000000000001',
  name: 'Zap Sync',
  tagline: 'Sends new contacts to your spreadsheet',
  description: 'Keeps a sheet up to date.',
  developer: 'Northwind Labs',
  websiteUrl: 'https://zapsync.example',
  supportEmail: 'help@zapsync.example',
  iconUrl: null,
  categories: ['productivity'],
  scopes: ['contacts.manage'],
  readGroups: ['Contacts'],
  webhookEvents: ['contact.created'],
  status: 'listed',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  install: null,
  ...patch,
});
const agencyAppOf = (patch: Partial<AgencyMarketplaceApp> = {}): AgencyMarketplaceApp => {
  const { install: _install, ...rest } = appOf();
  return {
    ...rest,
    installCount: 0,
    redirectUris: ['https://zapsync.example/cb'],
    clientSecretPrefix: null,
    clientSecretSetAt: null,
    webhookUrl: 'https://zapsync.example/hooks',
    webhookSecretSetAt: null,
    ...patch,
  };
};

describe('the address', () => {
  it('keeps the contract’s categories', () => {
    expect(marketplaceCategoryNames).toEqual(marketplaceCategories);
  });

  it('reads the tab, the search and the category, and leaves out what is not one', () => {
    expect(marketplaceSearchOf({})).toEqual({});
    expect(marketplaceSearchOf({ tab: 'installed', q: 'zap', category: 'sales' })).toEqual({
      tab: 'installed',
      q: 'zap',
      category: 'sales',
    });
    expect(marketplaceSearchOf({ tab: 'all', q: '   ', category: 'games' })).toEqual({});
    expect(marketplaceSearchOf({ q: 7 })).toEqual({});
    expect(marketplaceSearchOf({ q: 'a'.repeat(300) }).q).toHaveLength(200);
  });
});

describe('words', () => {
  it('names every category and status', () => {
    expect(marketplaceCategories.map((each) => i18n._(categoryNames[each]))).toEqual([
      'Analytics',
      'Calendars',
      'Communication',
      'Marketing',
      'Payments',
      'Productivity',
      'Reporting',
      'Sales',
      'Other',
    ]);
    expect(marketplaceAppStatuses.map((each) => i18n._(statusNames[each]))).toEqual([
      'Draft',
      'Listed',
      'Delisted',
    ]);
  });

  it('names every permission an app may ask for, and falls back to the key', () => {
    for (const scope of apiKeyScopes) expect(scopeName(scope, i18n)).not.toBe(scope);
    expect(scopeName('apps.manage', i18n)).toBe('Manage apps and API keys');
    expect(scopeName('made.up', i18n)).toBe('made.up');
  });

  it('offers the moves each status has', () => {
    const moves = (status: AgencyMarketplaceApp['status']) =>
      statusActions(status).map((each) => [each.to, i18n._(each.label)]);
    expect(moves('draft')).toEqual([['listed', 'List']]);
    expect(moves('listed')).toEqual([
      ['delisted', 'Delist'],
      ['draft', 'Back to draft'],
    ]);
    expect(moves('delisted')).toEqual([
      ['listed', 'List'],
      ['draft', 'Back to draft'],
    ]);
  });
});

describe('finding an installed app', () => {
  it('matches any part of the name, line or developer, in any case', () => {
    const app = appOf();
    expect(matchesApp(app, '', undefined)).toBe(true);
    expect(matchesApp(app, 'zap', undefined)).toBe(true);
    expect(matchesApp(app, 'SPREADSHEET', undefined)).toBe(true);
    expect(matchesApp(app, ' northwind ', undefined)).toBe(true);
    expect(matchesApp(app, 'calendar', undefined)).toBe(false);
  });

  it('matches the category', () => {
    const app = appOf();
    expect(matchesApp(app, '', 'productivity')).toBe(true);
    expect(matchesApp(app, '', 'sales')).toBe(false);
    expect(matchesApp(app, 'zap', 'sales')).toBe(false);
  });
});

describe('an app as the API takes it', () => {
  const chosen = {
    categories: ['sales'] as const,
    scopes: ['tags.manage'] as const,
    readGroups: ['Tags'] as const,
    webhookEvents: ['tag.assigned'] as const,
  };

  it('reads the form, with blank addresses as none', () => {
    const parsed = appInputOf(
      {
        name: ' Zap Sync ',
        tagline: '',
        description: 'Keeps a sheet.',
        developer: 'Northwind Labs',
        websiteUrl: '',
        supportEmail: ' ',
        iconUrl: 'https://zapsync.example/icon.png',
        redirectUris: ' https://zapsync.example/cb \r\n\nhttp://localhost:3000/cb\n',
      },
      chosen,
    );
    expect(parsed.success && parsed.data).toEqual({
      name: 'Zap Sync',
      tagline: '',
      description: 'Keeps a sheet.',
      developer: 'Northwind Labs',
      websiteUrl: null,
      supportEmail: null,
      iconUrl: 'https://zapsync.example/icon.png',
      categories: ['sales'],
      scopes: ['tags.manage'],
      readGroups: ['Tags'],
      redirectUris: ['https://zapsync.example/cb', 'http://localhost:3000/cb'],
      webhookUrl: null,
      webhookEvents: ['tag.assigned'],
    });
  });

  it('refuses what the API refuses, in its words', () => {
    const parsed = appInputOf(
      {
        name: '',
        developer: 'x',
        websiteUrl: 'http://plain.example',
        supportEmail: 'nope',
        redirectUris: 'http://plain.example/cb',
      },
      { categories: [], scopes: [], readGroups: [], webhookEvents: [] },
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = Object.fromEntries(
      parsed.error.issues.map((issue) => [issue.path.join('/'), issue.message]),
    );
    expect(messages).toEqual({
      name: 'Give the app a name.',
      websiteUrl: 'Use an address that starts with https://.',
      supportEmail: 'Use an email address.',
      'redirectUris/0':
        'Use an https:// address without a # part, or http://localhost for testing on your computer.',
    });
  });

  it('treats a field the form did not send as blank', () => {
    const parsed = appInputOf({ name: 'Zap', developer: 'Lee', tagline: 3 }, chosen);
    expect(parsed.success && parsed.data.tagline).toBe('');
  });

  it('fills a form from a saved app', () => {
    expect(appDraftOf(agencyAppOf({ websiteUrl: null, supportEmail: null }))).toEqual({
      name: 'Zap Sync',
      tagline: 'Sends new contacts to your spreadsheet',
      description: 'Keeps a sheet up to date.',
      developer: 'Northwind Labs',
      websiteUrl: '',
      supportEmail: '',
      iconUrl: '',
      categories: ['productivity'],
      scopes: ['contacts.manage'],
      readGroups: ['Contacts'],
      redirectUris: 'https://zapsync.example/cb',
      webhookUrl: 'https://zapsync.example/hooks',
      webhookEvents: ['contact.created'],
    });
    expect(appDraftOf(undefined)).toEqual({
      name: '',
      tagline: '',
      description: '',
      developer: '',
      websiteUrl: '',
      supportEmail: '',
      iconUrl: '',
      categories: [],
      scopes: [],
      readGroups: [],
      redirectUris: '',
      webhookUrl: '',
      webhookEvents: [],
    });
  });

  it('keeps everything but the status when listing or delisting', () => {
    const parsed = statusChangeOf(agencyAppOf({ installCount: 4 }), 'delisted');
    expect(parsed.success && parsed.data).toEqual({
      name: 'Zap Sync',
      tagline: 'Sends new contacts to your spreadsheet',
      description: 'Keeps a sheet up to date.',
      developer: 'Northwind Labs',
      websiteUrl: 'https://zapsync.example',
      supportEmail: 'help@zapsync.example',
      iconUrl: null,
      categories: ['productivity'],
      scopes: ['contacts.manage'],
      readGroups: ['Contacts'],
      redirectUris: ['https://zapsync.example/cb'],
      webhookUrl: 'https://zapsync.example/hooks',
      webhookEvents: ['contact.created'],
      status: 'delisted',
    });
    expect(statusChangeOf(agencyAppOf({ scopes: ['apps.manage'] }), 'listed').success).toBe(false);
  });
});

describe('connecting an app', () => {
  it('reads one redirect address a line, leaving blank lines out', () => {
    expect(redirectUrisOf('a\r\n\n  b  \n')).toEqual(['a', 'b']);
    expect(redirectUrisOf('')).toEqual([]);
  });

  it('shows the developer the authorization address, with what the app fills in', () => {
    expect(authorizationUrlOf('https://crm.example', 'mapp_1', 'https://zapsync.example/cb')).toBe(
      'https://crm.example/oauth/authorize?response_type=code&client_id=mapp_1&redirect_uri=https%3A%2F%2Fzapsync.example%2Fcb&state={state}&code_challenge={S256 challenge}&code_challenge_method=S256',
    );
  });
});
