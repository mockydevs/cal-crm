import type { Page } from '@playwright/test';
import { myPermissions, phoneCalling } from '@repo/contracts';
import { emptyMyTasks, plainContactDetails } from './contact-panels';

export const dana = { id: 'usr_dana', name: 'Dana Brooks', email: 'dana@harborlights.example' };

export interface Security {
  readonly twoFactorEnabled?: boolean;
  readonly twoFactorRequired?: boolean;
  readonly hasPassword?: boolean;
}

/**
 * Stands in for the server's answers to "who's signed in?" (Dana, or nobody) and "what
 * does signing in ask of them?": by default, nothing more. Someone signed in works where
 * `workplace` says, Dana's business by default.
 */
export async function signedIn(
  page: Page,
  user: typeof dana | null = dana,
  security: Security = {},
  workplace: Workplace = danasBusiness,
): Promise<void> {
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        user === null
          ? null
          : {
              user: { ...user, twoFactorEnabled: security.twoFactorEnabled ?? false },
              session: { id: 'ses_1' },
            },
      ),
    }),
  );
  await page.route('**/api/auth/security', (route) =>
    route.fulfill({
      json: {
        twoFactorRequired: security.twoFactorRequired ?? false,
        hasPassword: security.hasPassword ?? true,
      },
    }),
  );
  // The realtime socket, by default, is one nobody answers: opened in the browser and left
  // silent, so the dashboard stays as it is with no server (never connected) and no page
  // reaches out of the test. It is set on the browser context, which a page's own stand-in
  // comes before (inbox.spec.ts), whichever is made first.
  await page.context().routeWebSocket(/\/socket\.io\//, () => undefined);
  if (user === null) {
    // As the server answers anyone signed out.
    await page.route('**/api/v1/me', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401 }),
      }),
    );
  } else {
    await worksIn(page, workplace);
    // The shell keeps calling idle unless a test grants calling and configures it.
    await page.route('**/api/v1/me/permissions', (route) =>
      route.fulfill({
        json: myPermissions.parse({
          business: route.request().headers()['business-id'] ?? null,
          permissions: [],
        }),
      }),
    );
    await page.route('**/api/v1/calls/availability', (route) =>
      route.fulfill({
        json: phoneCalling.parse({
          available: false,
          unavailable: { code: 'calling_not_set_up', message: 'Calling is not set up.' },
        }),
      }),
    );
    // Today lists the person's overdue tasks: none, unless a test routes its own.
    await emptyMyTasks(page);
    // A contact's page reads its owner, followers and addresses beside the contact: what
    // the test's own contact gives, unless a test routes its own.
    await plainContactDetails(page);
    // A record's page lists the automations it has been through: none, unless a test
    // routes its own.
    await page.route(/\/api\/v1\/records\/[^/]+\/automation-runs(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route('**/api/v1/mailboxes/*/sending', (route) =>
      route.fulfill({
        json: {
          dailyLimit: 300,
          pacingPerMinute: 5,
          warmupEnabled: true,
          useForConversations: true,
          useForCampaigns: false,
          effectiveAutomatedDailyLimit: 50,
          warmupStartedAt: '2026-10-09T00:00:00.000Z',
          pausedUntil: null,
          pauseReason: null,
        },
      }),
    );
    await page.route('**/api/v1/mailbox-setup-alerts', (route) =>
      route.fulfill({ json: { data: [], hasMore: false } }),
    );
    // The top bar's bell: nothing unread, unless a test says otherwise after signing in.
    await page.route('**/api/v1/notifications/unread-count', (route) =>
      route.fulfill({ json: { unread: 0, more: false } }),
    );
    // Settings → Calendars asks whether Google Calendar can be connected: not here, unless
    // a test routes its own.
    await page.route('**/api/v1/integrations/google', (route) =>
      route.fulfill({ json: { available: false, mine: null, team: null } }),
    );
    await page.route(/\/api\/v1\/contacts\/con_[^/]+\/consent$/, (route) =>
      route.fulfill({
        json: {
          canManage: false,
          doNotContact: false,
          timeZone: null,
          current: [],
          suppressions: [],
          history: [],
          historyTruncated: false,
        },
      }),
    );
    // A contact's page shows where the contact came from: no touch recorded, unless a test
    // routes its own.
    await page.route(/\/api\/v1\/contacts\/con_[^/]+\/attribution$/, (route) =>
      route.fulfill({ json: { first: null, latest: null } }),
    );
    await page.route('**/api/v1/messaging-settings', (route) =>
      route.fulfill({
        json: {
          quietHoursEnabled: true,
          quietHoursStart: '21:00',
          quietHoursEnd: '08:00',
          contactDailyLimit: 10,
          revision: 'a'.repeat(64),
          canManage: false,
          heldMessages: 0,
          contactsWithoutTimeZone: 0,
        },
      }),
    );
    // The sidebar shows the Inbox's unread count: none, unless a test routes its own.
    await page.route('**/api/v1/inbox/summary', (route) =>
      route.fulfill({ json: { unreadConversations: 0, unreadMessages: 0, needsReply: 0 } }),
    );
    // A contact's page shows the contact's conversation: none, unless a test routes its
    // own. The Inbox's own reads of the list fall through.
    await page.route(/\/api\/v1\/conversations\?/, (route) =>
      new URL(route.request().url()).searchParams.has('contactId')
        ? route.fulfill({
            json: { canManage: false, canReply: false, items: [], nextCursor: null },
          })
        : route.fallback(),
    );
    // A contact's page lists the opportunities the contact is with, under Actions: none,
    // unless a test routes its own.
    await page.route(/\/api\/v1\/contacts\/con_[^/]+\/deals(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { items: [], more: false, canManage: false } }),
    );
    // And the contact's quotes and invoices, under Actions too: none, unless a test routes
    // its own. The Payments pages' own reads of the list fall through.
    await page.route(/\/api\/v1\/sales-documents\?/, (route) =>
      new URL(route.request().url()).searchParams.has('contactId')
        ? route.fulfill({ json: { items: [], nextCursor: null, canManage: false } })
        : route.fallback(),
    );
    await page.route(/\/api\/v1\/views\?object=(?:contact|deal)$/, (route) =>
      route.fulfill({ json: { canSave: true, items: [] } }),
    );
    // The Dashboard's widgets read the pipelines: none, so it asks for no report, unless a
    // test routes its own.
    await page.route('**/api/v1/pipelines', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { items: [], revision: 'a'.repeat(64), canManage: false } })
        : route.fallback(),
    );
  }
}

export interface Business {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'active' | 'suspended' | 'archived';
  /** The business's zone, which its calendar is drawn in; none draws it in the browser's. */
  readonly timezone?: string;
}

// Ids the server made: the contract checks each wraps a UUIDv7.
export const harbor: Business = {
  id: 'biz_01k8e2wzr0e008000000000001',
  name: 'Harbor Lights Events',
  slug: 'harbor-lights-events',
  status: 'active',
};
export const northwind: Business = {
  id: 'biz_01k8e2wzr0e008000000000002',
  name: 'Northwind Weddings',
  slug: 'northwind-weddings',
  status: 'active',
};
export const lakeside: Business = {
  id: 'biz_01k8e2wzr0e008000000000003',
  name: 'Lakeside Dental',
  slug: 'lakeside-dental',
  status: 'suspended',
};

/** Where someone may work: as agency staff or not, and the businesses they may enter. */
export interface Workplace {
  readonly agencyStaff: boolean;
  readonly businesses: readonly Business[];
}

/** Dana's: the one business they belong to. */
export const danasBusiness: Workplace = { agencyStaff: false, businesses: [harbor] };

/** The agency's staff's: every business of the agency, the suspended one too. */
export const agencyStaff: Workplace = {
  agencyStaff: true,
  businesses: [harbor, northwind, lakeside],
};

/** An address in Dana's business, such as inHarbor('/deals'). */
export const inHarbor = (path = ''): string => `/b/${harbor.slug}${path}`;

/**
 * Stands in for GET /api/v1/me. The dashboard asks it without naming a business, so the
 * business it names is a business user's only one, or none.
 */
export async function worksIn(page: Page, workplace: Workplace = danasBusiness): Promise<void> {
  const [only, ...others] = workplace.businesses;
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      json: {
        user: { name: dana.name, email: dana.email },
        agency: { name: 'Bluebird Digital', slug: 'bluebird-digital' },
        agencyStaff: workplace.agencyStaff,
        businesses: workplace.businesses,
        business: !workplace.agencyStaff && others.length === 0 ? (only?.id ?? null) : null,
      },
    }),
  );
}
