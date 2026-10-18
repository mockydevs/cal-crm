import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, me } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.84'));

test('keeps navigation alive when two realtime updates overlap a workspace read', async ({
  page,
}) => {
  const person = await newPerson();
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const api = `${address('app')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('Realtime fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: `Realtime ${randomUUID().slice(0, 8)}` },
  });
  expect(created.status()).toBe(201);
  const saved = contact.parse(await created.json());
  const view = await page.context().newPage();
  const connected = view.waitForEvent('websocket').then(async (socket) => {
    await socket.waitForEvent('framereceived', {
      predicate: ({ payload }) => typeof payload === 'string' && payload.startsWith('40'),
    });
    return socket;
  });
  await view.goto(inOurs(`/contacts/${saved.id}`));
  const socket = await connected;
  await expect(view.getByRole('heading', { name: saved.name ?? '', exact: true })).toBeVisible();
  let releaseRead: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let readStarted: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  let reads = 0;
  await view.route('**/api/v1/me', async (route) => {
    reads++;
    if (reads === 1) {
      readStarted?.();
      await paused;
    }
    await route.continue();
  });
  try {
    expect(
      (
        await page.request.patch(`${api}/contacts/${saved.id}`, {
          headers,
          data: { lastName: 'First change' },
        })
      ).status(),
    ).toBe(200);
    await requested;
    await view.getByRole('link', { name: 'Edit', exact: true }).click();
    const nextChange = socket.waitForEvent('framereceived', {
      predicate: ({ payload }) =>
        typeof payload === 'string' && payload.includes('business.changed'),
    });
    expect(
      (
        await page.request.patch(`${api}/contacts/${saved.id}`, {
          headers,
          data: { lastName: 'Second change' },
        })
      ).status(),
    ).toBe(200);
    await nextChange;
    // Let the received event run in the page before releasing the held HTTP response.
    await view.evaluate(() => Promise.resolve());
  } finally {
    releaseRead?.();
  }
  await expect(view.getByRole('heading', { name: /^Edit Realtime / })).toBeVisible();
  await expect(view.getByText('Something went wrong!', { exact: true })).toHaveCount(0);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  // The same refresh must preserve a page being appended, then refetch the full chain.
  for (let index = 0; index < 60; index++) {
    expect(
      (
        await page.request.patch(`${api}/contacts/${saved.id}`, {
          headers,
          data: { lastName: `Change ${String(index)}` },
        })
      ).status(),
    ).toBe(200);
  }
  const otherResponse = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: 'Unrelated realtime contact' },
  });
  expect(otherResponse.status()).toBe(201);
  const other = contact.parse(await otherResponse.json());
  await view.getByRole('link', { name: 'Cancel', exact: true }).click();
  const activity = view.getByRole('region', { name: 'Activity', exact: true });
  await expect(activity.getByRole('listitem')).toHaveCount(50);
  await expect(
    activity.getByRole('button', { name: 'Load older activity', exact: true }),
  ).toBeEnabled();
  let releasePage: (() => void) | undefined;
  const heldPage = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  let pageStarted: (() => void) | undefined;
  const paging = new Promise<void>((resolve) => {
    pageStarted = resolve;
  });
  let olderReads = 0;
  await view.route(`**/api/v1/records/${saved.id}/activity?*`, async (route) => {
    if (new URL(route.request().url()).searchParams.has('after')) {
      olderReads++;
      if (olderReads === 1) {
        pageStarted?.();
        await heldPage;
      }
    }
    await route.continue();
  });
  try {
    await activity.getByRole('button', { name: 'Load older activity', exact: true }).click();
    await paging;
    const changed = socket.waitForEvent('framereceived', {
      predicate: ({ payload }) =>
        typeof payload === 'string' && payload.includes('business.changed'),
    });
    expect(
      (
        await page.request.patch(`${api}/contacts/${other.id}`, {
          headers,
          data: { lastName: 'Changed during paging' },
        })
      ).status(),
    ).toBe(200);
    await changed;
    await view.evaluate(() => Promise.resolve());
  } finally {
    releasePage?.();
  }
  await expect(activity.getByRole('listitem')).toHaveCount(63);
  await expect.poll(() => olderReads).toBeGreaterThanOrEqual(2);
});
test('shows a committed field in another signed-in tab within one second', async ({
  page,
  context,
}) => {
  const person = await newPerson();
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const other = await context.newPage();
  const connected = other.waitForEvent('websocket').then((socket) =>
    socket.waitForEvent('framereceived', {
      predicate: ({ payload }) => typeof payload === 'string' && payload.startsWith('40'),
    }),
  );
  await other.goto(inOurs('/settings/custom-fields'));
  await connected;
  await expect(other.getByRole('button', { name: 'Create field', exact: true })).toBeVisible();
  await page.goto(inOurs('/settings/custom-fields'));
  await page.getByRole('button', { name: 'Create field', exact: true }).click();
  const name = `Realtime ${randomUUID().slice(0, 8)}`;
  await page.getByLabel('Field name', { exact: true }).fill(name);
  await page
    .getByLabel('Key', { exact: true })
    .fill(`realtime_${randomUUID().replaceAll('-', '')}`);
  await page.getByLabel('What it means', { exact: true }).fill('A field changed in another tab.');
  const committed = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/fields'),
  );
  await page.getByRole('button', { name: 'Create custom field', exact: true }).click();
  expect((await committed).status()).toBe(201);
  await expect(other.getByRole('button', { name: `Edit ${name}`, exact: true })).toBeVisible({
    timeout: 1000,
  });
});
