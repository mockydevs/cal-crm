// Reporting in a browser, with the API answered by the test from fixtures shaped as the
// contract says: the three tabs, the Appointment report's filters, the Attribution report's
// switch and tables, a custom report made from the template, changed in the builder, saved,
// reloaded, cloned and deleted, a save that finds the report changed elsewhere, what
// someone without the permissions sees, and a contact's Attribution group. Accessibility is
// checked at a phone and at a desk.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { ReportDefinition } from '@repo/contracts';
import { calendars } from './calendar-fixtures';
import { emptyContactPanels } from './contact-panels';
import { contactTouches, fakeReportingApi, pipelineTemplate, reportOf } from './reporting-fixtures';
import { choose } from './select';
import { inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';

const SHOTS = 'reports/reporting';

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

/** What reaches past the right edge of the window: nothing, on a page that fits it. */
const pastTheEdge = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document.documentElement.scrollWidth <= innerWidth
      ? []
      : [...document.querySelectorAll('body *')]
          .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 8)
          .map(
            (element) =>
              `${element.tagName.toLowerCase()}.${String(element.getAttribute('class')).slice(0, 60)} "${element.textContent.slice(0, 30)}"`,
          ),
  );

const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const widgetIds = (definition: ReportDefinition, page = 0): string[] =>
  definition.pages[page]?.widgets.map((widget) => widget.id) ?? [];

for (const width of [360, 1440]) {
  test.describe(`Reporting at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('has three tabs, each on real numbers', async ({ page }) => {
      await signedIn(page);
      await fakeReportingApi(page);
      await page.goto(inHarbor('/reports'));

      await expect(page.getByRole('heading', { level: 1, name: 'Reports overview' })).toBeVisible();
      await expect(page).toHaveTitle('Reports overview · Harbor Lights Events');
      const tabs = page.getByRole('navigation', { name: 'Reporting' });
      // Only the tabs with something real behind them: no ad reports, calls or audits yet.
      await expect(tabs.getByRole('link')).toHaveText([
        'Custom reports',
        'Attribution report',
        'Appointment report',
      ]);
      await expect(page.getByText('No reports yet. Make one from blank')).toBeVisible();
      // Schedules are not built: the list has no column for them.
      await expect(page.getByText('Schedule frequency')).toHaveCount(0);
      await expectAccessible(page);
      expect(await pastTheEdge(page)).toEqual([]);
      await shot(page, `${String(width)}-custom-reports-empty`);

      await tabs.getByRole('link', { name: 'Attribution report' }).click();
      await expect(page).toHaveURL(/\/reports\/attribution$/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Attribution report' }),
      ).toBeVisible();
      const totals = page.getByLabel('Totals');
      await expect(totals).toContainText('Leads4');
      // Each currency by itself, never added together.
      await expect(totals).toContainText('KES 125,000');
      await expect(totals).toContainText('USD 900.50');
      await expect(page.getByTestId('resolved-range')).toHaveText(
        "Sep 13, 2026 – Oct 12, 2026, in the business's time zone (Africa/Nairobi)",
      );
      await expect(page.getByRole('group', { name: 'Leads over time' })).toBeVisible();
      await expectAccessible(page);
      expect(await pastTheEdge(page)).toEqual([]);
      await shot(page, `${String(width)}-attribution-conversion`);

      await tabs.getByRole('link', { name: 'Appointment report' }).click();
      await expect(page).toHaveURL(/\/reports\/appointments$/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Appointment report' }),
      ).toBeVisible();
      const statuses = page.getByLabel('Appointments by status');
      await expect(statuses).toContainText('Booked4');
      await expect(statuses).toContainText('Confirmed2');
      await expect(statuses).toContainText('Showed2');
      await expect(statuses).toContainText('No Show1');
      // Cancelled covers invalid, as GoHighLevel counts them.
      await expect(statuses).toContainText('Cancelled2');
      await expect(statuses).toContainText('1 of them invalid');
      await expect(
        page.getByRole('list', { name: 'Appointments by channel' }).getByRole('listitem'),
      ).toHaveText(['Booking page655%', 'Team member436%', 'AI agent19.1%']);
      await expect(
        page.getByRole('list', { name: 'Top 5 users with appointments' }).getByRole('listitem'),
      ).toHaveText(['Dana Brooks8', 'Unassigned3']);
      // The server does not count reschedules yet: nothing is drawn for them.
      await expect(page.getByText(/reschedul/i)).toHaveCount(0);
      await expectAccessible(page);
      expect(await pastTheEdge(page)).toEqual([]);
      await shot(page, `${String(width)}-appointment-report`);
    });

    test('filters the Appointment report, and keeps the filters in the address', async ({
      page,
    }) => {
      await signedIn(page);
      const api = await fakeReportingApi(page);
      api.calendars = [...calendars];
      await page.goto(inHarbor('/reports/appointments'));
      await expect(page.getByLabel('Appointments by status')).toContainText('Booked4');
      expect(api.asked.at(-1)).toEqual({
        operation: 'getAppointmentOverview',
        query: { preset: 'last_30_days', dateProperty: 'starts', attribution: 'first' },
      });

      await page.getByRole('button', { name: 'By booking date' }).click();
      await expect(page).toHaveURL(/by=created/);
      await expect(page.getByText('11 appointments booked in these dates')).toBeVisible();
      expect(api.asked.at(-1)?.query).toMatchObject({ dateProperty: 'created' });

      const [first] = calendars;
      if (first === undefined) throw new Error('no calendar');
      await choose(page.getByLabel('Calendar', { exact: true }), first.id);
      await expect(page).toHaveURL(new RegExp(`calendar=${first.id}`));
      await expect.poll(() => api.asked.at(-1)?.query['calendarId']).toBe(first.id);

      await page
        .getByRole('group', { name: 'Which touch the source is read from' })
        .getByRole('button', { name: 'Latest' })
        .click();
      await expect.poll(() => api.asked.at(-1)?.query['attribution']).toBe('latest');

      await choose(page.getByLabel('Date range'), 'this_month');
      await expect.poll(() => api.asked.at(-1)?.query['preset']).toBe('this_month');

      // A custom range starts as the days that were showing, and is asked for once whole.
      await choose(page.getByLabel('Date range'), 'custom');
      await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-09-13');
      await expect(page.getByLabel('To', { exact: true })).toHaveValue('2026-10-12');
      await page.getByLabel('To', { exact: true }).fill('2026-09-01');
      await expect(page.getByRole('alert')).toHaveText(
        'End the range on or after the day it starts.',
      );
      await expectAccessible(page);
      await page.getByLabel('To', { exact: true }).fill('2026-09-30');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect
        .poll(() => api.asked.at(-1)?.query)
        .toEqual({
          from: '2026-09-13',
          to: '2026-09-30',
          dateProperty: 'created',
          attribution: 'latest',
          calendarId: first.id,
        });
      await expect(page.getByTestId('resolved-range')).toContainText('Sep 13, 2026 – Sep 30, 2026');

      // A reload opens the same report.
      await page.reload();
      await expect(page.getByLabel('To', { exact: true })).toHaveValue('2026-09-30');
      await expect(page.getByRole('button', { name: 'By booking date' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(await pastTheEdge(page)).toEqual([]);
      await shot(page, `${String(width)}-appointment-report-filtered`);
    });

    test('switches the Attribution report between first and latest, and shows its tables', async ({
      page,
    }) => {
      await signedIn(page);
      const api = await fakeReportingApi(page);
      await page.goto(inHarbor('/reports/attribution'));

      const bySource = page.getByRole('table', { name: 'Results by session source' });
      // The most leads first; "Others" has two by the first touch.
      await expect(bySource.getByRole('rowheader')).toHaveText(['Others', 'CRM UI']);
      await expect(bySource.getByRole('row', { name: /Others/ })).toContainText('2131KES 125,000');

      await page.getByRole('button', { name: 'Latest attribution' }).click();
      await expect(page).toHaveURL(/attribution=latest/);
      await expect.poll(() => api.asked.at(-1)?.query['attribution']).toBe('latest');
      // By the latest touch a lead moved: the numbers are not the same.
      await expect(bySource.getByRole('row', { name: /CRM UI/ })).toContainText('3110');
      await expect(bySource.getByRole('rowheader')).toHaveText(['CRM UI', 'Others']);

      // A chart's points are reached with the arrow keys and read out.
      const points = page.getByRole('group', { name: 'Leads over time' }).getByRole('listitem');
      await expect(points).toHaveCount(30);
      await points.first().focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(points.nth(3)).toBeFocused();
      await expect(points.nth(3)).toHaveAttribute('aria-label', 'Sep 16, 2026: 1');

      await page.getByRole('button', { name: 'Source report' }).click();
      await expect(page).toHaveURL(/view=source/);
      const campaigns = page.getByRole('table', { name: 'Results by campaign' });
      await expect(campaigns.getByRole('rowheader')).toHaveText([
        'fb_ad',
        'newsletter',
        'Not set',
        'OtherThe rest, added up',
      ]);
      await campaigns.getByRole('button', { name: 'UTM campaign' }).click();
      await expect(campaigns.getByRole('columnheader', { name: 'UTM campaign' })).toHaveAttribute(
        'aria-sort',
        'ascending',
      );
      // The row of the rest stays last, whatever the order.
      await expect(campaigns.getByRole('rowheader')).toHaveText([
        'Not set',
        'newsletter',
        'fb_ad',
        'OtherThe rest, added up',
      ]);
      await page.getByRole('searchbox', { name: 'Search campaigns' }).fill('news');
      await expect(campaigns.getByRole('rowheader')).toHaveText([
        'newsletter',
        'OtherThe rest, added up',
      ]);

      await expect(
        page.getByRole('table', { name: 'Leads by referrer' }).getByRole('rowheader'),
      ).toHaveText(['facebook.com', 'No referrer']);
      const touches = page.getByRole('table', { name: 'Latest touches' });
      await expect(touches.getByRole('row')).toHaveCount(3);
      // In the business's time zone: 09:15 UTC is 12:15 in Nairobi.
      await expect(touches.getByRole('rowheader').first()).toHaveText('Oct 11, 2026, 12:15 PM');
      await expect(touches.getByRole('link', { name: 'Maya Thompson' })).toHaveAttribute(
        'href',
        /\/contacts\/con_01h455vb4pex5vsknk084sn02q$/,
      );
      await page.getByRole('searchbox', { name: 'Search touches' }).fill('unnamed');
      await expect(touches.getByRole('row')).toHaveCount(2);
      await expect(page.getByText('Capture is still partial')).toBeVisible();
      await expectAccessible(page);
      expect(await pastTheEdge(page)).toEqual([]);
      await shot(page, `${String(width)}-attribution-source`);
    });

    test('shows a report, and its builder, on the grid', async ({ page }) => {
      await signedIn(page);
      const report = reportOf('Monthly review', { definition: pipelineTemplate.definition });
      const api = await fakeReportingApi(page, { reports: [report] });
      await page.goto(inHarbor(`/reports/${report.id}`));

      await expect(page.getByRole('heading', { level: 1, name: 'Monthly review' })).toBeVisible();
      const won = page.getByRole('region', { name: 'Won opportunities' });
      // The report compares with the period before: the number says which way it moved.
      await expect(won).toContainText('Opportunities');
      await expect(won).toContainText(/up from|down from|No change from/);
      await expect.poll(() => api.queries.length).toBeGreaterThanOrEqual(3);
      expect(api.queries.every((query) => query.compare === 'previous_period')).toBe(true);
      await expect(page.getByRole('list', { name: 'Funnel' }).getByRole('listitem')).toHaveCount(2);
      await expect(page.getByTestId('resolved-range')).toContainText('Africa/Nairobi');
      await expectAccessible(page);
      expect(await pastTheEdge(page)).toEqual([]);
      await shot(page, `${String(width)}-report-view`);

      // Other dates for a look, without changing the report.
      await choose(page.getByLabel('Report date range'), 'last_7_days');
      await expect(page.getByText('You are looking at other dates.')).toBeVisible();
      await expect
        .poll(() =>
          api.queries.some(
            (query) => 'preset' in query.range && query.range.preset === 'last_7_days',
          ),
        )
        .toBe(true);

      await page
        .getByRole('navigation', { name: 'Pages of the report' })
        .getByRole('button', { name: 'Attribution' })
        .click();
      await expect(page).toHaveURL(/page=2/);
      await expect(
        page.getByRole('group', { name: 'Leads over time' }).getByRole('listitem'),
      ).toHaveCount(7);
      await expect(
        page.getByRole('list', { name: 'Leads by session source' }).getByRole('listitem'),
      ).toHaveCount(3);
      await expectAccessible(page);
      expect(await pastTheEdge(page)).toEqual([]);
      await shot(page, `${String(width)}-report-view-page-2`);

      await page.getByRole('button', { name: 'Edit report' }).click();
      await expect(page).toHaveURL(/edit=true/);
      await expect(page.getByLabel('Report name')).toHaveValue('Monthly review');
      // Moving and resizing work from the keyboard.
      const later = page.getByRole('button', { name: 'Move Leads by session source later' });
      await later.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('status').filter({ hasText: 'Moved' })).toHaveText(
        'Moved Leads by session source to place 2 of 4.',
      );
      await page.getByRole('button', { name: 'More for Leads by session source' }).click();
      await page.getByRole('menuitem', { name: 'Wider' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'columns wide' })).toHaveText(
        'Leads by session source is now 7 columns wide and 4 rows tall.',
      );
      await expectAccessible(page);
      expect(await pastTheEdge(page)).toEqual([]);
      await shot(page, `${String(width)}-report-edit`);

      await page.getByRole('button', { name: 'Edit Leads over time' }).click();
      const settings = page.getByRole('dialog', { name: 'Widget settings' });
      await expect(settings.getByLabel('Title')).toHaveValue('Leads over time');
      await expect(
        settings.getByRole('group', { name: 'Leads over time' }).getByRole('listitem'),
      ).toHaveCount(7);
      await expectAccessible(page);
      await shot(page, `${String(width)}-widget-settings`);
      await settings.getByRole('button', { name: 'Done' }).click();
      await expect(page.getByRole('button', { name: 'Edit Leads over time' })).toBeFocused();

      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'saved' })).toHaveText(
        'Report saved.',
      );
      const saved = api.reports[0]?.definition;
      if (saved === undefined) throw new Error('nothing saved');
      expect(widgetIds(saved, 1)).toEqual([
        'won_by_source',
        'leads_by_source',
        'leads_over_time',
        'appointments_by_status',
      ]);
      expect(saved.pages[1]?.widgets[1]).toMatchObject({ w: 7, h: 4 });
    });
  });
}

test.describe('Custom reports at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('makes a report from the template, adds a filtered bar widget, saves, reloads, clones, renames and deletes', async ({
    page,
  }) => {
    await signedIn(page);
    const api = await fakeReportingApi(page);
    await page.goto(inHarbor('/reports'));

    await page.getByRole('button', { name: 'New report' }).click();
    const dialog = page.getByRole('dialog', { name: 'New report' });
    await expect(dialog.getByRole('radio', { name: 'Blank report' })).toBeChecked();
    await expect(
      dialog.getByText('Open, won and lost opportunities with their value'),
    ).toBeVisible();
    await expectAccessible(page);
    await shot(page, '1440-new-report');
    await dialog.getByRole('radio', { name: /Pipeline & Attribution Report/ }).check();
    await expect(dialog.getByLabel('Report name')).toHaveAttribute(
      'placeholder',
      'Pipeline & Attribution Report',
    );
    await dialog.getByRole('button', { name: 'Create report' }).click();
    expect(api.changes.at(-1)).toEqual({
      operation: 'createReport',
      input: { templateKey: 'pipeline_attribution' },
    });

    // It opens in the builder, on the template's first page.
    await expect(page).toHaveURL(/\/reports\/rpt_[0-9a-z]+\?edit=true$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Pipeline & Attribution Report' }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Open opportunities' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await page.getByRole('button', { name: 'Add widget' }).click();
    await page.getByRole('menuitem', { name: 'Bar', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Widget settings' });
    await settings.getByLabel('Title').fill('Leads by source');
    await choose(settings.getByLabel('Group by'), 'sessionSource');
    // Grouped by a touch, so which touch is asked.
    await expect(settings.getByLabel('Read from')).toBeVisible();
    await settings.getByRole('button', { name: 'Add condition', exact: true }).click();
    await choose(settings.getByLabel('Field of condition 1 of group 1'), 'type');
    // A choice takes only the operators of a choice.
    await settings.getByLabel('Operator of condition 1 of group 1').click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
      'Is any of',
      'Is none of',
      'Is empty',
      'Is not empty',
    ]);
    await page.keyboard.press('Escape');
    // With no value yet the widget is not sent: it says what is missing.
    await expect(settings.getByRole('alert')).toContainText('Give at least one value.');
    await choose(settings.getByLabel('Values of condition 1 of group 1'), ['lead']);
    const preview = settings.getByRole('region', { name: 'Preview of Leads by source' });
    await expect(preview.getByRole('group', { name: 'Leads by source' })).toBeVisible();
    await expect
      .poll(() => api.queries.at(-1))
      .toMatchObject({
        source: 'contacts',
        measures: ['count'],
        groupBy: ['sessionSource'],
        filters: {
          match: 'any',
          groups: [
            {
              match: 'all',
              conditions: [{ field: 'type', operator: 'any_of', values: ['lead'] }],
            },
          ],
        },
      });
    await expectAccessible(page);
    await shot(page, '1440-builder-bar-widget');
    await settings.getByRole('button', { name: 'Done' }).click();

    const added = page.getByRole('region', { name: 'Leads by source' });
    await expect(added.getByRole('group', { name: 'Leads by source' })).toBeVisible();
    // Narrowed by the condition: the stand-in counts one fewer in each group.
    // The template compares with the period before, so each group has both numbers.
    const bars = added.getByRole('list', { name: /^Values of Leads by source/ });
    await expect(bars.getByRole('listitem')).toHaveCount(3);
    await expect(bars.getByRole('listitem').nth(1)).toHaveAttribute(
      'aria-label',
      'CRM UI: Contacts 3; Contacts, period before 2',
    );

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'saved' })).toHaveText('Report saved.');
    const made = api.reports[0];
    if (made === undefined) throw new Error('no report');
    expect(api.changes.at(-1)).toMatchObject({
      operation: 'updateReport',
      input: { id: made.id, name: 'Pipeline & Attribution Report', revision: 1 },
    });
    expect(widgetIds(made.definition)).toEqual(['open', 'won', 'funnel', 'bar']);
    expect(made.revision).toBe(2);

    // Saved: a reload shows it, and leaving asks nothing.
    await page.reload();
    await expect(page.getByRole('region', { name: 'Leads by source' })).toBeVisible();
    await page.getByRole('button', { name: 'Done editing' }).click();
    await expect(page.getByRole('button', { name: 'Edit report' })).toBeVisible();

    await page.getByRole('button', { name: 'Clone' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Copy of Pipeline & Attribution Report' }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(made.id));
    await expect(page.getByRole('region', { name: 'Leads by source' })).toBeVisible();

    await page.getByRole('link', { name: 'Custom reports' }).first().click();
    const table = page.getByRole('table', { name: 'Custom reports' });
    await expect(table.getByRole('rowheader')).toHaveText([
      'Copy of Pipeline & Attribution Report',
      'Pipeline & Attribution Report',
    ]);
    // Made from a template, whoever pressed the button; the copy is its maker's.
    await expect(table.getByRole('row').nth(2)).toContainText('Template Library');
    await expect(table.getByRole('row').nth(1)).toContainText('Dana Brooks');
    await expectAccessible(page);
    await shot(page, '1440-custom-reports');

    await page
      .getByRole('button', { name: 'Actions for Copy of Pipeline & Attribution Report' })
      .click();
    await expect(page.getByRole('menuitem')).toHaveText(['Open', 'Rename', 'Clone', 'Delete']);
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename report' });
    await rename.getByLabel('Report name').fill('October review');
    await rename.getByRole('button', { name: 'Save' }).click();
    await expect(table.getByRole('rowheader').first()).toHaveText('October review');
    await expect(page.getByRole('button', { name: 'Actions for October review' })).toBeFocused();

    await page.getByRole('searchbox', { name: 'Search reports' }).fill('pipeline');
    await expect(table.getByRole('rowheader')).toHaveText(['Pipeline & Attribution Report']);
    await page.getByRole('searchbox', { name: 'Search reports' }).fill('');
    await expect(table.getByRole('rowheader')).toHaveCount(2);

    await page.getByRole('button', { name: 'Actions for October review' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this report?' });
    await expect(confirm).toContainText('"October review" will be gone from the list');
    await confirm.getByRole('button', { name: 'Delete report' }).click();
    await expect(table.getByRole('rowheader')).toHaveText(['Pipeline & Attribution Report']);
    // Deleted under the revision the list read: the rename had moved it to 2.
    expect(api.changes.at(-1)).toMatchObject({ operation: 'deleteReport', input: { revision: 2 } });
  });

  test('pages through the list by cursor', async ({ page }) => {
    await signedIn(page);
    const reports = Array.from({ length: 12 }, (_, index) =>
      reportOf(`Report ${String(index + 1).padStart(2, '0')}`),
    );
    await fakeReportingApi(page, { reports });
    await page.goto(inHarbor('/reports'));
    const table = page.getByRole('table', { name: 'Custom reports' });
    await expect(table.getByRole('rowheader')).toHaveCount(12);
    await page
      .getByRole('group', { name: 'Rows per page' })
      .getByRole('button', { name: '10' })
      .click();
    await expect(table.getByRole('rowheader')).toHaveCount(10);
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(table.getByRole('rowheader')).toHaveText(['Report 11', 'Report 12']);
    await expect(page.getByText('Page 2')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(table.getByRole('rowheader').first()).toHaveText('Report 01');
  });

  test('says a report changed elsewhere, and asks before unsaved changes are dropped', async ({
    page,
  }) => {
    await signedIn(page);
    const report = reportOf('Monthly review', { definition: pipelineTemplate.definition });
    const api = await fakeReportingApi(page, { reports: [report] });
    await page.goto(inHarbor(`/reports/${report.id}?edit=true`));
    await page.getByLabel('Report name').fill('Monthly review, mine');

    // Leaving with changes asks first, and staying keeps them.
    await page.getByRole('link', { name: 'Custom reports' }).first().click();
    const leave = page.getByRole('dialog', { name: 'Leave without saving?' });
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Report name')).toHaveValue('Monthly review, mine');

    api.conflictOnSave = true;
    await page.getByRole('button', { name: 'Save' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'changed somewhere else' });
    await expect(alert).toContainText('Your changes were not saved.');
    await expect(alert.getByRole('button')).toHaveText([
      'Reload saved version',
      'Save mine as a copy',
      'Keep editing',
    ]);
    await expectAccessible(page);
    await shot(page, '1440-report-changed-elsewhere');

    // Keep editing: nothing is lost, and nothing is saved over the other version.
    await alert.getByRole('button', { name: 'Keep editing' }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByLabel('Report name')).toHaveValue('Monthly review, mine');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(alert).toBeVisible();
    expect(api.reports[0]?.name).toBe('Monthly review (theirs)');

    await alert.getByRole('button', { name: 'Reload saved version' }).click();
    await expect(page.getByLabel('Report name')).toHaveValue('Monthly review (theirs)');
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    // The copy: mine, under a name of its own, and the other version untouched.
    await page.getByLabel('Report name').fill('Mine again');
    api.conflictOnSave = true;
    await page.getByRole('button', { name: 'Save' }).click();
    await alert.getByRole('button', { name: 'Save mine as a copy' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Copy of Mine again' })).toBeVisible();
    expect(api.changes.at(-1)).toMatchObject({
      operation: 'createReport',
      input: { name: 'Copy of Mine again' },
    });
    expect(api.reports.map((each) => each.name)).toEqual([
      'Copy of Mine again',
      'Monthly review (theirs) (theirs)',
    ]);
  });

  test('shows a server refusal at the widget it points to', async ({ page }) => {
    await signedIn(page);
    const report = reportOf('Monthly review', { definition: pipelineTemplate.definition });
    await fakeReportingApi(page, { reports: [report] });
    await page.route(`**/api/v1/reports/${report.id}`, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 422,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'about:blank',
              title: 'Unprocessable Content',
              status: 422,
              detail: 'The report cannot be saved as it is.',
              errors: [
                {
                  path: '/definition/pages/0/widgets/2/query/filters/groups/0/conditions/0/values/0',
                  code: 'unknown_reference',
                  message: 'Choose a pipeline of this business.',
                },
              ],
            }),
          })
        : route.fallback(),
    );
    await page.goto(inHarbor(`/reports/${report.id}?edit=true`));
    await page.getByLabel('Report name').fill('Monthly review 2');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('region', { name: 'Funnel' }).getByRole('alert')).toHaveText(
      'Choose a pipeline of this business.',
    );
    // A name the contract refuses is caught before anything is sent.
    await page.getByLabel('Report name').fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Name the report.')).toBeVisible();
  });

  test('shows each widget its own trouble', async ({ page }) => {
    await signedIn(page);
    const report = reportOf('Monthly review', { definition: pipelineTemplate.definition });
    const api = await fakeReportingApi(page, { reports: [report] });
    api.refuse = (query) =>
      query.source === 'opportunities' && query.groupBy.includes('stage')
        ? { status: 422, code: 'query_timeout' }
        : query.filters?.groups[0]?.conditions[0]?.values?.[0] === 'won'
          ? { status: 422, code: 'rate_limited' }
          : undefined;
    await page.goto(inHarbor(`/reports/${report.id}`));
    await expect(page.getByRole('region', { name: 'Funnel' }).getByRole('alert')).toContainText(
      'This query took too long. Narrow the dates, or group by less.',
    );
    await expect(
      page.getByRole('region', { name: 'Won opportunities' }).getByRole('alert'),
    ).toContainText('Too many requests just now. Wait a minute, then try again.');
    // The widget beside them is none the worse.
    await expect(page.getByRole('region', { name: 'Open opportunities' })).toContainText(
      'Opportunities',
    );
    await expectAccessible(page);
    await shot(page, '1440-report-widget-states');
  });
});

for (const width of [360, 1440]) {
  test.describe(`Reporting permissions at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('shows someone who may only view no way to change anything', async ({ page }) => {
      await signedIn(page);
      const report = reportOf('Monthly review', { definition: pipelineTemplate.definition });
      const api = await fakeReportingApi(page, { reports: [report], canManage: false });
      await page.goto(inHarbor('/reports'));
      const table = page.getByRole('table', { name: 'Custom reports' });
      await expect(table.getByRole('rowheader')).toHaveText(['Monthly review']);
      await expect(page.getByRole('button', { name: 'New report' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Actions for Monthly review' }).click();
      await expect(page.getByRole('menuitem')).toHaveText(['Open']);
      await page.getByRole('menuitem', { name: 'Open' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Monthly review' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Open opportunities' })).toBeVisible();
      for (const name of ['Edit report', 'Clone', 'Save', 'Add widget'])
        await expect(page.getByRole('button', { name })).toHaveCount(0);
      // The address alone does not open the builder.
      await page.goto(inHarbor(`/reports/${report.id}?edit=true`));
      await expect(page.getByRole('region', { name: 'Open opportunities' })).toBeVisible();
      await expect(page.getByLabel('Report name')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
      expect(api.changes).toEqual([]);
      await expectAccessible(page);
    });

    test('tells someone without the permission to view, plainly', async ({ page }) => {
      await signedIn(page);
      const report = reportOf('Monthly review');
      await fakeReportingApi(page, { reports: [report], canView: false });
      for (const path of [
        '/reports',
        '/reports/attribution',
        '/reports/appointments',
        `/reports/${report.id}`,
      ]) {
        await page.goto(inHarbor(path));
        await expect(
          page.getByRole('heading', { name: "You don't have access to Reporting" }),
        ).toBeVisible();
        await expect(page.getByText('An owner or an admin of this business')).toBeVisible();
        await expect(page.getByRole('table')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'New report' })).toHaveCount(0);
      }
      await expectAccessible(page);
      expect(await pastTheEdge(page)).toEqual([]);
      await shot(page, `${String(width)}-no-access`);
    });

    test('shows where a contact came from, on the contact', async ({ page }) => {
      const id = 'con_01m4bd188ff82s0add91b7pz63';
      const at = '2026-10-08T12:00:00.000Z';
      await signedIn(page);
      await emptyContactPanels(page);
      await page.route(`**/api/v1/contacts/${id}`, (route) =>
        route.fulfill({
          json: {
            id,
            firstName: 'Maya',
            lastName: 'Thompson',
            name: 'Maya Thompson',
            emails: ['maya@example.com'],
            phones: [],
            timeZone: null,
            doNotContact: false,
            preferencesRevision: 'a'.repeat(64),
            createdAt: at,
            updatedAt: at,
            trashedAt: null,
            canManage: true,
          },
        }),
      );
      await page.route(`**/api/v1/records/${id}/tags`, (route) =>
        route.fulfill({ json: { items: [], canManage: true } }),
      );
      await page.route('**/api/v1/tag-configuration', (route) =>
        route.fulfill({ json: configurationOf([]) }),
      );
      let touches = contactTouches;
      await page.route(`**/api/v1/contacts/${id}/attribution`, (route) =>
        route.fulfill({ json: touches }),
      );
      await page.goto(inHarbor(`/contacts/${id}`));

      const group = page.getByRole('group', { name: 'Attribution', exact: true });
      await expect(group.getByRole('button', { name: 'Attribution' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      const first = group.getByRole('group', { name: 'First attribution' });
      // The one name for how they arrived leads each touch.
      await expect(first).toContainText('Lead sourceFacebook Ads');
      await expect(first).toContainText('Session sourcePaid Social');
      await expect(first).toContainText('MediumForm');
      await expect(first).toContainText('UTM sourcefb_ad');
      await expect(first).toContainText('UTM campaignspring-open-day');
      await expect(first).toContainText('UTM contentvideo-a');
      await expect(first).toContainText('Referrerfacebook.com');
      await expect(first).toContainText('Landing pagehttps://harborlights.example/open-day');
      await expect(first).toContainText('Campaign ID120211');
      // Whose click id is held is named; the id itself is nowhere on the page.
      await expect(first).toContainText('Click ids heldMeta');
      await expect(page.getByText('fb-click-1')).toHaveCount(0);
      const latest = group.getByRole('group', { name: 'Latest attribution' });
      await expect(latest).toContainText('Lead sourceDirect');
      await expect(latest).toContainText('Session sourceDirect Traffic');
      await expect(latest).toContainText('MediumCalendar');
      // What a visit did not say is left out, not listed as empty rows.
      await expect(latest).not.toContainText('UTM source');
      await expect(latest).not.toContainText('Click ids held');
      await expectAccessible(page);
      expect(await pastTheEdge(page)).toEqual([]);
      await group.scrollIntoViewIfNeeded();
      await shot(page, `${String(width)}-contact-attribution`);

      // It folds, and the field search finds it by what it holds.
      await group.getByRole('button', { name: 'Attribution' }).click();
      await expect(first).toHaveCount(0);
      await group.getByRole('button', { name: 'Attribution' }).click();
      await page.getByRole('searchbox', { name: 'Search fields and folders' }).fill('utm camp');
      await expect(first).toBeVisible();
      await page.getByRole('searchbox', { name: 'Search fields and folders' }).fill('first name');
      await expect(group).toHaveCount(0);

      // One touch: said once. None: said plainly.
      touches = { first: contactTouches.first, latest: contactTouches.first };
      await page.reload();
      await expect(page.getByText('Latest attribution is the same')).toBeVisible();
      touches = { first: null, latest: null };
      await page.reload();
      await expect(page.getByText('No touch is recorded for this contact yet.')).toBeVisible();
      await expectAccessible(page);
    });
  });
}
