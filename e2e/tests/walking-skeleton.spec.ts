import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { tagList } from '@repo/contracts';

import { address, asClient, inOurs, owner } from '../servers.js';
import { askForSignInLink, emailTo, query } from '../signing-in.js';

test.use(asClient('203.0.113.10'));

/** The names in a listTags answer, checked against its contract. */
const tagNames = (body: unknown): string[] => tagList.parse(body).items.map((tag) => tag.name);

test('a tag made in Settings is saved, listed, and seen by no other business', async ({
  page,
  request,
}) => {
  const name = `Wedding ${randomUUID().slice(0, 8)}`;
  const meaning = 'Planning a wedding or rehearsal dinner.';

  await test.step('sign in as the owner, with a link emailed to them', async () => {
    await page.goto(inOurs('/settings'));
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fb%2Fharbor-lights-events%2Fsettings$/);
    await askForSignInLink(page, owner.email);
    await page.goto((await emailTo(owner.email)).link);
  });

  await test.step('create the tag in the dashboard', async () => {
    await page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name: 'Tags' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
    await page.getByRole('button', { name: 'New tag' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('What it means').fill(meaning);
    await page.getByRole('button', { name: 'Create tag' }).click();
  });

  await test.step('the dashboard lists it, and still does after a reload', async () => {
    const row = page
      .getByRole('region', { name: 'Tags' })
      .getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText(meaning);
    await page.reload();
    await expect(row).toContainText(meaning);
  });

  await test.step('the command recorded a tag.created event', async () => {
    const events = await query<{ type: string; subject_kind: string; actor_kind: string }>(
      `select type, subject_kind, actor_kind from events.events where payload ->> 'name' = $1`,
      [name],
    );
    expect(events).toEqual([{ type: 'tag.created', subject_kind: 'tag', actor_kind: 'user' }]);
  });

  await test.step("the worker ran the consumer: the day's count matches the day's tags", async () => {
    // Only the worker's count job writes the row. Both sides are read afresh on each try,
    // so tags other tests add to the same day can't leave the expected number behind.
    const theDay = () =>
      query<{ counted: number | null; tags: number }>(
        `select (select m.value::int from reporting.daily_metrics m
                 where m.business_id = mine.business_id and m.metric = 'crm.tags_created'
                   and m.day = mine.day) as counted,
                (select count(*)::int from events.events e
                 where e.business_id = mine.business_id and e.type = 'tag.created'
                   and (e.occurred_at at time zone mine.timezone)::date = mine.day) as tags
         from (select e.business_id, b.timezone,
                      (e.occurred_at at time zone b.timezone)::date as day
               from events.events e join tenancy.businesses b on b.id = e.business_id
               where e.type = 'tag.created' and e.payload ->> 'name' = $1) as mine`,
        [name],
      );
    await expect
      .poll(
        async () => {
          const [day] = await theDay();
          return day !== undefined && day.counted === day.tags;
        },
        { message: "the day's crm.tags_created should equal its tag.created events" },
      )
      .toBe(true);
  });

  await test.step("the business's API lists it to the owner, and to nobody signed out", async () => {
    const ours = await page.request.get(`${address('app')}/api/v1/tags`);
    expect(ours.status()).toBe(200);
    expect(tagNames(await ours.json())).toContain(name);

    const signedOut = await request.get(`${address('app')}/api/v1/tags`);
    expect(signedOut.status()).toBe(401);
  });

  await test.step("another business's API doesn't list it", async () => {
    const theirs = await request.get(`${address('otherBusiness')}/api/v1/tags`);
    expect(theirs.status()).toBe(200);
    expect(tagNames(await theirs.json())).not.toContain(name);
  });
});
