// What someone may change, by area: the catalog every command's permission comes from, and
// the permissions each built-in role gives. Agency permissions cover the agency's own work;
// business permissions cover the work inside a business, wherever the person works in one.

/** Every permission, as `<area>.<what>` or, for a named part of an area, `<area>.<part>.<what>`. */
export const permissions = [
  'agency.security',
  'ai.manage',
  'appointments.manage',
  'apps.manage',
  'assistant.use',
  'audit.read',
  'automations.manage',
  'automations.publish',
  'businesses.create',
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
  'views.save',
  'views.share',
  'webchat.manage',
] as const;

export type Permission = (typeof permissions)[number];

export type PermissionScope = 'agency' | 'business';

export interface PermissionInfo {
  /** Where it applies: at the agency, inside a business, or both. */
  readonly scope: PermissionScope | 'both';
  readonly description: string;
}

export const permissionCatalog: Readonly<Record<Permission, PermissionInfo>> = {
  'email.verification.manage': {
    scope: 'business',
    description:
      'Manage email verification settings, provider connections and hard-bounce unblocking.',
  },
  'conversations.manage': {
    scope: 'business',
    description: 'Assign, open, snooze, close and mark conversations read, and add internal notes.',
  },
  'conversations.reply': {
    scope: 'business',
    description: 'Reply to conversations through the outbound pipeline.',
  },
  'templates.manage': {
    scope: 'business',
    description:
      'Create and edit message templates, and the custom values and their folders that messages fill in.',
  },
  'automations.manage': {
    scope: 'business',
    description: 'Create, edit, validate and test automation drafts.',
  },
  'automations.publish': {
    scope: 'business',
    description: 'Publish automation versions and pause or resume new enrolments.',
  },
  'campaigns.manage': {
    scope: 'business',
    description:
      'Create, edit, test and delete email campaign drafts and their folders, and see campaigns and their results.',
  },
  'campaigns.send': {
    scope: 'business',
    description:
      'Send, schedule, pause, resume and cancel email campaigns, send a test to an address other than your own, and send an email or a text message to many contacts at once from the contact list.',
  },
  'calendars.manage': {
    scope: 'business',
    description: 'Configure calendars, team availability and booking settings.',
  },
  'appointments.manage': {
    scope: 'business',
    description: 'Book, move and cancel appointments, and set their status.',
  },
  'mailboxes.manage': {
    scope: 'business',
    description: 'Connect mailboxes and manage email settings.',
  },
  'sms.manage': {
    scope: 'business',
    description: 'Connect SMS provider accounts and register existing phone numbers.',
  },
  'calls.read': {
    scope: 'business',
    description:
      "See the business's calls: who called whom, from which number, when, and how each ended.",
  },
  'calls.place': {
    scope: 'business',
    description:
      'Call contacts from the business’s numbers, and hang up or cancel your own calls. Every call is checked against the contact’s do-not-call and consent first.',
  },
  'phone.manage': {
    scope: 'business',
    description:
      "Set how the business's calls are handled: its calling defaults, and each phone number's name, owner, routing, recording and advanced options.",
  },
  'notes.manage': {
    scope: 'business',
    description: 'Create, edit and delete notes on records.',
  },
  'objects.manage': {
    scope: 'business',
    description:
      'Create, edit and delete custom objects and the associations between objects. GoHighLevel gives this to admins only; everyone else reads them.',
  },
  'tasks.manage': {
    scope: 'business',
    description: 'Create, edit, complete and delete tasks.',
  },
  'companies.manage': {
    scope: 'business',
    description: 'Create, edit, trash and restore companies.',
  },
  'deals.manage': {
    scope: 'business',
    description: 'Create and edit deals, move stages and record outcomes.',
  },
  'fields.manage': {
    scope: 'business',
    description: 'Configure field definitions and their AI fill policies.',
  },
  'fields.values': {
    scope: 'business',
    description: 'Edit record field values and confirm AI-filled values.',
  },
  'agency.security': {
    scope: 'agency',
    description: "Change the agency's sign-in rules, such as requiring two-factor sign-in.",
  },
  'apps.manage': {
    scope: 'both',
    description:
      'Create and revoke API keys, and publish and install marketplace apps, in this agency or business.',
  },
  'audit.read': {
    scope: 'business',
    description:
      "Read the audit log: who ran which command on a record, when, and the reason given for a do-not-contact change. An API key can't have it.",
  },
  'businesses.create': {
    scope: 'agency',
    description: 'Add businesses to the agency.',
  },
  'files.upload': {
    scope: 'both',
    description: 'Upload agency-shared files or files to the business.',
  },
  'media.manage': {
    scope: 'business',
    description:
      "Change the business's media library: upload into it, make folders, rename, move and delete files, and give a file a public address.",
  },
  'business.profile': {
    scope: 'business',
    description: "Change the business's profile, address and logo.",
  },
  'tags.manage': {
    scope: 'business',
    description: "Create and change the business's tags.",
  },
  'tags.configure': {
    scope: 'business',
    description: 'Configure tag groups, definitions and creation rules.',
  },
  'pipelines.manage': {
    scope: 'business',
    description: 'Configure pipelines and their deal stages.',
  },
  'team.manage': {
    scope: 'both',
    description: 'Invite people and manage the workspace team.',
  },
  'contacts.manage': {
    scope: 'business',
    description: "Add, change and trash the business's contacts.",
  },
  'contacts.import': {
    scope: 'business',
    description:
      'Import contacts from a file, stop an import, and see the history of imports with the rows each one did not apply. An import also needs what its rows would need one at a time: contacts.manage, and tags.manage or fields.values when it adds tags or fills custom fields.',
  },
  'contacts.merge': {
    scope: 'business',
    description:
      "Manage Duplicates: see the groups of contacts that may be the same person, say a group is not, and merge contacts into one, which cannot be undone. GoHighLevel gives Manage Duplicates to admins only, so a member's built-in role does not have it.",
  },
  'contacts.export': {
    scope: 'business',
    description:
      "Export the business's contacts to a CSV file from the list, and download the files exported. GoHighLevel lets only admins export, so a member's built-in role does not have it.",
  },
  'trash.purge': {
    scope: 'business',
    description: 'Delete records in the trash forever, with everything attached to them.',
  },
  'views.save': {
    scope: 'business',
    description: 'Save private views of lists, and change or delete your own.',
  },
  'views.share': {
    scope: 'business',
    description: "Share saved views with the team, and change or delete the team's shared views.",
  },
  'sites.manage': {
    scope: 'business',
    description:
      'Create, edit, copy and delete funnels and websites, their folders, steps, pages and saved sections; save and use templates; import a shared site; reset statistics.',
  },
  'sites.publish': {
    scope: 'business',
    description:
      'Publish and unpublish pages, start and stop a split test, and declare its winner.',
  },
  'sites.share': {
    scope: 'business',
    description:
      'Export a funnel or website to share with another business, and save templates for the whole agency.',
  },
  'domains.manage': {
    scope: 'business',
    description: 'Connect and check domains for sites, and manage URL redirects.',
  },
  'forms.manage': {
    scope: 'business',
    description:
      'Build and publish forms, choose the websites that may show them and discard unattached submissions.',
  },
  'payments.read': {
    scope: 'business',
    description:
      'See quotes, invoices, payments and receipts, and the settings they are numbered and worded by. Products and their prices are open to everyone in the business.',
  },
  'payments.manage': {
    scope: 'business',
    description:
      'Keep the catalogue of products and services; write, issue, void and convert quotes and invoices; record and reverse payments; change the numbering, terms and tax settings. It includes seeing them.',
  },
  'ai.manage': {
    scope: 'both',
    description:
      'Connect AI providers and test them, choose a model for each job, set the spending limit and privacy, and choose how much each assistant does on its own. At the agency: the keys every business may use, and model prices.',
  },
  'assistant.use': {
    scope: 'business',
    description:
      'Talk to the in-app assistant and keep your own conversations with it. What the assistant then reads or changes is held to the rest of your role: it can never do more than you.',
  },
  'reports.view': {
    scope: 'business',
    description:
      'Open Reporting, run report queries and read saved reports. A report counts only what the rest of your role lets you see.',
  },
  'reports.manage': {
    scope: 'business',
    description: 'Make, change, copy and delete saved reports. It needs reports.view too.',
  },
  'webchat.manage': {
    scope: 'business',
    description:
      'Add web chat widgets, choose the websites that may show them and replace their keys.',
  },
};

/** A role, as a membership has it: built in, or made by the agency with its own keys. */
export interface RoleGrant {
  readonly scope: PermissionScope;
  readonly key: string;
  readonly isBuiltin: boolean;
  /** A custom role's keys. A built-in role's come from builtInPermissions instead. */
  readonly permissions: readonly string[];
}

const everything: readonly Permission[] = permissions;

/** Daily work, including agency-shared uploads for agency members. */
const dailyWork: readonly Permission[] = [
  'appointments.manage',
  'assistant.use',
  // Calling contacts, and seeing the calls made, is daily work; configuring numbers is not.
  'calls.place',
  'calls.read',
  // Writing a campaign is daily work; sending one to a list is not.
  'campaigns.manage',
  'companies.manage',
  'contacts.manage',
  'conversations.manage',
  'conversations.reply',
  'deals.manage',
  'files.upload',
  'media.manage',
  'notes.manage',
  'fields.values',
  // Seeing what a customer was quoted and has paid is daily work; writing it is not.
  'payments.read',
  // Reading the business's numbers is daily work; making and changing reports is not.
  'reports.view',
  'tags.manage',
  'tasks.manage',
  'views.save',
];

/**
 * What each built-in role gives, from this release's code, so a new permission reaches
 * every agency's built-in roles without a migration. An agency role's business permissions
 * apply in every business of the agency.
 */
export const builtInPermissions: Readonly<
  Record<PermissionScope, Readonly<Record<string, readonly Permission[]>>>
> = {
  agency: { owner: everything, admin: everything, member: dailyWork },
  // A viewer may ask the assistant too: its tools are held to the viewer's own role, so it
  // reads for them and changes nothing.
  business: {
    owner: everything,
    admin: everything,
    member: dailyWork,
    viewer: ['assistant.use'],
  },
};

const isPermission = (key: string): key is Permission =>
  (permissions as readonly string[]).includes(key);

/**
 * The permissions a role gives where the person works: at the agency, its agency
 * permissions; in a business, its business permissions. A business role gives nothing at
 * the agency. Keys the catalog doesn't have are ignored.
 */
export function permissionsOf(role: RoleGrant, at: PermissionScope): ReadonlySet<Permission> {
  if (role.scope === 'business' && at === 'agency') return new Set();
  const keys = role.isBuiltin
    ? (Object.entries(builtInPermissions[role.scope]).find(([key]) => key === role.key)?.[1] ?? [])
    : role.permissions.filter(isPermission);
  return new Set(
    keys.filter(
      (key) => permissionCatalog[key].scope === at || permissionCatalog[key].scope === 'both',
    ),
  );
}
