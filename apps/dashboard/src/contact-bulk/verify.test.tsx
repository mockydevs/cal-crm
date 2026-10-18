// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { ContactEmailCheckPreview } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { bulkActionOf } from '../../e2e/contact-bulk-fixtures';
import { emailCheckPreviewOf } from '../../e2e/email-verification-fixtures';
import VerifyDialog from './verify';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

let preview: ContactEmailCheckPreview | Error;
beforeEach(() => {
  server.calls.length = 0;
  preview = emailCheckPreviewOf();
  server.answer = (operation) => {
    if (operation === 'bulkUpdateContacts')
      return bulkActionOf(4, { action: 'verify_emails', status: 'queued' });
    if (preview instanceof Error) throw preview;
    return preview;
  };
});

const selection = { all: true as const, q: 'fair', except: ['con_9'] };

function show() {
  const done = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <VerifyDialog
          businessId="biz_test"
          selection={selection}
          count={120}
          more={false}
          returnFocus={{ current: null }}
          onClose={() => undefined}
          onDone={done}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), done };
}

const inputsOf = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

describe('the Verify emails dialog', () => {
  it('counts what verifying the same selection would do, then verifies it', async () => {
    const { user, done } = show();
    const dialog = screen.getByRole('dialog', { name: 'Verify emails' });
    const verify = within(dialog).getByRole('button', { name: 'Verify 120 contacts' });
    // Nothing starts before the counts are in.
    expect(verify.hasAttribute('disabled')).toBe(true);
    expect(await within(dialog).findByText('120 contacts in the selection.')).toBeDefined();
    // What counts as current, said as the server counts it, whatever Re-verify says.
    expect(
      within(dialog).getByText(
        "120 contacts are selected. Each contact's primary email address is checked unless it has a current result: valid, risky or invalid from the last 90 days, and from the mailbox while a provider is connected.",
      ),
    ).toBeDefined();
    expect(inputsOf('previewContactEmailChecks')).toEqual([{ body: { selection } }]);
    expect(
      within(dialog).getByText('30 already have a current result: kept as they are, at no cost.'),
    ).toBeDefined();
    expect(
      within(dialog).getByText('70 will be checked, 60 of them using a provider credit.'),
    ).toBeDefined();
    expect(within(dialog).getByText('20 skipped:')).toBeDefined();
    expect(within(dialog).getByText('8 have no email address')).toBeDefined();
    expect(within(dialog).getByText('2 are excluded from email verification')).toBeDefined();
    expect(within(dialog).getByText("10 are over today's verification limit")).toBeDefined();
    expect(within(dialog).getByText('60 provider checks left today.')).toBeDefined();
    await waitFor(() => {
      expect(verify.hasAttribute('disabled')).toBe(false);
    });
    await user.click(verify);
    await waitFor(() => {
      expect(done).toHaveBeenCalledOnce();
    });
    const [sent] = inputsOf('bulkUpdateContacts') as { body: Record<string, unknown> }[];
    expect(sent?.body).toEqual({
      action: 'verify_emails',
      selection,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
  });

  it('says domain checks still run without a provider, and leaves out the daily limit', async () => {
    preview = emailCheckPreviewOf({ provider: null, providerCalls: 0, remainingToday: null });
    show();
    expect(
      await screen.findByText(
        'Mailbox checks need a verification provider. Domain checks still run.',
      ),
    ).toBeDefined();
    expect(screen.getByText('70 will be checked, none using a provider credit.')).toBeDefined();
    expect(screen.queryByText(/checks left today/)).toBeNull();
  });

  it('says verification is off and does not offer Verify', async () => {
    preview = emailCheckPreviewOf({ enabled: false });
    show();
    expect(
      await screen.findByText(
        'Email verification is off. Turn it on in Settings → Email Services → Email Verification.',
      ),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Verify 120 contacts' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('does not offer Verify when nothing is left to check', async () => {
    preview = emailCheckPreviewOf({ current: 100, checks: 0, providerCalls: 0, overLimit: 0 });
    show();
    expect(
      await screen.findByText('Nothing to check: every address is current or skipped.'),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Verify 120 contacts' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('says the counts could not be loaded, and tries again on request', async () => {
    // A refusal is not asked again by itself (a fault is, twice, before this shows).
    preview = new ApiError({ type: 'about:blank', title: 'Unprocessable Content', status: 422 });
    const { user } = show();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("The counts couldn't be loaded.");
    preview = emailCheckPreviewOf();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('120 contacts in the selection.')).toBeDefined();
    expect(inputsOf('previewContactEmailChecks')).toHaveLength(2);
  });
});
