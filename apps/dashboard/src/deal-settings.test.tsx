// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { updateOpportunitySettingsInput, type OpportunitySettings } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DealSettings from './deal-settings';

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

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const read = (changes: Partial<OpportunitySettings> = {}): OpportunitySettings => ({
  allowDifferentOwners: false,
  opportunityOwnerFollowsContact: true,
  contactOwnerFollowsOpportunity: false,
  revision: 'a'.repeat(64),
  canManage: true,
  ...changes,
});

interface Shown {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly dialog: HTMLElement;
  readonly events: string[];
}

async function show(): Promise<Shown> {
  const events: string[] = [];
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <DealSettings
          businessId="biz_test"
          returnFocus={createRef<HTMLElement>()}
          onClose={() => events.push('closed')}
          onSaved={() => events.push('saved')}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Opportunity settings' });
  return { user: userEvent.setup(), dialog, events };
}

const checkedOf = (element: HTMLElement): boolean =>
  element instanceof HTMLInputElement
    ? element.checked
    : element.getAttribute('aria-checked') === 'true';
const disabledOf = (element: HTMLElement): boolean =>
  (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) && element.disabled;
const ownerRule = /^When an opportunity's owner changes/;
const contactRule = /^When a contact's owner changes/;

describe('the opportunity settings panel', () => {
  it('shows the three settings as the server keeps them, with nothing to save yet', async () => {
    server.answer = () => read();
    const { dialog } = await show();
    const panel = within(dialog);
    const owners = await panel.findByRole('switch', {
      name: 'Allow different owners for primary contacts and opportunities',
    });
    expect(checkedOf(owners)).toBe(false);
    expect(checkedOf(panel.getByRole('checkbox', { name: ownerRule }))).toBe(true);
    expect(checkedOf(panel.getByRole('checkbox', { name: contactRule }))).toBe(false);
    expect(disabledOf(panel.getByRole('button', { name: 'Save changes' }))).toBe(true);
    expect(server.calls).toEqual([{ operation: 'getOpportunitySettings', input: {} }]);
  });

  it('saves the three together under the revision they were read with', async () => {
    server.answer = (operation) =>
      operation === 'getOpportunitySettings'
        ? read()
        : read({ allowDifferentOwners: true, revision: 'b'.repeat(64) });
    const { user, dialog, events } = await show();
    const panel = within(dialog);
    await user.click(await panel.findByRole('switch', { name: /^Allow different owners/ }));
    await user.click(panel.getByRole('checkbox', { name: ownerRule }));
    await user.click(panel.getByRole('checkbox', { name: contactRule }));
    // Put back as it was: only what differs from what was read counts as a change.
    await user.click(panel.getByRole('checkbox', { name: contactRule }));
    await user.click(panel.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(events).toEqual(['saved']);
    });
    const sent = server.calls.find((call) => call.operation === 'updateOpportunitySettings');
    expect(sent?.input).toEqual({
      body: {
        allowDifferentOwners: true,
        opportunityOwnerFollowsContact: false,
        contactOwnerFollowsOpportunity: false,
        revision: 'a'.repeat(64),
      },
    });
    expect(
      updateOpportunitySettingsInput.safeParse((sent?.input as { body: unknown }).body).success,
    ).toBe(true);
  });

  it('has nothing to save once every change is put back', async () => {
    server.answer = () => read();
    const { user, dialog } = await show();
    const panel = within(dialog);
    const owners = await panel.findByRole('switch', { name: /^Allow different owners/ });
    await user.click(owners);
    expect(disabledOf(panel.getByRole('button', { name: 'Save changes' }))).toBe(false);
    await user.click(owners);
    expect(disabledOf(panel.getByRole('button', { name: 'Save changes' }))).toBe(true);
  });

  it('shows them without a way to change them to someone who may not', async () => {
    server.answer = () => read({ canManage: false });
    const { user, dialog, events } = await show();
    const panel = within(dialog);
    expect(disabledOf(await panel.findByRole('switch', { name: /^Allow different owners/ }))).toBe(
      true,
    );
    expect(disabledOf(panel.getByRole('checkbox', { name: ownerRule }))).toBe(true);
    expect(disabledOf(panel.getByRole('checkbox', { name: contactRule }))).toBe(true);
    expect(
      panel.getByText('You can see these settings, but you may not change them.'),
    ).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Save changes' })).toBeNull();
    const [, close] = panel.getAllByRole('button', { name: 'Close' });
    if (close === undefined) throw new Error('A Close button at the foot was expected.');
    await user.click(close);
    expect(events).toEqual(['closed']);
  });

  it('reloads settings someone else changed, keeping nothing of the stale draft', async () => {
    let reads = 0;
    server.answer = (operation) => {
      if (operation === 'getOpportunitySettings') {
        reads += 1;
        return reads === 1
          ? read()
          : read({ contactOwnerFollowsOpportunity: true, revision: 'c'.repeat(64) });
      }
      throw new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 });
    };
    const { user, dialog, events } = await show();
    const panel = within(dialog);
    await user.click(await panel.findByRole('switch', { name: /^Allow different owners/ }));
    await user.click(panel.getByRole('button', { name: 'Save changes' }));
    expect(await panel.findByText(/^These settings changed since you opened them/)).toBeTruthy();
    expect(events).toEqual([]);
    await user.click(panel.getByRole('button', { name: 'Reload settings' }));
    await waitFor(() => {
      expect(checkedOf(panel.getByRole('checkbox', { name: contactRule }))).toBe(true);
    });
    expect(checkedOf(panel.getByRole('switch', { name: /^Allow different owners/ }))).toBe(false);
    expect(panel.queryByText(/^These settings changed/)).toBeNull();
    expect(disabledOf(panel.getByRole('button', { name: 'Save changes' }))).toBe(true);
  });

  it('says when the settings could not be read, and reads them again when asked', async () => {
    let reads = 0;
    server.answer = () => {
      reads += 1;
      if (reads === 1) throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      return read();
    };
    const { user, dialog } = await show();
    const panel = within(dialog);
    expect(await panel.findByText("The opportunity settings couldn't be loaded.")).toBeTruthy();
    expect(panel.queryByRole('switch')).toBeNull();
    await user.click(panel.getByRole('button', { name: 'Try again' }));
    expect(await panel.findByRole('switch', { name: /^Allow different owners/ })).toBeTruthy();
  });
});
