// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  jane,
  janeId,
  janet,
  janetId,
  mergeDetailsOf,
  mergeFieldsOf,
  mergePreviewOf,
} from '../../e2e/contact-merge-fixtures';
import MergeDialog from './dialog';
import { mergeNoticeFor } from './notice';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

const contacts = new Map([
  [janeId, jane()],
  [janetId, janet()],
]);
const idOf = (input: unknown): string => (input as { params: { id: string } }).params.id;
const mergeIdsOf = (input: unknown): string[] =>
  (input as { query: { mergeIds: string } }).query.mergeIds.split(',');

/** The server as it answers the dialog's reads, with `rest` over the preview. */
function answering(rest: Parameters<typeof mergePreviewOf>[1] = {}) {
  return (operation: string, input: unknown): unknown => {
    const id = idOf(input);
    const contact = contacts.get(id);
    if (contact === undefined) throw new Error(`No contact ${id}`);
    if (operation === 'getContact') return contact;
    if (operation === 'getContactDetails') return mergeDetailsOf(contact);
    if (operation === 'getRecordFields') return mergeFieldsOf(id);
    if (operation === 'previewContactMerge')
      return mergePreviewOf([id, ...mergeIdsOf(input)], rest);
    if (operation === 'mergeContacts') return { contact, mergedIds: [], moved: {} };
    throw new Error(`Unexpected ${operation}`);
  };
}

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  server.answer = answering();
  navigate.mockReset();
});
afterEach(cleanup);

const onClose = vi.fn();

function show(ids: readonly string[] = [janeId, janetId]): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <MergeDialog contactIds={ids} returnFocus={createRef()} onClose={onClose} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const inputsOf = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

const dialog = () => screen.findByRole('dialog', { name: 'Merge Contacts' });
function rowOf(name: string): HTMLTableRowElement {
  const row = screen.getByRole('rowheader', { name }).closest('tr');
  if (row === null) throw new Error(`No row for ${name}.`);
  return row;
}

describe('Merge Contacts', () => {
  it("keeps the master's values by default and asks only where the contacts differ", async () => {
    show();
    const panel = await dialog();
    await within(panel).findByRole('table');

    expect(within(panel).getByRole('radio', { name: /^Jane Doe/u })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(rowOf('First name')).getByRole('radio', { name: 'Jane' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(rowOf('First name')).getByRole('radio', { name: 'Janet' })).toHaveProperty(
      'checked',
      false,
    );
    // The same value on both, or only one has a value: nothing to pick.
    expect(within(rowOf('Last name')).queryAllByRole('radio')).toHaveLength(0);
    expect(within(rowOf('Date of birth')).queryAllByRole('radio')).toHaveLength(0);
    expect(within(rowOf('Date of birth')).getByText('Apr 12, 1990')).toBeTruthy();
    expect(within(rowOf('Owner')).queryAllByRole('radio')).toHaveLength(0);
    expect(within(rowOf('Contact type')).getByRole('radio', { name: 'Lead' })).toHaveProperty(
      'checked',
      true,
    );
    // A custom field someone has a value in; none for one nobody has.
    expect(within(rowOf('Budget')).getByRole('radio', { name: '5000' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.queryByRole('rowheader', { name: 'Venue' })).toBeNull();
    expect(
      within(within(panel).getByRole('group', { name: 'Primary email' })).getByRole('radio', {
        name: 'jane.doe@gmail.com',
      }),
    ).toHaveProperty('checked', true);
    expect(within(panel).getByText('Notes: 2')).toBeTruthy();
    expect(within(panel).getByText('Conversations: 1')).toBeTruthy();
    expect(within(panel).queryByText(/Tags/u)).toBeNull();
    expect(inputsOf('previewContactMerge')).toEqual([
      { params: { id: janeId }, query: { mergeIds: janetId } },
    ]);
  });

  it('merges only once the box is ticked, sending the choices changed, then opens the master', async () => {
    const user = show();
    const panel = await dialog();
    await within(panel).findByRole('table');
    const merge = within(panel).getByRole('button', { name: 'Merge' });
    expect(merge).toHaveProperty('disabled', true);

    await user.click(within(rowOf('First name')).getByRole('radio', { name: 'Janet' }));
    await user.click(within(panel).getByRole('radio', { name: 'janedoe+news@gmail.com' }));
    await user.click(
      within(panel).getByRole('checkbox', { name: 'I understand this cannot be undone' }),
    );
    expect(merge).toHaveProperty('disabled', false);
    await user.click(merge);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        to: '/b/$slug/contacts/$contactId',
        params: { slug: 'harbor', contactId: janeId },
      });
    });
    expect(inputsOf('mergeContacts')).toEqual([
      {
        params: { id: janeId },
        body: {
          mergeIds: [janetId],
          fields: { firstName: janetId },
          primaryEmail: 'janedoe+news@gmail.com',
          revisions: { [janeId]: '1'.repeat(64), [janetId]: '2'.repeat(64) },
        },
      },
    ]);
    expect(mergeNoticeFor(janeId)).toEqual({ kind: 'merged', count: 1 });
  });

  it('reads the preview again for another master, whose values then come first', async () => {
    const user = show();
    const panel = await dialog();
    await within(panel).findByRole('table');
    await user.click(within(panel).getByRole('radio', { name: /^Janet Doe/u }));

    await waitFor(() => {
      expect(inputsOf('previewContactMerge')).toContainEqual({
        params: { id: janetId },
        query: { mergeIds: janeId },
      });
    });
    expect(within(rowOf('First name')).getByRole('radio', { name: 'Janet' })).toHaveProperty(
      'checked',
      true,
    );
    await user.click(
      within(panel).getByRole('checkbox', { name: 'I understand this cannot be undone' }),
    );
    await user.click(within(panel).getByRole('button', { name: 'Merge' }));
    await waitFor(() => {
      expect(inputsOf('mergeContacts')).toHaveLength(1);
    });
    expect(inputsOf('mergeContacts')[0]).toEqual({
      params: { id: janetId },
      body: {
        mergeIds: [janeId],
        revisions: { [janetId]: '2'.repeat(64), [janeId]: '1'.repeat(64) },
      },
    });
  });

  it('refuses a merge that would move more rows than one merge may', async () => {
    server.answer = answering({ rows: 60_000, maxRows: 50_000 });
    const user = show();
    const panel = await dialog();
    expect(
      (await within(panel).findByText(/more than the 50,000 one merge moves/u)).textContent,
    ).toBe(
      'These contacts have 60,000 rows of history between them, more than the 50,000 one merge moves. Merge fewer contacts at a time.',
    );
    await user.click(
      within(panel).getByRole('checkbox', { name: 'I understand this cannot be undone' }),
    );
    expect(within(panel).getByRole('button', { name: 'Merge' })).toHaveProperty('disabled', true);
  });

  it('says a contact changed meanwhile, and reads the preview again', async () => {
    const answer = answering();
    server.answer = (operation, input) => {
      if (operation === 'mergeContacts')
        throw new ApiError({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'Contact changed after you opened the merge. Reload and try again.',
        });
      return answer(operation, input);
    };
    const user = show();
    const panel = await dialog();
    await within(panel).findByRole('table');
    await user.click(
      within(panel).getByRole('checkbox', { name: 'I understand this cannot be undone' }),
    );
    await user.click(within(panel).getByRole('button', { name: 'Merge' }));

    expect((await within(panel).findByRole('alert')).textContent).toBe(
      'One of these contacts changed while you had this open. The latest is shown: check your choices and merge again.',
    );
    await waitFor(() => {
      expect(inputsOf('previewContactMerge')).toHaveLength(2);
    });
    expect(navigate).not.toHaveBeenCalled();
  });
});
