import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSettings, settingsColumns } from './audit.ts';

const schema = `export interface CrmContacts {
  business_id: string;
  name: string;
}

export interface CrmSettings {
  business_id: string;
  tag_creation: Generated<string>;
  trash_retention_days: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface MessagingSettings {
  business_id: string;
  quiet_hours_enabled: Generated<boolean>;
  revision: Generated<number>;
}

export interface DB {
  "crm.contacts": CrmContacts;
  "crm.settings": CrmSettings;
  "messaging.settings": MessagingSettings;
}
`;

const tests = {
  'packages/crm/tags.int.test.ts': `it('lets everyone create tags once the policy allows it', async () => {});`,
  'packages/crm/trash.int.test.ts': `it(\`purges past the retention days at \${String(days)}\`, () => {});`,
};
const read = (file) => tests[file];

const proven = {
  'crm.settings': {
    tag_creation: {
      proof: {
        file: 'packages/crm/tags.int.test.ts',
        test: 'lets everyone create tags once the policy allows it',
      },
    },
    trash_retention_days: {
      proof: {
        file: 'packages/crm/trash.int.test.ts',
        test: 'purges past the retention days at ${String(days)}',
      },
    },
  },
  'messaging.settings': { quiet_hours_enabled: { gap: 'Nothing holds a message yet.' } },
};

test('reads the columns of every settings table, without the bookkeeping columns', () => {
  assert.deepEqual(
    settingsColumns(schema),
    new Map([
      ['crm.settings', ['tag_creation', 'trash_retention_days']],
      ['messaging.settings', ['quiet_hours_enabled']],
    ]),
  );
});

test('reads a schema written with Windows line endings', () => {
  assert.deepEqual(settingsColumns(schema.replaceAll('\n', '\r\n')).get('crm.settings'), [
    'tag_creation',
    'trash_retention_days',
  ]);
});

test('counts the settings and lists the gaps with their reasons', () => {
  assert.deepEqual(auditSettings({ schema, effects: proven, read }), {
    problems: [],
    settings: 3,
    gaps: [
      { setting: 'messaging.settings.quiet_hours_enabled', reason: 'Nothing holds a message yet.' },
    ],
  });
});

test('does not count a column that is not a setting', () => {
  const effects = {
    ...proven,
    'messaging.settings': { quiet_hours_enabled: { notASetting: 'State the worker keeps.' } },
  };
  assert.deepEqual(auditSettings({ schema, effects, read }), {
    problems: [],
    settings: 2,
    gaps: [],
  });
});

test('refuses a setting with neither a proof nor a gap', () => {
  const effects = { ...proven, 'messaging.settings': {} };
  assert.deepEqual(auditSettings({ schema, effects, read }).problems, [
    'messaging.settings.quiet_hours_enabled: name the test that proves what it changes, or list it as a gap with its reason.',
  ]);
});

test('refuses an entry for a column or a table that no longer exists', () => {
  const effects = {
    ...proven,
    'crm.settings': { ...proven['crm.settings'], tag_policy: { gap: 'Renamed.' } },
    'ai.settings': { enabled: { gap: 'Gone.' } },
  };
  assert.deepEqual(auditSettings({ schema, effects, read }).problems, [
    'crm.settings.tag_policy: no such column; remove its entry.',
    'ai.settings.enabled: no such column; remove its entry.',
  ]);
});

test('refuses a proof whose test cannot be found, or that is not in a test file', () => {
  const effects = {
    ...proven,
    'crm.settings': {
      tag_creation: { proof: { file: 'packages/crm/tags.int.test.ts', test: 'lets everyone' } },
      trash_retention_days: { proof: { file: 'packages/crm/gone.int.test.ts', test: 'purges' } },
    },
    'messaging.settings': {
      quiet_hours_enabled: { proof: { file: 'packages/crm/tags.ts', test: 'holds' } },
    },
  };
  assert.deepEqual(auditSettings({ schema, effects, read }).problems, [
    'crm.settings.tag_creation: packages/crm/tags.int.test.ts has no test named "lets everyone".',
    'crm.settings.trash_retention_days: packages/crm/gone.int.test.ts does not exist.',
    'messaging.settings.quiet_hours_enabled: packages/crm/tags.ts is not a test file.',
  ]);
});

test('refuses a gap or a column left out without a reason', () => {
  const effects = {
    'crm.settings': { tag_creation: { gap: ' ' }, trash_retention_days: { notASetting: '' } },
    'messaging.settings': proven['messaging.settings'],
  };
  assert.deepEqual(auditSettings({ schema, effects, read }).problems, [
    'crm.settings.tag_creation: give the reason.',
    'crm.settings.trash_retention_days: give the reason.',
  ]);
});
