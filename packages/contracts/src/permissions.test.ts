import { describe, expect, it } from 'vitest';

import { permissionCatalog, permissions, permissionsOf, type RoleGrant } from './permissions.js';

const builtIn = (scope: RoleGrant['scope'], key: string): RoleGrant => ({
  scope,
  key,
  isBuiltin: true,
  permissions: [],
});

const sorted = (granted: ReadonlySet<string>): string[] => [...granted].sort();

const agencyKeys = [
  'agency.security',
  'ai.manage',
  'apps.manage',
  'businesses.create',
  'files.upload',
  'team.manage',
];
const businessKeys = [
  'ai.manage',
  'appointments.manage',
  'apps.manage',
  'assistant.use',
  'audit.read',
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
  'integrations.manage',
  'mailboxes.manage',
  'media.manage',
  'notes.manage',
  'objects.manage',
  'payments.manage',
  'payments.read',
  'phone.manage',
  'pipelines.manage',
  'records.manage',
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
  'views.save',
  'views.share',
  'webchat.manage',
];

it('allows inbox work in a business while keeping viewers and agency scope read-only', () => {
  for (const scope of ['agency', 'business'] as const) {
    for (const key of ['owner', 'admin', 'member']) {
      const granted = permissionsOf(builtIn(scope, key), 'business');
      expect([...granted]).toContain('conversations.manage');
      expect([...granted]).toContain('conversations.reply');
      expect([...permissionsOf(builtIn(scope, key), 'agency')]).not.toContain(
        'conversations.manage',
      );
      expect([...permissionsOf(builtIn(scope, key), 'agency')]).not.toContain(
        'conversations.reply',
      );
    }
  }
  expect([...permissionsOf(builtIn('business', 'viewer'), 'business')]).not.toContain(
    'conversations.manage',
  );
  expect([...permissionsOf(builtIn('business', 'viewer'), 'business')]).not.toContain(
    'conversations.reply',
  );
});

it('keeps an explicitly granted custom reply role separate from conversation management', () => {
  const role: RoleGrant = {
    scope: 'business',
    key: 'responder',
    isBuiltin: false,
    permissions: ['conversations.reply'],
  };
  expect([...permissionsOf(role, 'business')]).toEqual(['conversations.reply']);
  expect([...permissionsOf(role, 'agency')]).toEqual([]);
});

it('restricts automation, template, SMS, phone, web chat and form configuration to business owners and admins by default', () => {
  for (const permission of [
    'automations.manage',
    'automations.publish',
    'templates.manage',
    'sms.manage',
    'phone.manage',
    'webchat.manage',
    'forms.manage',
  ]) {
    for (const scope of ['agency', 'business'] as const) {
      for (const key of ['owner', 'admin']) {
        expect(sorted(permissionsOf(builtIn(scope, key), 'business'))).toContain(permission);
        expect(sorted(permissionsOf(builtIn(scope, key), 'agency'))).not.toContain(permission);
      }
      expect(sorted(permissionsOf(builtIn(scope, 'member'), 'business'))).not.toContain(permission);
    }
    expect(sorted(permissionsOf(builtIn('business', 'viewer'), 'business'))).not.toContain(
      permission,
    );
  }
});

// GoHighLevel: "Only admins at the location level" manage custom objects; others read them.
it('gives managing custom objects and associations to business owners and admins only', () => {
  for (const scope of ['agency', 'business'] as const) {
    for (const key of ['owner', 'admin']) {
      expect(permissionsOf(builtIn(scope, key), 'business').has('objects.manage')).toBe(true);
      expect(permissionsOf(builtIn(scope, key), 'agency').has('objects.manage')).toBe(false);
    }
    expect(permissionsOf(builtIn(scope, 'member'), 'business').has('objects.manage')).toBe(false);
  }
  expect(permissionsOf(builtIn('business', 'viewer'), 'business').has('objects.manage')).toBe(
    false,
  );
  expect(permissionCatalog['objects.manage'].scope).toBe('business');
});

// Adding contacts one at a time is daily work; adding a file of them at once is not.
it('gives importing contacts to business owners and admins, and not to members, viewers or the agency scope', () => {
  for (const scope of ['agency', 'business'] as const) {
    for (const key of ['owner', 'admin']) {
      expect(permissionsOf(builtIn(scope, key), 'business').has('contacts.import')).toBe(true);
      expect(permissionsOf(builtIn(scope, key), 'agency').has('contacts.import')).toBe(false);
    }
    const member = permissionsOf(builtIn(scope, 'member'), 'business');
    expect([member.has('contacts.import'), member.has('contacts.manage')]).toEqual([false, true]);
  }
  expect(permissionsOf(builtIn('business', 'viewer'), 'business').has('contacts.import')).toBe(
    false,
  );
  expect(permissionCatalog['contacts.import'].scope).toBe('business');
});

// GoHighLevel lets only admins export contacts: a file of all of them leaves with whoever has it.
it('gives exporting contacts to business owners and admins, and not to members, viewers or the agency scope', () => {
  for (const scope of ['agency', 'business'] as const) {
    for (const key of ['owner', 'admin']) {
      expect(permissionsOf(builtIn(scope, key), 'business').has('contacts.export')).toBe(true);
      expect(permissionsOf(builtIn(scope, key), 'agency').has('contacts.export')).toBe(false);
    }
    expect(permissionsOf(builtIn(scope, 'member'), 'business').has('contacts.export')).toBe(false);
  }
  expect(permissionsOf(builtIn('business', 'viewer'), 'business').has('contacts.export')).toBe(
    false,
  );
});

// Changing a contact is daily work; reading who changed what, and why, is not.
it('gives reading the audit log to business owners and admins, and not to members, viewers or the agency scope', () => {
  for (const scope of ['agency', 'business'] as const) {
    for (const key of ['owner', 'admin']) {
      expect(permissionsOf(builtIn(scope, key), 'business').has('audit.read')).toBe(true);
      expect(permissionsOf(builtIn(scope, key), 'agency').has('audit.read')).toBe(false);
    }
    const member = permissionsOf(builtIn(scope, 'member'), 'business');
    expect([member.has('audit.read'), member.has('contacts.manage')]).toEqual([false, true]);
  }
  expect(permissionsOf(builtIn('business', 'viewer'), 'business').has('audit.read')).toBe(false);
  expect(permissionCatalog['audit.read'].scope).toBe('business');
});

it('gives AI settings to owners and admins, in a business and at the agency, and to nobody else', () => {
  for (const key of ['owner', 'admin']) {
    // Agency staff: the agency's shared keys and prices, and every business's own settings.
    expect(permissionsOf(builtIn('agency', key), 'agency').has('ai.manage')).toBe(true);
    expect(permissionsOf(builtIn('agency', key), 'business').has('ai.manage')).toBe(true);
    // A business's own owner or admin: that business only, never the agency.
    expect(permissionsOf(builtIn('business', key), 'business').has('ai.manage')).toBe(true);
    expect(permissionsOf(builtIn('business', key), 'agency').has('ai.manage')).toBe(false);
  }
  for (const at of ['agency', 'business'] as const) {
    expect(permissionsOf(builtIn('agency', 'member'), at).has('ai.manage')).toBe(false);
    expect(permissionsOf(builtIn('business', 'member'), at).has('ai.manage')).toBe(false);
    expect(permissionsOf(builtIn('business', 'viewer'), at).has('ai.manage')).toBe(false);
  }
  expect(permissionCatalog['ai.manage'].scope).toBe('both');
});

it('restricts calendar configuration to business owners and admins', () => {
  for (const scope of ['agency', 'business'] as const) {
    for (const key of ['owner', 'admin']) {
      expect(permissionsOf(builtIn(scope, key), 'business').has('calendars.manage')).toBe(true);
      expect(permissionsOf(builtIn(scope, key), 'agency').has('calendars.manage')).toBe(false);
    }
  }
  for (const key of ['member', 'viewer']) {
    expect(permissionsOf(builtIn('business', key), 'business').has('calendars.manage')).toBe(false);
  }
});

it('gives booking and changing appointments to everyone who works in a business, and not to viewers or the agency scope', () => {
  for (const scope of ['agency', 'business'] as const) {
    for (const key of ['owner', 'admin', 'member']) {
      expect(permissionsOf(builtIn(scope, key), 'business').has('appointments.manage')).toBe(true);
      expect(permissionsOf(builtIn(scope, key), 'agency').has('appointments.manage')).toBe(false);
    }
  }
  expect(permissionsOf(builtIn('business', 'viewer'), 'business').has('appointments.manage')).toBe(
    false,
  );
  expect(permissionCatalog['appointments.manage'].scope).toBe('business');
});

describe('the permission catalog', () => {
  it('lets members save their own views, owners and admins share them, and viewers neither', () => {
    for (const scope of ['agency', 'business'] as const) {
      const member = permissionsOf(builtIn(scope, 'member'), 'business');
      expect(member.has('views.save')).toBe(true);
      expect(member.has('views.share')).toBe(false);
      for (const key of ['owner', 'admin']) {
        expect(permissionsOf(builtIn(scope, key), 'business').has('views.share')).toBe(true);
      }
      expect(permissionsOf(builtIn(scope, 'owner'), 'agency').has('views.save')).toBe(false);
    }
    const viewer = permissionsOf(builtIn('business', 'viewer'), 'business');
    expect([viewer.has('views.save'), viewer.has('views.share')]).toEqual([false, false]);
  });
  it('allows notes and tasks as business daily work, with viewers read-only', () => {
    for (const permission of ['notes.manage', 'tasks.manage'] as const) {
      for (const scope of ['agency', 'business'] as const) {
        expect(permissionsOf(builtIn(scope, 'member'), 'business').has(permission)).toBe(true);
        expect(permissionsOf(builtIn(scope, 'owner'), 'agency').has(permission)).toBe(false);
      }
      expect(permissionsOf(builtIn('business', 'viewer'), 'business').has(permission)).toBe(false);
    }
  });
  it('allows company management in daily business work and keeps it outside agency scope', () => {
    expect(permissionsOf(builtIn('business', 'member'), 'business').has('companies.manage')).toBe(
      true,
    );
    expect(permissionsOf(builtIn('business', 'viewer'), 'business').has('companies.manage')).toBe(
      false,
    );
    expect(permissionsOf(builtIn('agency', 'owner'), 'agency').has('companies.manage')).toBe(false);
  });
  it('describes every key, each with an area and what it allows', () => {
    for (const key of permissions) {
      // Feature permissions can have a named sub-area, such as email.verification.manage.
      expect(key).toMatch(/^[a-z]+\.[a-z_]+(?:\.[a-z_]+)?$/);
      expect(permissionCatalog[key].description).toMatch(/^[A-Z].*\.$/);
    }
    expect(agencyKeys.length).toBeGreaterThan(0);
    expect(businessKeys.length).toBeGreaterThan(0);
  });
});

describe('permissionsOf', () => {
  it('gives agency owners and admins everything, at the agency and in each business', () => {
    for (const key of ['owner', 'admin']) {
      const role = builtIn('agency', key);
      expect(sorted(permissionsOf(role, 'agency'))).toEqual([...agencyKeys].sort());
      expect(sorted(permissionsOf(role, 'business'))).toEqual([...businessKeys].sort());
    }
  });

  it("gives agency members shared uploads at the agency, and a business member's daily work in each business", () => {
    const member = builtIn('agency', 'member');
    expect(sorted(permissionsOf(member, 'agency'))).toEqual(['files.upload']);
    expect(sorted(permissionsOf(member, 'business'))).toEqual([
      'appointments.manage',
      'assistant.use',
      'calls.place',
      'calls.read',
      'campaigns.manage',
      'companies.manage',
      'contacts.manage',
      'conversations.manage',
      'conversations.reply',
      'deals.manage',
      'fields.values',
      'files.upload',
      'media.manage',
      'notes.manage',
      'payments.read',
      'records.manage',
      'reports.view',
      'tags.manage',
      'tasks.manage',
      'views.save',
    ]);
  });

  it("gives a business's owners and admins all of its work, members daily work, and viewers only the assistant", () => {
    expect(sorted(permissionsOf(builtIn('business', 'owner'), 'business'))).toEqual(
      [...businessKeys].sort(),
    );
    expect(sorted(permissionsOf(builtIn('business', 'admin'), 'business'))).toEqual(
      [...businessKeys].sort(),
    );
    expect(sorted(permissionsOf(builtIn('business', 'member'), 'business'))).toEqual([
      'appointments.manage',
      'assistant.use',
      'calls.place',
      'calls.read',
      'campaigns.manage',
      'companies.manage',
      'contacts.manage',
      'conversations.manage',
      'conversations.reply',
      'deals.manage',
      'fields.values',
      'files.upload',
      'media.manage',
      'notes.manage',
      'payments.read',
      'records.manage',
      'reports.view',
      'tags.manage',
      'tasks.manage',
      'views.save',
    ]);
    // A viewer may ask the assistant, which is then held to the viewer's role.
    expect(sorted(permissionsOf(builtIn('business', 'viewer'), 'business'))).toEqual([
      'assistant.use',
    ]);
  });

  it('never gives a business role anything at the agency', () => {
    for (const key of ['owner', 'admin', 'member', 'viewer']) {
      expect(sorted(permissionsOf(builtIn('business', key), 'agency'))).toEqual([]);
    }
  });

  it("ignores what a built-in role has stored: its permissions come from the catalog's release", () => {
    const viewer = { ...builtIn('business', 'viewer'), permissions: ['tags.manage'] };
    expect(sorted(permissionsOf(viewer, 'business'))).toEqual(['assistant.use']);
  });

  it('gives a built-in key it does not know nothing', () => {
    for (const scope of ['agency', 'business'] as const) {
      for (const key of ['auditor', 'constructor', 'toString', '__proto__']) {
        expect(sorted(permissionsOf(builtIn(scope, key), scope))).toEqual([]);
      }
    }
  });

  it("gives a custom role its stored keys that the catalog has, in the place's scope", () => {
    const custom: RoleGrant = {
      scope: 'agency',
      key: 'account_manager',
      isBuiltin: false,
      permissions: [
        'businesses.create',
        'files.upload',
        'tags.manage',
        'payments.refund',
        '*',
        'all',
        'constructor',
      ],
    };
    expect(sorted(permissionsOf(custom, 'agency'))).toEqual(['businesses.create', 'files.upload']);
    expect(sorted(permissionsOf(custom, 'business'))).toEqual(['files.upload', 'tags.manage']);
  });

  it('keeps custom business grants inside their business, even when agency keys are stored', () => {
    const custom: RoleGrant = {
      scope: 'business',
      key: 'custom',
      isBuiltin: false,
      permissions: [...permissions],
    };
    expect(sorted(permissionsOf(custom, 'agency'))).toEqual([]);
    expect(sorted(permissionsOf(custom, 'business'))).toEqual(businessKeys);
  });
});

// Records of custom objects are daily work, as companies are; their objects are not.
it('gives working with custom records to owners, admins and members, never viewers', () => {
  for (const scope of ['agency', 'business'] as const)
    for (const key of ['owner', 'admin', 'member'])
      expect(permissionsOf(builtIn(scope, key), 'business').has('records.manage')).toBe(true);
  expect(permissionsOf(builtIn('business', 'viewer'), 'business').has('records.manage')).toBe(
    false,
  );
  expect(permissionCatalog['records.manage'].scope).toBe('business');
});
