// External Tracking on the whole product: the "app" install (global-setup.ts), its built
// server, dashboard and tracking script, over a migrated Postgres. The team copies the script
// from Settings → External Tracking; the script goes on a website of the test's own, on
// another origin, beside a plain HTML form of the website's own. A visitor views two pages
// and sends the form: a contact is made from the form, the page views are linked to it, and
// the contact's activity says so. Troubleshoot lists what arrived. Nothing is stood in for.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { expect, test } from '@playwright/test';
import { contactList, me, trackingActivity } from '@repo/contracts';

import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.187'));

interface Website {
  readonly origin: string;
  close(): Promise<void>;
}

/** The business's own website: what it pasted on every page, and a form of its own. */
async function startWebsite(tag: string): Promise<Website> {
  const page = (title: string, body: string): string =>
    [
      '<!doctype html>',
      '<html lang="en">',
      `<head><meta charset="utf-8"><title>${title}</title></head>`,
      `<body><main><h1>${title}</h1>${body}</main>`,
      tag,
      '</body></html>',
    ].join('\n');
  const pages: Readonly<Record<string, string>> = {
    '/': page('Acme Roofing', '<a href="/contact?utm_source=google&utm_medium=cpc">Contact</a>'),
    '/contact': page(
      'Contact us',
      [
        '<form id="free-estimate" action="/thanks" method="get">',
        '<label for="n">Name</label><input id="n" name="your-name">',
        '<label for="e">Email</label><input id="e" name="email" type="email">',
        '<label for="m">Message</label><textarea id="m" name="message"></textarea>',
        '<input type="password" name="password">',
        '<button type="submit">Send</button>',
        '</form>',
      ].join(''),
    ),
    '/thanks': page('Thank you', '<p>We will be in touch.</p>'),
  };
  const server: Server = createServer((request, response) => {
    const body = pages[request.url?.split('?')[0] ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const where = server.address();
  if (where === null || typeof where === 'string') throw new Error('No port.');
  return {
    origin: `http://127.0.0.1:${String(where.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

test('a page view and a form fill on another website reach the contact’s timeline', async ({
  page,
  browser,
}) => {
  const person = await newPerson();
  const email = `visitor-${randomUUID().slice(0, 8)}@example.com`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const api = `${address('app')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((each) => each.slug === ours.slug);
  if (business === undefined) throw new Error('Expected the business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };

  // Settings → External Tracking → Installation: the script to paste.
  await page.goto(inOurs('/settings/external-tracking'));
  const code = page.getByRole('textbox', { name: 'Tracking script' });
  await expect(code).toHaveValue(/data-tracking-id="tk_[a-z0-9]{32}"/);
  const tag = await code.inputValue();
  const website = await startWebsite(tag);
  try {
    // A visitor on the website, in a browser of their own: one that adds no X-Forwarded-For
    // to the script's cross-origin requests, as no real visitor's does (README).
    const visitorContext = await browser.newContext({ extraHTTPHeaders: {} });
    const visitor = await visitorContext.newPage();
    const viewed = (path: string) =>
      visitor.waitForResponse(
        (response) =>
          response.url().endsWith('/events') &&
          (response.request().postDataJSON() as { pageUrl?: string } | null)?.pageUrl?.includes(
            path,
          ) === true,
      );
    const home = viewed(`${website.origin}/`);
    await visitor.goto(`${website.origin}/`);
    expect((await home).status()).toBe(200);
    const contactPage = viewed('/contact');
    await visitor.getByRole('link', { name: 'Contact' }).click();
    expect((await contactPage).status()).toBe(200);
    // A person takes a moment to fill a form: the server takes none sent sooner than 2 s.
    await visitor.waitForTimeout(2_500);
    await visitor.getByLabel('Name').fill('Pat Visitor');
    await visitor.getByLabel('Email').fill(email);
    await visitor.getByLabel('Message').fill('Our roof leaks.');
    // The form posts to the website's own /thanks: the browser leaves the page as the
    // script reports the form (keepalive), so its answer is read on the CRM's side below.
    await visitor.getByRole('button', { name: 'Send' }).click();
    await expect(visitor.getByRole('heading', { name: 'Thank you' })).toBeVisible();

    // The contact the form made, by its address.
    const found = async () =>
      contactList.parse(
        await (
          await page.request.get(`${api}/contacts?q=${encodeURIComponent(email)}`, { headers })
        ).json(),
      ).items;
    await expect.poll(async () => (await found()).length, { timeout: 15_000 }).toBe(1);
    const [made] = await found();
    if (made === undefined) throw new Error('No contact.');

    // Its timeline: the external form, and the page views before it.
    await page.goto(inOurs(`/contacts/${made.id}`));
    await expect(page.getByText('External form submitted').first()).toBeVisible();
    await expect(page.getByText('Earlier page visits linked').first()).toBeVisible();

    // Troubleshoot: both page views and the form, the form's linked to the contact.
    const activity = trackingActivity.parse(
      await (await page.request.get(`${api}/external-tracking/activity`, { headers })).json(),
    );
    const mine = activity.events.filter((event) => event.pageHost === '127.0.0.1');
    expect(mine.map((event) => [event.kind, event.pagePath, event.contactId])).toEqual(
      expect.arrayContaining([
        ['form_submission', '/contact', made.id],
        ['page_view', '/contact', made.id],
        ['page_view', '/', made.id],
      ]),
    );
    await page.goto(inOurs('/settings/external-tracking/troubleshoot'));
    await expect(page.getByText('Receiving events')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'free-estimate' }).first()).toBeVisible();
    await visitorContext.close();
  } finally {
    await website.close();
  }
});
