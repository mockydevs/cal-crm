// Payments: products, a quote written with its live paper, issued and turned into an
// invoice, a part payment with its receipt, and the settings; then printing, sharing and
// sending: the PDF, the link for the customer and the email to the contact. All against a
// stand-in for the API that answers as the server does and does the contract's own
// arithmetic.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { computeDocumentTotals, fromUnits, toUnits } from '@repo/contracts';
import { amina, fakePaymentsApi, frontDesk, productOf } from './payments-fixtures';
import { choose } from './select';
import { inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** An amount as the pages write it in shillings, worked out here apart from the pages. */
function kes(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  return `KES ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.slice(0, 2).padEnd(2, '0')}`;
}

const notice = (page: Page): Locator =>
  page.getByRole('main').locator('p[role="status"][aria-live="polite"]');
const tabs = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Payments', exact: true });
const line = (page: Page, number: number): Locator =>
  page.getByRole('group', { name: `Line ${String(number)}`, exact: true });

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`sells from a product to a receipt at ${String(width)}px`, async ({ page }, testInfo) => {
    test.slow();
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakePaymentsApi(page, {
      products: [productOf('Design hour', '2000.0000', { taxRate: '16.0000' })],
    });

    // Payments opens on Invoices, the first of its tabs.
    await page.goto(inHarbor('/payments'));
    await expect(page).toHaveURL(inHarbor('/payments/invoices'));
    await expect(page.getByRole('heading', { level: 1, name: 'Invoices' })).toBeVisible();
    await expect(page).toHaveTitle('Invoices · Harbor Lights Events');
    await expect(tabs(page).getByRole('link')).toHaveText([
      'Invoices',
      'Quotes',
      'Receipts',
      'Products',
      'Settings',
    ]);
    await expect(tabs(page).getByRole('link', { name: 'Invoices', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByText('No invoices yet.', { exact: false })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);

    // Products: one is added in the panel at the right.
    await tabs(page).getByRole('link', { name: 'Products', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
    const products = page.getByRole('region', { name: 'Products table', exact: true });
    await expect(products.getByRole('row').filter({ hasText: 'Design hour' })).toContainText(
      'KES 2,000.00',
    );
    const add = page.getByRole('button', { name: 'Add product', exact: true });
    await add.click();
    const adding = page.getByRole('dialog', { name: 'Add product', exact: true });
    await expect(adding.getByLabel('Currency', { exact: true })).toHaveValue('KES');
    await adding.getByLabel('Name', { exact: true }).fill('Site visit');
    await adding.getByLabel('Unit', { exact: true }).fill('visit');
    await adding.getByLabel('Rate', { exact: true }).fill('abc');
    await expectNoAccessibilityViolations(page);
    await adding.getByRole('button', { name: 'Add product', exact: true }).click();
    // The server's own words, under the box it refuses.
    await expect(adding.getByLabel('Rate', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(
      adding.getByText('Enter a nonnegative decimal amount with at most four decimal places.'),
    ).toBeVisible();
    await adding.getByLabel('Rate', { exact: true }).fill('1500');
    await adding.getByRole('button', { name: 'Add product', exact: true }).click();
    await expect(notice(page)).toHaveText('Site visit was added.');
    await expect(adding).toBeHidden();
    await expect(add).toBeFocused();
    const visit = products.getByRole('row').filter({ hasText: 'Site visit' });
    await expect(visit).toContainText('KES 1,500.00');
    await expect(visit).toContainText('Product');
    await expect(visit).toContainText('visit');
    await expect(visit).toContainText('Default');
    await expect(visit.getByRole('button', { name: 'Edit Site visit', exact: true })).toBeVisible();
    await expect(
      visit.getByRole('button', { name: 'Archive Site visit', exact: true }),
    ).toBeVisible();
    await expect(
      visit.getByRole('button', { name: 'Delete Site visit', exact: true }),
    ).toBeVisible();
    const visitId = api.products.find((each) => each.name === 'Site visit')?.id ?? '';
    expect(api.products.find((each) => each.id === visitId)).toMatchObject({
      unitPrice: '1500.0000',
      currency: 'KES',
      unit: 'visit',
      taxRate: null,
    });
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);

    await page.screenshot({ path: testInfo.outputPath('products.png'), fullPage: true });
    // A quote: two lines, a line discount, a document discount and tax.
    await page.goto(inHarbor('/payments/quotes'));
    await page.getByRole('link', { name: 'New quote', exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'New quote' })).toBeVisible();
    const save = page.getByRole('button', { name: 'Save draft', exact: true });
    await expect(save).toBeDisabled();
    await page.getByRole('searchbox', { name: 'Search for a contact' }).fill('Ami');
    await page.getByRole('button', { name: /Amina Otieno/ }).click();
    const paper = page.getByRole('article', { name: 'Quote as it is printed', exact: true });
    await expect(paper).toContainText('Amina Otieno');
    await expect(paper).toContainText('Harbor Lights Events');
    await expect(paper).toContainText('12 Harbour Road');
    await expect(paper).toContainText('Thank you for your business.');

    await choose(page.getByLabel('Add a product or service', { exact: true }), visitId);
    await expect(line(page, 1).getByLabel('Item', { exact: true })).toHaveValue('Site visit');
    await expect(line(page, 1).getByLabel('Unit price (KES)', { exact: true })).toHaveValue(
      '1500.00',
    );
    // A product with no rate of its own takes the default rate of the business.
    await expect(line(page, 1).getByLabel('Tax (%)', { exact: true })).toHaveValue('16');
    await line(page, 1).getByLabel('Quantity', { exact: true }).fill('2');
    await line(page, 1).getByLabel('Discount', { exact: true }).fill('10');
    await page.getByRole('button', { name: 'Add line', exact: true }).click();
    await line(page, 2).getByLabel('Item', { exact: true }).fill('Travel');
    await line(page, 2).getByLabel('Quantity', { exact: true }).fill('0');
    await line(page, 2).getByLabel('Unit price (KES)', { exact: true }).fill('800');
    // The contract's own words, as it is typed.
    await expect(
      line(page, 2).getByText('Enter a quantity above zero, with at most four decimal places.'),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    await line(page, 2).getByLabel('Quantity', { exact: true }).fill('1.5');
    await line(page, 2).getByLabel('Tax (%)', { exact: true }).fill('');
    await choose(
      page.getByLabel('Discount on the whole document is in', { exact: true }),
      'amount',
    );
    await page.getByLabel('Discount on the whole document', { exact: true }).fill('100');

    const worked = computeDocumentTotals({
      currency: 'KES',
      lines: [
        {
          quantity: '2',
          unitPrice: '1500.00',
          discount: { kind: 'percent', value: '10' },
          taxRate: '16',
        },
        { quantity: '1.5', unitPrice: '800', discount: null, taxRate: null },
      ],
      discount: { kind: 'amount', value: '100' },
    });
    if (!worked.ok) throw new Error('The numbers of the test cannot be worked out.');
    const { totals } = worked;
    const printed = paper.getByRole('region', { name: 'Totals', exact: true });
    await expect(printed).toContainText(`Subtotal${kes(totals.subtotal)}`);
    await expect(printed).toContainText(`Discounts−${kes(totals.discountTotal)}`);
    const taxed = totals.taxes.find((each) => each.rate === '16.0000');
    await expect(printed).toContainText(
      `Tax 16% on ${kes(taxed?.taxable ?? '')}${kes(taxed?.tax ?? '')}`,
    );
    await expect(printed).toContainText(`Total${kes(totals.total)}`);
    await expect(paper).toContainText('Site visit');
    await expect(paper).toContainText('Travel');
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);

    await page.screenshot({ path: testInfo.outputPath('quote-editor.png'), fullPage: true });
    await save.click();
    await expect(notice(page)).toHaveText('Draft saved.');
    await expect(page.getByRole('heading', { level: 1, name: 'Draft quote' })).toBeVisible();
    const quote = api.documents.find((each) => each.kind === 'quote');
    expect(quote?.totals).toMatchObject({
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
    });
    expect(quote?.contactId).toBe(amina.id);
    await expect(page).toHaveURL(inHarbor(`/payments/quotes/${quote?.id ?? ''}`));
    await expect(save).toBeDisabled();

    // Issuing says the number it will get, and that it is then no longer edited freely.
    await page.getByRole('button', { name: 'Issue', exact: true }).click();
    const issuing = page.getByRole('dialog', { name: 'Issue this quote?', exact: true });
    await expect(issuing).toContainText('It will be numbered QUO-0001 and marked as sent.');
    await expect(issuing).toContainText('can no longer be edited freely');
    await issuing.getByRole('button', { name: 'Issue', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Quote QUO-0001' })).toBeVisible();
    await expect(notice(page)).toHaveText('Issued as QUO-0001.');
    await expect(page.getByRole('form', { name: 'Quote details', exact: true })).toHaveCount(0);
    await expect(paper).toContainText('QUO-0001');
    await expect(paper).toContainText('Sent');
    await expect(paper).toContainText('Oct 12, 2026');
    // Thirty days of validity, from the settings.
    await expect(paper).toContainText('Nov 11, 2026');
    await expect(paper.getByRole('region', { name: 'Totals', exact: true })).toContainText(
      `Total${kes(totals.total)}`,
    );
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);

    // An invoice is made from it, once, as a draft with the same lines.
    await page.getByRole('button', { name: 'Convert to invoice', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Draft invoice' })).toBeVisible();
    await expect(notice(page)).toHaveText('This draft invoice was made from quote QUO-0001.');
    const invoice = api.documents.find((each) => each.kind === 'invoice');
    await expect(page).toHaveURL(inHarbor(`/payments/invoices/${invoice?.id ?? ''}`));
    await expect(line(page, 2).getByLabel('Item', { exact: true })).toHaveValue('Travel');
    await page.getByRole('button', { name: 'Issue', exact: true }).click();
    const billing = page.getByRole('dialog', { name: 'Issue this invoice?', exact: true });
    await expect(billing).toContainText('INV-0001');
    await billing.getByRole('button', { name: 'Issue', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice INV-0001' })).toBeVisible();
    const bill = page.getByRole('article', { name: 'Invoice as it is printed', exact: true });
    await expect(bill).toContainText('Paybill 123456');
    await expect(bill).toContainText(`Balance due${kes(totals.total)}`);

    await page.screenshot({ path: testInfo.outputPath('invoice-issued.png'), fullPage: true });
    // A part payment: never more than is owed, and the balance follows.
    const record = page.getByRole('button', { name: 'Record payment', exact: true });
    await record.click();
    const paying = page.getByRole('dialog', { name: 'Record payment', exact: true });
    const amount = paying.getByLabel('Amount (KES)', { exact: true });
    await expect(amount).toHaveValue(kes(totals.total).replace('KES ', '').replaceAll(',', ''));
    await expect(paying.getByLabel('Date received', { exact: true })).toHaveValue(
      /^\d{4}-\d\d-\d\d$/,
    );
    await amount.fill('999999');
    await expect(paying.getByText('This is more than is still owed on the invoice.')).toBeVisible();
    await expect(
      paying.getByRole('button', { name: 'Record payment', exact: true }),
    ).toBeDisabled();
    await amount.fill('1000');
    await choose(paying.getByLabel('Method', { exact: true }), 'mobile_money');
    await paying.getByLabel('Reference', { exact: true }).fill('QJ12ABC345');
    await expectNoAccessibilityViolations(page);
    await paying.getByRole('button', { name: 'Record payment', exact: true }).click();
    await expect(notice(page)).toHaveText('Payment recorded. Its receipt is RCT-0001.');
    await expect(paying).toBeHidden();
    const balance = fromUnits(toUnits(totals.total) - toUnits('1000'));
    await expect(bill).toContainText(`Paid${kes('1000.0000')}`);
    await expect(bill).toContainText(`Balance due${kes(balance)}`);
    await expect(bill).toContainText('Partly paid');
    const received = page.getByRole('region', { name: 'Payments', exact: true });
    await expect(received).toContainText('RCT-0001');
    await expect(received).toContainText('Mobile money');
    await expect(
      received.getByRole('button', { name: 'Reverse payment RCT-0001', exact: true }),
    ).toBeVisible();
    expect(api.payments[0]).toMatchObject({
      amount: '1000.0000',
      method: 'mobile_money',
      reference: 'QJ12ABC345',
      balanceAfter: balance,
    });
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);

    await page.screenshot({ path: testInfo.outputPath('invoice-part-paid.png'), fullPage: true });
    // The invoice in its list, and the payment among the receipts and as its own paper.
    await page.goto(inHarbor('/payments/invoices'));
    const invoices = page.getByRole('region', { name: 'Invoices table', exact: true });
    const billed = invoices.getByRole('row').filter({ hasText: 'INV-0001' });
    await expect(billed).toContainText('Amina Otieno');
    await expect(billed).toContainText(kes(totals.total));
    await expect(billed).toContainText(kes(balance));
    await expect(billed).toContainText('Partly paid');
    await page.getByRole('button', { name: 'Paid', exact: true }).click();
    await expect(page.getByText('No invoices match.', { exact: true })).toBeVisible();
    await expectNoSidewaysScroll(page);

    await page.goto(inHarbor('/payments/receipts'));
    const receipts = page.getByRole('region', { name: 'Receipts table', exact: true });
    const receiptRow = receipts.getByRole('row').filter({ hasText: 'RCT-0001' });
    await expect(receiptRow).toContainText('INV-0001');
    await expect(receiptRow).toContainText('Amina Otieno');
    await expect(receiptRow).toContainText('KES 1,000.00');
    await expect(receiptRow).toContainText('Received');
    await expectNoAccessibilityViolations(page);
    await receiptRow.getByRole('link', { name: 'RCT-0001', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Receipt RCT-0001' })).toBeVisible();
    const slip = page.getByRole('article', { name: 'Receipt as it is printed', exact: true });
    await expect(slip).toContainText('KES 1,000.00');
    await expect(slip).toContainText('QJ12ABC345');
    await expect(slip).toContainText('INV-0001');
    await expect(slip).toContainText(kes(balance));
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);

    await page.screenshot({ path: testInfo.outputPath('receipt.png'), fullPage: true });
    // Settings: the next number is shown as it will be printed, as it is typed.
    await tabs(page).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Payment settings' })).toBeVisible();
    const company = page.getByRole('region', { name: 'Company details and logo', exact: true });
    await expect(company).toContainText('Harbor Lights Events');
    await expect(company.getByRole('link', { name: 'Edit in Business Profile' })).toHaveAttribute(
      'href',
      inHarbor('/settings/business'),
    );
    const numbering = page.getByRole('group', { name: 'Invoices', exact: true });
    const next = page.getByRole('status', { name: 'Next number for Invoices', exact: true });
    // One invoice was issued, so the next is the second.
    await expect(next).toHaveText('INV-0002');
    await numbering.getByLabel('Prefix', { exact: true }).fill('2026/');
    await numbering.getByLabel('Next number', { exact: true }).fill('40');
    await expect(next).toHaveText('2026/0040');
    await numbering.getByLabel('Next number', { exact: true }).fill('x');
    await expect(next).toHaveText('—');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(numbering.getByText('Enter a whole number.', { exact: true })).toBeVisible();
    await numbering.getByLabel('Next number', { exact: true }).fill('40');
    await page.getByLabel('Payment terms (days)', { exact: true }).fill('7');
    await expectNoAccessibilityViolations(page);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(notice(page)).toHaveText('Settings saved.');
    await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true });
    expect(api.settings.numbering.invoice).toMatchObject({ prefix: '2026/', nextNumber: 40 });
    expect(api.settings.paymentTermsDays).toBe(7);
    await expect(next).toHaveText('2026/0040');
    await expectNoSidewaysScroll(page);
  });
}

test('starts an invoice for the contact its address names, and deletes the draft', async ({
  page,
}) => {
  const api = await fakePaymentsApi(page);
  await page.goto(inHarbor(`/payments/invoices/new?contact=${amina.id}`));
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
  const paper = page.getByRole('article', { name: 'Invoice as it is printed', exact: true });
  await expect(paper).toContainText('Amina Otieno');
  await expect(
    page.getByRole('button', { name: 'Choose another contact', exact: true }),
  ).toBeVisible();
  await line(page, 1).getByLabel('Item', { exact: true }).fill('Deposit');
  await line(page, 1).getByLabel('Unit price (KES)', { exact: true }).fill('5000');
  // Sixteen percent, the default rate of the business, on five thousand.
  await expect(paper.getByRole('region', { name: 'Totals', exact: true })).toContainText(
    'TotalKES 5,800.00',
  );
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(notice(page)).toHaveText('Draft saved.');
  expect(api.documents[0]).toMatchObject({ kind: 'invoice', contactId: amina.id });
  expect(api.documents[0]?.totals.total).toBe('5800.0000');
  await expectNoAccessibilityViolations(page);

  // A draft that was never issued has no number, and can be deleted.
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete draft', exact: true }).click();
  const deleting = page.getByRole('dialog', { name: 'Delete this draft?', exact: true });
  await deleting.getByRole('button', { name: 'Delete for good', exact: true }).click();
  await expect(page).toHaveURL(inHarbor('/payments/invoices'));
  await expect(page.getByText('No invoices yet.', { exact: false })).toBeVisible();
  expect(api.documents).toHaveLength(0);
});

test('shows what may be seen and offers nothing to someone who may only look', async ({ page }) => {
  await fakePaymentsApi(page, {
    canManage: false,
    products: [productOf('Design hour', '2000.0000')],
  });
  await page.goto(inHarbor('/payments/products'));
  await expect(
    page.getByRole('region', { name: 'Products table', exact: true }).getByRole('row'),
  ).toHaveCount(2);
  await expect(page.getByText('You can look at the products.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add product', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Edit|Archive|Delete) / })).toHaveCount(0);
  await page.goto(inHarbor('/payments/quotes'));
  await expect(page.getByText('No quotes yet.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New quote', exact: true })).toHaveCount(0);
  await page.goto(inHarbor('/payments/settings'));
  await expect(page.getByText('You can look at these settings.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Payment terms (days)', { exact: true })).toBeDisabled();
  await expectNoAccessibilityViolations(page);
});

test('says so to someone who may not see payments', async ({ page }) => {
  await fakePaymentsApi(page, { forbidden: true });
  for (const path of [
    '/payments/invoices',
    '/payments/quotes',
    '/payments/receipts',
    '/payments/settings',
  ]) {
    await page.goto(inHarbor(path));
    await expect(
      page.getByText("You don't have permission to see this business's payments.", { exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  await page.goto(inHarbor('/payments/orders'));
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
});

/** A draft invoice for Amina with one line, saved: five thousand and its sixteen percent. */
async function draftInvoice(page: Page): Promise<void> {
  await page.goto(inHarbor(`/payments/invoices/new?contact=${amina.id}`));
  await line(page, 1).getByLabel('Item', { exact: true }).fill('Deposit');
  await line(page, 1).getByLabel('Unit price (KES)', { exact: true }).fill('5000');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(notice(page)).toHaveText('Draft saved.');
}

/** The name the browser was asked to save the file under, when `press` starts a download. */
async function downloaded(page: Page, press: () => Promise<void>): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), press()]);
  return download.suggestedFilename();
}

for (const width of [1440, 360]) {
  test(`prints, shares and sends an invoice and its receipt at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    test.slow();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakePaymentsApi(page);
    await draftInvoice(page);
    const invoiceId = api.documents[0]?.id ?? '';

    // A draft is downloaded as a preview, under the name the server gives it.
    expect(
      await downloaded(page, () =>
        page.getByRole('button', { name: 'Download draft PDF', exact: true }).click(),
      ),
    ).toBe('invoice-draft.pdf');
    await expect(notice(page)).toHaveText('Downloaded invoice-draft.pdf.');

    // Sending a draft issues it, and only once the person says so. A contact with no
    // consent recorded is refused under To, with the way to the contact, and nothing is issued.
    api.mailRefusal = {
      path: '/to',
      code: 'consent_required',
      message:
        "No consent to transactional email is recorded for this contact. Record it on the contact's consent first.",
    };
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const sending = page.getByRole('dialog', { name: 'Issue and send this invoice', exact: true });
    const to = sending.getByRole('combobox', { name: 'To', exact: true });
    await expect(to).toContainText(amina.email);
    await expect(sending.getByRole('combobox', { name: 'From', exact: true })).toContainText(
      "The business's default mailbox",
    );
    await expect(sending.getByRole('checkbox', { name: 'Attach the PDF' })).toBeChecked();
    const issueAndSend = sending.getByRole('button', { name: 'Issue and send', exact: true });
    await expect(issueAndSend).toBeDisabled();
    await sending
      .getByRole('checkbox', { name: /^Issue this draft as INV-0001 and send it\./ })
      .check();
    await issueAndSend.click();
    const refusal = sending.getByRole('alert');
    await expect(refusal).toContainText(
      'This contact has not agreed to be emailed about their orders. Record their consent on the contact page first.',
    );
    await expect(refusal.getByRole('link', { name: 'Open the contact' })).toHaveAttribute(
      'href',
      inHarbor(`/contacts/${amina.id}`),
    );
    await expect(to).toHaveAttribute('aria-invalid', 'true');
    expect(api.documents[0]).toMatchObject({ status: 'draft', number: null });
    expect(api.emails).toHaveLength(0);
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath('send-refused.png'), fullPage: true });

    // With the consent recorded it is issued and sent in one step, with its PDF.
    api.mailRefusal = undefined;
    await issueAndSend.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice INV-0001' })).toBeVisible();
    await expect(sending).toBeHidden();
    await expect(notice(page)).toHaveText(`Sent to ${amina.email}.`);
    // The keyboard is on the page's Send button: the one that opened the dialog is gone.
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeFocused();
    const summary = page.getByText(/^Last sent Oct 12, 2026/);
    await expect(summary).toContainText('sent 1 time');
    expect(api.emails).toEqual([
      {
        of: invoiceId,
        to: amina.email,
        mailboxId: undefined,
        subject: undefined,
        message: undefined,
        attachedPdf: true,
      },
    ]);
    expect(api.sent.findLast((each) => each.call.endsWith('/send'))?.body).toMatchObject({
      to: amina.email,
      attachPdf: true,
      issueIfDraft: true,
    });

    // The link for the customer: copied, opened in a new tab, and replaced after a warning.
    const link = page.getByRole('region', { name: 'Link for the customer', exact: true });
    const first = api.documents[0]?.publicLink?.url ?? '';
    expect(first).toMatch(/^https:\/\/crm\.harborlights\.test\/d\/[A-Za-z0-9_-]{43}$/);
    await expect(link).toContainText(first);
    await link.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(notice(page)).toHaveText('Link copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);
    const opening = link.getByRole('link', { name: 'Open link in a new tab', exact: true });
    await expect(opening).toHaveAttribute('href', first);
    await expect(opening).toHaveAttribute('target', '_blank');
    await expect(opening).toHaveAttribute('rel', 'noopener noreferrer');
    await link.getByRole('button', { name: 'Link actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Make a new link', exact: true }).click();
    const replacing = page.getByRole('dialog', { name: 'Make a new link?', exact: true });
    await expect(replacing).toContainText('The link you have now stops working at once');
    await replacing.getByRole('button', { name: 'Make a new link', exact: true }).click();
    await expect(notice(page)).toHaveText('A new link was made. The old one no longer works.');
    const second = api.documents[0]?.publicLink?.url ?? '';
    expect(second).not.toBe(first);
    await expect(link).toContainText(second);
    await expect(link.getByRole('button', { name: 'Link actions', exact: true })).toBeFocused();

    // The issued invoice as a PDF, named after its number.
    expect(
      await downloaded(page, () =>
        page.getByRole('button', { name: 'Download PDF', exact: true }).click(),
      ),
    ).toBe('INV-0001.pdf');
    await expect(notice(page)).toHaveText('Downloaded INV-0001.pdf.');
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath('invoice-sent.png'), fullPage: true });

    // Sent again: to the contact's other address, from a named mailbox, with words of the
    // sender's own and no PDF; quiet hours hold it, and the page says so.
    api.quietHours = true;
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await send.click();
    const again = page.getByRole('dialog', { name: 'Send invoice INV-0001', exact: true });
    await expect(
      again.getByText('Leave it empty to use “Invoice INV-0001 from Harbor Lights Events”.'),
    ).toBeVisible();
    await choose(again.getByRole('combobox', { name: 'To', exact: true }), amina.otherEmail);
    await choose(again.getByRole('combobox', { name: 'From', exact: true }), frontDesk.id);
    await again.getByLabel('Subject', { exact: true }).fill('Your invoice from Harbor Lights');
    await again.getByLabel('Message (optional)', { exact: true }).fill('Thank you, Amina.');
    await again.getByRole('checkbox', { name: 'Attach the PDF' }).uncheck();
    await expectNoAccessibilityViolations(page);
    await again.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(notice(page)).toHaveText(
      `It will be sent to ${amina.otherEmail} after quiet hours, or when the mailbox's limit allows.`,
    );
    await expect(again).toBeHidden();
    await expect(send).toBeFocused();
    await expect(summary).toContainText('sent 2 times');
    expect(api.emails[1]).toEqual({
      of: invoiceId,
      to: amina.otherEmail,
      mailboxId: frontDesk.id,
      subject: 'Your invoice from Harbor Lights',
      message: 'Thank you, Amina.',
      attachedPdf: false,
    });
    api.quietHours = false;

    // The team's own note, which is never printed.
    const note = page.getByLabel('Internal note (never printed)', { exact: true });
    const saveNote = page.getByRole('button', { name: 'Save note', exact: true });
    await expect(saveNote).toBeDisabled();
    await note.fill('Call before delivering.');
    await saveNote.click();
    await expect(notice(page)).toHaveText('Note saved.');
    expect(api.documents[0]?.internalNote).toBe('Call before delivering.');
    await expect(
      page.getByRole('article', { name: 'Invoice as it is printed', exact: true }),
    ).not.toContainText('Call before delivering.');

    // A payment's receipt: downloaded and sent from its own page.
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    const paying = page.getByRole('dialog', { name: 'Record payment', exact: true });
    await paying.getByLabel('Amount (KES)', { exact: true }).fill('1000');
    await paying.getByRole('button', { name: 'Record payment', exact: true }).click();
    await expect(notice(page)).toHaveText('Payment recorded. Its receipt is RCT-0001.');
    await page
      .getByRole('region', { name: 'Payments', exact: true })
      .getByRole('link', { name: 'RCT-0001', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Receipt RCT-0001' })).toBeVisible();
    await expect(
      page.getByText('This receipt has not been sent to the customer yet.', { exact: true }),
    ).toBeVisible();
    expect(
      await downloaded(page, () =>
        page.getByRole('button', { name: 'Download PDF', exact: true }).click(),
      ),
    ).toBe('RCT-0001.pdf');
    await expect(notice(page)).toHaveText('Downloaded RCT-0001.pdf.');
    const sendReceipt = page.getByRole('button', { name: 'Send receipt', exact: true });
    await sendReceipt.click();
    const receiptDialog = page.getByRole('dialog', { name: 'Send receipt RCT-0001', exact: true });
    await expect(receiptDialog.getByRole('combobox', { name: 'To', exact: true })).toContainText(
      amina.email,
    );
    await expectNoAccessibilityViolations(page);
    await receiptDialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(notice(page)).toHaveText(`Sent to ${amina.email}.`);
    await expect(sendReceipt).toBeFocused();
    await expect(page.getByText(/^Last sent Oct 12, 2026/)).toContainText('sent 1 time');
    expect(api.emails[2]).toMatchObject({ of: api.payments[0]?.id, to: amina.email });
    expect(api.sent.findLast((each) => each.call.endsWith('/send'))?.body).toMatchObject({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath('receipt-sent.png'), fullPage: true });

    // In the lists a small button in each row downloads the same files.
    await page.goto(inHarbor('/payments/receipts'));
    expect(
      await downloaded(page, () =>
        page
          .getByRole('region', { name: 'Receipts table', exact: true })
          .getByRole('button', { name: 'Download RCT-0001 as a PDF', exact: true })
          .click(),
      ),
    ).toBe('RCT-0001.pdf');
    await expect(notice(page)).toHaveText('Downloaded RCT-0001.pdf.');
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);
    await page.goto(inHarbor('/payments/invoices'));
    expect(
      await downloaded(page, () =>
        page
          .getByRole('region', { name: 'Invoices table', exact: true })
          .getByRole('button', { name: 'Download INV-0001 as a PDF', exact: true })
          .click(),
      ),
    ).toBe('INV-0001.pdf');
    await expect(notice(page)).toHaveText('Downloaded INV-0001.pdf.');
    await expectNoAccessibilityViolations(page);
    await expectNoSidewaysScroll(page);
    expect(api.downloads).toEqual([
      'invoice-draft.pdf',
      'INV-0001.pdf',
      'RCT-0001.pdf',
      'RCT-0001.pdf',
      'INV-0001.pdf',
    ]);
  });
}

test('says why there is no link on an install that serves no public pages', async ({ page }) => {
  const api = await fakePaymentsApi(page, { publicPages: false });
  await draftInvoice(page);
  await page.getByRole('button', { name: 'Issue', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Issue this invoice?', exact: true })
    .getByRole('button', { name: 'Issue', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Invoice INV-0001' })).toBeVisible();
  await expect(page.getByText('Not sent yet. Issuing sends nothing by itself.')).toBeVisible();
  const link = page.getByRole('region', { name: 'Link for the customer', exact: true });
  await link.getByRole('button', { name: 'Create link', exact: true }).click();
  // The server's own sentence, where the button was.
  await expect(link).toContainText(
    'This install gives documents no public address: it needs PUBLIC_INTAKE_SECRET and a PUBLIC_URL.',
  );
  await expect(link.getByRole('button', { name: 'Create link', exact: true })).toHaveCount(0);
  expect(api.documents[0]?.publicLink ?? null).toBeNull();
  // It can still be sent, as its PDF.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Send invoice INV-0001', exact: true })
    .getByRole('button', { name: 'Send', exact: true })
    .click();
  await expect(notice(page)).toHaveText(`Sent to ${amina.email}.`);
  await expectNoAccessibilityViolations(page);
});

test('creates the link of a document that has none yet', async ({ page }) => {
  await fakePaymentsApi(page);
  await draftInvoice(page);
  await page.getByRole('button', { name: 'Issue', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Issue this invoice?', exact: true })
    .getByRole('button', { name: 'Issue', exact: true })
    .click();
  const link = page.getByRole('region', { name: 'Link for the customer', exact: true });
  await link.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(notice(page)).toHaveText('Link created.');
  await expect(link).toContainText('https://crm.harborlights.test/d/');
  await expect(link.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
});
