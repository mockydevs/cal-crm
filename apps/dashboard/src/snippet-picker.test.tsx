// @vitest-environment jsdom
// The composer's snippet picker on its own, and inside the reply form it belongs to: what
// it lists for a channel, how it is searched and worked from the keyboard, what it does
// when the contact has no value for a field, and where the chosen text lands.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { ConversationComposer } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { snippetFolderOf, snippetOf } from '../e2e/conversation-extras-fixtures';
import {
  bookings,
  composerOf,
  contactId,
  conversationId,
  mayaPhone,
  openChat,
} from '../e2e/inbox-fixtures';
import { Composer, type ComposerDraft, type DraftStore } from './inbox-composer';
import SnippetPicker, { type FilledSnippet } from './snippet-picker';

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
    className,
    children,
  }: {
    to: string;
    params: { slug: string };
    className?: string;
    children: ReactNode;
  }) => (
    <a href={to.replace('$slug', params.slug)} className={className}>
      {children}
    </a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  // jsdom lays nothing out, so it has nothing to scroll.
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const pricing = snippetFolderOf(1, 'Pricing');
const directions = snippetOf(1, 'Directions', 'Park at the back, by the blue door.');
const hello = snippetOf(2, 'Hello', 'Hi {{contact.first_name}}, thanks for writing.', {
  mergeFields: ['contact.first_name'],
});
const rates = snippetOf(3, 'Rates', 'Our day rate is $900.', {
  folderId: pricing.id,
  folderName: pricing.name,
});
const welcome = snippetOf(4, 'Welcome', 'Welcome aboard, {{contact.first_name}}.', {
  type: 'email',
  subject: 'Welcome to Harbor Lights',
  mergeFields: ['contact.first_name'],
});
type Kept = typeof directions;

const summaryOf = ({ body, mergeFields: _fields, ...rest }: Kept) => ({
  ...rest,
  bodyPreview: body.slice(0, 200),
});

/** A server holding these snippets, which lists a type and searches as the API does. */
function serve(
  snippets: Kept[],
  on: (operation: string, input: unknown) => unknown = () => undefined,
  total?: number,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listSnippets') {
      const { query } = input as { query: { type: string; q?: string } };
      const q = (query.q ?? '').toLowerCase();
      const items = snippets
        .filter((each) => each.type === query.type)
        .filter((each) => `${each.name} ${each.body}`.toLowerCase().includes(q));
      return {
        items: items.map(summaryOf),
        total: total ?? items.length,
        next: null,
        canManage: true,
      };
    }
    if (operation === 'getSnippet') {
      const { params } = input as { params: { snippetId: string } };
      return snippets.find((each) => each.id === params.snippetId);
    }
    if (operation === 'renderSnippet') {
      const { params } = input as { params: { snippetId: string } };
      const snippet = snippets.find((each) => each.id === params.snippetId);
      if (snippet === undefined) return undefined;
      return {
        ok: true,
        type: snippet.type,
        subject: snippet.subject,
        body: snippet.body.replaceAll('{{contact.first_name}}', 'Maya'),
      };
    }
    return undefined;
  };
}

const inputsOf = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

function wrap(children: ReactNode): ReactNode {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    </QueryClientProvider>
  );
}

interface Shown {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly inserted: FilledSnippet[];
  readonly closed: string[];
}

function showPicker(
  options: {
    readonly type?: 'text' | 'email';
    readonly initialQuery?: string;
    /** What the composer answers when handed a snippet: whether it fitted. */
    readonly fits?: boolean;
  } = {},
): Shown {
  const inserted: FilledSnippet[] = [];
  const closed: string[] = [];
  render(
    wrap(
      <>
        <button type="button">Outside</button>
        <SnippetPicker
          type={options.type ?? 'text'}
          contactId={contactId('1')}
          contactName="Maya Thompson"
          initialQuery={options.initialQuery ?? ''}
          opener={{ current: null }}
          onInsert={(filled) => {
            inserted.push(filled);
            return options.fits ?? true;
          }}
          onClose={(how) => {
            closed.push(how);
          }}
        />
      </>,
    ),
  );
  return { user: userEvent.setup(), inserted, closed };
}

function at(elements: readonly HTMLElement[], index: number): HTMLElement {
  const element = elements[index];
  if (element === undefined) throw new Error(`Nothing at ${String(index)}.`);
  return element;
}

const optionNames = (): (string | null)[] =>
  screen.getAllByRole('option').map((each) => each.firstElementChild?.textContent ?? null);

describe('the snippet picker', () => {
  it('lists the text snippets by folder for a text, with the search holding the keyboard', async () => {
    serve([directions, hello, rates, welcome]);
    showPicker();
    const search = screen.getByRole('combobox', { name: 'Search text snippets' });
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole('status').textContent).toBe('Searching…');
    const list = await screen.findByRole('listbox', { name: 'Text snippets' });
    // Email snippets are not offered for a text: the server is asked for text ones only.
    expect(inputsOf('listSnippets')).toEqual([{ query: { type: 'text', limit: 50 } }]);
    expect(optionNames()).toEqual(['Directions', 'Hello', 'Rates']);
    expect(screen.queryByText('Welcome')).toBeNull();
    const groups = within(list).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'No folder',
      'Pricing',
    ]);
    expect(within(at(groups, 1)).getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('3 snippets');
    // The search names the list it works and the option it is on.
    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(search.getAttribute('aria-controls')).toBe(list.id);
    const first = at(screen.getAllByRole('option'), 0);
    expect(search.getAttribute('aria-activedescendant')).toBe(first.id);
    expect(first.getAttribute('aria-selected')).toBe('true');
    // A merge field is shown as one, not filled in or hidden.
    expect(within(list).getByText('{{contact.first_name}}').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: 'Manage snippets' }).getAttribute('href')).toBe(
      '/b/harbor/marketing/snippets',
    );
  });

  it('offers an email its own snippets, each with its subject', async () => {
    serve([directions, welcome]);
    showPicker({ type: 'email' });
    await screen.findByRole('listbox', { name: 'Email snippets' });
    expect(screen.getByRole('combobox', { name: 'Search email snippets' })).toBeTruthy();
    expect(inputsOf('listSnippets')).toEqual([{ query: { type: 'email', limit: 50 } }]);
    expect(optionNames()).toEqual(['Welcome']);
    expect(screen.getByRole('option').textContent).toContain('Welcome to Harbor Lights: ');
    expect(screen.getByRole('status').textContent).toBe('1 snippet');
    // One group, of snippets in no folder, needs no heading.
    expect(screen.queryByText('No folder')).toBeNull();
  });

  it('says so when there are none of the kind the channel takes', async () => {
    serve([welcome]);
    showPicker();
    expect(
      await screen.findByText('No text snippets yet. A text or a chat takes text snippets only.'),
    ).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('combobox').hasAttribute('aria-activedescendant')).toBe(false);
    cleanup();
    serve([directions]);
    showPicker({ type: 'email' });
    expect(
      await screen.findByText('No email snippets yet. An email takes email snippets only.'),
    ).toBeTruthy();
  });

  it('searches on the server as the person types, and says when nothing matches', async () => {
    serve([directions, hello, rates]);
    const { user } = showPicker();
    await screen.findByRole('listbox');
    await user.type(screen.getByRole('combobox'), 'rate');
    await waitFor(() => {
      expect(optionNames()).toEqual(['Rates']);
    });
    expect(inputsOf('listSnippets').at(-1)).toEqual({
      query: { type: 'text', limit: 50, q: 'rate' },
    });
    expect(screen.getByRole('status').textContent).toBe('1 snippet');
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(await screen.findByText('No snippets match “ratezzz”.')).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('starts from what was typed after the "/"', async () => {
    serve([directions, hello, rates]);
    showPicker({ initialQuery: 'dir' });
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'dir');
    await waitFor(() => {
      expect(optionNames()).toEqual(['Directions']);
    });
    expect(inputsOf('listSnippets')).toEqual([{ query: { type: 'text', limit: 50, q: 'dir' } }]);
  });

  it('says how many more there are when the list is cut short', async () => {
    serve([directions, hello], undefined, 120);
    showPicker();
    await screen.findByRole('listbox');
    expect(screen.getByRole('status').textContent).toBe(
      'Showing the first 2 of 120 snippets. Search to find the others.',
    );
  });

  it('moves with the arrow keys, stops at the ends, and Enter fills the one it is on', async () => {
    serve([directions, hello, rates]);
    const { user, inserted } = showPicker();
    await screen.findByRole('listbox');
    const search = screen.getByRole('combobox');
    const options = screen.getAllByRole('option');
    await user.keyboard('{ArrowUp}');
    expect(search.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    await user.keyboard('{ArrowDown}');
    expect(search.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(search.getAttribute('aria-activedescendant')).toBe(options[2]?.id);
    await user.keyboard('{ArrowUp}{Enter}');
    await waitFor(() => {
      expect(inserted).toEqual([{ subject: null, body: 'Hi Maya, thanks for writing.' }]);
    });
    // Filled in by the server, for this conversation's contact.
    expect(inputsOf('renderSnippet')).toEqual([
      { params: { snippetId: hello.id }, body: { contactId: contactId('1') } },
    ]);
  });

  it('fills the one that is pressed, and the pointer moves the highlight', async () => {
    serve([directions, hello, rates]);
    const { user, inserted } = showPicker();
    await screen.findByRole('listbox');
    const rate = at(screen.getAllByRole('option'), 2);
    fireEvent.pointerMove(rate);
    expect(rate.getAttribute('aria-selected')).toBe('true');
    fireEvent.pointerMove(rate);
    await user.click(rate);
    await waitFor(() => {
      expect(inserted).toEqual([{ subject: null, body: 'Our day rate is $900.' }]);
    });
  });

  it('hands an email snippet over with its subject', async () => {
    serve([welcome]);
    const { user, inserted } = showPicker({ type: 'email' });
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(inserted).toEqual([
        { subject: 'Welcome to Harbor Lights', body: 'Welcome aboard, Maya.' },
      ]);
    });
  });

  it('names a field the contact has no value for, and puts the snippet in unfilled only when asked', async () => {
    serve([directions, hello], (operation) =>
      operation === 'renderSnippet'
        ? { ok: false, code: 'missing_values', fields: ['contact.first_name'] }
        : undefined,
    );
    const { user, inserted } = showPicker();
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Maya Thompson has no value for {{contact.first_name}}, which “Hello” uses.',
    );
    expect(inserted).toEqual([]);
    // The list gives way to the question; Enter in the search does not answer it.
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{Enter}');
    expect(inputsOf('renderSnippet')).toHaveLength(1);
    await user.click(
      within(alert).getByRole('button', { name: 'Insert with the fields unfilled' }),
    );
    await waitFor(() => {
      expect(inserted).toEqual([
        { subject: null, body: 'Hi {{contact.first_name}}, thanks for writing.' },
      ]);
    });
    expect(inputsOf('getSnippet')).toEqual([{ params: { snippetId: hello.id } }]);
  });

  it('goes back to the list from a refusal, with the keyboard in the search', async () => {
    serve([hello], (operation) =>
      operation === 'renderSnippet'
        ? { ok: false, code: 'subject_line_break', fields: ['contact.custom.notes'] }
        : undefined,
    );
    const { user, inserted } = showPicker();
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'For Maya Thompson, {{contact.custom.notes}} would break the subject of “Hello” onto a second line.',
    );
    await user.click(within(alert).getByRole('button', { name: 'Choose another snippet' }));
    expect(await screen.findByRole('listbox')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
    expect(inserted).toEqual([]);
  });

  it('says so when the snippet is too long for the message, and when it could not be read', async () => {
    serve([directions]);
    const tooLong = showPicker({ fits: false });
    await screen.findByRole('listbox');
    await tooLong.user.keyboard('{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      '“Directions” is too long to fit in this message.Choose another snippet',
    );
    expect(
      within(alert).queryByRole('button', { name: 'Insert with the fields unfilled' }),
    ).toBeNull();
    cleanup();

    serve([directions], (operation) => {
      if (operation === 'renderSnippet') throw new Error('offline');
      return undefined;
    });
    const failed = showPicker();
    await screen.findByRole('listbox');
    await failed.user.keyboard('{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain(
      '“Directions” couldn’t be read. Check your connection and try again.',
    );
    expect(failed.inserted).toEqual([]);
  });

  it('says so when a snippet asked for unfilled can no longer be read', async () => {
    serve([hello], (operation) => {
      if (operation === 'renderSnippet')
        return { ok: false, code: 'missing_values', fields: ['contact.first_name'] };
      if (operation === 'getSnippet') throw new Error('gone');
      return undefined;
    });
    const { user, inserted } = showPicker();
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}');
    await user.click(
      await screen.findByRole('button', { name: 'Insert with the fields unfilled' }),
    );
    expect(await screen.findByText(/“Hello” couldn’t be read\./)).toBeTruthy();
    expect(inserted).toEqual([]);
  });

  it('says so when the snippets cannot be loaded, and loads them on a retry', async () => {
    let failing = true;
    serve([directions], (operation) => {
      if (operation === 'listSnippets' && failing) throw new Error('offline');
      return undefined;
    });
    const { user } = showPicker();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The snippets couldn’t be loaded.');
    expect(screen.getByRole('status').textContent).toBe('');
    failing = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listbox')).toBeTruthy();
  });

  it('closes on Escape from anywhere in it, and on a press elsewhere, saying which', async () => {
    serve([directions]);
    const { user, closed } = showPicker();
    await screen.findByRole('listbox');
    await user.keyboard('a');
    expect(closed).toEqual([]);
    await user.keyboard('{Escape}');
    expect(closed).toEqual(['escape']);
    screen.getByRole('link', { name: 'Manage snippets' }).focus();
    await user.keyboard('{Escape}');
    expect(closed).toEqual(['escape', 'escape']);
    // Escape outside the picker is not the picker's.
    screen.getByRole('button', { name: 'Outside' }).focus();
    await user.keyboard('{Escape}');
    expect(closed).toEqual(['escape', 'escape']);
    // The search the typed letter started may still be on its way: the list is back when it lands.
    fireEvent.pointerDown(await screen.findByRole('listbox'));
    expect(closed).toEqual(['escape', 'escape']);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(closed).toEqual(['escape', 'escape', 'elsewhere']);
  });

  it('ignores Enter while a search is still on its way', async () => {
    serve([directions, hello]);
    const { user, inserted } = showPicker();
    await screen.findByRole('listbox');
    await user.keyboard('hel{Enter}');
    await waitFor(() => {
      expect(optionNames()).toEqual(['Hello']);
    });
    expect(inputsOf('renderSnippet')).toEqual([]);
    expect(inserted).toEqual([]);
  });
});

// The reply form with the picker in it -----------------------------------------------------

const id = conversationId('1');
const noDraft: ComposerDraft = {
  mode: undefined,
  channel: undefined,
  accountId: undefined,
  to: undefined,
  subject: undefined,
  text: '',
  note: '',
};
const textOnly = (): ConversationComposer =>
  composerOf({
    suggestedChannel: 'sms',
    channels: [
      {
        channel: 'sms',
        available: true,
        unavailable: null,
        accounts: [{ id: bookings.id, name: 'Main line', address: '+15550100000' }],
        recipients: [mayaPhone],
      },
    ],
  });

interface ShownComposer {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly drafts: DraftStore;
  readonly sent: unknown[];
}

function showComposer(
  options: {
    readonly composer?: ConversationComposer;
    readonly draft?: Partial<ComposerDraft>;
    readonly contact?: string | undefined;
  } = {},
): ShownComposer {
  const drafts: DraftStore = new Map(
    options.draft === undefined ? [] : [[id, { ...noDraft, ...options.draft }]],
  );
  const sent: unknown[] = [];
  render(
    wrap(
      <Composer
        conversationId={id}
        contactId={'contact' in options ? options.contact : contactId('1')}
        contactName="Maya Thompson"
        composer={options.composer ?? composerOf()}
        composerFailed={false}
        onRetryComposer={vi.fn()}
        canManage
        drafts={drafts}
        onSendReply={(content) => {
          sent.push(content);
          return new Promise(() => undefined);
        }}
        onAddNote={vi.fn()}
      />,
    ),
  );
  return { user: userEvent.setup(), drafts, sent };
}

const message = (): HTMLTextAreaElement => screen.getByLabelText('Message to Maya Thompson');
const snippetsButton = (): HTMLElement => screen.getByRole('button', { name: 'Snippets' });

describe('the reply form with snippets', () => {
  it('opens the picker from its button and puts the filled-in text at the caret', async () => {
    serve([directions, hello, welcome]);
    const { user, drafts } = showComposer({
      composer: textOnly(),
      draft: { text: 'Before. After.' },
    });
    expect(snippetsButton().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
    message().focus();
    message().setSelectionRange(8, 8);
    await user.click(snippetsButton());
    expect(snippetsButton().getAttribute('aria-expanded')).toBe('true');
    const picker = await screen.findByRole('dialog', { name: 'Snippets' });
    await within(picker).findByRole('listbox', { name: 'Text snippets' });
    // A text message takes text snippets only.
    expect(inputsOf('listSnippets')).toEqual([{ query: { type: 'text', limit: 50 } }]);
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => {
      expect(message().value).toBe('Before. Hi Maya, thanks for writing.After.');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // The draft holds it, so it is kept when the conversation is left and come back to.
    expect(drafts.get(id)?.text).toBe('Before. Hi Maya, thanks for writing.After.');
    await waitFor(() => {
      expect(document.activeElement).toBe(message());
    });
    expect(message().selectionStart).toBe(36);
    expect(screen.queryByText(/Still to fill in/)).toBeNull();
  });

  it('opens on a "/" at the start of a word and replaces what was typed after it', async () => {
    serve([directions, hello]);
    const { user } = showComposer({ composer: textOnly() });
    await user.type(message(), 'Sure. /dir');
    const picker = await screen.findByRole('dialog', { name: 'Snippets' });
    const search = within(picker).getByRole('combobox');
    await waitFor(() => {
      expect(document.activeElement).toBe(search);
    });
    await within(picker).findByRole('option');
    expect(inputsOf('listSnippets').at(-1)).toMatchObject({ query: { type: 'text' } });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(message().value).toBe('Sure. Park at the back, by the blue door.');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves the text alone on Escape, and stays closed while that word is typed', async () => {
    serve([directions]);
    const { user } = showComposer({ composer: textOnly() });
    await user.type(message(), 'See /');
    const picker = await screen.findByRole('dialog', { name: 'Snippets' });
    await within(picker).findByRole('option');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(message().value).toBe('See /');
    await waitFor(() => {
      expect(document.activeElement).toBe(message());
    });
    expect(message().selectionStart).toBe(5);
    await user.keyboard('map');
    expect(message().value).toBe('See /map');
    expect(screen.queryByRole('dialog')).toBeNull();
    // A new word with a "/" is a new question.
    await user.keyboard(' and /');
    expect(await screen.findByRole('dialog', { name: 'Snippets' })).toBeTruthy();
  });

  it('closes a picker the "/" opened when the "/" is deleted, and opens none inside a word', async () => {
    serve([directions]);
    const { user } = showComposer({ composer: textOnly() });
    await user.type(message(), 'and/or 10/12');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(message(), { target: { value: 'and/or 10/12 /', selectionStart: 14 } });
    expect(await screen.findByRole('dialog', { name: 'Snippets' })).toBeTruthy();
    fireEvent.change(message(), { target: { value: 'and/or 10/12 ', selectionStart: 13 } });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('closes from its button, and when the reply is sent', async () => {
    serve([directions]);
    const { user, sent } = showComposer({ composer: textOnly(), draft: { text: 'On my way.' } });
    await user.click(snippetsButton());
    await screen.findByRole('dialog', { name: 'Snippets' });
    await user.click(snippetsButton());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(snippetsButton().getAttribute('aria-expanded')).toBe('false');
    await user.click(snippetsButton());
    await screen.findByRole('dialog', { name: 'Snippets' });
    fireEvent.submit(screen.getByRole('form', { name: 'Reply to Maya Thompson' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on a press elsewhere without taking the keyboard back', async () => {
    serve([directions]);
    const { user } = showComposer({ composer: textOnly() });
    await user.click(snippetsButton());
    await screen.findByRole('dialog', { name: 'Snippets' });
    const sendBy = screen.getByLabelText('Send by');
    await user.click(sendBy);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).not.toBe(message());
  });

  it('offers an email its snippets, and keeps the subject the reply already has', async () => {
    serve([directions, welcome]);
    const { user, drafts } = showComposer();
    await user.click(snippetsButton());
    const picker = await screen.findByRole('dialog', { name: 'Snippets' });
    await within(picker).findByRole('listbox', { name: 'Email snippets' });
    expect(inputsOf('listSnippets')).toEqual([{ query: { type: 'email', limit: 50 } }]);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(message().value).toBe('Welcome aboard, Maya.');
    });
    expect(screen.getByLabelText('Subject')).toHaveProperty('value', 'Re: June 13');
    expect(drafts.get(id)?.subject).toBeUndefined();
  });

  it('gives an email with no subject the snippet’s', async () => {
    serve([welcome]);
    const { user, drafts } = showComposer({ composer: composerOf({ suggestedSubject: null }) });
    await user.click(snippetsButton());
    await within(await screen.findByRole('dialog', { name: 'Snippets' })).findByRole('option');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(message().value).toBe('Welcome aboard, Maya.');
    });
    expect(screen.getByLabelText('Subject')).toHaveProperty('value', 'Welcome to Harbor Lights');
    expect(drafts.get(id)).toMatchObject({
      subject: 'Welcome to Harbor Lights',
      text: 'Welcome aboard, Maya.',
    });
  });

  it('says which fields a message still holds, as long as it holds them', async () => {
    serve([hello], (operation) =>
      operation === 'renderSnippet'
        ? { ok: false, code: 'missing_values', fields: ['contact.first_name'] }
        : undefined,
    );
    const { user } = showComposer({ composer: textOnly() });
    await user.click(snippetsButton());
    await within(await screen.findByRole('dialog', { name: 'Snippets' })).findByRole('option');
    await user.keyboard('{Enter}');
    await user.click(
      await screen.findByRole('button', { name: 'Insert with the fields unfilled' }),
    );
    await waitFor(() => {
      expect(message().value).toBe('Hi {{contact.first_name}}, thanks for writing.');
    });
    const warning = screen.getByText(/Still to fill in/);
    expect(warning.textContent).toBe(
      'Still to fill in: {{contact.first_name}}. A reply is sent as it is written, so replace each one before you send.',
    );
    expect(message().getAttribute('aria-describedby')).toBe(warning.id);
    fireEvent.change(message(), { target: { value: 'Hi Maya, thanks for writing.' } });
    expect(screen.queryByText(/Still to fill in/)).toBeNull();
    expect(message().hasAttribute('aria-describedby')).toBe(false);
  });

  it('keeps the picker open and says so when the snippet does not fit a chat message', async () => {
    const long = snippetOf(9, 'Long', 'x'.repeat(1500));
    serve([long]);
    const { user } = showComposer({
      composer: composerOf({ suggestedChannel: 'webchat', channels: [openChat] }),
      draft: { text: 'y'.repeat(900) },
    });
    await user.click(snippetsButton());
    await within(await screen.findByRole('dialog', { name: 'Snippets' })).findByRole('option');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('“Long” is too long to fit in this message.')).toBeTruthy();
    expect(message().value).toBe('y'.repeat(900));
  });

  it('offers no snippets where the contact is not known, and none in a note', async () => {
    serve([directions]);
    const { user } = showComposer({ composer: textOnly(), contact: undefined });
    expect(screen.queryByRole('button', { name: 'Snippets' })).toBeNull();
    await user.type(message(), '/');
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    showComposer({ composer: textOnly(), draft: { mode: 'note' } });
    expect(screen.queryByRole('button', { name: 'Snippets' })).toBeNull();
  });
});
