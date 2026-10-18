// A business's External Tracking as the API holds it, for the component tests and the
// browser spec of Settings → External Tracking: every write is parsed by the contract's own
// schema and every answer is typed by the contract's own types. A change is taken only at
// the revision it was read at, as the server takes it. Nothing here imports the dashboard's
// code, so a test never checks the page against itself.
import {
  regenerateTrackingIdInput,
  updateExternalTrackingInput,
  type ExternalTracking,
  type MyPermissions,
  type TrackingActivity,
} from '@repo/contracts';

export const trackingId = `tk_${'a1'.repeat(16)}`;
export const trackedContactId = 'con_01k8e2wzr0e008000000000001';

export interface TrackingWorld {
  settings: ExternalTracking;
  activity: TrackingActivity;
  /** Whether the person may change it (sites.manage). */
  mayManage: boolean;
}

/** A refusal the API would answer, as the test API throws it. */
export interface Refusal {
  readonly status: number;
  readonly detail: string;
}
export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && 'status' in value && 'detail' in value;

export const heardFrom: TrackingActivity = {
  lastEventAt: '2026-10-18T09:05:00.000Z',
  events: [
    {
      receivedAt: '2026-10-18T09:05:00.000Z',
      kind: 'form_submission',
      pageHost: 'www.acme-roofing.example',
      pagePath: '/contact',
      pageTitle: 'Contact us',
      formName: 'Free estimate',
      contactId: trackedContactId,
    },
    {
      receivedAt: '2026-10-18T09:04:00.000Z',
      kind: 'page_view',
      pageHost: 'www.acme-roofing.example',
      pagePath: '/pricing',
      pageTitle: 'Pricing',
      formName: null,
      contactId: null,
    },
  ],
  pages: [
    {
      pageHost: 'www.acme-roofing.example',
      pagePath: '/contact',
      pageViews: 4,
      formSubmissions: 1,
      lastSeenAt: '2026-10-18T09:05:00.000Z',
    },
    {
      pageHost: 'www.acme-roofing.example',
      pagePath: '/pricing',
      pageViews: 12,
      formSubmissions: 0,
      lastSeenAt: '2026-10-18T09:04:00.000Z',
    },
  ],
};

export const trackingWorldOf = (change: Partial<TrackingWorld> = {}): TrackingWorld => ({
  settings: {
    trackingId,
    pageViews: true,
    formCapture: true,
    allowedDomains: [],
    visitorIds: 'unless_opted_out',
    revision: 1,
  },
  activity: { lastEventAt: null, events: [], pages: [] },
  mayManage: true,
  ...change,
});

const stale: Refusal = {
  status: 409,
  detail: 'The tracking settings changed since you opened them. Open them again.',
};
const forbidden: Refusal = { status: 403, detail: 'You may not change this.' };

export function updateTrackingIn(world: TrackingWorld, body: unknown): ExternalTracking | Refusal {
  if (!world.mayManage) return forbidden;
  const input = updateExternalTrackingInput.parse(body);
  if (input.revision !== world.settings.revision) return stale;
  world.settings = {
    ...world.settings,
    pageViews: input.pageViews,
    formCapture: input.formCapture,
    allowedDomains: [...input.allowedDomains],
    visitorIds: input.visitorIds,
    revision: world.settings.revision + 1,
  };
  return world.settings;
}

export function regenerateIn(world: TrackingWorld, body: unknown): ExternalTracking | Refusal {
  if (!world.mayManage) return forbidden;
  const input = regenerateTrackingIdInput.parse(body);
  if (input.revision !== world.settings.revision) return stale;
  world.settings = {
    ...world.settings,
    trackingId: `tk_${'b2'.repeat(16)}`,
    revision: world.settings.revision + 1,
  };
  return world.settings;
}

export const permissionsOf = (world: TrackingWorld): MyPermissions => ({
  business: 'biz_01k8e2wzr0e008000000000001',
  permissions: world.mayManage ? ['contacts.manage', 'sites.manage'] : ['contacts.manage'],
});
