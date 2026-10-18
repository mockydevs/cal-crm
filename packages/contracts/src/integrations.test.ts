import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  agencyApiKeyScopes,
  apiKeyReadGroups,
  apiKeyScopes,
  auditModuleOf,
  connectIntegrationInput,
  elsewhereIntegrations,
  endpoints,
  integrationConnection,
  integrationKey,
  integrationList,
  notificationKinds,
  notificationTarget,
  parseInput,
  permissionCatalog,
  permissionsOf,
  updateIntegrationConnectionInput,
} from './index.js';

const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('integrationKey', () => {
  it.each(['slack', 'google_workspace', 'standin'])('takes %s', (key) => {
    expect(integrationKey.safeParse(key).success).toBe(true);
  });

  it.each([
    ['google', 'Google Calendar keeps its own routes there'],
    ['Slack', 'capitals'],
    ['s', 'one letter'],
    ['9lives', 'a digit first'],
    ['a'.repeat(41), 'too long'],
    ['slack.app', 'a dot, which would split its vault purpose'],
  ])('refuses %s (%s)', (key) => {
    expect(integrationKey.safeParse(key).success).toBe(false);
  });
});

describe('the catalogue of connections that live elsewhere', () => {
  it('lists each existing connection once, with the permission its page needs', () => {
    expect(
      elsewhereIntegrations.map(({ key, page, permission }) => [key, page, permission]),
    ).toEqual([
      ['google_calendar', 'calendar_connections', 'appointments.manage'],
      ['mailboxes', 'email_services', 'mailboxes.manage'],
      ['emailable', 'email_verification', 'email.verification.manage'],
      ['twilio', 'phone_system', 'sms.manage'],
      ['ai_models', 'ai_models', 'ai.manage'],
      ['apps_and_api_keys', 'apps_and_api_keys', 'apps.manage'],
    ]);
  });

  it('keeps every key usable as a provider key, and none reserved', () => {
    for (const { key } of elsewhereIntegrations)
      expect(integrationKey.safeParse(key).success).toBe(true);
  });
});

describe('integrations.manage', () => {
  it('is a business permission owners and admins hold, and members do not', () => {
    expect(permissionCatalog['integrations.manage'].scope).toBe('business');
    const role = (key: string) => ({
      scope: 'business' as const,
      key,
      isBuiltin: true,
      permissions: [],
    });
    expect(permissionsOf(role('owner'), 'business').has('integrations.manage')).toBe(true);
    expect(permissionsOf(role('admin'), 'business').has('integrations.manage')).toBe(true);
    expect(permissionsOf(role('member'), 'business').has('integrations.manage')).toBe(false);
    expect(permissionsOf(role('viewer'), 'business').has('integrations.manage')).toBe(false);
  });

  it('can never be given to an API key, nor so asked for by a marketplace app: it moves credentials', () => {
    expect(apiKeyScopes).not.toContain('integrations.manage');
    expect(agencyApiKeyScopes).not.toContain('integrations.manage');
  });
});

describe('the API', () => {
  it('lists the integration endpoints under a read group a key can be limited to', () => {
    const integrations = endpoints.filter((endpoint) => endpoint.group === 'Integrations');
    expect(integrations.map((endpoint) => endpoint.operationId)).toEqual([
      'listIntegrations',
      'getIntegration',
      'connectIntegration',
      'updateIntegrationConnection',
      'testIntegrationConnection',
      'disconnectIntegration',
      'listIntegrationActivity',
    ]);
    expect(apiKeyReadGroups).toContain('Integrations');
  });

  it('files integration commands under Settings in the audit log', () => {
    expect(auditModuleOf('integration.connect')).toBe('settings');
  });

  it('reads a connection with its public id, and no credential field', () => {
    const connection = integrationConnection.parse({
      id: toPublicId('integration_connection', uuid),
      accountLabel: 'Acme Workspace',
      status: 'connected',
      errorCode: null,
      errorDetail: null,
      primary: true,
      connectedBy: 'Dana Brooks',
      connectedAt: '2026-10-18T09:30:00.000Z',
      lastOkAt: null,
      lastErrorAt: null,
      settings: {},
      webhookUrl: null,
      revision: 1,
    });
    expect(connection.id.startsWith('int_')).toBe(true);
    expect(integrationList.safeParse({ entries: [], canManage: false }).success).toBe(true);
  });

  it('takes a pasted key trimmed, and refuses an empty one', () => {
    expect(parseInput(connectIntegrationInput, { apiKey: '  sk_123 ' })).toEqual({
      apiKey: 'sk_123',
    });
    expect(parseInput(connectIntegrationInput, {})).toEqual({});
    expect(() => parseInput(connectIntegrationInput, { apiKey: '  ' })).toThrow();
  });

  it('makes a connection primary only by saying true, at a revision', () => {
    expect(parseInput(updateIntegrationConnectionInput, { primary: true, revision: 2 })).toEqual({
      primary: true,
      revision: 2,
    });
    expect(() =>
      parseInput(updateIntegrationConnectionInput, { primary: false, revision: 2 }),
    ).toThrow();
    expect(() => parseInput(updateIntegrationConnectionInput, { primary: true })).toThrow();
  });
});

describe('the notification', () => {
  it('tells the people who manage integrations when one needs them, and opens the page', () => {
    expect(notificationKinds).toContain('integration.needs_attention');
    expect(notificationTarget.parse({ kind: 'integrations' })).toEqual({ kind: 'integrations' });
  });
});
