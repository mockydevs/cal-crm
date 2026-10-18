import { describe, expect, it } from 'vitest';
import { endpoints } from './api.js';

import {
  agencyApiKeyScopes,
  apiKeyReadGroups,
  apiKeyPersonalGroups,
  apiKeySelectableReadGroups,
  createApiKeyInput,
} from './api-keys.js';

describe('scoped integration key access', () => {
  it('accounts for every native API group so new features cannot silently evade selected-read policy', () => {
    const known = new Set<string>(apiKeyReadGroups);
    const missing = [
      ...new Set(
        endpoints
          .filter((endpoint) => endpoint.audience !== 'public')
          .map((endpoint) => endpoint.group),
      ),
    ].filter((group) => !known.has(group));
    expect(missing).toEqual([]);
  });
  it('offers usable CRM read groups without offering personal state or private agency sign-in settings', () => {
    expect(apiKeySelectableReadGroups).toEqual(
      expect.arrayContaining(['Contacts', 'Automations', 'Users', 'Team']),
    );
    expect(apiKeySelectableReadGroups.some((group) => apiKeyPersonalGroups.includes(group))).toBe(
      false,
    );
    expect(apiKeySelectableReadGroups).not.toContain('Agency');
  });
  it('allows a read-only key without write permissions', () => {
    const input = {
      name: 'External reporting agent',
      scopes: [],
      readOnly: true,
      readGroups: ['Contacts', 'Automations'],
    };
    expect(createApiKeyInput.parse(input)).toEqual(input);
  });

  it('keeps the existing request shape and legacy read behavior explicit', () => {
    const input = { name: 'Existing app', scopes: ['tags.manage'] };
    expect(createApiKeyInput.parse(input)).toEqual(input);
  });

  it.each([
    { scopes: [], readGroups: [] },
    { scopes: [] },
    { scopes: ['tags.manage'], readGroups: ['Contacts', 'Contacts'] },
    { scopes: ['tags.manage'], readGroups: ['unverified-domain'] },
    { scopes: ['automations.manage'], readOnly: true, readGroups: ['Automations'] },
  ])('refuses empty, duplicate, unknown or contradictory access: %j', (access) => {
    expect(createApiKeyInput.safeParse({ name: 'Agent', ...access }).success).toBe(false);
  });

  it('allows native read permissions on a read-only reporting key', () => {
    expect(
      createApiKeyInput.safeParse({
        name: 'Reporting',
        scopes: ['reports.view', 'payments.read'],
        readOnly: true,
        readGroups: ['Reports', 'Payments'],
      }).success,
    ).toBe(true);
  });

  it('allows agency business management without granting key or personal security management', () => {
    expect(agencyApiKeyScopes).toContain('businesses.create');
    for (const scope of [
      'apps.manage',
      'agency.security',
      'ai.manage',
      'assistant.use',
      'audit.read',
    ])
      expect(agencyApiKeyScopes).not.toContain(scope);
    expect(
      createApiKeyInput.safeParse({ name: 'Agency agent', scopes: ['businesses.create'] }).success,
    ).toBe(true);
  });

  it('accepts optional future expiry and refuses past or malformed expiry', () => {
    const base = { name: 'Agent', scopes: ['tags.manage'] };
    expect(
      createApiKeyInput.safeParse({
        ...base,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }).success,
    ).toBe(true);
    for (const expiresAt of ['yesterday', '2000-01-01T00:00:00.000Z'])
      expect(createApiKeyInput.safeParse({ ...base, expiresAt }).success).toBe(false);
  });

  it('offers canonical read groups for workflow construction and account discovery', () => {
    expect(apiKeyReadGroups).toEqual(
      expect.arrayContaining([
        'Automations',
        'Contacts',
        'Forms',
        'Fields',
        'Message templates',
        'Businesses',
      ]),
    );
  });
});
