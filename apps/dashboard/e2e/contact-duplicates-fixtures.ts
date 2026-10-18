// Stands in for the API behind duplicate contacts: Manage Duplicates' groups and Reject, a
// contact's possible duplicates and the deduplication preferences, answering as the server
// does.
import type { Page, Route } from '@playwright/test';
import type {
  DuplicateContact,
  DuplicateFindMode,
  DuplicateGroup,
  DuplicateMatchField,
  DuplicateSettings,
} from '@repo/contracts';
import { idOf } from './settings-fixtures';

export function duplicateContactOf(
  number: number,
  name: string | null,
  addresses: { emails?: string[]; phones?: string[] } = {},
): DuplicateContact {
  return {
    id: idOf('con', number),
    name,
    emails: addresses.emails ?? [],
    phones: addresses.phones ?? [],
    createdAt: new Date(Date.UTC(2026, 8, number, 12)).toISOString(),
  };
}

export function duplicateGroupOf(
  by: DuplicateFindMode,
  valueKey: string,
  contacts: DuplicateContact[],
  rest: Partial<DuplicateGroup> = {},
): DuplicateGroup {
  return {
    by,
    valueKey,
    reasons: [by],
    weak: false,
    total: contacts.length,
    contacts,
    ...rest,
  };
}

/** Jane Doe twice: two addresses that reach one Gmail inbox. */
export const gmailTwins = (): DuplicateGroup =>
  duplicateGroupOf('email', 'janedoe@gmail.com', [
    duplicateContactOf(1, 'Jane Doe', { emails: ['jane.doe@gmail.com'], phones: ['+12125550142'] }),
    duplicateContactOf(2, 'Jane Doe', { emails: ['janedoe+news@gmail.com'] }),
  ]);

/** Two numbers that end alike under different names: a weaker sign. */
export const phoneTails = (): DuplicateGroup =>
  duplicateGroupOf(
    'phone',
    '2125550199',
    [
      duplicateContactOf(3, 'Maya Chen', { phones: ['+12125550199'] }),
      duplicateContactOf(4, 'Sam Lee', { phones: ['+2125550199'] }),
    ],
    { weak: true },
  );

/** Similar names backed by a shared company. */
export const companyNames = (): DuplicateGroup =>
  duplicateGroupOf(
    'name',
    'katherine johnson',
    [
      duplicateContactOf(5, 'Katherine Johnson', { emails: ['kate@one.example'] }),
      duplicateContactOf(6, 'Katharine Johnson', { emails: ['kj@two.example'] }),
    ],
    { reasons: ['name', 'company'] },
  );

export interface DuplicatesApi {
  groups: Record<DuplicateFindMode, DuplicateGroup[]>;
  settings: DuplicateSettings;
  /** Each rejection asked for, as sent. */
  rejected: unknown[];
  /** Each save of the preferences, as sent. */
  saved: unknown[];
  /** The modes Manage Duplicates asked for, in order. */
  asked: string[];
  /** Answer the groups as the server answers someone without contacts.merge. */
  refused: boolean;
}

const forbidden = (route: Route): Promise<void> =>
  route.fulfill({
    status: 403,
    contentType: 'application/problem+json',
    json: {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: "Your role doesn't allow this: it needs contacts.merge.",
    },
  });

export async function fakeDuplicatesApi(
  page: Page,
  seed: { groups?: Partial<Record<DuplicateFindMode, DuplicateGroup[]>>; canManage?: boolean } = {},
): Promise<DuplicatesApi> {
  const api: DuplicatesApi = {
    groups: { email: [], phone: [], name: [], ...seed.groups },
    settings: {
      primary: 'email',
      secondary: null,
      revision: '1'.padStart(64, '0'),
      canManage: seed.canManage ?? true,
    },
    rejected: [],
    saved: [],
    asked: [],
    refused: false,
  };
  await page.route(/\/api\/v1\/contacts\/duplicate-groups(?:\?.*)?$/, (route) => {
    if (api.refused) return forbidden(route);
    const by = (new URL(route.request().url()).searchParams.get('by') ??
      'email') as DuplicateFindMode;
    api.asked.push(by);
    return route.fulfill({ json: { items: api.groups[by], next: null } });
  });
  await page.route('**/api/v1/contacts/duplicate-groups/reject', async (route) => {
    if (api.refused) return forbidden(route);
    const body = route.request().postDataJSON() as { by: DuplicateFindMode; contactIds: string[] };
    api.rejected.push(body);
    api.groups[body.by] = api.groups[body.by].filter(
      (group) => !group.contacts.every((each) => body.contactIds.includes(each.id)),
    );
    await route.fulfill({ status: 204 });
  });
  await page.route(/\/api\/v1\/contacts\/[^/]+\/possible-duplicates$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    const groups = [...api.groups.email, ...api.groups.phone, ...api.groups.name].filter((group) =>
      group.contacts.some((each) => each.id === id),
    );
    const others = new Set(
      groups
        .flatMap((group) => group.contacts.map((each) => each.id))
        .filter((each) => each !== id),
    );
    return route.fulfill({ json: { groups, count: others.size } });
  });
  await page.route('**/api/v1/contact-duplicate-settings', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as {
        primary: DuplicateMatchField;
        secondary: DuplicateMatchField | null;
      };
      api.saved.push(body);
      api.settings = {
        ...api.settings,
        primary: body.primary,
        secondary: body.secondary,
        revision: String(api.saved.length + 1).padStart(64, '0'),
      };
    }
    await route.fulfill({ json: api.settings });
  });
  return api;
}
