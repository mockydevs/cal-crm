// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { snippetFolderOf, snippetOf } from '../e2e/conversation-extras-fixtures';
import { SnippetsPage } from './snippets';

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
vi.mock('./shell/page', () => ({
  Page: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const pricing = snippetFolderOf(1, 'Pricing');
const directions = snippetOf(1, 'Directions', 'Park at the back, by the blue door.');
const welcome = snippetOf(2, 'Welcome', 'Hello {{contact.first_name}}, welcome aboard.', {
  type: 'email',
  subject: 'Welcome aboard',
  folderId: pricing.id,
  folderName: pricing.name,
  mergeFields: ['contact.first_name'],
});

const summaryOf = ({ body, mergeFields: _fields, ...rest }: typeof directions) => ({
  ...rest,
  bodyPreview: body.slice(0, 200),
});

/** A server holding these snippets; `on` answers the operations a test cares about. */
function serve(
  snippets: (typeof directions)[],
  on: (operation: string, input: unknown) => unknown = () => undefined,
  canManage = true,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listSnippets')
      return { items: snippets.map(summaryOf), total: snippets.length, next: null, canManage };
    if (operation === 'listSnippetFolders') return { items: [pricing], canManage };
    if (operation === 'getSnippet') {
      const { params } = input as { params: { snippetId: string } };
      return snippets.find((each) => each.id === params.snippetId);
    }
    return undefined;
  };
}

function show(): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <SnippetsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

async function rowAction(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  action: string,
): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

describe('the Snippets page', () => {
  it('lists each snippet with the start of its body, its folder and its type', async () => {
    serve([directions, welcome]);
    show();
    const row = (await screen.findByRole('rowheader', { name: 'Welcome' })).closest('tr');
    if (row === null) throw new Error('No row.');
    expect(within(row).getByText(/welcome aboard\./)).toBeTruthy();
    expect(within(row).getByText('Welcome aboard:')).toBeTruthy();
    expect(within(row).getByText('Pricing')).toBeTruthy();
    expect(within(row).getByText('Email')).toBeTruthy();
    expect(inputOf('listSnippets')).toEqual({ query: { limit: 20 } });
  });

  it('creates a text snippet with no subject, and says so', async () => {
    serve([], (operation) => (operation === 'createSnippet' ? directions : undefined));
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'New snippet' }));
    const panel = await screen.findByRole('dialog', { name: 'New snippet' });
    const create = within(panel).getByRole('button', { name: 'Create snippet' });
    expect(create).toHaveProperty('disabled', true);
    // A text snippet has no subject to fill in.
    expect(within(panel).queryByLabelText('Subject')).toBeNull();
    await user.type(within(panel).getByLabelText('Name'), 'Directions');
    await user.type(within(panel).getByLabelText('Message'), 'Park at the back.');
    expect(within(panel).getByText(/17 of 1600 characters/)).toBeTruthy();
    await user.click(create);
    await waitFor(() => {
      expect(inputOf('createSnippet')).toEqual({
        body: {
          type: 'text',
          name: 'Directions',
          subject: null,
          body: 'Park at the back.',
          folderId: null,
        },
      });
    });
    expect(await screen.findByText('Snippet created.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('reads the whole snippet before editing it, and saves from its revision', async () => {
    serve([directions, welcome], (operation) =>
      operation === 'updateSnippet' ? welcome : undefined,
    );
    const user = show();
    await rowAction(user, 'Welcome', 'Edit');
    const panel = await screen.findByRole('dialog', { name: 'Edit snippet' });
    const message = await within(panel).findByLabelText('Message');
    expect(message).toHaveProperty('value', welcome.body);
    expect(inputOf('getSnippet')).toEqual({ params: { snippetId: welcome.id } });
    await user.clear(within(panel).getByLabelText('Subject'));
    await user.type(within(panel).getByLabelText('Subject'), 'Glad you are here');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(inputOf('updateSnippet')).toEqual({
        params: { snippetId: welcome.id },
        body: {
          name: 'Welcome',
          subject: 'Glad you are here',
          body: welcome.body,
          folderId: pricing.id,
          revision: welcome.revision,
        },
      });
    });
    expect(await screen.findByText('Snippet saved.')).toBeTruthy();
  });

  it('duplicates a snippet as a new one named after it', async () => {
    serve([directions], (operation) => (operation === 'createSnippet' ? directions : undefined));
    const user = show();
    await rowAction(user, 'Directions', 'Duplicate');
    const panel = await screen.findByRole('dialog', { name: 'Duplicate snippet' });
    expect(await within(panel).findByLabelText('Name')).toHaveProperty(
      'value',
      'Copy of Directions',
    );
    await user.click(within(panel).getByRole('button', { name: 'Create snippet' }));
    await waitFor(() => {
      expect(inputOf('createSnippet')).toMatchObject({
        body: { type: 'text', name: 'Copy of Directions', body: directions.body },
      });
    });
  });

  it('offers the saved version when someone else saved first', async () => {
    const theirs = { ...directions, body: 'Park out front.', revision: 'f'.repeat(64) };
    let saved = false;
    serve([directions], (operation) => {
      if (operation === 'updateSnippet')
        throw new ApiError({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'Someone else changed this snippet. Reload it and try again.',
        });
      if (operation === 'getSnippet') {
        if (!saved) {
          saved = true;
          return directions;
        }
        return theirs;
      }
      return undefined;
    });
    const user = show();
    await rowAction(user, 'Directions', 'Edit');
    const panel = await screen.findByRole('dialog', { name: 'Edit snippet' });
    await user.type(await within(panel).findByLabelText('Message'), ' Mind the step.');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(await within(panel).findByRole('alert')).toHaveProperty(
      'textContent',
      'Someone else changed this snippet. Reload it and try again.',
    );
    await user.click(within(panel).getByRole('button', { name: 'Reload saved version' }));
    await waitFor(() => {
      expect(within(panel).getByLabelText('Message')).toHaveProperty('value', 'Park out front.');
    });
  });

  it('asks before deleting a snippet', async () => {
    serve([directions], (operation) => (operation === 'deleteSnippet' ? null : undefined));
    const user = show();
    await rowAction(user, 'Directions', 'Delete');
    const asking = await screen.findByRole('dialog', { name: 'Delete Directions?' });
    expect(within(asking).getByText(/deleted for good/)).toBeTruthy();
    expect(server.calls.some((call) => call.operation === 'deleteSnippet')).toBe(false);
    await user.click(within(asking).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(inputOf('deleteSnippet')).toEqual({ params: { snippetId: directions.id } });
    });
    expect(await screen.findByText('Snippet deleted.')).toBeTruthy();
  });

  it('shows a merge field in a body as one', async () => {
    serve([welcome]);
    show();
    const row = (await screen.findByRole('rowheader', { name: 'Welcome' })).closest('tr');
    if (row === null) throw new Error('No row.');
    expect(within(row).getByText('{{contact.first_name}}').tagName).toBe('CODE');
  });

  it('moves the ticked snippets together, and unticks them', async () => {
    serve([directions, welcome], (operation) =>
      operation === 'moveSnippets' ? { items: [] } : undefined,
    );
    const user = show();
    await screen.findByRole('rowheader', { name: 'Directions' });
    expect(screen.queryByRole('group', { name: 'Selected snippets' })).toBeNull();
    const all: HTMLInputElement = screen.getByRole('checkbox', {
      name: 'Select every snippet on this page',
    });
    await user.click(screen.getByRole('checkbox', { name: 'Select Directions' }));
    const bar = screen.getByRole('group', { name: 'Selected snippets' });
    expect(within(bar).getByText('1 selected')).toBeTruthy();
    // Some, not all: the box that ticks them all says so.
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
    await user.click(all);
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    expect(all.indeterminate).toBe(false);
    expect(all.checked).toBe(true);
    await user.click(within(bar).getByRole('button', { name: 'Move to folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to folder' });
    expect(within(dialog).getByText('2 snippets')).toBeTruthy();
    // They are in different places, so the choice starts at no folder; one of them is
    // already there, and the other is not, so there is something to move.
    const move = within(dialog).getByRole('button', { name: 'Move' });
    expect(move).toHaveProperty('disabled', false);
    await user.click(within(dialog).getByRole('combobox', { name: 'Folder' }));
    await user.click(await screen.findByRole('option', { name: 'Pricing' }));
    await user.click(move);
    await waitFor(() => {
      expect(inputOf('moveSnippets')).toEqual({
        body: { snippetIds: [directions.id, welcome.id], folderId: pricing.id },
      });
    });
    expect(await screen.findByText('2 snippets moved.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Selected snippets' })).toBeNull();
    expect(all.checked).toBe(false);
  });

  it('deletes the ticked snippets one by one, after asking', async () => {
    serve([directions, welcome], (operation) => (operation === 'deleteSnippet' ? null : undefined));
    const user = show();
    await user.click(await screen.findByRole('checkbox', { name: 'Select Directions' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Welcome' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Selected snippets' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    const asking = await screen.findByRole('dialog', { name: 'Delete 2 snippets?' });
    expect(within(asking).getByText(/The snippets are deleted for good\./)).toBeTruthy();
    expect(server.calls.some((call) => call.operation === 'deleteSnippet')).toBe(false);
    await user.click(within(asking).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('2 snippets deleted.')).toBeTruthy();
    expect(
      server.calls.filter((call) => call.operation === 'deleteSnippet').map((call) => call.input),
    ).toEqual([{ params: { snippetId: directions.id } }, { params: { snippetId: welcome.id } }]);
    expect(screen.queryByRole('group', { name: 'Selected snippets' })).toBeNull();
  });

  it('carries on past a snippet that is already gone, and stops at one that fails', async () => {
    let fail = true;
    serve([directions, welcome], (operation, input) => {
      if (operation !== 'deleteSnippet') return undefined;
      const { params } = input as { params: { snippetId: string } };
      if (params.snippetId === directions.id)
        throw new ApiError({ type: 'about:blank', title: 'Not Found', status: 404 });
      if (fail)
        throw new ApiError({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'Try that again.',
        });
      return null;
    });
    const user = show();
    await user.click(
      await screen.findByRole('checkbox', { name: 'Select every snippet on this page' }),
    );
    await user.click(
      within(screen.getByRole('group', { name: 'Selected snippets' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    const asking = await screen.findByRole('dialog', { name: 'Delete 2 snippets?' });
    await user.click(within(asking).getByRole('button', { name: 'Delete' }));
    expect(await within(asking).findByText('Try that again.')).toBeTruthy();
    fail = false;
    await user.click(within(asking).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('2 snippets deleted.')).toBeTruthy();
  });

  it('clears the ticks when asked, and unticks one row at a time', async () => {
    serve([directions, welcome]);
    const user = show();
    const one = await screen.findByRole('checkbox', { name: 'Select Directions' });
    await user.click(one);
    await user.click(one);
    expect(screen.queryByRole('group', { name: 'Selected snippets' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Select every snippet on this page' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select every snippet on this page' }));
    expect(screen.queryByRole('group', { name: 'Selected snippets' })).toBeNull();
    await user.click(one);
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(one).toHaveProperty('checked', false);
  });

  it('only reads for someone who may not manage templates', async () => {
    serve([directions], undefined, false);
    show();
    expect(await screen.findByRole('rowheader', { name: 'Directions' })).toBeTruthy();
    expect(
      screen.getByText(
        'You can read snippets. Changing them needs permission to manage templates.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New snippet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for Directions' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says so when there are none, and when the list could not be read', async () => {
    serve([]);
    show();
    expect(
      await screen.findByText('No snippets yet. Add one to keep a message you write often.'),
    ).toBeTruthy();
    cleanup();
    serve([], (operation) => {
      // An answer that would be the same again, so the page does not ask twice more.
      if (operation === 'listSnippets')
        throw new ApiError({ type: 'about:blank', title: 'Bad Request', status: 400 });
      return undefined;
    });
    show();
    expect(await screen.findByText("The snippets couldn't be loaded.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
