// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Receipt, SalesDocument } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SendDialog, { type SendTarget, type Sent } from './payments-send-dialog';
import { sendRefusalCodes, type SendRefusalCode } from './payments-rules';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params: Record<string, string>;
    children: ReactNode;
  }) => <a href={to.replaceAll(/\$(\w+)/g, (_, name: string) => params[name] ?? '')}>{children}</a>,
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const at = '2026-10-12T09:00:00.000Z';
const contactId = 'con_01h455vb4pex5vsknk084sn02q';
const customer = {
  name: 'Amina Otieno',
  email: 'amina@example.com',
  phone: null,
  billTo: '',
  taxNumber: null,
};
const seller = {
  name: 'Harbor Lights Events',
  address: null,
  taxNumber: null,
  logoFileId: null,
  paymentInstructions: '',
};

const invoice = (more: Partial<SalesDocument> = {}): SalesDocument => ({
  id: 'sdoc_invoice',
  kind: 'invoice',
  status: 'sent',
  number: 'INV-0007',
  contactId,
  dealId: null,
  quoteId: null,
  invoiceId: null,
  currency: 'KES',
  issueDate: '2026-10-12',
  dueDate: '2026-10-26',
  customer,
  seller,
  lines: [],
  discount: null,
  notes: '',
  terms: '',
  internalNote: '',
  totals: {
    subtotal: '5000.0000',
    lineDiscountTotal: '0.0000',
    documentDiscount: '0.0000',
    discountTotal: '0.0000',
    taxes: [],
    taxTotal: '0.0000',
    total: '5000.0000',
    amountPaid: '0.0000',
    balanceDue: '5000.0000',
  },
  overdue: false,
  expired: false,
  issuedAt: at,
  acceptedAt: null,
  declinedAt: null,
  voidedAt: null,
  voidReason: null,
  payments: [],
  actions: [],
  revision: 4,
  canManage: true,
  createdAt: at,
  updatedAt: at,
  ...more,
});

const receipt: Receipt = {
  id: 'pay_receipt',
  number: 'RCT-0003',
  invoiceId: 'sdoc_invoice',
  invoiceNumber: 'INV-0007',
  contactId,
  customerName: customer.name,
  amount: '1000.0000',
  currency: 'KES',
  paidOn: '2026-10-12',
  method: 'mobile_money',
  reference: null,
  note: '',
  balanceAfter: '4000.0000',
  status: 'recorded',
  reversedAt: null,
  reversalReason: null,
  createdAt: at,
  seller,
  customer,
  invoice: {
    id: 'sdoc_invoice',
    number: 'INV-0007',
    status: 'partly_paid',
    issueDate: '2026-10-12',
    dueDate: '2026-10-26',
    total: '5000.0000',
    amountPaid: '1000.0000',
    balanceDue: '4000.0000',
  },
  canManage: true,
};

const queued = (to: string, status: 'queued' | 'deferred' = 'queued') => ({
  id: 'msg_1',
  conversationId: 'conv_1',
  to,
  status,
  attachedPdf: true,
});

const refused = (status: number, more: object): ApiError =>
  new ApiError({ type: 'about:blank', title: 'Refused', status, ...more });

/** A server with the contact's addresses and one mailbox; `on` answers what a test cares about. */
function serve(
  on: (operation: string, input: unknown) => unknown = () => undefined,
  emails: string[] = ['billing@example.com', 'amina@example.com'],
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'getContact') return { id: contactId, emails };
    if (operation === 'getBusinessProfile') return { name: 'Harbor Lights Events' };
    if (operation === 'listMailboxes')
      return {
        data: [
          { id: 'mbx_front', name: 'Front desk', email: 'hello@harbor.test', status: 'active' },
          { id: 'mbx_news', name: 'News', email: 'news@harbor.test', status: 'active' },
          { id: 'mbx_old', name: 'Old', email: 'old@harbor.test', status: 'paused' },
        ],
      };
    if (operation === 'getMailboxSendingSettings')
      return {
        useForConversations: (input as { params: { id: string } }).params.id === 'mbx_front',
      };
    return undefined;
  };
}

interface Shown {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly onSent: ReturnType<typeof vi.fn<(sent: Sent) => void>>;
  readonly onConflict: ReturnType<typeof vi.fn<() => void>>;
  readonly onClose: ReturnType<typeof vi.fn<() => void>>;
}

function show(target: SendTarget): Shown {
  const onSent = vi.fn<(sent: Sent) => void>();
  const onConflict = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <SendDialog
          target={target}
          returnFocus={{ current: null }}
          onClose={onClose}
          onSent={onSent}
          onConflict={onConflict}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onSent, onConflict, onClose };
}

const ofInvoice = (more: Partial<SalesDocument> = {}): SendTarget => ({
  kind: 'document',
  document: invoice(more),
  nextNumber: 'INV-0008',
});
const bodyOf = (operation: string): unknown =>
  (
    server.calls.findLast((call) => call.operation === operation)?.input as
      { body: unknown } | undefined
  )?.body;
const sendButton = (name = 'Send'): HTMLElement => screen.getByRole('button', { name });
/** The button once the contact's addresses are read and it can be pressed. */
async function ready(name = 'Send'): Promise<HTMLElement> {
  await waitFor(() => {
    expect(sendButton(name)).toHaveProperty('disabled', false);
  });
  return sendButton(name);
}

describe('SendDialog', () => {
  it("sends an invoice to the customer's address with its PDF, leaving the rest to the server", async () => {
    serve((operation) =>
      operation === 'sendSalesDocument'
        ? { document: invoice({ revision: 5, sendCount: 1 }), message: queued('amina@example.com') }
        : undefined,
    );
    const { user, onSent } = show(ofInvoice());
    expect(screen.getByRole('dialog', { name: 'Send invoice INV-0007' })).toBeTruthy();
    // What the server would call it, as a hint and never as what is sent.
    expect(
      screen.getByText('Leave it empty to use “Invoice INV-0007 from Harbor Lights Events”.'),
    ).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Attach the PDF' })).toHaveProperty(
      'checked',
      true,
    );
    await user.click(await ready());
    await waitFor(() => {
      expect(onSent).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf('sendSalesDocument')).toEqual({
      to: 'amina@example.com',
      attachPdf: true,
      issueIfDraft: false,
      revision: 4,
    });
    expect(onSent.mock.calls[0]?.[0]).toMatchObject({
      to: 'amina@example.com',
      deferred: false,
      document: { revision: 5 },
    });
    // Only the mailbox that sends conversations was asked about and is offered.
    expect(
      server.calls.filter((call) => call.operation === 'getMailboxSendingSettings'),
    ).toHaveLength(2);
  });

  it('sends what was typed, without the PDF when it is unticked, and says when it is held', async () => {
    serve((operation) =>
      operation === 'sendSalesDocument'
        ? { document: invoice(), message: queued('amina@example.com', 'deferred') }
        : undefined,
    );
    const { user, onSent } = show(ofInvoice());
    await user.type(screen.getByLabelText('Subject'), 'Your invoice');
    await user.type(screen.getByLabelText('Message (optional)'), 'Thank you for your order.');
    await user.click(screen.getByRole('checkbox', { name: 'Attach the PDF' }));
    await user.click(await ready());
    await waitFor(() => {
      expect(onSent).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf('sendSalesDocument')).toEqual({
      to: 'amina@example.com',
      subject: 'Your invoice',
      message: 'Thank you for your order.',
      attachPdf: false,
      issueIfDraft: false,
      revision: 4,
    });
    expect(onSent.mock.calls[0]?.[0]).toMatchObject({ deferred: true });
  });

  const underTo: readonly [SendRefusalCode, string][] = [
    ['no_address', 'This contact has no email address. Add one on the contact page first.'],
    [
      'not_contacts_address',
      "This is not one of the contact's own email addresses. Add it on the contact page first.",
    ],
    ['contact_inactive', 'This contact is in the trash. Restore the contact first.'],
    [
      'do_not_contact',
      'This contact is marked do not contact, or has do not disturb on for email. Change that on the contact page before sending.',
    ],
    [
      'suppressed',
      "This address is on the suppression list, so nothing is sent to it. Choose another of the contact's addresses.",
    ],
    [
      'consent_withdrawn',
      'This contact withdrew their consent to email. Nothing is sent until they agree again and it is recorded on the contact page.',
    ],
    [
      'consent_required',
      'This contact has not agreed to be emailed about their orders. Record their consent on the contact page first.',
    ],
    [
      'timing_unknown',
      "Quiet hours are on and this contact has no time zone to keep them in. Set the contact's time zone on the contact page first.",
    ],
  ];
  const underFrom: readonly [SendRefusalCode, string][] = [
    [
      'no_mailbox',
      'There is no mailbox to send from. Connect one that sends conversations in Settings → Email Services, or choose another.',
    ],
    [
      'sender_inactive',
      'This mailbox, or the business, is not active. Choose another mailbox, or check it in Settings → Email Services.',
    ],
  ];

  it('has words for every code the server refuses a send with', () => {
    expect([...underTo, ...underFrom].map(([code]) => code).toSorted()).toEqual(
      [...sendRefusalCodes].toSorted(),
    );
  });

  it.each(underTo)('says %s under To, with the way to the contact', async (code, sentence) => {
    serve((operation) => {
      if (operation === 'sendSalesDocument')
        throw refused(422, {
          errors: [{ path: '/to', code, message: "The server's own words." }],
        });
      return undefined;
    });
    const { user, onSent, onConflict } = show(ofInvoice());
    await user.click(await ready());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(`${sentence} Open the contact`);
    expect(alert.querySelector('a')?.getAttribute('href')).toBe(`/b/harbor/contacts/${contactId}`);
    // It is tied to the box it is about.
    const to = screen.getByRole('combobox', { name: 'To' });
    expect(to.getAttribute('aria-describedby')).toBe(alert.id);
    expect(to.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onSent).not.toHaveBeenCalled();
    expect(onConflict).not.toHaveBeenCalled();
  });

  it.each(underFrom)(
    'says %s under From, with the way to Email Services',
    async (code, sentence) => {
      serve((operation) => {
        if (operation === 'sendSalesDocument')
          throw refused(422, {
            errors: [{ path: '/mailboxId', code, message: "The server's own words." }],
          });
        return undefined;
      });
      const { user } = show(ofInvoice());
      await user.click(await ready());
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(`${sentence} Open Email Services`);
      expect(alert.querySelector('a')?.getAttribute('href')).toBe('/b/harbor/settings/email');
      const from = screen.getByRole('combobox', { name: 'From' });
      expect(from.getAttribute('aria-describedby')).toBe(alert.id);
      expect(from.getAttribute('aria-invalid')).toBe('true');
    },
  );

  it("shows the server's own words for a code it has none for, and under the subject", async () => {
    serve((operation) => {
      if (operation === 'sendSalesDocument')
        throw refused(422, {
          errors: [
            { path: '/to', code: 'brand_new', message: 'A reason invented later.' },
            { path: '/subject', code: 'too_long', message: 'Use at most 200 characters.' },
          ],
        });
      return undefined;
    });
    const { user } = show(ofInvoice());
    await user.click(await ready());
    expect((await screen.findByText('A reason invented later.')).getAttribute('role')).toBe(
      'alert',
    );
    const subject = screen.getByLabelText('Subject');
    expect(subject.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use at most 200 characters.').id).toBe(
      subject.getAttribute('aria-describedby'),
    );
    // Typing in the box takes its refusal away, and leaves the other.
    await user.type(subject, 'Shorter');
    expect(screen.queryByText('Use at most 200 characters.')).toBeNull();
    expect(screen.getByText('A reason invented later.')).toBeTruthy();
  });

  it("shows a 409's sentence as the dialog's alert and has the page read the document again", async () => {
    serve((operation) => {
      if (operation === 'sendSalesDocument')
        throw refused(409, { detail: 'This install cannot send email.' });
      return undefined;
    });
    const { user, onConflict, onSent } = show(ofInvoice());
    await user.click(await ready());
    expect((await screen.findByRole('alert')).textContent).toBe('This install cannot send email.');
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onSent).not.toHaveBeenCalled();
  });

  it('says so when nothing came back from the server', async () => {
    serve((operation) => {
      if (operation === 'sendSalesDocument') throw new TypeError('Failed to fetch');
      return undefined;
    });
    const { user } = show(ofInvoice());
    await user.click(await ready());
    expect((await screen.findByRole('alert')).textContent).toBe(
      "It wasn't sent. Check your connection and try again.",
    );
  });

  it('issues a draft only once the person says so, with the number it will get', async () => {
    serve((operation) =>
      operation === 'sendSalesDocument'
        ? {
            document: invoice({ number: 'INV-0008', revision: 3 }),
            message: queued('amina@example.com'),
          }
        : undefined,
    );
    const { user, onSent } = show(
      ofInvoice({ status: 'draft', number: null, seller: null, issuedAt: null, revision: 2 }),
    );
    expect(screen.getByRole('dialog', { name: 'Issue and send this invoice' })).toBeTruthy();
    const confirm = screen.getByRole('checkbox', {
      name: 'Issue this draft as INV-0008 and send it. After that it can no longer be edited freely: to change it you revise it, and it keeps its number.',
    });
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'To' })).toHaveProperty('disabled', false);
    });
    // Until it is ticked nothing can be sent.
    expect(sendButton('Issue and send')).toHaveProperty('disabled', true);
    expect(server.calls.some((call) => call.operation === 'sendSalesDocument')).toBe(false);
    await user.click(confirm);
    await user.click(await ready('Issue and send'));
    await waitFor(() => {
      expect(onSent).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf('sendSalesDocument')).toEqual({
      to: 'amina@example.com',
      attachPdf: true,
      issueIfDraft: true,
      revision: 2,
    });
  });

  it('says a contact has no address before anything is sent', async () => {
    serve(() => undefined, []);
    show(ofInvoice());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'This contact has no email address. Add one on the contact page first. Open the contact',
    );
    expect(sendButton()).toHaveProperty('disabled', true);
    expect(screen.queryByRole('combobox', { name: 'To' })).toBeNull();
  });

  it('sends a receipt with one key for the attempt, and a new one once something is changed', async () => {
    let failures = 1;
    serve((operation) => {
      if (operation !== 'sendReceipt') return undefined;
      if (failures > 0) {
        failures -= 1;
        throw new TypeError('Failed to fetch');
      }
      return { receipt: { ...receipt, sendCount: 1 }, message: queued('amina@example.com') };
    });
    const { user, onSent } = show({ kind: 'receipt', receipt });
    expect(screen.getByRole('dialog', { name: 'Send receipt RCT-0003' })).toBeTruthy();
    expect(
      screen.getByText('Leave it empty to use “Receipt RCT-0003 from Harbor Lights Events”.'),
    ).toBeTruthy();
    await user.click(await ready());
    await screen.findByRole('alert');
    const first = bodyOf('sendReceipt') as { idempotencyKey: string };
    expect(first).toEqual({
      to: 'amina@example.com',
      attachPdf: true,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
    });
    // The same attempt again: the same key, so a send the server did take is not made twice.
    await user.click(await ready());
    await waitFor(() => {
      expect(onSent).toHaveBeenCalledTimes(1);
    });
    expect((bodyOf('sendReceipt') as { idempotencyKey: string }).idempotencyKey).toBe(
      first.idempotencyKey,
    );
    expect(onSent.mock.calls[0]?.[0]).toMatchObject({ to: 'amina@example.com', receipt });

    // Another message is another attempt.
    await user.type(screen.getByLabelText('Message (optional)'), 'Thank you.');
    await user.click(await ready());
    await waitFor(() => {
      expect(onSent).toHaveBeenCalledTimes(2);
    });
    const later = bodyOf('sendReceipt') as { idempotencyKey: string; message: string };
    expect(later.message).toBe('Thank you.');
    expect(later.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
