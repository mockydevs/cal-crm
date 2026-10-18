// @vitest-environment jsdom
// Settings → Manage Scoring: the rules table in GoHighLevel's words, the dialog that adds a
// rule (checked by the API's own schema), publishing the draft, and the contact's score. The
// API is a small world shaped by the contract's own types (e2e/scoring-fixtures.ts).
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createScoreRuleIn,
  deleteScoreRuleIn,
  isRefusal,
  profileOf,
  publishIn,
  renameIn,
  scoredContactId,
  scoringForms,
  scoringTagId,
  scoringTags,
  scoringWorldOf,
  setScoreIn,
  updateScoreRuleIn,
  type ScoringWorld,
} from '../../e2e/scoring-fixtures';
import ContactScore from './contact-score';
import ManageScoringPage from './settings-page';

interface Input {
  readonly body?: unknown;
  readonly params?: { readonly ruleId?: string };
}
const server = vi.hoisted(
  (): { world: ScoringWorld | undefined; writes: unknown[]; asked: string[] } => ({
    world: undefined,
    writes: [],
    asked: [],
  }),
);

vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: Input) =>
      Promise.resolve().then(() => {
        const world = server.world;
        if (world === undefined) throw new Error('no server');
        server.asked.push(endpoint.operationId);
        if (input.body !== undefined) server.writes.push(input.body);
        const id = input.params?.ruleId ?? '';
        const answers: Record<string, () => unknown> = {
          getScoreProfile: () => profileOf(world),
          getTagConfiguration: () => scoringTags,
          listForms: () => scoringForms,
          createScoreRule: () => createScoreRuleIn(world, input.body),
          updateScoreRule: () => updateScoreRuleIn(world, id, input.body),
          deleteScoreRule: () => (deleteScoreRuleIn(world, id), null),
          publishScoreProfile: () => publishIn(world, input.body),
          updateScoreProfile: () => renameIn(world, input.body),
          getContactScore: () => world.score,
          setContactScore: () => setScoreIn(world, input.body),
        };
        const answer = answers[endpoint.operationId]?.();
        if (answer === undefined) throw new Error(`unexpected ${endpoint.operationId}`);
        if (isRefusal(answer))
          throw new ApiError({ type: 'about:blank', title: 'Refused', ...answer });
        return answer;
      }),
  }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('../shell/page', () => ({
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

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 60000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  server.world = undefined;
  server.writes = [];
  server.asked = [];
});
afterEach(cleanup);

function show(
  part: ReactNode,
  world: ScoringWorld = scoringWorldOf(),
): { world: ScoringWorld; user: ReturnType<typeof userEvent.setup> } {
  server.world = world;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>{part}</I18nProvider>
    </QueryClientProvider>,
  );
  return { world, user: userEvent.setup() };
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}

const rows = (): string[] =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .concat(within(row).getAllByRole('rowheader'))
        .map((cell) => cell.textContent)
        .join(' | '),
    );

it('reads each rule as GoHighLevel does, with its calculation and points', async () => {
  show(<ManageScoringPage />);
  expect(await screen.findByRole('tab', { name: 'Engagement Score' })).toBeTruthy();
  await screen.findByText('if an email is - Bounced');
  expect(rows()).toEqual([
    'Subtract points | -5 |  | if an email is - Bounced',
    'Add points | +1 |  | if an appointment Status is - Confirmed',
    'Add points | +1 |  | if a contact replies and contact Has tag - Hot lead',
  ]);
  expect(screen.getByText(/Every rule here scores what contacts do/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/Email opened, Email link clicked, Order form submission/)).toBeTruthy();
});

it('finds rules by their words', async () => {
  const { user } = show(<ManageScoringPage />);
  await screen.findByText('if an email is - Bounced');
  await user.type(screen.getByRole('searchbox', { name: 'Search rules' }), 'hot');
  expect(rows()).toEqual([
    'Add points | +1 |  | if a contact replies and contact Has tag - Hot lead',
  ]);
  await user.clear(screen.getByRole('searchbox', { name: 'Search rules' }));
  await user.type(screen.getByRole('searchbox', { name: 'Search rules' }), 'nothing like it');
  expect(screen.getByText('No rules match.')).toBeTruthy();
});

it('adds a rule to the draft, as the API takes it, and publishes the draft', async () => {
  const { world, user } = show(<ManageScoringPage />);
  await user.click(await screen.findByRole('button', { name: 'Add new rule' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add new rule' });
  await choose(user, within(dialog).getByRole('combobox', { name: 'Action' }), 'Contact tag');
  // A tag rule needs its tag.
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(within(dialog).getByText('Choose the tag this rule scores.')).toBeTruthy();
  await choose(user, within(dialog).getByRole('combobox', { name: 'Tag' }), 'VIP');
  await choose(user, within(dialog).getByRole('combobox', { name: 'Calculation' }), 'Add points');
  await user.clear(within(dialog).getByRole('spinbutton', { name: 'Points' }));
  await user.type(within(dialog).getByRole('spinbutton', { name: 'Points' }), '10');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(server.writes.at(-1)).toEqual({
    when: { action: 'contact_tag', change: 'added', tagId: scoringTagId(2) },
    hasTagId: null,
    calculation: 'add',
    points: 10,
  });
  expect(await screen.findByText('if a tag is added - VIP')).toBeTruthy();
  expect(
    screen.getByText(/The draft has changes that score nothing until you publish them/),
  ).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Publish' }));
  await waitFor(() => {
    expect(world.liveRules).toBe(4);
  });
  expect(server.writes.at(-1)).toEqual({ revision: 4 });
  expect(await screen.findByText(/Every rule here scores what contacts do/)).toBeTruthy();
});

it('asks for another tag when the one a rule names was deleted, and links each error', async () => {
  const gone = scoringTagId(9);
  const world = scoringWorldOf();
  const [first] = world.rules;
  if (first === undefined) throw new Error('No rule.');
  world.rules = [
    {
      ...first,
      when: { action: 'contact_tag', change: 'added', tagId: gone },
      hasTagId: gone,
      problems: [{ code: 'tag_missing', id: gone, message: 'A tag this rule names was deleted.' }],
    },
  ];
  const { user } = show(<ManageScoringPage />, world);
  const said = 'if a tag is added - a deleted tag and contact Has tag - a deleted tag';
  await screen.findByText(said);
  await user.click(screen.getByRole('button', { name: `Actions for ${said}` }));
  await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit rule' });
  const tagBox = within(dialog).getByRole('combobox', { name: 'Tag' });
  const onlyWith = within(dialog).getByRole('combobox', { name: 'Only contacts with the tag' });
  expect(tagBox.textContent).toContain('(deleted)');
  expect(onlyWith.textContent).toContain('(deleted)');
  const describedBy = (control: HTMLElement): string =>
    (control.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
  expect(describedBy(tagBox)).toContain('That tag was deleted. Choose another.');
  expect(describedBy(onlyWith)).toContain('That tag was deleted. Choose another, or any contact.');
  expect(tagBox.getAttribute('aria-invalid')).toBe('true');

  const writes = server.writes.length;
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(server.writes).toHaveLength(writes);
  await choose(user, tagBox, 'VIP');
  await choose(user, onlyWith, 'Any contact');
  await user.clear(within(dialog).getByRole('spinbutton', { name: 'Points' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  const points = within(dialog).getByRole('spinbutton', { name: 'Points' });
  expect(describedBy(points)).toContain('Enter whole points from 1 to 1,000.');
  expect(server.writes).toHaveLength(writes);
  await user.type(points, '4');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(server.writes.at(-1)).toMatchObject({
    when: { action: 'contact_tag', change: 'added', tagId: scoringTagId(2) },
    hasTagId: null,
    points: 4,
  });
});

it('says why a publish was refused when the draft changed meanwhile', async () => {
  const world = scoringWorldOf({ publishedRevision: 2 });
  const { user } = show(<ManageScoringPage />, world);
  await screen.findByText('if an email is - Bounced');
  world.revision = 9;
  await user.click(screen.getByRole('button', { name: 'Publish' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'The rules changed since this page read them. They were read again: check them and publish once more.',
  );
});

it('deletes a rule after asking', async () => {
  const { world, user } = show(<ManageScoringPage />);
  await screen.findByText('if an email is - Bounced');
  await user.click(screen.getByRole('button', { name: 'Actions for if an email is - Bounced' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
  const asking = await screen.findByRole('dialog', { name: 'Delete this rule?' });
  await user.click(within(asking).getByRole('button', { name: 'Delete' }));
  await waitFor(() => {
    expect(world.rules).toHaveLength(2);
  });
  await waitFor(() => {
    expect(screen.queryByText('if an email is - Bounced')).toBeNull();
  });
  // The change reads the rules again, not the forms they can name.
  expect(server.asked.filter((each) => each === 'getScoreProfile')).toHaveLength(2);
  expect(server.asked.filter((each) => each === 'listForms')).toHaveLength(1);
});

it('shows the rules without changing them to someone who may not', async () => {
  show(<ManageScoringPage />, scoringWorldOf({ canManage: false }));
  await screen.findByText('if an email is - Bounced');
  expect(screen.queryByRole('button', { name: 'Add new rule' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  expect(screen.getByText(/Changing them needs permission to configure fields/)).toBeTruthy();
});

it("shows the contact's score when opened, and sets it", async () => {
  const { world, user } = show(<ContactScore contactId={scoredContactId} readOnly={false} />);
  const toggle = screen.getByRole('button', { name: 'Contact Engagement Score' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await user.click(toggle);
  expect((await screen.findByTestId('engagement-score')).textContent).toBe('12');
  expect(screen.getByRole('list', { name: 'Latest changes' }).textContent).toContain(
    'A scoring rule',
  );
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  const box = screen.getByRole('spinbutton', { name: 'Engagement score' });
  await user.clear(box);
  await user.type(box, '1.5');
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  await user.clear(box);
  await user.type(box, '40');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(world.score.score).toBe(40);
  });
  expect((await screen.findByTestId('engagement-score')).textContent).toBe('40');
  expect(screen.getByRole('list', { name: 'Latest changes' }).textContent).toContain('Set by hand');
});

it('lets nobody edit the score of a contact in the trash', async () => {
  const { user } = show(<ContactScore contactId={scoredContactId} readOnly />);
  await user.click(screen.getByRole('button', { name: 'Contact Engagement Score' }));
  await screen.findByTestId('engagement-score');
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});
