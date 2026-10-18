import { expect, it } from 'vitest';
import { apiKeyInputOf } from './api-keys-input';

const policy = {
  access: 'read-only',
  scopes: ['contacts.manage', 'payments.read'],
  readGroups: ['Contacts'],
  chosen: new Set<string>(),
  selectedGroups: new Set(['Contacts']),
} as const;

it.each(['not a date', 42, null])(
  'rejects malformed expiry %s before sending a native request',
  (expiresAt) => {
    expect(apiKeyInputOf({ name: 'Sourcepoint', expiresAt }, policy)).toEqual({
      success: false,
      expiryProblem: 'invalid',
    });
  },
);

it('converts a future local expiry without delegating unrequested protected read grants', () => {
  const result = apiKeyInputOf({ name: 'Sourcepoint', expiresAt: '2099-05-06T12:34' }, policy);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('Expected a valid draft');
  expect(result.data).toEqual({
    name: 'Sourcepoint',
    scopes: [],
    readOnly: true,
    readGroups: ['Contacts'],
    expiresAt: new Date(2099, 4, 6, 12, 34).toISOString(),
  });
});

it('delegates only chosen held protected reads and excludes stale grants and chosen writers', () => {
  const result = apiKeyInputOf(
    { name: 'Sourcepoint' },
    {
      ...policy,
      chosen: new Set(['payments.read', 'reports.view', 'contacts.manage']),
    },
  );
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('Expected a valid draft');
  expect(result.data.scopes).toEqual(['payments.read']);
});

it('does not delegate a chosen custom writer or an unrequested held read in read-only mode', () => {
  const result = apiKeyInputOf(
    { name: 'Sourcepoint' },
    {
      ...policy,
      chosen: new Set(['contacts.manage']),
    },
  );
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('Expected a valid draft');
  expect(result.data.scopes).toEqual([]);
});

it('rejects a past expiry and lets the native contract reject an empty name', () => {
  expect(apiKeyInputOf({ name: 'Sourcepoint', expiresAt: '2020-01-01T10:00' }, policy)).toEqual({
    success: false,
    expiryProblem: 'past',
  });
  const result = apiKeyInputOf({ name: '' }, policy);
  expect(result.success).toBe(false);
  if (result.success || 'expiryProblem' in result) throw new Error('Expected native validation');
  expect(result.error.issues[0]?.path).toEqual(['name']);
});

it('drops stale custom choices when they are no longer in the returned grants or catalog', () => {
  const result = apiKeyInputOf(
    { name: 'Sourcepoint' },
    {
      ...policy,
      access: 'custom',
      scopes: ['contacts.manage'],
      chosen: new Set(['contacts.manage', 'team.manage']),
      selectedGroups: new Set(['Contacts', 'Team']),
    },
  );
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('Expected a valid draft');
  expect(result.data).toEqual({
    name: 'Sourcepoint',
    scopes: ['contacts.manage'],
    readOnly: false,
    readGroups: ['Contacts'],
  });
});
