// What global-setup.ts started, for the tests. It sets these environment variables, and
// Playwright starts its test workers after it, with them.
export const variables = {
  /** Our business: the API, and the dashboard. */
  app: 'E2E_APP_URL',
  /** A separate install with no users or businesses, bootstrapped by the install CLI. */
  freshApp: 'E2E_FRESH_APP_URL',
  /** The one-time first-admin URL printed by that install. */
  freshSetupLink: 'E2E_FRESH_SETUP_LINK',
  /** Another business in the same agency: the API only. */
  otherBusiness: 'E2E_OTHER_BUSINESS_URL',
  /** The database, as crm_owner: for what the API doesn't show, such as events. */
  database: 'E2E_DATABASE_URL',
  /** Mailpit's API: the mail the app sent, such as sign-in links. */
  mail: 'E2E_MAILPIT_URL',
  /** The "Inbox day" install (Checkpoint 1C), at its public https address. */
  inboxDay: 'E2E_INBOX_DAY_URL',
  /** The same server without the HTTPS front: where the Twilio stand-in posts webhooks. */
  inboxDayDirect: 'E2E_INBOX_DAY_DIRECT_URL',
  /** That install's database, as crm_owner. */
  inboxDayDatabase: 'E2E_INBOX_DAY_DATABASE_URL',
  /** The "Automation day" install (Checkpoint 1E), at its public https address. */
  automationDay: 'E2E_AUTOMATION_DAY_URL',
  /** The same server without the HTTPS front: where the Twilio stand-in posts webhooks. */
  automationDayDirect: 'E2E_AUTOMATION_DAY_DIRECT_URL',
  /** That install's database, as crm_owner. */
  automationDayDatabase: 'E2E_AUTOMATION_DAY_DATABASE_URL',
  /** The "Booking day" install (Checkpoint 1D): the API, the dashboard and the booking page. */
  bookingDay: 'E2E_BOOKING_DAY_URL',
  /** That install's database, as crm_owner. */
  bookingDayDatabase: 'E2E_BOOKING_DAY_DATABASE_URL',
  /** The "Model day" install (Settings → AI models): the API and the dashboard. */
  modelDay: 'E2E_MODEL_DAY_URL',
  /** That install's database, as crm_owner. */
  modelDayDatabase: 'E2E_MODEL_DAY_DATABASE_URL',
  /** A model server of that install's own, which its operator listed: its /v1 address. */
  modelServer: 'E2E_MODEL_SERVER_URL',
  /** The "Draft day" install (proposals and reply drafts): the API and the dashboard. */
  draftDay: 'E2E_DRAFT_DAY_URL',
  /** That install's database, as crm_owner. */
  draftDayDatabase: 'E2E_DRAFT_DAY_DATABASE_URL',
  /** That install's stand-in for Claude, which a test scripts (apps/server/test/fake-claude.ts). */
  draftDayClaude: 'E2E_DRAFT_DAY_CLAUDE_URL',
  /** The "Verify day" install (email verification): the API and the dashboard. */
  verifyDay: 'E2E_VERIFY_DAY_URL',
  /** That install's database, as crm_owner. */
  verifyDayDatabase: 'E2E_VERIFY_DAY_DATABASE_URL',
  /** The local stand-in for Twilio's REST API (apps/server/test/fake-twilio.ts). */
  twilio: 'E2E_TWILIO_URL',
  /** The mail server a mailbox is connected to on "Inbox day", as JSON (InboxDayMailServer). */
  mailServer: 'E2E_MAIL_SERVER',
} as const;

/** GreenMail, as the "Inbox day" tests reach it. Its user and password are made for the run. */
export interface InboxDayMailServer {
  readonly address: string;
  /** SMTP and IMAP over TLS: what the mailbox is connected to. */
  readonly smtpPort: number;
  readonly imapPort: number;
  /** SMTP without TLS or sign-in: how mail from outside arrives. */
  readonly plainSmtpPort: number;
  readonly username: string;
  readonly password: string;
  /** GreenMail's own HTTP API. */
  readonly apiUrl: string;
}

/** The business and its owner on the "Inbox day" install. */
export const inboxDay = {
  business: { name: 'Lakeside Studio', slug: 'lakeside-studio' },
  owner: { name: 'Sam Rivers', email: 'sam@lakeside.example' },
} as const;

/** The business and its owner on the "Automation day" install. */
export const automationDay = {
  business: { name: 'Meadow Lane Events', slug: 'meadow-lane-events' },
  owner: { name: 'Ava Stone', email: 'ava@meadowlane.example' },
} as const;

/** The business and its owner on the "Booking day" install. */
export const bookingDay = {
  business: { name: 'Juniper Hall', slug: 'juniper-hall' },
  owner: { name: 'Noor Haddad', email: 'noor@juniperhall.example' },
} as const;

/**
 * The business and its owner on the "Model day" install, and the key its stand-in for
 * Claude accepts. The key is made up for these tests: no provider issued it.
 */
export const modelDay = {
  business: { name: 'Fernbank Studio', slug: 'fernbank-studio' },
  owner: { name: 'Imani Okoro', email: 'imani@fernbank.example' },
  claudeKey: 'sk-ant-fixture-model-day-00000000c7e2',
} as const;

/**
 * The business and its owner on the "Draft day" install, and the key its stand-in for
 * Claude accepts. The key is made up for these tests: no provider issued it.
 */
export const draftDay = {
  business: { name: 'Willow Park Events', slug: 'willow-park-events' },
  owner: { name: 'Lena Fischer', email: 'lena@willowpark.example' },
  claudeKey: 'sk-ant-fixture-draft-day-000000004b9d',
} as const;

/**
 * The business and its owner on the "Verify day" install, and the key its stand-in for
 * Emailable accepts. The key is made up for these tests: no provider issued it. A key that
 * starts with test_ is one of Emailable's test keys, so the page says Test mode.
 */
export const verifyDay = {
  business: { name: 'Birchwood Rooms', slug: 'birchwood-rooms' },
  owner: { name: 'Omar Haddad', email: 'omar@birchwood.example' },
  emailableKey: 'test_fake_verify_day',
} as const;

export function address(name: keyof typeof variables): string {
  const value = process.env[variables[name]];
  if (value === undefined) {
    throw new Error(`${variables[name]} isn't set. Run these tests with playwright test.`);
  }
  return value;
}

/** Our business's owner, whom global-setup.ts makes. They sign in with an emailed link. */
export const owner = { name: 'Dana Brooks', email: 'dana@harborlights.example' } as const;

/**
 * Says which client a test file's requests come from. The app server trusts the test
 * browser as its proxy (TRUST_PROXY), as an install trusts Coolify's, so it takes the
 * client's address from X-Forwarded-For. Better Auth limits sign-in attempts per client,
 * such as five sign-in links a minute, so files that each have their own don't use up each
 * other's. Use addresses from 203.0.113.0/24, which is for documentation.
 */
export function asClient(ip: string): { extraHTTPHeaders: Record<string, string> } {
  return { extraHTTPHeaders: { 'x-forwarded-for': ip } };
}

/** The two businesses global-setup.ts makes, in the same agency. */
export const ours = { name: 'Harbor Lights Events', slug: 'harbor-lights-events' } as const;
export const theirs = { name: 'Northwind Weddings', slug: 'northwind-weddings' } as const;

/** The dashboard's address for a page in our business, such as inOurs('/contacts'). */
export function inOurs(path = ''): string {
  return `${address('app')}/b/${ours.slug}${path}`;
}
