import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { CallDetail } from '@repo/contracts';
import { grant } from './phone-system-fixtures';
import { inHarbor, signedIn } from './session';

const callId = 'call_01k8e2wzr0e008000000000001';
const initial = (): CallDetail => ({
  id: callId,
  direction: 'outbound',
  state: 'connected',
  outcome: null,
  failure: null,
  phoneNumberId: 'phn_01k8e2wzr0e008000000000001',
  localNumber: '+14155550123',
  remoteNumber: '+14155550199',
  contactId: null,
  contactIdentityId: null,
  membershipId: null,
  needsReconciliation: false,
  hangUpRequested: false,
  createdAt: '2026-10-15T10:00:00.000Z',
  connectedAt: '2026-10-15T10:00:05.000Z',
  endedAt: null,
  legs: [
    {
      id: 'cleg_01k8e2wzr0e008000000000001',
      parentId: null,
      party: 'remote',
      membershipId: null,
      status: 'in-progress',
      providerDirection: 'outbound-api',
      providerCallId: `CA${'1'.repeat(32)}`,
      durationSeconds: null,
      conflict: false,
      answeredAt: '2026-10-15T10:00:05.000Z',
      endedAt: null,
    },
  ],
});

for (const width of [360, 1280]) {
  test(`shows actual call progress and requests a hang-up without inventing an end at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    await grant(page, ['calls.read', 'calls.place']);
    let call = initial();
    let endings = 0;
    const summary = () => {
      const { legs: _legs, ...record } = call;
      return record;
    };
    await page.route(/\/api\/v1\/calls(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { items: [summary()], nextCursor: null } }),
    );
    await page.route(`**/api/v1/calls/${callId}`, (route) => route.fulfill({ json: call }));
    await page.route(`**/api/v1/calls/${callId}/hang-up`, (route) => {
      endings += 1;
      call = { ...call, hangUpRequested: true };
      return route.fulfill({ json: summary() });
    });
    await page.goto(inHarbor('/calls'));
    await expect(page.getByRole('heading', { level: 1, name: 'Calls', exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Conversations', exact: true })
        .getByRole('link', { name: 'Call history' }),
    ).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: /Details of the call with/ }).click();
    const panel = page.getByRole('dialog', { name: 'Call details', exact: true });
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await panel.getByRole('button', { name: 'Hang up', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Hang up this call?', exact: true })
      .getByRole('button', { name: 'Hang up', exact: true })
      .click();
    await expect(
      panel.getByText('Hang-up requested. The call ends when the provider reports it has.'),
    ).toBeVisible();
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible();
    expect(endings).toBe(1);
    call = {
      ...call,
      state: 'ended',
      outcome: 'completed',
      endedAt: '2026-10-15T10:01:10.000Z',
      legs: call.legs.map((leg) => ({
        ...leg,
        status: 'completed',
        durationSeconds: 65,
        endedAt: '2026-10-15T10:01:10.000Z',
      })),
    };
    await page.reload();
    await expect(page.getByText('Ended: completed', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test('does not request call data for a role without calls.read', async ({ page }) => {
  await signedIn(page);
  await grant(page, ['sms.manage']);
  let reads = 0;
  await page.route(/\/api\/v1\/calls(?:\?.*)?$/, (route) => {
    reads += 1;
    return route.fulfill({ status: 403 });
  });
  await page.goto(inHarbor('/calls'));
  await expect(page.getByText('You need permission to read calls.')).toBeVisible();
  expect(reads).toBe(0);
});
