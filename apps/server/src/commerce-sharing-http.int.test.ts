// Printing, sharing and sending through the production start, over real HTTP, on real
// Postgres with the real files service and the real shared limiter: a PDF downloaded from
// the signed-in API, a document's public address as a page of its own, a quote answered
// from that page, and an invoice emailed through the outbound queue.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  problem,
  salesDocument,
  salesDocumentLink,
  salesDocumentSend,
  type SalesDocument,
} from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { DOCUMENT_PAGE_POLICY } from '@repo/module-commerce';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { start, type Running } from './start.js';

const PUBLIC_URL = 'https://crm.example.test';

let database: TestDatabase;
let app: Running;
let root: string;
let business: Awaited<ReturnType<TestDatabase['fixtures']['business']>>;
let contact: { id: string };
const EMAIL = 'maya@example.test';

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  root = await mkdtemp(join(tmpdir(), 'crm-commerce-http-'));
  const agency = await database.fixtures.agency();
  business = await database.fixtures.business(agency.id, { name: 'Harbor Lights Events' });
  const user = await database.fixtures.user();
  contact = await database.fixtures.contact(business.context, {
    firstName: 'Maya',
    lastName: 'Thompson',
    email: EMAIL,
  });
  // A mailbox that sends conversations, the contact's consent to transactional email, and
  // no quiet hours: what the outbound pipeline asks before it takes an invoice.
  await database.as('crm_owner', async (sql) => {
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'mailbox.credentials', 1, decode(repeat('03', 32), 'hex'),
               decode(repeat('ef', 32), 'hex')) returning id`,
      [agency.id, business.id],
    );
    const account = await sql.one<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name)
       values ($1, 'email', 'Billing') returning id`,
      [business.id],
    );
    await sql.query(
      `insert into messaging.mailboxes
         (business_id, id, email_address, auth_method, smtp_host, smtp_port, smtp_security,
          smtp_username, secret_id)
       values ($1, $2, 'billing@harborlights.example', 'password', 'smtp.example.test', 465,
               'tls', 'billing', $3)`,
      [business.id, account.id, secret.id],
    );
    await sql.query(
      'insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)',
      [business.id],
    );
    await sql.query(
      `insert into messaging.consents
         (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'transactional', 'granted', 'user', 'system')`,
      [business.id, contact.id],
    );
  });
  const config: Config = {
    nodeEnv: 'test',
    role: 'app',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: undefined,
    databasePoolSize: 4,
    shutdownTimeoutMs: 2000,
    dashboardDir: undefined,
    // The API is called as one person of the business, who may do everything.
    devTenantContext: { agencyId: agency.id, businessId: business.id, userId: user.id },
    publicUrl: PUBLIC_URL,
    publicIntake: { secret: 'commerce-http-fixture-key-with-at-least-32-bytes' },
    authentication: undefined,
    mail: undefined,
    trustProxy: ['loopback'],
    files: {
      storage: { kind: 'local', directory: join(root, 'files') },
      maxBytes: 5 * 1024 * 1024,
      linkSecret: 'commerce-http-file-link-key-of-32-bytes-or-more',
    },
    vault: undefined,
  };
  app = await start(config, apiRoutes, []);
});
afterAll(async () => {
  await app.stop();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

const api = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> =>
  fetch(`${app.address}/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

let visitors = 0;
/** A visitor with an address of their own, as a proxy in front of the server names them. */
const visit = (
  method: 'GET' | 'POST',
  path: string,
  form?: { readonly contentType: string; readonly body: string },
): Promise<Response> =>
  fetch(`${app.address}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      'x-forwarded-for': `198.51.100.${String((visitors = (visitors % 250) + 1))}`,
      'user-agent': 'TestBrowser/1.0',
      ...(form === undefined ? {} : { 'content-type': form.contentType }),
    },
    ...(form === undefined ? {} : { body: form.body }),
  });

async function issued(kind: 'quote' | 'invoice'): Promise<SalesDocument> {
  const created = await api('POST', '/sales-documents', {
    kind,
    contactId: toPublicId('contact', contact.id),
    currency: 'KES',
    lines: [{ name: 'Wedding day coordination', quantity: '1', unitPrice: '1500.00' }],
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const draft = salesDocument.parse(await created.json());
  const answer = await api('POST', `/sales-documents/${draft.id}/issue`, {
    revision: draft.revision,
  });
  expect(answer.status, await answer.clone().text()).toBe(200);
  return salesDocument.parse(await answer.json());
}

const pathOf = (document: SalesDocument): string => {
  const url = document.publicLink?.url;
  if (url === undefined) throw new Error('The document has no public address.');
  expect(url.startsWith(`${PUBLIC_URL}/d/`)).toBe(true);
  return new URL(url).pathname;
};

it('downloads an invoice as a PDF from the signed-in API, named after its number', async () => {
  const invoice = await issued('invoice');
  const answer = await api('GET', `/sales-documents/${invoice.id}/pdf`);
  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('application/pdf');
  expect(answer.headers.get('content-disposition')).toBe(
    `attachment; filename="${invoice.number ?? ''}.pdf"; filename*=UTF-8''${invoice.number ?? ''}.pdf`,
  );
  expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
  expect(answer.headers.get('cache-control')).toBe('private, no-store');
  const bytes = Buffer.from(await answer.arrayBuffer());
  expect(answer.headers.get('content-length')).toBe(String(bytes.length));
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');

  // An id that names nothing is a problem document, as everywhere in the API.
  const missing = await api('GET', '/sales-documents/sdoc_01h455vb4pex5vsknk084sn02q/pdf');
  expect(missing.status).toBe(404);
  expect(problem.parse(await missing.json()).status).toBe(404);
});

it('serves a document’s public address as a page that runs nothing and is not indexed', async () => {
  const invoice = await issued('invoice');
  const path = pathOf(invoice);
  const page = await visit('GET', path);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(page.headers.get('content-security-policy')).toBe(DOCUMENT_PAGE_POLICY);
  expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(page.headers.get('referrer-policy')).toBe('no-referrer');
  expect(page.headers.get('x-content-type-options')).toBe('nosniff');
  const html = await page.text();
  expect(html).toContain(invoice.number ?? '');
  expect(html).toContain('KES 1,500.00');
  expect(html).toContain(`href="${path}/pdf"`);
  expect(html).not.toMatch(/<script/i);

  const pdf = await visit('GET', `${path}/pdf`);
  expect(pdf.status).toBe(200);
  expect(pdf.headers.get('content-type')).toBe('application/pdf');
  expect(pdf.headers.get('content-disposition')).toContain(
    `filename="${invoice.number ?? ''}.pdf"`,
  );
  expect(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 5)
      .toString(),
  ).toBe('%PDF-');

  // The business has no logo, so the page asks for none and there is none to give.
  expect(html).not.toContain('<img');
  expect((await visit('GET', `${path}/logo`)).status).toBe(410);
});

it('answers one plain page to an address that opens nothing, whatever the reason', async () => {
  const unknown = await visit('GET', `/d/${'A'.repeat(43)}`);
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get('content-security-policy')).toBe(DOCUMENT_PAGE_POLICY);
  const words = await unknown.text();
  expect(words).toContain('This document is no longer available.');
  for (const path of [
    '/d/short',
    `/d/${'A'.repeat(43)}/pdf`,
    `/d/${'A'.repeat(43)}/other`,
    '/d/',
  ]) {
    const answer = await visit('GET', path);
    expect(answer.status, path).toBe(404);
    expect(await answer.text()).toBe(words);
  }

  // A void invoice's address is gone, with the same words.
  const invoice = await issued('invoice');
  const path = pathOf(invoice);
  const voided = await api('POST', `/sales-documents/${invoice.id}/void`, {
    reason: 'Raised by mistake.',
  });
  expect(voided.status).toBe(200);
  const gone = await visit('GET', path);
  expect(gone.status).toBe(410);
  expect(await gone.text()).toBe(words);
  expect((await visit('GET', `${path}/pdf`)).status).toBe(410);
});

it('replaces an address on request: the old one stops, the new one opens', async () => {
  const invoice = await issued('invoice');
  const old = pathOf(invoice);
  const same = await api('POST', `/sales-documents/${invoice.id}/link`, {});
  expect(same.status).toBe(200);
  expect(salesDocumentLink.parse(await same.json())).toEqual(invoice.publicLink);
  const replaced = await api('POST', `/sales-documents/${invoice.id}/link`, { regenerate: true });
  const fresh = new URL(salesDocumentLink.parse(await replaced.json()).url).pathname;
  expect(fresh).not.toBe(old);
  expect((await visit('GET', old)).status).toBe(404);
  expect((await visit('GET', fresh)).status).toBe(200);
});

it('lets a quote’s customer accept it from the page, once, as themselves', async () => {
  const quote = await issued('quote');
  const path = pathOf(quote);
  const open = await (await visit('GET', path)).text();
  expect(open).toContain(`<form method="post" action="${path}/accept">`);

  // A browser posts the form as urlencoded text; the answer sends it back to the page.
  const post = (answer: string) =>
    visit('POST', `${path}/${answer}`, {
      contentType: 'application/x-www-form-urlencoded',
      body: '',
    });
  const accepted = await post('accept');
  expect(accepted.status).toBe(303);
  expect(accepted.headers.get('location')).toBe(path);
  const after = await (await visit('GET', path)).text();
  expect(after).toContain('This quote was accepted on');
  expect(after).not.toContain('<form');

  // The same press again changes nothing; the other answer is refused, in words.
  expect((await post('accept')).status).toBe(303);
  const late = await post('decline');
  expect(late.status).toBe(409);
  expect(late.headers.get('content-security-policy')).toBe(DOCUMENT_PAGE_POLICY);
  expect(await late.text()).toContain('This quote was already accepted.');
  // Nothing else can be posted to an address, in any form.
  expect((await post('void')).status).toBe(404);
  const json = await visit('POST', `${path}/decline`, {
    contentType: 'application/json',
    body: '{}',
  });
  expect(json.status).toBe(415);

  const read = await api('GET', `/sales-documents/${quote.id}`);
  expect(salesDocument.parse(await read.json()).status).toBe('accepted');
  const audit = await database.as('crm_owner', (sql) =>
    sql.query<{ actor_kind: string; actor_id: string; ip: string; events: number }>(
      `select actor_kind, actor_id, host(ip) as ip, cardinality(event_ids) as events
       from audit.commands
       where business_id = $1 and command = 'sales_document.accept' and outcome = 'ok'
       order by recorded_at, id`,
      [business.id],
    ),
  );
  // Audited as the contact, from the address the server saw, the event once.
  expect(audit.map((row) => [row.actor_kind, row.actor_id, row.events])).toEqual([
    ['contact', contact.id, 1],
    ['contact', contact.id, 0],
  ]);
  expect(audit[0]?.ip).toMatch(/^198\.51\.100\.\d+$/);
});

it('emails an invoice through the outbound queue, with its link and its PDF', async () => {
  const invoice = await issued('invoice');
  const answer = await api('POST', `/sales-documents/${invoice.id}/send`, {
    revision: invoice.revision,
  });
  expect(answer.status, await answer.clone().text()).toBe(200);
  const sent = salesDocumentSend.parse(await answer.json());
  expect(sent.document).toMatchObject({ sendCount: 1, revision: invoice.revision + 1 });
  expect(sent.message).toMatchObject({ to: EMAIL, status: 'queued', attachedPdf: true });

  const [message] = await database.as('crm_owner', (sql) =>
    sql.query<{
      body_text: string;
      purpose: string;
      lane: string;
      contact_id: string;
      files: number;
    }>(
      `select m.body_text, d.purpose, d.lane, v.contact_id,
              (select count(*)::int from messaging.message_attachments a
                 join files.files f on f.business_id = a.business_id and f.id = a.file_id
               where a.business_id = m.business_id and a.message_id = m.id
                 and f.content_type = 'application/pdf') as files
       from messaging.messages m
       join messaging.outbound_dispatch d on d.business_id = m.business_id and d.id = m.id
       join messaging.conversations v on v.business_id = m.business_id and v.id = m.conversation_id
       where m.business_id = $1 and m.idempotency_key like 'commerce:document:%'
       order by m.id desc limit 1`,
      [business.id],
    ),
  );
  expect(message).toMatchObject({
    purpose: 'transactional',
    lane: 'transactional',
    contact_id: contact.id,
    files: 1,
  });
  expect(message?.body_text).toContain(`View it online: ${invoice.publicLink?.url ?? 'none'}`);

  // The same request again is stale: nothing more is sent.
  const again = await api('POST', `/sales-documents/${invoice.id}/send`, {
    revision: invoice.revision,
  });
  expect(again.status).toBe(409);
  // A draft is refused with the contract's words unless it is issued in the same step.
  const created = await api('POST', '/sales-documents', {
    kind: 'invoice',
    contactId: toPublicId('contact', contact.id),
    currency: 'KES',
    lines: [{ name: 'Deposit', quantity: '1', unitPrice: '100.00' }],
  });
  const draft = salesDocument.parse(await created.json());
  const refused = await api('POST', `/sales-documents/${draft.id}/send`, {
    revision: draft.revision,
  });
  expect(refused.status).toBe(409);
  expect(problem.parse(await refused.json()).detail).toBe(
    'This invoice is a draft. Issue it first, or send it with issueIfDraft.',
  );
  // A suppressed address is refused where it was named.
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into messaging.suppressions (business_id, channel, address_normalized, reason)
       values ($1, 'email', $2, 'hard_bounce')`,
      [business.id, EMAIL],
    ),
  );
  const suppressed = await api('POST', `/sales-documents/${draft.id}/send`, {
    revision: draft.revision,
    issueIfDraft: true,
  });
  expect(suppressed.status).toBe(422);
  expect(problem.parse(await suppressed.json()).errors).toEqual([
    {
      path: '/to',
      code: 'suppressed',
      message:
        'This address is on the suppression list (mail to it bounced), so nothing is sent to it.',
    },
  ]);
});
