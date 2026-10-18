// Marketing → Emails → Campaigns in a browser, with the API answered by the test from
// fixtures shaped by the contract's own types (campaigns-fixtures.ts): a campaign made from
// a template, its subject and text edited in the popup editor, an audience of tags with who
// will not get it and why, a blocking check and its fix, a test, a schedule in batches with
// when it will finish, the campaign's page while it sends, pause, resume and cancel, and a
// member who may draft and not send. Accessibility is checked at a phone and at a desk, and
// each screen is photographed.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { ContactList, TagConfiguration } from '@repo/contracts';
import {
  audienceOf,
  calari,
  campaignMailboxAnswer,
  campaignOf,
  cancelCampaign,
  checksOf,
  createCampaign,
  createFolder,
  deleteCampaign,
  foldersOf,
  getOf,
  isRefusal,
  listOf,
  mailboxAnswer,
  moveCampaign,
  pauseCampaign,
  recipientsOf,
  recipientsUnderWay,
  removeFolder,
  resumeCampaign,
  scheduleCampaign,
  sendCampaign,
  sendingAnswer,
  sendTest,
  smartLists,
  startScheduled,
  statsOf,
  updateCampaign,
  updateFolder,
  updateSettings,
  worldOf,
  type CampaignsWorld,
} from './campaigns-fixtures';
import { tags } from './lead-sources-fixtures';
import { harbor, inHarbor, signedIn } from './session';
import { templateOf, templateServer } from './template-fixtures';

const SHOTS = 'reports/campaigns';

// The email's own frame is not gone into: it is sandboxed, so nothing can be run inside it
// (the checker would wait for an answer that cannot come), and what it holds is the email,
// not the dashboard. The frame itself is checked: it has a title.
const violations = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .options({ iframes: false })
      .setLegacyMode(true)
      .analyze()
  ).violations;
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const main = (page: Page): Locator => page.getByRole('main');

const noContacts: ContactList = { items: [], next: null, canManage: true };

/** Stands in for the API the campaign screens talk to: every write is parsed by the contract. */
async function campaignsApi(page: Page, world: CampaignsWorld): Promise<void> {
  const answer = async (route: Route, result: unknown, status = 200): Promise<void> => {
    if (isRefusal(result)) {
      await route.fulfill({
        status: result.status,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Refused', ...result }),
      });
      return;
    }
    if (result === null) await route.fulfill({ status: 204 });
    else await route.fulfill({ status, json: result });
  };
  const forbidden = { status: 403, detail: 'You may not manage mailboxes.' };
  await templateServer(page, world.templates);
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: tags satisfies TagConfiguration }),
  );
  await page.route(/\/api\/v1\/views\?/, (route) =>
    route.fulfill({ json: { canSave: true, items: smartLists } }),
  );
  await page.route(/\/api\/v1\/contacts\?/, (route) => route.fulfill({ json: noContacts }));
  await page.route('**/api/v1/mailboxes', (route) =>
    answer(
      route,
      world.canManageMailboxes ? { data: world.mailboxes.map(mailboxAnswer) } : forbidden,
    ),
  );
  // Whoever may write campaigns reads the mailboxes they may be sent from.
  await page.route('**/api/v1/email-campaign-mailboxes', (route) =>
    answer(
      route,
      world.canManage
        ? { items: world.mailboxes.map(campaignMailboxAnswer) }
        : { status: 403, detail: 'You may not write campaigns.' },
    ),
  );
  await page.route('**/api/v1/mailboxes/*/sending', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const mailbox = world.mailboxes.find((each) => each.id === id);
    return answer(route, mailbox === undefined ? forbidden : sendingAnswer(mailbox));
  });
  await page.route('**/api/v1/email-campaign-settings', (route) =>
    route.request().method() === 'PUT'
      ? answer(route, updateSettings(world, route.request().postDataJSON()))
      : answer(route, world.canManageMailboxes ? world.settings : forbidden),
  );
  await page.route(/\/api\/v1\/email-campaign-folders(?:\/.*)?$/, (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname
      .replace('/api/v1/email-campaign-folders', '')
      .slice(1);
    const method = request.method();
    if (id === '' && method === 'GET') return answer(route, foldersOf(world));
    if (id === '' && method === 'POST')
      return answer(route, createFolder(world, request.postDataJSON()), 201);
    if (method === 'PATCH') return answer(route, updateFolder(world, id, request.postDataJSON()));
    if (method === 'DELETE') return answer(route, removeFolder(world, id));
    return route.fulfill({ status: 405 });
  });
  await page.route(/\/api\/v1\/email-campaigns(?:[/?].*)?$/, (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const url = new URL(request.url());
    const [id = '', action = ''] = url.pathname
      .replace('/api/v1/email-campaigns', '')
      .split('/')
      .slice(1);
    const method = request.method();
    const body = (): unknown => request.postDataJSON();
    if (id === '')
      return method === 'POST'
        ? answer(route, createCampaign(world, body()), 201)
        : answer(route, listOf(world, url.searchParams));
    if (action === '') {
      if (method === 'PUT') return answer(route, updateCampaign(world, id, body()));
      if (method === 'DELETE') return answer(route, deleteCampaign(world, id));
      return answer(route, getOf(world, id));
    }
    switch (action) {
      case 'folder':
        return answer(route, moveCampaign(world, id, body()));
      case 'audience':
        return answer(route, audienceOf(world, id));
      case 'checks':
        return answer(route, checksOf(world, id));
      case 'test':
        return answer(route, sendTest(world, id, body()));
      case 'send':
        return answer(route, sendCampaign(world, id, body()));
      case 'schedule':
        return answer(route, scheduleCampaign(world, id, body()));
      case 'pause':
        return answer(route, pauseCampaign(world, id));
      case 'resume':
        return answer(route, resumeCampaign(world, id));
      case 'cancel':
        return answer(route, cancelCampaign(world, id));
      case 'recipients':
        return answer(route, recipientsOf(world, id, url.searchParams));
      case 'stats':
        return answer(route, statsOf(world, id));
      default:
        return route.fulfill({ status: 404 });
    }
  });
}

const pricing = templateOf({
  name: 'Pricing guide',
  subject: 'Your guide, {{contact.firstName}}',
  body: 'Hi {{contact.firstName}},\nHere is our pricing guide.',
});

const sectionOf = (page: Page, name: string): Locator => main(page).getByRole('region', { name });

/**
 * Goes to a place of an Emails library: the left panel on a wide screen, the list that
 * stands for it on a phone.
 */
async function showPlace(page: Page, width: number, panel: string, place: string): Promise<void> {
  if (width >= 1024) {
    await page
      .getByRole('navigation', { name: panel })
      .getByRole('button', { name: new RegExp(`^${place}`) })
      .click();
    return;
  }
  const list = main(page).getByRole('combobox', { name: panel });
  const label = await list
    .getByRole('option', { name: new RegExp(`^${place}`) })
    .first()
    .textContent();
  await list.selectOption({ label: label ?? place });
}

for (const width of [360, 1440]) {
  test.describe(`at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: width === 360 ? 780 : 900 } });

    test('a campaign from a template: written, tested, scheduled in batches, sent, paused, resumed and cancelled', async ({
      page,
    }) => {
      test.slow();
      const world = worldOf({ templates: [pricing] });
      await signedIn(page);
      await campaignsApi(page, world);

      // Marketing opens on Emails, and Emails on Campaigns, the first of its pages.
      await page.goto(inHarbor('/marketing'));
      await expect(page).toHaveURL(inHarbor('/marketing/emails/campaigns'));
      await expect(page.getByRole('heading', { level: 1, name: 'Email campaigns' })).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Emails', exact: true }).getByRole('link'),
      ).toHaveText(['Campaigns', 'Templates']);
      await expect(
        main(page).getByText('No campaigns yet. Send one email to many contacts, now or later.'),
      ).toBeVisible();
      // What a campaign needs is behind the mark beside the title.
      await page.getByRole('button', { name: 'About campaigns' }).click();
      await expect(
        page.getByText(/a mailbox switched on for campaigns that passes its setup checks/),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `list-empty-${String(width)}`);

      // New campaign, from a template: the page's one New button, then Campaign.
      await page.getByRole('button', { name: 'New campaign' }).first().click();
      await page.getByRole('menuitem', { name: /^Campaign/ }).click();
      const starting = page.getByRole('dialog', { name: 'New campaign' });
      await starting.getByLabel('Campaign name', { exact: true }).fill('Spring open day');
      await starting.getByRole('radio', { name: 'From a template' }).check();
      await starting.getByRole('button', { name: 'Template: Choose a template' }).click();
      await starting.getByRole('option', { name: /^Pricing guide/ }).click();
      expect(await violations(page)).toEqual([]);
      await shot(page, `new-campaign-${String(width)}`);
      await starting.getByRole('button', { name: 'Create campaign' }).click();

      // The editor: the template's subject and text were copied.
      await expect(page).toHaveURL(new RegExp(`${inHarbor('/marketing/emails/campaigns/')}camp_`));
      await expect(page.getByRole('heading', { level: 1, name: 'Spring open day' })).toBeVisible();
      const details = sectionOf(page, 'Details');
      const email = sectionOf(page, 'Email');
      const audience = sectionOf(page, 'Audience');
      const review = sectionOf(page, 'Review and send');
      await expect(details.getByLabel('Subject', { exact: true })).toHaveValue(
        'Your guide, {{contact.firstName}}',
      );
      const frame = email.frameLocator('iframe[title="The email as it is written"]');
      await expect(frame.getByText('Here is our pricing guide.')).toBeVisible();
      await expect(
        email.getByText(/a\s+standard unsubscribe line is added at its end when it is sent/),
      ).toBeVisible();

      // The subject and the text, edited in the popup editor.
      await email.getByRole('button', { name: 'Edit the email' }).click();
      const editor = page.getByRole('dialog', { name: 'Spring open day' });
      await editor
        .getByLabel('Subject', { exact: true })
        .fill('Come to our open day, {{contact.firstName}}');
      await editor
        .getByLabel('Message (plain text)', { exact: true })
        .fill('Hi {{contact.firstName}},\nDoors open at ten on Saturday.');
      await expect(editor.getByText(/A campaign email leaves as it is written here/)).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await shot(page, `popup-editor-${String(width)}`);
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor.getByText('Saved.')).toBeVisible();
      await editor.getByRole('button', { name: 'Close' }).click();
      await expect(details.getByLabel('Subject', { exact: true })).toHaveValue(
        'Come to our open day, {{contact.firstName}}',
      );
      await expect(frame.getByText('Doors open at ten on Saturday.')).toBeVisible();
      expect(world.campaigns[0]?.content).toEqual({
        format: 'text',
        text: 'Hi {{contact.firstName}},\nDoors open at ten on Saturday.',
      });

      // An audience of tags, and who will not get it.
      await audience.getByRole('radio', { name: 'Tags' }).check();
      await audience.getByRole('button', { name: 'Add tag' }).click();
      await page.getByRole('combobox', { name: 'Search tags' }).fill('vip');
      await page.getByRole('option', { name: 'VIP' }).click();
      await page.keyboard.press('Escape');
      await expect(audience.getByText('80 will receive it')).toBeVisible();
      await expect(audience.getByText('6 will not')).toBeVisible();
      const tagReasons = audience.getByRole('list', { name: 'Why some will not receive it' });
      await expect(tagReasons.getByRole('listitem')).toHaveCount(1);
      await expect(tagReasons.getByRole('listitem')).toContainText('No marketing consent');
      await expect(tagReasons.getByRole('listitem')).toContainText('Ada Okafor');
      expect(world.campaigns[0]?.audience).toMatchObject({ kind: 'tags', match: 'any' });

      // Everyone: every reason known before sending, each with what to do.
      await audience.getByRole('radio', { name: 'Everyone' }).check();
      await expect(audience.getByText('1,240 will receive it')).toBeVisible();
      await expect(audience.getByText('310 will not')).toBeVisible();
      const reasons = audience.getByRole('list', { name: 'Why some will not receive it' });
      await expect(reasons.getByRole('listitem')).toHaveCount(8);
      await expect(
        reasons.getByText('Only they can sign up again', { exact: false }),
      ).toBeVisible();
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `editor-audience-${String(width)}`);

      // A blocking check: no mailbox chosen. Send says why it is disabled.
      const checks = review.getByRole('list', { name: 'Checks before sending' });
      await expect(checks.getByText('Choose the mailbox to send from.')).toBeVisible();
      const send = review.getByRole('button', { name: 'Send or schedule' });
      await expect(send).toBeDisabled();
      await expect(review.locator('#campaign-send-block')).toHaveText(
        'Choose the mailbox to send from.',
      );
      expect(await violations(page)).toEqual([]);
      await shot(page, `editor-blocked-${String(width)}`);

      // Fixed: the mailbox switched on for campaigns is the only one offered.
      await checks.getByRole('button', { name: 'Go to Details' }).click();
      await expect(
        details.getByLabel('From mailbox', { exact: true }).locator('option'),
      ).toHaveText(['Choose a mailbox', 'Calari mailbox · hello@calari.example']);
      await details.getByLabel('From mailbox', { exact: true }).selectOption(calari.id);
      await expect(send).toBeEnabled();
      await expect(checks.getByText('Must be fixed before sending')).toHaveCount(0);
      await expect(
        checks.getByText(
          'At most 500 campaign emails can leave this mailbox in a day now, so this send will take about 3 days.',
        ),
      ).toBeVisible();
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `editor-ready-${String(width)}`);

      // A test, to me.
      await review.getByRole('button', { name: 'Send a test' }).click();
      const testing = page.getByRole('dialog', { name: 'Send a test' });
      await expect(testing.getByRole('checkbox', { name: /^To me \(/ })).toBeChecked();
      expect(await violations(page)).toEqual([]);
      await shot(page, `test-dialog-${String(width)}`);
      await testing.getByRole('button', { name: 'Send test' }).click();
      await expect(
        testing.getByText(/The test is on its way to dana@harborlights.example/),
      ).toBeVisible();
      expect(world.tests).toHaveLength(1);
      await testing.getByRole('button', { name: 'Done' }).click();

      // Scheduled, in batches, with when it will finish said before it is confirmed.
      await send.click();
      const sending = page.getByRole('dialog', { name: 'Send or schedule' });
      await expect(
        sending.getByText('About 3 days: at most 500 a day from Calari mailbox.'),
      ).toBeVisible();
      await sending.getByRole('radio', { name: 'Schedule for a date and time' }).check();
      await sending.getByLabel('Start sending at', { exact: true }).fill('2027-03-01T09:00');
      await sending.getByRole('checkbox', { name: 'Send in batches' }).check();
      await sending.getByLabel('Emails in a batch', { exact: true }).fill('500');
      await expect(
        sending.getByText(
          '3 batches; the last may start Mar 3, 2027, 9:00 AM. About 3 days: at most 500 a day from Calari mailbox.',
        ),
      ).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await shot(page, `send-dialog-${String(width)}`);
      await sending.getByRole('button', { name: 'Continue' }).click();
      const confirming = page.getByRole('dialog', { name: 'Confirm' });
      await expect(
        confirming.getByText(
          'Schedule “Spring open day” for 1,240 contacts from Calari mailbox, starting Mar 1, 2027, 9:00 AM?',
        ),
      ).toBeVisible();
      await expect(confirming.getByText('500 emails every day')).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await shot(page, `send-confirm-${String(width)}`);
      await confirming.getByRole('button', { name: 'Schedule campaign' }).click();

      // The campaign's page: scheduled, on the business's clock (Chicago: 15:00 UTC).
      await expect(main(page).getByText('Scheduled to start Mar 1, 2027, 9:00 AM')).toBeVisible();
      expect(world.campaigns[0]?.schedule).toEqual({
        sendAt: '2027-03-01T15:00:00.000Z',
        batches: { size: 500, every: 1, unit: 'days', window: null },
      });
      await expect(main(page).getByText('In batches: 500 emails every day.')).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await shot(page, `campaign-scheduled-${String(width)}`);

      // The time comes: it is sending.
      startScheduled(world, world.campaigns[0]?.id ?? '');
      await page.reload();
      await expect(main(page).getByText(/^Sending since /)).toBeVisible();
      await expect(
        main(page).getByText("Sending at the mailbox's pace: a few emails a minute."),
      ).toBeVisible();
      const numbers = sectionOf(page, 'Numbers');
      await expect(numbers.getByText('Hard bounced')).toBeVisible();
      await expect(numbers.getByText(/Opens and clicks are not tracked yet/)).toBeVisible();
      await expect(numbers.getByText(/Opened|Clicked|Delivered/)).toHaveCount(0);
      const recipients = sectionOf(page, 'Recipients');
      await expect(recipients.getByRole('link', { name: 'Grace Hall' })).toHaveAttribute(
        'href',
        /\/contacts\/con_/,
      );
      await expect(recipients.getByRole('row').filter({ hasText: 'Gus Moreno' })).toContainText(
        'Missing a merge value: {{contact.firstName}}',
      );
      await recipients.getByLabel('State', { exact: true }).selectOption('skipped');
      await expect(recipients.getByRole('row')).toHaveCount(3);
      await recipients.getByLabel('State', { exact: true }).selectOption('all');
      await expect(
        sectionOf(page, 'What was sent').getByText('Come to our open day, {{contact.firstName}}'),
      ).toBeVisible();
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `campaign-sending-${String(width)}`);

      // Pause, resume, cancel: each says what it really does.
      await main(page).getByRole('button', { name: 'Pause', exact: true }).click();
      const pausing = page.getByRole('dialog', { name: 'Pause this campaign?' });
      await expect(pausing.getByText(/Emails that have left stay sent/)).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await pausing.getByRole('button', { name: 'Pause sending' }).click();
      await expect(main(page).getByText('Paused by a person.')).toBeVisible();

      await main(page).getByRole('button', { name: 'Resume', exact: true }).click();
      const resuming = page.getByRole('dialog', { name: 'Resume this campaign?' });
      await expect(resuming.getByText(/Nobody is sent the campaign twice/)).toBeVisible();
      await resuming.getByRole('button', { name: 'Resume sending' }).click();
      await expect(main(page).getByText(/^Sending since /)).toBeVisible();

      await main(page).getByRole('button', { name: 'Cancel campaign' }).click();
      const cancelling = page.getByRole('dialog', { name: 'Cancel this campaign?' });
      await expect(cancelling.getByText(/stops for good and cannot be resumed/)).toBeVisible();
      await shot(page, `cancel-confirm-${String(width)}`);
      await cancelling.getByRole('button', { name: 'Cancel campaign' }).click();
      await expect(main(page).getByText('Cancelled', { exact: true }).first()).toBeVisible();
      await expect(main(page).getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
      await expect(numbers.getByText('Cancelled first')).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await shot(page, `campaign-cancelled-${String(width)}`);

      // Back in the list, the campaign is there with what became of it.
      await main(page).getByRole('link', { name: 'All campaigns' }).click();
      const row = main(page).getByRole('row').filter({ hasText: 'Spring open day' });
      await expect(row).toContainText('Cancelled');
      await expect(row).toContainText('Every contact');
      await expect(row).toContainText('2 of 1,550');
    });

    test('the list: statuses with their reasons, folders, the status filter and a draft deleted', async ({
      page,
    }) => {
      const world = worldOf({
        campaigns: [
          campaignOf(2, {
            name: 'October news',
            status: 'sending',
            subject: 'October at Calari',
            audience: { kind: 'all' },
            startedAt: '2026-10-14T14:00:00.000Z',
            counts: { audience: 1550, pending: 900, queued: 0, sent: 340, skipped: 310, failed: 0 },
            waiting: { reason: 'mailbox_daily_limit', until: '2026-10-15T05:00:00.000Z' },
          }),
          campaignOf(3, {
            name: 'Old list',
            status: 'paused',
            statusReason: 'bounce_rate',
            audience: { kind: 'smart_list', viewId: smartLists[0].id },
            startedAt: '2026-10-13T14:00:00.000Z',
            counts: { audience: 420, pending: 300, queued: 0, sent: 120, skipped: 0, failed: 0 },
          }),
          campaignOf(4, { name: 'Winter draft', subject: 'Winter is coming' }),
        ],
      });
      await signedIn(page);
      await campaignsApi(page, world);
      await page.goto(inHarbor('/marketing/emails/campaigns'));

      const rowOf = (name: string): Locator =>
        main(page).getByRole('row').filter({ hasText: name });
      await expect(rowOf('October news')).toContainText(
        "Waiting until Oct 15, 2026, 12:00 AM because the mailbox's daily limit is reached.",
      );
      await expect(rowOf('October news')).toContainText('340 of 1,550');
      await expect(rowOf('October news')).toContainText('Every contact');
      await expect(rowOf('Old list')).toContainText(
        'It paused itself: too many of its emails bounced.',
      );
      await expect(rowOf('Old list')).toContainText('Smart list: Newsletter readers');
      await expect(rowOf('Winter draft')).toContainText('Draft');
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `list-${String(width)}`);

      // A folder is made, a campaign moved into it, and the list narrowed to it.
      await main(page).getByRole('button', { name: 'New folder' }).click();
      const naming = page.getByRole('dialog', { name: 'New folder' });
      await naming.getByLabel('Folder name', { exact: true }).fill('Newsletters');
      expect(await violations(page)).toEqual([]);
      await naming.getByRole('button', { name: 'Save folder' }).click();
      // The new folder is shown, empty; the panel (a list on a phone) goes back to all.
      await expect(main(page).getByText('This folder is empty.')).toBeVisible();
      await showPlace(page, width, 'Campaign folders', 'All campaigns');
      await main(page).getByRole('button', { name: 'Actions for October news' }).click();
      expect(await violations(page)).toEqual([]);
      await page.getByRole('menuitem', { name: 'Move to folder' }).click();
      const moving = page.getByRole('dialog', { name: 'Move to folder' });
      await moving.getByLabel('Folder', { exact: true }).selectOption(world.folders[0]?.id ?? '');
      await moving.getByRole('button', { name: 'Move', exact: true }).click();
      await expect(moving).toHaveCount(0);
      await showPlace(page, width, 'Campaign folders', 'Newsletters');
      await expect(main(page).getByRole('row')).toHaveCount(2);
      await expect(rowOf('October news')).toBeVisible();
      await showPlace(page, width, 'Campaign folders', 'All campaigns');

      // The status filter.
      await main(page)
        .getByRole('combobox', { name: 'Status', exact: true })
        .selectOption('paused');
      await expect(main(page).getByRole('row')).toHaveCount(2);
      await expect(rowOf('Old list')).toBeVisible();
      await expect(page).toHaveURL(/status=paused/);
      await main(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('all');

      // A draft is deleted after asking; a campaign that started has no Delete.
      await main(page).getByRole('button', { name: 'Actions for Winter draft' }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      const deleting = page.getByRole('dialog', { name: 'Delete this draft?' });
      expect(await violations(page)).toEqual([]);
      await deleting.getByRole('button', { name: 'Delete draft' }).click();
      await expect(rowOf('Winter draft')).toHaveCount(0);
      await main(page).getByRole('button', { name: 'Actions for Old list' }).click();
      await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: 'Cancel campaign' })).toBeVisible();
    });

    test('a member who may draft and not send', async ({ page }) => {
      const draft = campaignOf(1, {
        name: 'Spring open day',
        mailboxId: calari.id,
        subject: 'Come to our open day',
        content: { format: 'text', text: 'Hello {{contact.firstName}}' },
        audience: { kind: 'all' },
      });
      const underWay = campaignOf(2, {
        name: 'October news',
        status: 'sending',
        mailboxId: calari.id,
        subject: 'October at Calari',
        content: { format: 'text', text: 'News' },
        audience: { kind: 'all' },
        startedAt: '2026-10-14T14:00:00.000Z',
        counts: { audience: 1550, pending: 1237, queued: 1, sent: 2, skipped: 310, failed: 0 },
      });
      const world = worldOf({
        campaigns: [underWay, draft],
        canSend: false,
        canManageMailboxes: false,
      });
      world.recipients[underWay.id] = recipientsUnderWay();
      await signedIn(page);
      await campaignsApi(page, world);

      await page.goto(inHarbor('/marketing/emails/campaigns'));
      await expect(main(page).getByRole('button', { name: 'New campaign' })).toBeVisible();
      await main(page).getByRole('button', { name: 'Actions for October news' }).click();
      await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Cancel campaign' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      await main(page).getByRole('link', { name: 'Spring open day', exact: true }).click();
      const review = sectionOf(page, 'Review and send');
      await expect(review.getByRole('button', { name: 'Send or schedule' })).toBeDisabled();
      await expect(review.getByText('Ask an owner or admin to send.')).toBeVisible();
      // Managing mailboxes is not theirs, and they still see and choose the From mailbox.
      const from = sectionOf(page, 'Details').getByLabel('From mailbox', { exact: true });
      await expect(from).toHaveValue(calari.id);
      await expect(from.getByRole('option')).toHaveText([
        'Choose a mailbox',
        `${calari.name} · ${calari.email}`,
      ]);
      // The member may still write, and it saves.
      await sectionOf(page, 'Details')
        .getByLabel('Subject', { exact: true })
        .fill('Come along on Saturday');
      await expect(main(page).getByText('All changes saved')).toBeVisible();
      expect(world.campaigns[1]?.subject).toBe('Come along on Saturday');
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `member-editor-${String(width)}`);

      // A test goes to themselves only.
      await review.getByRole('button', { name: 'Send a test' }).click();
      const testing = page.getByRole('dialog', { name: 'Send a test' });
      await expect(testing.getByLabel('Other addresses', { exact: true })).toBeDisabled();
      await expect(testing.getByText(/Your role can send a test to yourself only/)).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await testing.getByRole('button', { name: 'Send test' }).click();
      await expect(testing.getByText(/The test is on its way/)).toBeVisible();
      await testing.getByRole('button', { name: 'Done' }).click();

      // A campaign that is sending: the controls are there, disabled, with whom to ask.
      await main(page).getByRole('link', { name: 'All campaigns' }).click();
      await main(page).getByRole('link', { name: 'October news', exact: true }).click();
      await expect(main(page).getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
      await expect(main(page).getByRole('button', { name: 'Cancel campaign' })).toBeDisabled();
      await expect(
        main(page).getByText('Ask an owner or admin to pause, resume or cancel it.'),
      ).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await shot(page, `member-campaign-${String(width)}`);
    });

    test('Settings → Email Services holds the campaign ceiling', async ({ page }) => {
      // Two mailboxes: each one's setup is a section named after it, so the page's
      // landmarks stay unique.
      const world = worldOf();
      await signedIn(page);
      await campaignsApi(page, world);
      await page.route('**/api/v1/mailboxes/*/setup', (route) => route.fulfill({ json: null }));
      await page.goto(inHarbor('/settings/email'));
      const card = main(page).getByRole('region', { name: 'Campaign sending limit' });
      await expect(
        card.getByText(/Replies and workflow emails always leave first and are never held back/),
      ).toBeVisible();
      await card.getByLabel('Campaign emails a day', { exact: true }).fill('800');
      await card.getByRole('button', { name: 'Save limit' }).click();
      await expect(card.getByText('Campaign limit saved.')).toBeVisible();
      expect(world.settings.dailyLimit).toBe(800);
      await card.scrollIntoViewIfNeeded();
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `settings-limit-${String(width)}`);
    });
  });
}
