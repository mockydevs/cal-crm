// A document's public address on real Postgres: the address a document gets, what whoever
// holds it sees, what stops it, and a quote's customer accepting or declining as
// themselves, once.
import type { SalesDocument, SalesDocumentLink } from '@repo/contracts';
import { ConflictError } from '@repo/kernel';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';

import { NOW, refusalOf } from '../test/commerce-fixtures.js';
import {
  PUBLIC_URL,
  sharingSuite,
  tokenOf,
  type SharingFixture,
} from '../test/sharing-fixtures.js';
import { linkDigest } from './links.js';

const suite = sharingSuite();

const read = (f: SharingFixture, id: string): Promise<SalesDocument> =>
  suite.api(f, 'getSalesDocument', { params: { id } }) as Promise<SalesDocument>;
const link = (f: SharingFixture, id: string, regenerate = false): Promise<SalesDocumentLink> =>
  suite.api(f, 'createSalesDocumentLink', {
    params: { id },
    body: { regenerate },
  }) as Promise<SalesDocumentLink>;
const page = async (token: string) => suite.visitor.page(token, suite.request());
const html = async (token: string): Promise<string> => {
  const found = await page(token);
  if (found.outcome !== 'ok') throw new Error(`The address answered ${found.outcome}.`);
  return found.value;
};
const events = (f: SharingFixture, document: SalesDocument) =>
  suite.rows<{ type: string; actor_kind: string; actor_id: string | null }>(
    `select type, actor_kind, actor_id from events.events
     where business_id = $1 and subject_id = (
       select d.id from commerce.documents d where d.business_id = $1 and d.number = $2 and d.kind = $3)
     order by recorded_at, id`,
    [f.business.id, document.number, document.kind],
  );

describe('the address a document gets', () => {
  it('is there from the moment it is issued, and never before', async () => {
    const f = await suite.fixture();
    const draft = await suite.draft(f, 'invoice');
    expect(draft.publicLink).toBeNull();
    const refused = await refusalOf(() => link(f, draft.id), ConflictError);
    expect(refused.message).toBe('Issue this invoice first: a draft has no public address.');
    const invoice = (await suite.api(f, 'issueSalesDocument', {
      params: { id: draft.id },
      body: { revision: draft.revision },
    })) as SalesDocument;
    expect(invoice.publicLink?.url).toMatch(
      new RegExp(`^${PUBLIC_URL.replaceAll('.', String.raw`\.`)}/d/[A-Za-z0-9_-]{43}$`),
    );
    // Asking for it again gives the same address, and makes nothing.
    expect(await link(f, invoice.id)).toEqual(invoice.publicLink);
    expect((await read(f, invoice.id)).publicLink).toEqual(invoice.publicLink);
  });

  it('is kept only as the digest of its token', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const token = tokenOf(invoice.publicLink?.url);
    const stored = await suite.rows<Record<string, unknown>>(
      'select * from commerce.document_links where business_id = $1',
      [f.business.id],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.['digest']).toBe(linkDigest(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('is replaced on request: the old one stops at once, the new one works', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const old = tokenOf(invoice.publicLink?.url);
    expect((await page(old)).outcome).toBe('ok');
    const replaced = await link(f, invoice.id, true);
    const fresh = tokenOf(replaced.url);
    expect(fresh).not.toBe(old);
    expect((await page(old)).outcome).toBe('unknown');
    expect((await page(fresh)).outcome).toBe('ok');
    expect((await read(f, invoice.id)).publicLink).toEqual(replaced);
    // Only a new address is told of, and never by its address.
    const told = (await events(f, invoice)).filter(
      (event) => event.type === 'invoice.link_created',
    );
    expect(told).toHaveLength(1);
    const [payload] = await suite.rows<{ payload: unknown }>(
      "select payload from events.events where business_id = $1 and type = 'invoice.link_created'",
      [f.business.id],
    );
    expect(payload?.payload).toEqual({ number: invoice.number, replaced: true });
  });

  it('is made by someone who may manage payments only', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    await expect(
      suite.api(
        f,
        'createSalesDocumentLink',
        { params: { id: invoice.id }, body: {} },
        f.withPermissions('payments.read'),
      ),
    ).rejects.toThrow('payments.manage');
  });

  it('is not made where the install serves no public pages', async () => {
    const f = await suite.fixture();
    const without = suite.routesWith({ links: undefined });
    const draft = await suite.draft(f, 'invoice');
    const invoice = (await suite.api(
      f,
      'issueSalesDocument',
      { params: { id: draft.id }, body: { revision: draft.revision } },
      f.manager,
      without,
    )) as SalesDocument;
    expect(invoice.publicLink).toBeNull();
    const refused = await refusalOf(
      () =>
        suite.api(
          f,
          'createSalesDocumentLink',
          { params: { id: invoice.id }, body: {} },
          f.manager,
          without,
        ),
      ConflictError,
    );
    expect(refused.message).toContain('PUBLIC_INTAKE_SECRET');
  });

  it('is made again when the install’s secret changed, and the old one opens nothing', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const rotated = suite.routesWith({
      links: { secret: 'another-secret-of-thirty-two-bytes-or-more!', publicUrl: PUBLIC_URL },
    });
    const call = (operationId: string, body?: unknown) =>
      suite.api(f, operationId, { params: { id: invoice.id }, body }, f.manager, rotated);
    // Under the new secret the stored address cannot be written again, so none is shown.
    expect(((await call('getSalesDocument')) as SalesDocument).publicLink).toBeNull();
    const again = (await call('createSalesDocumentLink', {})) as SalesDocumentLink;
    expect(again.url).not.toBe(invoice.publicLink?.url);
    expect((await page(tokenOf(invoice.publicLink?.url))).outcome).toBe('unknown');
  });
});

describe('what an address shows', () => {
  it('shows the document as a page, with its PDF, and nothing of the team’s', async () => {
    const f = await suite.fixture({ logo: true });
    const invoice = await suite.issued(f, 'invoice');
    await suite.api(f, 'setSalesDocumentNote', {
      params: { id: invoice.id },
      body: { internalNote: 'Margin is thin on this one.' },
    });
    const token = tokenOf(invoice.publicLink?.url);
    const shown = await html(token);
    for (const words of [
      invoice.number ?? '',
      'Harbor Lights Events',
      'Maya Thompson',
      'Wedding day coordination',
      'KES 1,500.00',
      `href="/d/${token}/pdf"`,
      `src="/d/${token}/logo"`,
    ])
      expect(shown).toContain(words);
    expect(shown).not.toContain('Margin is thin');
    // An invoice is not answered.
    expect(shown).not.toContain('<form');

    const file = await suite.visitor.pdf(token, suite.request());
    if (file.outcome !== 'ok') throw new Error('No PDF.');
    expect(file.value.filename).toBe(`${invoice.number ?? ''}.pdf`);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(file.value.content)), {
      mergePages: true,
    });
    expect(text).toContain(invoice.number ?? '');
    expect(text).toContain('KES 1,500.00');
    expect(text).not.toContain('Margin is thin');

    const logo = await suite.visitor.logo(token, suite.request());
    if (logo.outcome !== 'ok') throw new Error('No logo.');
    expect(logo.value.contentType).toBe('image/png');
    const chunks: Buffer[] = [];
    for await (const chunk of logo.value.body) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).length).toBe(logo.value.size);
  });

  it('has no logo to show for a business without one', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const token = tokenOf(invoice.publicLink?.url);
    expect(await html(token)).not.toContain('<img');
    expect((await suite.visitor.logo(token, suite.request())).outcome).toBe('gone');
  });

  it('says a paid invoice is paid', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    await suite.api(f, 'recordPayment', {
      params: { id: invoice.id },
      body: { amount: '1500.00', method: 'cash' },
    });
    expect(await html(tokenOf(invoice.publicLink?.url))).toContain(
      'This invoice is paid. Thank you.',
    );
  });

  it('answers nothing to what is not an address of this install', async () => {
    const f = await suite.fixture();
    await suite.issued(f, 'invoice');
    for (const token of ['', 'short', 'A'.repeat(43), `${'A'.repeat(42)}/`, '../../etc/passwd']) {
      expect((await page(token)).outcome).toBe('unknown');
      expect((await suite.visitor.pdf(token, suite.request())).outcome).toBe('unknown');
      expect((await suite.visitor.logo(token, suite.request())).outcome).toBe('unknown');
      expect((await suite.visitor.answer(token, 'accept', suite.request())).outcome).toBe(
        'unknown',
      );
    }
  });
});

describe('what stops an address', () => {
  it('stops for a void invoice', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const token = tokenOf(invoice.publicLink?.url);
    const voided = (await suite.api(f, 'voidInvoice', {
      params: { id: invoice.id },
      body: { reason: 'Raised by mistake.' },
    })) as SalesDocument;
    expect(voided.publicLink).toBeNull();
    expect((await page(token)).outcome).toBe('gone');
    expect((await suite.visitor.pdf(token, suite.request())).outcome).toBe('gone');
    expect((await suite.visitor.logo(token, suite.request())).outcome).toBe('gone');
    expect((await suite.visitor.answer(token, 'accept', suite.request())).outcome).toBe('gone');
    const refused = await refusalOf(() => link(f, invoice.id), ConflictError);
    expect(refused.message).toBe('A void invoice has no public address.');
    expect(suite.visitor.unavailable()).toContain('This document is no longer available.');
  });

  it('stops while a document is back to a draft, and answers again once it is issued', async () => {
    const f = await suite.fixture();
    const quote = await suite.issued(f, 'quote');
    const token = tokenOf(quote.publicLink?.url);
    const revised = (await suite.api(f, 'reviseSalesDocument', {
      params: { id: quote.id },
    })) as SalesDocument;
    expect(revised.publicLink).toBeNull();
    expect((await page(token)).outcome).toBe('gone');
    const again = (await suite.api(f, 'issueSalesDocument', {
      params: { id: quote.id },
      body: { revision: revised.revision },
    })) as SalesDocument;
    // The same address, as every email already sent carries it.
    expect(again.publicLink).toEqual(quote.publicLink);
    expect((await page(token)).outcome).toBe('ok');
  });

  it('stops for a business that is no longer active', async () => {
    const f = await suite.fixture();
    const invoice = await suite.issued(f, 'invoice');
    const token = tokenOf(invoice.publicLink?.url);
    await suite.rows("update tenancy.businesses set status = 'suspended' where id = $1", [
      f.business.id,
    ]);
    expect((await page(token)).outcome).toBe('unknown');
  });
});

describe('a customer answering a quote', () => {
  it('accepts it as themselves, once, and the team sees who did', async () => {
    const f = await suite.fixture();
    const quote = await suite.issued(f, 'quote');
    const token = tokenOf(quote.publicLink?.url);
    const open = await html(token);
    expect(open).toContain(`action="/d/${token}/accept"`);
    expect(open).toContain(`action="/d/${token}/decline"`);

    const first = await suite.visitor.answer(token, 'accept', suite.request());
    expect(first).toMatchObject({ outcome: 'ok', value: { answered: true } });
    const accepted = await read(f, quote.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedAt).not.toBeNull();
    // The page now says so, and offers nothing more.
    const after = await html(token);
    expect(after).toContain('This quote was accepted on');
    expect(after).not.toContain('<form');

    // Pressing the button again changes nothing and still answers yes.
    const second = await suite.visitor.answer(token, 'accept', suite.request());
    expect(second).toMatchObject({ outcome: 'ok', value: { answered: true } });
    expect((await read(f, quote.id)).revision).toBe(accepted.revision);
    const told = await events(f, quote);
    expect(told.filter((event) => event.type === 'quote.accepted')).toEqual([
      { type: 'quote.accepted', actor_kind: 'contact', actor_id: f.contact.id },
    ]);

    // Audited as the contact, with where the answer came from; the second press too, with
    // nothing to show for it.
    const audit = await suite.rows<{
      actor_kind: string;
      actor_id: string;
      ip: string;
      user_agent: string;
      outcome: string;
      input: unknown;
      events: number;
    }>(
      `select actor_kind, actor_id, host(ip) as ip, user_agent, outcome, input,
              cardinality(event_ids) as events
       from audit.commands
       where business_id = $1 and command = 'sales_document.accept' order by recorded_at, id`,
      [f.business.id],
    );
    expect(audit).toEqual([
      {
        actor_kind: 'contact',
        actor_id: f.contact.id,
        ip: '203.0.113.7',
        user_agent: 'TestBrowser/1.0',
        outcome: 'ok',
        input: { id: quote.id, source: 'public_link' },
        events: 1,
      },
      {
        actor_kind: 'contact',
        actor_id: f.contact.id,
        ip: '203.0.113.7',
        user_agent: 'TestBrowser/1.0',
        outcome: 'ok',
        input: { id: quote.id, source: 'public_link' },
        events: 0,
      },
    ]);

    // Changing their mind afterwards is the team's to do: the page says what stands.
    const late = await suite.visitor.answer(token, 'decline', suite.request());
    expect(late).toMatchObject({ outcome: 'ok', value: { answered: false } });
    if (late.outcome === 'ok')
      expect(late.value.html).toContain('This quote was already accepted.');
    expect((await read(f, quote.id)).status).toBe('accepted');
  });

  it('declines it, and the timeline of the contact says so', async () => {
    const f = await suite.fixture();
    const quote = await suite.issued(f, 'quote');
    const token = tokenOf(quote.publicLink?.url);
    expect(await suite.visitor.answer(token, 'decline', suite.request())).toMatchObject({
      outcome: 'ok',
      value: { answered: true },
    });
    expect((await read(f, quote.id)).status).toBe('declined');
    expect(await html(token)).toContain('This quote was declined on');
    const timeline = await suite.rows<{ event_type: string }>(
      `select event_type from crm.timeline_entries
       where business_id = $1 and record_id = $2 and event_type = 'quote.declined'`,
      [f.business.id, f.contact.id],
    );
    expect(timeline).toHaveLength(1);
  });

  it('cannot answer once the quote has expired', async () => {
    const f = await suite.fixture();
    const quote = await suite.issued(f, 'quote');
    const token = tokenOf(quote.publicLink?.url);
    // Through the whole of its last day it can be answered, wherever the business is.
    const lastDay = Date.parse(`${quote.dueDate ?? ''}T10:00:00.000Z`);
    suite.at(new Date(lastDay).toISOString());
    try {
      expect(await html(token)).toContain(`action="/d/${token}/accept"`);
      // Two days on, its last day has gone by in every time zone.
      suite.at(new Date(lastDay + 2 * 86_400_000).toISOString());
      const expired = await html(token);
      expect(expired).toContain('This quote expired on');
      expect(expired).not.toContain('<form');
      const refused = await suite.visitor.answer(token, 'accept', suite.request());
      expect(refused).toMatchObject({ outcome: 'ok', value: { answered: false } });
      if (refused.outcome === 'ok')
        expect(refused.value.html).toContain('This quote has expired. Ask for a new one.');
      expect((await read(f, quote.id)).status).toBe('sent');
      const [audit] = await suite.rows<{ outcome: string; error_code: string }>(
        `select outcome, error_code from audit.commands
         where business_id = $1 and command = 'sales_document.accept'`,
        [f.business.id],
      );
      expect(audit).toEqual({ outcome: 'failed', error_code: 'conflict' });
    } finally {
      suite.at(NOW);
    }
  });

  it('cannot answer through an address that was replaced, nor answer an invoice', async () => {
    const f = await suite.fixture();
    const quote = await suite.issued(f, 'quote');
    const old = tokenOf(quote.publicLink?.url);
    await link(f, quote.id, true);
    expect((await suite.visitor.answer(old, 'accept', suite.request())).outcome).toBe('unknown');
    expect((await read(f, quote.id)).status).toBe('sent');

    const invoice = await suite.issued(f, 'invoice');
    const refused = await suite.visitor.answer(
      tokenOf(invoice.publicLink?.url),
      'accept',
      suite.request(),
    );
    expect(refused).toMatchObject({ outcome: 'ok', value: { answered: false } });
    if (refused.outcome === 'ok')
      expect(refused.value.html).toContain('Only a quote is accepted or declined.');
  });

  it('cannot answer a quote whose contact was deleted for good', async () => {
    const f = await suite.fixture();
    const quote = await suite.issued(f, 'quote');
    const token = tokenOf(quote.publicLink?.url);
    await suite.rows('delete from crm.records where business_id = $1 and id = $2', [
      f.business.id,
      f.contact.id,
    ]);
    expect((await read(f, quote.id)).contactId).toBeNull();
    // It still says who it was for, and offers no answer.
    const shown = await html(token);
    expect(shown).toContain('Maya Thompson');
    expect(shown).not.toContain('<form');
    const refused = await suite.visitor.answer(token, 'accept', suite.request());
    expect(refused).toMatchObject({ outcome: 'ok', value: { answered: false } });
    if (refused.outcome === 'ok')
      expect(refused.value.html).toContain('This quote can no longer be answered here.');
  });
});
