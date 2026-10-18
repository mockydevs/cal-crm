// Stands in for the Phone System's API in the browser tests: the business's calling
// defaults, its registered numbers with their settings, and its members, kept as a server
// keeps them, so a save can be read back after the page is loaded again. A save under a
// revision that isn't the current one is refused as the server refuses it.
import type { Page } from '@playwright/test';
import type {
  Permission,
  PhoneNumberSettings,
  PhoneSystemSettings,
  UpdatePhoneNumberSettingsInput,
  UpdatePhoneSystemSettingsInput,
} from '@repo/contracts';
import { harbor } from './session';

/** What the person may change in the business (GET /me/permissions), which the page reads first. */
export async function grant(page: Page, permissions: readonly Permission[]): Promise<void> {
  await page.route('**/api/v1/me/permissions', (route) =>
    route.fulfill({ json: { business: harbor.id, permissions } }),
  );
}

const revisionOf = (letter: string): string => letter.repeat(64);
/** The revisions each save moves the stand-in's settings on to, in turn. */
export const revisions: readonly [string, string, string, string] = [
  revisionOf('a'),
  revisionOf('b'),
  revisionOf('c'),
  revisionOf('d'),
];

export const dana = 'mem_01k8e2wzr0e008000000000001';
export const lee = 'mem_01k8e2wzr0e008000000000002';

/** The members who may own a number or take its calls (GET /phone-system/members). */
export const phoneMembers = [
  { id: dana, name: 'Dana Brooks', email: 'dana@harborlights.example' },
  { id: lee, name: 'Lee Park', email: 'lee@harborlights.example' },
];

/** Answers GET /phone-system/members a page at a time, as many a page as `limit` asks. */
async function standInMembers(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/phone-system\/members(?:\?.*)?$/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const after = query.get('after');
    const limit = Number(query.get('limit') ?? '100');
    const start = after === null ? 0 : phoneMembers.findIndex((each) => each.id === after) + 1;
    const data = phoneMembers.slice(start, start + limit);
    const last = data.at(-1);
    return route.fulfill({
      json: {
        data,
        nextCursor: last === undefined || start + limit >= phoneMembers.length ? null : last.id,
      },
    });
  });
}

export const voiceNumber = (patch: Partial<PhoneNumberSettings> = {}): PhoneNumberSettings => ({
  id: 'phn_01k8e2wzr0e008000000000001',
  e164: '+14155550123',
  capabilities: ['sms', 'mms', 'voice'],
  status: 'active',
  isDefault: true,
  name: 'Front desk',
  ownerId: dana,
  voice: {
    recording: { enabled: false, announcement: { enabled: false, message: null } },
    routing: {
      primaryMemberId: dana,
      forwardTo: null,
      useBusinessFallback: false,
      ringAlso: [],
      ringTimeoutSeconds: 20,
      voicemailBackup: true,
    },
    advanced: {
      callConnectConfirmation: false,
      whisper: { enabled: false, message: null },
      forwardedCallerId: 'caller',
      preferContactOwner: false,
    },
  },
  revision: revisions[0],
  warnings: [],
  ...patch,
});

export const phoneSettings = (patch: Partial<PhoneSystemSettings> = {}): PhoneSystemSettings => ({
  defaultNumberId: 'phn_01k8e2wzr0e008000000000001',
  inbound: { preferAssignedUser: true, allowAnonymousCallers: true, fallbackNumber: null },
  outbound: {
    callerId: 'account_default',
    connectAgent: 'after_announcement',
    quietHoursWarning: true,
  },
  recording: { retentionDays: null, transcriptionEnabled: false },
  missedCallText: { enabled: false, message: null },
  revision: revisions[0],
  calling: {
    available: false,
    unavailable: {
      code: 'calling_not_set_up',
      message: "The server's own sentence, which the page does not show.",
    },
  },
  ...patch,
});

export interface PhoneSystemState {
  settings: PhoneSystemSettings;
  numbers: PhoneNumberSettings[];
  /** Every save the page sent, in order. */
  readonly saves: (UpdatePhoneNumberSettingsInput | UpdatePhoneSystemSettingsInput)[];
}

const nextRevision = (current: string): string =>
  revisions[(revisions.indexOf(current) + 1) % revisions.length] ?? '';

const conflict = {
  status: 409,
  contentType: 'application/problem+json',
  json: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'Saved meanwhile.' },
};

export async function standInPhoneSystem(page: Page, state: PhoneSystemState): Promise<void> {
  await standInMembers(page);
  await page.route('**/api/v1/phone-system/numbers', (route) =>
    route.fulfill({ json: { data: state.numbers } }),
  );
  // The Twilio account behind the numbers, with calling set up on it.
  await page.route('**/api/v1/phone-system/calling-setups', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            connectionId: 'smsc_01k8e2wzr0e008000000000001',
            label: 'Main account',
            connectionStatus: 'connected',
            voiceNumbers: 1,
            setup: {
              status: 'ready',
              failure: null,
              requestedAt: '2026-10-15T09:00:00.000Z',
              finishedAt: '2026-10-15T09:00:02.000Z',
            },
            canSetUp: false,
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/phone-system/settings', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fulfill({ json: state.settings });
      return;
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as UpdatePhoneSystemSettingsInput;
    state.saves.push(body);
    if (body.revision !== state.settings.revision) {
      await route.fulfill(conflict);
      return;
    }
    const { revision, ...fields } = body;
    state.settings = { ...state.settings, ...fields, revision: nextRevision(revision) };
    state.numbers = state.numbers.map((number) => ({
      ...number,
      isDefault: number.id === state.settings.defaultNumberId,
    }));
    await route.fulfill({ json: state.settings });
  });
  await page.route(/\/api\/v1\/phone-numbers\/(phn_[^/]+)\/settings$/, async (route) => {
    const id = /phone-numbers\/(phn_[^/]+)\/settings/.exec(route.request().url())?.[1];
    const number = state.numbers.find((each) => each.id === id);
    if (number === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such number.' },
      });
      return;
    }
    if (route.request().method() !== 'PUT') {
      await route.fulfill({ json: number });
      return;
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as UpdatePhoneNumberSettingsInput;
    state.saves.push(body);
    if (body.revision !== number.revision) {
      await route.fulfill(conflict);
      return;
    }
    const { revision, ...fields } = body;
    const saved: PhoneNumberSettings = { ...number, ...fields, revision: nextRevision(revision) };
    state.numbers = state.numbers.map((each) => (each.id === saved.id ? saved : each));
    await route.fulfill({ json: saved });
  });
}
