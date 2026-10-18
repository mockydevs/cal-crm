// The stand-in API behind Settings → Calendars for the browser tests. It answers over HTTP
// with the same stand-in the unit tests use (calendar-settings-fake.ts): calendars, groups,
// the people of the account, forms, senders, files and the Media Storage files a logo or a
// cover is, each body parsed by the contract's
// schema there, and each answer parsed by the SDK in the page. It is apart from
// calendar-fixtures.ts, which the Calendars module's own pages are tested with.
import { expect, type Page } from '@playwright/test';
import { businessProfile } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { fakeCalendarApi, type Call, type FakeApi } from './calendar-settings-fake';
import { harbor } from './session';

// The smallest PNG there is: one transparent pixel, for a logo's preview.
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** The operation an HTTP request is, with what its address carries. */
function callOf(method: string, parts: readonly string[], query: Record<string, string>): Call {
  const [root, second, third, fourth] = parts;
  const operation = (name: string, params?: Record<string, string>): Call => ({
    operation: name,
    ...(params === undefined ? {} : { params }),
    query,
  });
  if (root === 'calendar-groups') {
    if (second === undefined)
      return operation(method === 'GET' ? 'listCalendarGroups' : 'createCalendarGroup');
    return operation(method === 'PUT' ? 'renameCalendarGroup' : 'deleteCalendarGroup', {
      groupId: second,
    });
  }
  if (root === 'calendars') {
    if (second === undefined)
      return operation(method === 'GET' ? 'listCalendars' : 'createCalendar');
    if (second === 'senders') return operation('listCalendarSenders');
    if (second === 'users' && third !== undefined && fourth === 'availability')
      return operation('getCalendarUserAvailability', { membershipId: third });
    if (third === 'availability') return operation('updateCalendarAvailability', { id: second });
    return operation(
      method === 'GET' ? 'getCalendar' : method === 'PUT' ? 'updateCalendar' : 'deleteCalendar',
      { id: second },
    );
  }
  if (root === 'users') return operation('listUsers');
  if (root === 'forms') return operation('listForms');
  if (root === 'files')
    return second === undefined
      ? operation('uploadFile')
      : operation('createFileLink', { id: second });
  if (root === 'media' && second !== undefined)
    return operation(method === 'GET' ? 'getMediaFile' : 'updateMediaFile', { id: second });
  throw new Error(`The stand-in does not answer ${method} /${parts.join('/')}.`);
}

/** Answers Settings → Calendars as the server does, for Dana's business. */
export async function fakeCalendarSettingsApi(
  page: Page,
  options: Parameters<typeof fakeCalendarApi>[0] = {},
): Promise<FakeApi> {
  const api = fakeCalendarApi(options);
  await page.route('**/fake-files/image.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: pixel }),
  );
  await page.route(
    /\/api\/v1\/(?:calendars|calendar-groups|users|business-profile|forms|files|media)(?:[/?].*)?$/,
    async (route) => {
      const request = route.request();
      expect(request.headers()['business-id']).toBe(harbor.id);
      const url = new URL(request.url());
      const parts = url.pathname
        .replace('/api/v1', '')
        .split('/')
        .filter((part) => part !== '');
      if (parts[0] === 'business-profile') {
        await route.fulfill({
          json: businessProfile.parse({
            id: harbor.id,
            name: harbor.name,
            timezone: options.timezone ?? 'Africa/Nairobi',
            locale: 'en',
            currency: 'KES',
            address: null,
            logoFileId: null,
            canManage: false,
          }),
        });
        return;
      }
      const method = request.method();
      const call = callOf(method, parts, Object.fromEntries(url.searchParams));
      const sends = method === 'POST' || method === 'PUT' || method === 'PATCH';
      const body: unknown =
        sends && call.operation !== 'uploadFile' ? request.postDataJSON() : undefined;
      try {
        const answer = await api.ask(body === undefined ? call : { ...call, body });
        if (answer === undefined) {
          await route.fulfill({ status: 204 });
          return;
        }
        await route.fulfill({
          status: method === 'POST' ? 201 : 200,
          json:
            call.operation === 'createFileLink'
              ? {
                  url: new URL('/fake-files/image.png', url).toString(),
                  expiresAt: '2026-10-12T10:00:00.000Z',
                }
              : answer,
        });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        await route.fulfill({
          status: error.status,
          contentType: 'application/problem+json',
          body: JSON.stringify(error.problem),
        });
      }
    },
  );
  return api;
}
