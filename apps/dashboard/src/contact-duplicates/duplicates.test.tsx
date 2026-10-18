// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { DuplicateSettings } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  companyNames,
  duplicateContactOf,
  gmailTwins,
  phoneTails,
} from '../../e2e/contact-duplicates-fixtures';
import { ManageDuplicatesPage } from './manage-page';
import PossibleDuplicates from './possible-chip';
import DuplicatePreferences from './preferences';

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
// The merge dialog by itself is tested in contact-merge/dialog.test.tsx: here, what opens it.
vi.mock('../contact-merge/loader', () => ({
  ContactMergeDialog: ({ contactIds }: { contactIds: readonly string[] }) => (
    <div role="dialog" aria-label="Merge Contacts">
      {contactIds.join(',')}
    </div>
  ),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({
    id: 'biz_test',
    name: 'Harbor Lights Events',
    slug: 'harbor',
    timezone: 'America/New_York',
  }),
}));
vi.mock('../shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ params, children }: { params: { contactId: string }; children: ReactNode }) => (
    <a href={`/contacts/${params.contactId}`}>{children}</a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

function show(element: ReactElement): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>{element}</I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const inputsOf = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

const forbidden = new ApiError({
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: "Your role doesn't allow this: it needs contacts.merge.",
});

describe('Manage Duplicates', () => {
  it('finds by email first, then by phone or name, a card for each group', async () => {
    const groups = { email: [gmailTwins()], phone: [phoneTails()], name: [companyNames()] };
    server.answer = (operation, input) =>
      operation === 'listDuplicateGroups'
        ? {
            items: groups[(input as { query: { by: 'email' | 'phone' | 'name' } }).query.by],
            next: null,
          }
        : undefined;
    const user = show(<ManageDuplicatesPage />);

    expect(await screen.findByText('janedoe@gmail.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email', pressed: true })).toBeTruthy();
    expect(screen.getByText(/2 contacts/u).textContent).toContain('Jane Doe, Jane Doe');
    expect(screen.getByText(/reach one Gmail inbox/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Phone' }));
    expect(await screen.findByText('…2125550199')).toBeTruthy();
    expect(screen.getByText('Weaker match')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Name' }));
    expect(await screen.findByText('katherine johnson')).toBeTruthy();
    expect(screen.getByText('Same company')).toBeTruthy();
    expect(inputsOf('listDuplicateGroups')).toEqual([
      { query: { by: 'email' } },
      { query: { by: 'phone' } },
      { query: { by: 'name' } },
    ]);
    // Merge is in the review, not on the cards.
    expect(screen.queryByRole('button', { name: /merge/iu })).toBeNull();
  });

  it('shows a group side by side, and rejects it once asked, never to show it again', async () => {
    let shown = [gmailTwins()];
    server.answer = (operation) => {
      if (operation === 'listDuplicateGroups') return { items: shown, next: null };
      if (operation === 'rejectDuplicateGroup') {
        shown = [];
        return undefined;
      }
      return undefined;
    };
    const user = show(<ManageDuplicatesPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));

    const panel = await screen.findByRole('dialog', { name: 'Review duplicates' });
    const table = within(panel).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Jane Doe', 'Jane Doe']);
    expect(within(table).getByRole('rowheader', { name: 'Email' })).toBeTruthy();
    expect(within(table).getByText('janedoe+news@gmail.com')).toBeTruthy();
    expect(within(table).getByText('None')).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: 'Reject' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reject these duplicates?' });
    expect(confirm.textContent).toContain("This can't be undone.");
    await user.click(within(confirm).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(screen.queryByText('janedoe@gmail.com')).toBeNull();
    });
    expect(inputsOf('rejectDuplicateGroup')).toEqual([
      {
        body: {
          by: 'email',
          valueKey: 'janedoe@gmail.com',
          contactIds: gmailTwins().contacts.map((each) => each.id),
        },
      },
    ]);
    expect(screen.getByRole('status').textContent).toBe(
      "janedoe@gmail.com was rejected. Those contacts won't be shown as duplicates again.",
    );
    expect(screen.getByText('No possible duplicates found.')).toBeTruthy();
  });

  it("merges a group's contacts from the review", async () => {
    server.answer = (operation) =>
      operation === 'listDuplicateGroups' ? { items: [gmailTwins()], next: null } : undefined;
    const user = show(<ManageDuplicatesPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const panel = await screen.findByRole('dialog', { name: 'Review duplicates' });
    await user.click(within(panel).getByRole('button', { name: 'Merge' }));
    expect((await screen.findByRole('dialog', { name: 'Merge Contacts' })).textContent).toBe(
      gmailTwins()
        .contacts.map((each) => each.id)
        .join(','),
    );
  });

  it('keeps Merge from a group of more than ten contacts', async () => {
    const twelve = Array.from({ length: 12 }, (_, index) =>
      duplicateContactOf(index + 10, 'Jane Doe'),
    );
    server.answer = (operation) =>
      operation === 'listDuplicateGroups'
        ? { items: [{ ...gmailTwins(), total: 12, contacts: twelve }], next: null }
        : undefined;
    const user = show(<ManageDuplicatesPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const panel = await screen.findByRole('dialog', { name: 'Review duplicates' });
    expect(within(panel).getByRole('button', { name: 'Merge' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(
      within(panel).getByText(
        'Merge at most 10 contacts at a time: tick the ones to merge in the contact list.',
      ),
    ).toBeTruthy();
  });

  it('rejects the whole of a group larger than it lists, and says how many', async () => {
    const big = { ...gmailTwins(), total: 27 };
    server.answer = (operation) =>
      operation === 'listDuplicateGroups' ? { items: [big], next: null } : undefined;
    const user = show(<ManageDuplicatesPage />);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reject these duplicates?' });
    expect(confirm.textContent).toContain('The 27 contacts are not shown together');
  });

  it('says who may manage duplicates when the role may not', async () => {
    server.answer = () => Promise.reject(forbidden);
    show(<ManageDuplicatesPage />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only admins can manage duplicates.',
    );
  });
});

describe("a contact's possible duplicates", () => {
  it('shows how many, opens the same review, and offers Reject only to who may', async () => {
    const group = gmailTwins();
    server.answer = (operation) =>
      operation === 'listPossibleDuplicates'
        ? { groups: [group], count: 1 }
        : operation === 'getMyPermissions'
          ? { business: null, permissions: ['contacts.manage'] }
          : undefined;
    const user = show(<PossibleDuplicates contactId={group.contacts[0]?.id ?? ''} />);

    await user.click(await screen.findByRole('button', { name: 'Possible duplicates (1)' }));
    const panel = await screen.findByRole('dialog', { name: 'Review duplicates' });
    expect(within(panel).getByText('janedoe@gmail.com')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Merge' })).toBeNull();
  });

  it('offers Merge and Reject to whoever may manage duplicates', async () => {
    const group = gmailTwins();
    server.answer = (operation) =>
      operation === 'listPossibleDuplicates'
        ? { groups: [group], count: 1 }
        : operation === 'getMyPermissions'
          ? { business: null, permissions: ['contacts.manage', 'contacts.merge'] }
          : undefined;
    const user = show(<PossibleDuplicates contactId={group.contacts[0]?.id ?? ''} />);
    await user.click(await screen.findByRole('button', { name: 'Possible duplicates (1)' }));
    const panel = await screen.findByRole('dialog', { name: 'Review duplicates' });
    expect(await within(panel).findByRole('button', { name: 'Reject' })).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Merge' }));
    expect(await screen.findByRole('dialog', { name: 'Merge Contacts' })).toBeTruthy();
  });

  it('shows nothing when there are none', async () => {
    server.answer = (operation) =>
      operation === 'listPossibleDuplicates' ? { groups: [], count: 0 } : undefined;
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider i18n={i18n}>
          <PossibleDuplicates contactId="con_x" />
        </I18nProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(inputsOf('listPossibleDuplicates')).toHaveLength(1);
    });
    expect(container.textContent).toBe('');
  });
});

describe('Contact Deduplication Preferences', () => {
  const saved = (rest: Partial<DuplicateSettings> = {}): DuplicateSettings => ({
    primary: 'email',
    secondary: null,
    revision: 'a'.repeat(64),
    canManage: true,
    ...rest,
  });

  it('saves the primary field and the other as secondary, from the revision read', async () => {
    server.answer = (operation, input) =>
      operation === 'updateDuplicateSettings'
        ? saved({ ...(input as { body: object }).body, revision: 'b'.repeat(64) })
        : saved();
    const user = show(<DuplicatePreferences />);

    expect(screen.getByRole('heading', { name: 'Contact Deduplication Preferences' })).toBeTruthy();
    const save = await screen.findByRole('button', { name: 'Save preferences' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('combobox', { name: 'Primary field' }));
    await user.click(await screen.findByRole('option', { name: 'Phone' }));
    await user.click(screen.getByRole('combobox', { name: 'Secondary field' }));
    await user.click(await screen.findByRole('option', { name: 'Email' }));
    await user.click(save);

    expect((await screen.findByRole('status')).textContent).toBe(
      'Contact deduplication preferences saved.',
    );
    expect(inputsOf('updateDuplicateSettings')).toEqual([
      { body: { primary: 'phone', secondary: 'email', revision: 'a'.repeat(64) } },
    ]);
  });

  it('shows them, unchangeable, to whoever may not change the business profile', async () => {
    server.answer = () => saved({ canManage: false, primary: 'phone', secondary: 'email' });
    show(<DuplicatePreferences />);
    expect(
      await screen.findByText('Only someone who may change the business profile can change these.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save preferences' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Match fields' }).hasAttribute('disabled')).toBe(true);
  });
});
