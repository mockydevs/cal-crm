import { describe, expect, it } from 'vitest';

import { apiKeyScopes, createApiKeyInput, parseInput } from './index.js';

describe('apiKeyScopes', () => {
  it("are the business's permissions, apart from making keys and saving views", () => {
    expect([...apiKeyScopes].sort()).toEqual([
      'appointments.manage',
      'automations.manage',
      'automations.publish',
      'business.profile',
      'calendars.manage',
      'calls.place',
      'calls.read',
      'campaigns.manage',
      'campaigns.send',
      'companies.manage',
      'contacts.export',
      'contacts.import',
      'contacts.manage',
      'contacts.merge',
      'conversations.manage',
      'conversations.reply',
      'deals.manage',
      'domains.manage',
      'email.verification.manage',
      'fields.manage',
      'fields.values',
      'files.upload',
      'forms.manage',
      'mailboxes.manage',
      'media.manage',
      'notes.manage',
      'objects.manage',
      'payments.manage',
      'payments.read',
      'phone.manage',
      'pipelines.manage',
      'reports.manage',
      'reports.view',
      'sites.manage',
      'sites.publish',
      'sites.share',
      'sms.manage',
      'tags.configure',
      'tags.manage',
      'tasks.manage',
      'team.manage',
      'templates.manage',
      'trash.purge',
      'webchat.manage',
    ]);
  });

  it('never include AI settings: a provider’s key and its spending limit are for people', () => {
    expect(apiKeyScopes).not.toContain('ai.manage');
    expect(() =>
      parseInput(createApiKeyInput, { name: 'Zapier', scopes: ['ai.manage'] }),
    ).toThrow();
  });
});

describe('createApiKeyInput', () => {
  it('takes a name and at least one permission', () => {
    expect(parseInput(createApiKeyInput, { name: '  Zapier ', scopes: ['tags.manage'] })).toEqual({
      name: 'Zapier',
      scopes: ['tags.manage'],
    });
  });

  it.each([
    [
      'no name',
      { name: ' ', scopes: ['tags.manage'] },
      '/name',
      'Give the key a name, such as the app that uses it.',
    ],
    [
      'a long name',
      { name: 'x'.repeat(81), scopes: ['tags.manage'] },
      '/name',
      'Use at most 80 characters.',
    ],
    ['no permission', { name: 'Zapier', scopes: [] }, '/scopes', 'Choose at least one permission.'],
    [
      'a permission twice',
      { name: 'Zapier', scopes: ['tags.manage', 'tags.manage'] },
      '/scopes',
      'Choose each permission once.',
    ],
  ])('refuses %s', (_case, input, path, message) => {
    expect(() => parseInput(createApiKeyInput, input)).toThrow(message);
    expect(createApiKeyInput.safeParse(input).error?.issues[0]?.path.join('/')).toBe(path.slice(1));
  });

  it.each([
    'apps.manage',
    'assistant.use',
    'agency.security',
    'views.save',
    'views.share',
    'contacts.everything',
  ])("refuses %s, which a key can't have", (scope) => {
    expect(createApiKeyInput.safeParse({ name: 'Zapier', scopes: [scope] }).success).toBe(false);
  });
});
