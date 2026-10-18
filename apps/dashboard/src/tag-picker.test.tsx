// @vitest-environment jsdom
// The tag chips a setting shows (tag-picker.tsx): chosen tags with a button that takes each
// off, and a panel that searches, groups and makes tags, by mouse and by keyboard.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { TagConfiguration, TagDefinition } from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TagPicker } from './tag-picker';

const at = '2026-10-10T09:00:00.000Z';
const idOf = (number: number): string =>
  `tag_01k8e2wzr0e00800000000${String(number).padStart(4, '0')}`;
const tagOf = (number: number, name: string, groupId: string | null = null): TagDefinition => ({
  id: idOf(number),
  name,
  description: '',
  createdAt: at,
  updatedAt: at,
  groupId,
  revision: 'a'.repeat(64),
});
const sales = {
  id: 'tgrp_01k8e2wzr0e008000000000001',
  name: 'Sales',
  description: '',
  revision: 'a'.repeat(64),
};
const hot = tagOf(1, 'Hot lead', sales.id);
const cold = tagOf(2, 'Cold lead', sales.id);
const wedding = tagOf(3, 'Wedding enquiry');
const website = tagOf(4, 'Website');
const configurationOf = (patch: Partial<TagConfiguration> = {}): TagConfiguration => ({
  items: [cold, hot, website, wedding],
  groups: [sales],
  rules: { creation: 'everyone', suggestSimilar: true, revision: 'a'.repeat(64) },
  canManage: true,
  canCreate: true,
  ...patch,
});

interface Server {
  configuration: () => TagConfiguration | Promise<TagConfiguration>;
  create: (name: string) => TagDefinition | Promise<TagDefinition>;
  calls: { operation: string; input: unknown }[];
}
let server: Server;
const client = {
  request: (endpoint: { operationId: string }, input: { body?: { name: string } }) => {
    server.calls.push({ operation: endpoint.operationId, input });
    return Promise.resolve().then(() =>
      endpoint.operationId === 'createTag'
        ? server.create(input.body?.name ?? '')
        : server.configuration(),
    );
  },
} as unknown as Client;

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  // jsdom draws nothing, so it has nothing to scroll.
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  server = {
    configuration: () => configurationOf(),
    create: (name) => tagOf(99, name),
    calls: [],
  };
});
afterEach(cleanup);

const changes: string[][] = [];
function Held({
  initial,
  limit,
  disabled,
}: {
  readonly initial: readonly string[];
  readonly limit: number;
  readonly disabled: boolean;
}): ReactElement {
  const [chosen, setChosen] = useState<readonly string[]>(initial);
  return (
    <TagPicker
      label="Tags added to the contact"
      chosen={chosen}
      limit={limit}
      disabled={disabled}
      client={client}
      cacheKey={['tags']}
      onChange={(next) => {
        changes.push(next);
        setChosen(next);
      }}
    />
  );
}
function show(
  initial: readonly string[] = [],
  { limit = 10, disabled = false }: { limit?: number; disabled?: boolean } = {},
): ReturnType<typeof userEvent.setup> {
  changes.length = 0;
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <Held initial={initial} limit={limit} disabled={disabled} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}
const chips = (): string[] =>
  within(screen.getByRole('list', { name: 'Tags added to the contact' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent);
const opened = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await user.click(screen.getByRole('button', { name: 'Add tag' }));
  return screen.findByRole('combobox', { name: 'Search tags' });
};
const options = (): string[] => screen.queryAllByRole('option').map((option) => option.textContent);

it('shows the chosen tags as chips in their order, and takes one off with its button', async () => {
  const user = show([wedding.id, hot.id]);
  await waitFor(() => {
    expect(chips()).toEqual(['Wedding enquiry', 'Hot lead']);
  });
  await user.click(screen.getByRole('button', { name: 'Remove Wedding enquiry' }));
  expect(changes).toEqual([[hot.id]]);
  expect(chips()).toEqual(['Hot lead']);
  // Said aloud, and the keyboard is on the button that adds a tag.
  expect(screen.getAllByRole('status').map((each) => each.textContent)).toContain(
    'Removed Wedding enquiry.',
  );
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add tag' }));
});

it('says so when no tag is chosen, and offers every tag by group', async () => {
  const user = show();
  expect(screen.getByText('No tags chosen.')).toBeTruthy();
  const box = await opened(user);
  await waitFor(() => {
    expect(options()).toEqual(['Cold lead', 'Hot lead', 'Website', 'Wedding enquiry']);
  });
  const list = screen.getByRole('listbox', { name: 'Tags to add' });
  expect(
    within(within(list).getByRole('group', { name: 'Sales' }))
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['Cold lead', 'Hot lead']);
  expect(
    within(within(list).getByRole('group', { name: 'Other tags' }))
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['Website', 'Wedding enquiry']);
  expect(box.getAttribute('aria-expanded')).toBe('true');
  expect(box.getAttribute('aria-controls')).toBe(list.id);
  // How many there are is said to a screen reader, and not drawn.
  const said = screen.getAllByRole('status').find((each) => each.textContent === '4 tags to add');
  expect(said?.className).toBe('sr-only');
});

it('narrows as the person types, and Enter adds the first match and keeps the panel open', async () => {
  const user = show([website.id]);
  const box = await opened(user);
  await waitFor(() => {
    expect(options()).toHaveLength(3);
  });
  await user.type(box, 'lead');
  // The matches first, and under them the offer to make a tag of that very name.
  expect(options()).toEqual(['Cold lead', 'Hot lead', 'Create tag “lead”']);
  expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]?.id);
  expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
  await user.keyboard('{Enter}');
  expect(changes).toEqual([[website.id, cold.id]]);
  expect(chips()).toEqual(['Website', 'Cold lead']);
  // Ready for the next one: the box is empty, still open, and holds the keyboard.
  expect(box).toHaveProperty('value', '');
  expect(document.activeElement).toBe(box);
  expect(options()).toEqual(['Hot lead', 'Wedding enquiry']);
  expect(screen.getAllByRole('status').map((each) => each.textContent)).toContain(
    'Added Cold lead.',
  );
  expect(screen.getAllByRole('status').map((each) => each.textContent)).toContain('2 tags to add');
});

it('moves through the list with the arrow keys, round its ends, and adds the row it is on', async () => {
  const user = show();
  const box = await opened(user);
  await waitFor(() => {
    expect(options()).toHaveLength(4);
  });
  const rowAt = (): string | null | undefined =>
    screen
      .getAllByRole('option')
      .find((option) => option.id === box.getAttribute('aria-activedescendant'))?.textContent;
  expect(box.getAttribute('aria-activedescendant')).toBeNull();
  // Enter with no row chosen and several to choose from adds nothing.
  await user.keyboard('{Enter}');
  expect(changes).toEqual([]);
  await user.keyboard('{ArrowDown}');
  expect(rowAt()).toBe('Cold lead');
  await user.keyboard('{ArrowUp}');
  expect(rowAt()).toBe('Wedding enquiry');
  await user.keyboard('{Home}{ArrowDown}');
  expect(rowAt()).toBe('Hot lead');
  await user.keyboard('{End}');
  expect(rowAt()).toBe('Wedding enquiry');
  await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  expect(changes).toEqual([[hot.id]]);
});

it('adds the tag that is pressed', async () => {
  const user = show();
  await opened(user);
  await user.click(await screen.findByRole('option', { name: 'Website' }));
  expect(changes).toEqual([[website.id]]);
  expect(chips()).toEqual(['Website']);
});

it('adds the only match on Enter even when the arrows were not used', async () => {
  server.configuration = () => configurationOf({ items: [website], groups: [], canCreate: false });
  const user = show();
  await opened(user);
  await screen.findByRole('option', { name: 'Website' });
  // One list, so no group and no heading.
  expect(screen.queryByRole('group')).toBeNull();
  await user.keyboard('{Enter}');
  expect(changes).toEqual([[website.id]]);
  expect(await screen.findByText('Every tag is already chosen.')).toBeTruthy();
});

it('makes a new tag from the words typed, for someone who may, and shows it at once', async () => {
  let release: (tag: TagDefinition) => void = () => undefined;
  server.create = (name) =>
    new Promise<TagDefinition>((resolve) => {
      release = () => {
        resolve(tagOf(99, name));
      };
    });
  const user = show([hot.id]);
  const box = await opened(user);
  await waitFor(() => {
    expect(options()).toHaveLength(3);
  });
  await user.type(box, ' VIP guest ');
  expect(options()).toEqual(['Create tag “VIP guest”']);
  expect(box.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option').id);
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('option', { name: 'Creating “VIP guest”…' })).toBeTruthy();
  // A second Enter while it is being made makes nothing more.
  await user.keyboard('{Enter}');
  release(tagOf(99, 'VIP guest'));
  await waitFor(() => {
    expect(changes).toEqual([[hot.id, idOf(99)]]);
  });
  expect(server.calls.filter((call) => call.operation === 'createTag')).toEqual([
    { operation: 'createTag', input: { body: { name: 'VIP guest' } } },
  ]);
  // Named by what it was made with, though the business's list read again does not hold it.
  expect(chips()).toEqual(['Hot lead', 'VIP guest']);
  expect(box).toHaveProperty('value', '');
});

it('makes a new tag when its row is pressed', async () => {
  const user = show();
  const box = await opened(user);
  await user.type(box, 'Gold');
  await user.click(await screen.findByRole('option', { name: 'Create tag “Gold”' }));
  await waitFor(() => {
    expect(changes).toEqual([[idOf(99)]]);
  });
});

it('says why a tag could not be made, in the server words or its own', async () => {
  server.create = () => {
    throw new ApiError({
      type: 'about:blank',
      title: 'Refused',
      status: 403,
      detail: 'Only owners and admins make tags.',
    });
  };
  const user = show();
  const box = await opened(user);
  await user.type(box, 'Gold{Enter}');
  expect((await screen.findByRole('alert')).textContent).toBe('Only owners and admins make tags.');
  expect(changes).toEqual([]);
  // Typing again takes the message away.
  await user.type(box, 'en');
  expect(screen.queryByRole('alert')).toBeNull();
  server.create = () => {
    throw new TypeError('Failed to fetch');
  };
  await user.keyboard('{Enter}');
  expect((await screen.findByRole('alert')).textContent).toBe(
    "The tag wasn't made. Check your connection and try again.",
  );
});

it('offers no new tag to someone who may not make one, and says when nothing matches or it is chosen', async () => {
  server.configuration = () => configurationOf({ canCreate: false });
  const user = show([hot.id]);
  const box = await opened(user);
  await waitFor(() => {
    expect(options()).toHaveLength(3);
  });
  expect(box.getAttribute('placeholder')).toBe('Search tags');
  await user.type(box, 'VIP');
  expect(options()).toEqual([]);
  expect(screen.getByText('No tags match.')).toBeTruthy();
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(box.getAttribute('aria-expanded')).toBe('false');
  expect(box.getAttribute('aria-controls')).toBeNull();
  await user.keyboard('{Enter}{ArrowDown}');
  expect(changes).toEqual([]);
  await user.clear(box);
  await user.type(box, 'hot-lead');
  expect(screen.getByText('This tag is already chosen.')).toBeTruthy();
});

it('says where things stand when there is nothing to list', async () => {
  server.configuration = () => configurationOf({ items: [], groups: [] });
  const user = show();
  await opened(user);
  expect(
    await screen.findByText('There are no tags yet. Type a name to make the first one.'),
  ).toBeTruthy();
  cleanup();
  server.configuration = () => configurationOf({ items: [], groups: [], canCreate: false });
  await opened(show());
  expect(
    await screen.findByText(
      'There are no tags yet. Make them in Settings, under Custom Fields & Tags.',
    ),
  ).toBeTruthy();
  cleanup();
  server.configuration = () => configurationOf({ items: [hot], groups: [] });
  await opened(show([hot.id]));
  expect(
    await screen.findByText('Every tag is already chosen. Type a name to make a new one.'),
  ).toBeTruthy();
});

it('shows a first screenful of a long list and narrows it by typing', async () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    tagOf(100 + index, `Campaign ${String(index + 1).padStart(2, '0')}`),
  );
  server.configuration = () => configurationOf({ items: many, groups: [] });
  const user = show();
  const box = await opened(user);
  await waitFor(() => {
    expect(options()).toHaveLength(50);
  });
  expect(screen.getByText('Showing 50 of 60. Type to narrow the list.')).toBeTruthy();
  await user.type(box, 'campaign 57');
  expect(options()).toEqual(['Campaign 57']);
  await user.keyboard('{Enter}');
  expect(changes).toEqual([[idOf(156)]]);
});

it('takes no more than its limit, and says how to make room', async () => {
  const user = show([hot.id, cold.id], { limit: 2 });
  await waitFor(() => {
    expect(chips()).toHaveLength(2);
  });
  await user.click(screen.getByRole('button', { name: 'Add tag' }));
  expect(
    await screen.findByText('2 tags are chosen, which is the most. Remove one to add another.'),
  ).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('reaches its limit while open, and then offers nothing more', async () => {
  const user = show([hot.id], { limit: 2 });
  await opened(user);
  await user.click(await screen.findByRole('option', { name: 'Website' }));
  expect(changes).toEqual([[hot.id, website.id]]);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByText(/2 tags are chosen, which is the most/)).toBeTruthy();
});

it('shows the tags and changes nothing when it is disabled', async () => {
  show([hot.id], { disabled: true });
  await waitFor(() => {
    expect(chips()).toEqual(['Hot lead']);
  });
  expect(screen.queryByRole('button', { name: 'Add tag' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove Hot lead' })).toBeNull();
});

it('shows a tag that no longer exists as deleted, and lets it be taken off', async () => {
  const user = show(['tag_01k8e2wzr0e008000000009999', hot.id]);
  await waitFor(() => {
    expect(chips()).toEqual(['Deleted tag', 'Hot lead']);
  });
  await user.click(screen.getByRole('button', { name: 'Remove Deleted tag' }));
  expect(changes).toEqual([[hot.id]]);
});

it('says the chosen tags are loading, and offers another try when they cannot be read', async () => {
  let fail = true;
  server.configuration = () => {
    if (fail) throw new TypeError('Failed to fetch');
    return configurationOf();
  };
  const user = show([hot.id]);
  expect(screen.getByText('Loading tags…')).toBeTruthy();
  expect(
    await screen.findByText("The tags couldn't be loaded. Reload the page to see the chosen tags."),
  ).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Add tag' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain("The tags couldn't be loaded.");
  fail = false;
  await user.click(within(alert).getByRole('button', { name: 'Try again' }));
  await waitFor(() => {
    expect(chips()).toEqual(['Hot lead']);
  });
  expect(options()).toEqual(['Cold lead', 'Website', 'Wedding enquiry']);
});

it('says the tags are loading in the panel while they are read', async () => {
  let release: () => void = () => undefined;
  server.configuration = () =>
    new Promise<TagConfiguration>((resolve) => {
      release = () => {
        resolve(configurationOf());
      };
    });
  const user = show();
  await opened(user);
  expect(screen.getByText('Loading tags…')).toBeTruthy();
  release();
  await waitFor(() => {
    expect(options()).toHaveLength(4);
  });
});
