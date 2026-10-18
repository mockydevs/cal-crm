import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, contactScore, me, scoreProfile, scoreRule } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';

test.use(asClient('203.0.113.134'));

test('a published rule scores a tag added to a contact, and the score is set on the contact page', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().slice(0, 8);
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const api = `${address('app')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((each) => each.slug === ours.slug);
  if (business === undefined) throw new Error('Expected the scoring business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const tagName = `Scored ${suffix}`;
  const made = await page.request.post(`${api}/tags`, { headers, data: { name: tagName } });
  expect(made.status()).toBe(201);
  const tagId = ((await made.json()) as { id: string }).id;
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: 'Scored', lastName: suffix },
  });
  expect(created.status()).toBe(201);
  const scored = contact.parse(await created.json());

  // Settings → Manage Scoring: a rule in the draft, then published.
  await page.goto(inOurs('/settings/scoring'));
  await page.getByRole('button', { name: 'Add new rule', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add new rule', exact: true });
  await choose(dialog.getByRole('combobox', { name: 'Action', exact: true }), 'contact_tag');
  await choose(dialog.getByRole('combobox', { name: 'Tag', exact: true }), tagId);
  await dialog.getByRole('spinbutton', { name: 'Points', exact: true }).fill('5');
  const saving = page.waitForResponse(
    (response) =>
      response.url() === `${api}/scoring/rules` && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await saving;
  expect(response.status()).toBe(201);
  const rule = scoreRule.parse(await response.json());
  await expect(
    page.getByRole('rowheader', { name: `if a tag is added - ${tagName}`, exact: true }),
  ).toBeVisible();
  const publishing = page.waitForResponse((each) => each.url() === `${api}/scoring/publish`);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  expect((await publishing).status()).toBe(200);

  // The tag added through the API: the worker scores it, once.
  const tagged = await page.request.put(`${api}/records/${scored.id}/tags/${tagId}`, {
    headers,
    data: {},
  });
  expect(tagged.status()).toBe(200);
  const scoreNow = async () =>
    contactScore.parse(
      await (
        await page.request.get(`${api}/contacts/${scored.id}/engagement-score`, { headers })
      ).json(),
    ).score;
  await expect.poll(scoreNow, { timeout: 20_000 }).toBe(5);

  // The contact page's Contact Engagement Score: shown, and set by hand.
  await page.goto(inOurs(`/contacts/${scored.id}`));
  const section = page.getByRole('region', { name: 'Contact Engagement Score', exact: true });
  await section.getByRole('button', { name: 'Contact Engagement Score', exact: true }).click();
  await expect(section.getByTestId('engagement-score')).toHaveText('5');
  await section.getByRole('button', { name: 'Edit', exact: true }).click();
  await section.getByRole('spinbutton', { name: 'Engagement score', exact: true }).fill('9');
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.getByTestId('engagement-score')).toHaveText('9');
  expect(await scoreNow()).toBe(9);

  // The business's rules as they were: the rule deleted, and the draft published.
  expect((await page.request.delete(`${api}/scoring/rules/${rule.id}`, { headers })).status()).toBe(
    204,
  );
  const read = scoreProfile.parse(
    await (await page.request.get(`${api}/scoring`, { headers })).json(),
  );
  expect(
    (
      await page.request.post(`${api}/scoring/publish`, {
        headers,
        data: { revision: read.revision },
      })
    ).status(),
  ).toBe(200);
});
