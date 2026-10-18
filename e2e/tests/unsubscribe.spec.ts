import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { address, ours } from '../servers.js';
import { query } from '../signing-in.js';

async function fixture() {
  const token = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(token).digest('hex');
  const email = `optout-${randomUUID()}@example.test`;
  const [row] = await query<{ contact_id: string }>(
    `
    with record as (
      insert into crm.records (business_id, kind, object_type_id)
      select b.id, 'contact', o.id from tenancy.businesses b
      join crm.object_types o on o.business_id=b.id and o.kind='contact'
      where b.slug=$1 returning business_id,id
    ), contact as (
      insert into crm.contacts (business_id,id,first_name,created_by_kind)
      select business_id,id,'Unsubscribe reader','system' from record returning business_id,id
    ), identity as (
      insert into crm.contact_identities (business_id,contact_id,kind,value,value_normalized)
      select business_id,id,'email',$2,$2 from contact returning business_id,id
    ), account as (
      insert into messaging.channel_accounts (business_id,channel,name)
      select business_id,'email','Unsubscribe fixture' from contact returning business_id,id
    ), conversation as (
      insert into messaging.conversations (business_id,contact_id)
      select business_id,id from contact returning business_id,id
    ), message as (
      insert into messaging.messages (business_id,conversation_id,channel,channel_account_id,direction,status,idempotency_key,author_kind,to_addresses)
      select v.business_id,v.id,'email',a.id,'outbound','sent',$3,'system',array[$2]::text[]
      from conversation v join account a on a.business_id=v.business_id returning business_id,id
    ), dispatch as (
      insert into messaging.outbound_dispatch (business_id,id,identity_id,purpose,lane,request_hash)
      select m.business_id,m.id,i.id,'marketing','campaign',$4
      from message m join identity i on i.business_id=m.business_id returning business_id,id
    ), link as (
      -- The link is a record of its own, naming the address the email went to.
      insert into messaging.unsubscribe_links (business_id,digest,address_normalized,message_id,contact_id)
      select d.business_id,$4,$2,d.id,c.id
      from dispatch d join contact c on c.business_id=d.business_id returning digest
    ), consent as (
      insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind)
      select business_id,id,'email','marketing','granted','user','system' from contact
    ) select contact.id as contact_id from contact,link`,
    [ours.slug, email, randomUUID(), digest],
  );
  if (row === undefined) throw new Error('Unsubscribe fixture has no contact.');
  const withdrawals = () =>
    query<{ status: string; purpose: string }>(
      "select status,purpose from messaging.consents where contact_id=$1 and status='withdrawn'",
      [row.contact_id],
    );
  return { url: `${address('app')}/unsubscribe/${token}`, email, withdrawals };
}

for (const width of [360, 1440]) {
  test(`anonymous unsubscribe confirmation works by keyboard at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    const f = await fixture();
    await page.setViewportSize({ width, height: 800 });
    const response = await page.goto(f.url);
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: 'Unsubscribe from marketing emails', exact: true }),
    ).toBeVisible();
    await page.reload();
    expect(await f.withdrawals()).toEqual([]);
    expect(await page.context().cookies()).toEqual([]);
    expect(await page.content()).not.toContain(f.email);
    const design = await page.evaluate(async () => {
      await document.fonts.ready;
      const main = document.querySelector('main');
      const button = document.querySelector('button');
      if (main === null || button === null) throw new Error('Confirmation controls are missing.');
      const card = getComputedStyle(main);
      const action = getComputedStyle(button);
      return {
        font: getComputedStyle(document.body).fontFamily,
        loadedFont: Array.from(document.fonts).some(
          (font) => font.family.includes('Lexend Variable') && font.status === 'loaded',
        ),
        background: getComputedStyle(document.body).backgroundColor,
        cardRadius: card.borderRadius,
        borders: [
          card.borderTopWidth,
          card.borderRightWidth,
          card.borderBottomWidth,
          card.borderLeftWidth,
        ],
        buttonColor: action.backgroundColor,
        buttonRadius: action.borderRadius,
        buttonHeight: button.getBoundingClientRect().height,
      };
    });
    expect(design.font).toContain('Lexend Variable');
    expect(design).toMatchObject({
      loadedFont: true,
      background: 'rgb(242, 245, 241)',
      cardRadius: '20px',
      borders: ['1px', '1px', '1px', '1px'],
      buttonColor: 'rgb(15, 122, 104)',
      buttonRadius: '999px',
    });
    expect(design.buttonHeight).toBeGreaterThanOrEqual(48);
    await page.screenshot({ path: testInfo.outputPath('confirmation.png'), fullPage: true });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Unsubscribe', exact: true })).toBeFocused();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'You are unsubscribed', exact: true }),
    ).toBeVisible();
    expect(await f.withdrawals()).toEqual([{ status: 'withdrawn', purpose: 'marketing' }]);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(new URL(page.url()).pathname).toBe(new URL(f.url).pathname);
    await page.goto(`${address('app')}/unsubscribe/bad-link`);
    await expect(
      page.getByRole('heading', { name: 'This link cannot be used', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unsubscribe', exact: true })).toHaveCount(0);
    expect(await f.withdrawals()).toHaveLength(1);
  });
}
