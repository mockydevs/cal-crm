// @vitest-environment jsdom
// Settings → Lead Sources → Rules: the business's rules as sentences, in their order, with
// the editor, and the built-in rules under them. The API is a small world shaped by the
// contract's own types and schemas (e2e/lead-sources-fixtures.ts).
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  LEAD_SOURCE_RULE_LIMITS,
  leadSourceKeys,
  leadSourceLabels,
  leadSourceRuleDescriptions,
  type LeadSourceRule,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createRule,
  deleteRule,
  fieldId,
  fields,
  funnelRule,
  isRefusal,
  listOf,
  previewOf,
  reorderRules,
  ruleOf,
  springRule,
  tagId,
  tags,
  updateRule,
  worldOf,
  type LeadSourcesWorld,
} from '../../e2e/lead-sources-fixtures';
import RulesTab from './rules-tab';

interface Server {
  world: LeadSourcesWorld;
  /** Answers one request in place of the world, when it returns something. */
  instead: (operation: string, input: Input) => unknown;
}
interface Input {
  readonly body?: unknown;
  readonly params?: { readonly ruleId?: string };
}
const server = vi.hoisted((): { current: Server | undefined } => ({ current: undefined }));

vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: Input) =>
      Promise.resolve().then(() => {
        const held = server.current;
        if (held === undefined) throw new Error('no server');
        const { world } = held;
        const custom = held.instead(endpoint.operationId, input);
        const id = input.params?.ruleId ?? '';
        const answer =
          custom ??
          (endpoint.operationId === 'listLeadSourceRules'
            ? listOf(world)
            : endpoint.operationId === 'getTagConfiguration'
              ? tags
              : endpoint.operationId === 'getFields'
                ? fields
                : endpoint.operationId === 'createLeadSourceRule'
                  ? createRule(world, input.body)
                  : endpoint.operationId === 'updateLeadSourceRule'
                    ? updateRule(world, id, input.body)
                    : endpoint.operationId === 'getLeadSourceRule'
                      ? world.rules.find((rule) => rule.id === id)
                      : endpoint.operationId === 'reorderLeadSourceRules'
                        ? reorderRules(world, input.body)
                        : endpoint.operationId === 'deleteLeadSourceRule'
                          ? (deleteRule(world, id), null)
                          : endpoint.operationId === 'previewLeadSource'
                            ? previewOf(world, input.body)
                            : undefined);
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
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
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
  server.current = undefined;
});
afterEach(cleanup);

function show(
  rules: LeadSourceRule[] = [],
  rest: Partial<LeadSourcesWorld> = {},
): { world: LeadSourcesWorld; user: ReturnType<typeof userEvent.setup> } {
  const world = worldOf(rules, rest);
  server.current = { world, instead: () => undefined };
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <RulesTab />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { world, user: userEvent.setup() };
}

const ownRules = (): HTMLElement => screen.getByRole('region', { name: 'Your rules' });
const names = (): string[] =>
  within(ownRules())
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('aria-label') ?? '');
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}
const lastWrite = (world: LeadSourcesWorld): unknown => world.writes.at(-1)?.body;

it('says when a rule is worth having while there is none, and lists the built-in rules as the contract has them', async () => {
  show();
  expect(await screen.findByText(/most businesses need none/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add rule' })).toBeTruthy();

  const builtIn = screen.getByRole('region', { name: 'Built-in rules' });
  const rows = within(builtIn).getAllByRole('listitem');
  expect(rows).toHaveLength(leadSourceKeys.length);
  leadSourceKeys.forEach((key, index) => {
    const row = rows[index]?.textContent ?? '';
    expect(row).toContain(key === 'source_param' ? 'The name in the link' : leadSourceLabels[key]);
    expect(row).toContain(leadSourceRuleDescriptions[key]);
  });
  // Nothing in the built-in list can be pressed: it is read-only.
  expect(within(builtIn).queryAllByRole('button')).toHaveLength(0);
});

it('reads each rule as a sentence, in the order they are tried', async () => {
  show([springRule(), funnelRule()]);
  await screen.findByText('Spring promo', { selector: 'p' });
  expect(names()).toEqual([
    'Rule 1: Spring promo. When UTM campaign contains “spring” and Lead source (built-in) is Facebook Ads → Source: Spring promo · tags: Promo, VIP',
    'Rule 2: Wedding funnel. When Step (page path) starts with “/wedding” → tags: Wedding enquiry · fills Campaign: wedding',
  ]);
  expect(within(ownRules()).getByText(/^2 of 50\./)).toBeTruthy();
});

it('makes a rule with two conditions and two actions, checked by the schema of the API', async () => {
  const { world, user } = show();
  await user.click(await screen.findByRole('button', { name: 'Add rule' }));
  const editor = await screen.findByRole('form', { name: 'New rule' });
  // The keyboard starts on the name.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(editor).getByLabelText('Name'));
  });
  await user.type(within(editor).getByLabelText('Name'), 'Spring promo');
  await user.type(within(editor).getByRole('textbox', { name: 'Condition 1: value' }), 'spring');

  await user.click(within(editor).getByRole('button', { name: 'Add condition' }));
  await choose(
    user,
    within(editor).getByRole('combobox', { name: 'Condition 2: what to look at' }),
    'Lead source (built-in)',
  );
  await choose(
    user,
    within(editor).getByRole('combobox', { name: 'Condition 2: value' }),
    'Facebook Ads',
  );

  await user.type(within(editor).getByLabelText('Name the Source'), 'Spring promo');
  await user.click(within(editor).getByRole('button', { name: 'Add tag' }));
  await user.click(await screen.findByRole('option', { name: 'Promo' }));
  await user.keyboard('{Escape}');

  await user.click(within(editor).getByRole('button', { name: 'Save rule' }));
  await waitFor(() => {
    expect(screen.queryByRole('form', { name: 'New rule' })).toBeNull();
  });
  expect(lastWrite(world)).toEqual({
    name: 'Spring promo',
    enabled: true,
    conditions: [
      { fact: 'utm_campaign', op: 'contains', value: 'spring' },
      { fact: 'lead_source', op: 'is', value: 'facebook_ads' },
    ],
    source: 'Spring promo',
    tagIds: [tagId(1)],
    fieldWrites: [],
  });
  expect(await screen.findByText('“Spring promo” was saved.')).toBeTruthy();
  await waitFor(() => {
    expect(names()).toEqual([
      'Rule 1: Spring promo. When UTM campaign contains “spring” and Lead source (built-in) is Facebook Ads → Source: Spring promo · tags: Promo',
    ]);
  });
});

it('fills a custom field, lists only the text fields of contacts, and takes a click id as yes or no', async () => {
  const { world, user } = show();
  await user.click(await screen.findByRole('button', { name: 'Add rule' }));
  const editor = await screen.findByRole('form', { name: 'New rule' });
  await user.type(within(editor).getByLabelText('Name'), 'Google clicks');
  await choose(
    user,
    within(editor).getByRole('combobox', { name: 'Condition 1: what to look at' }),
    'Google click ID',
  );
  // A click id is there or it is not: no operator and no value to type.
  expect(
    within(editor).queryByRole('combobox', { name: 'Condition 1: how it is compared' }),
  ).toBeNull();
  expect(within(editor).queryByRole('textbox', { name: 'Condition 1: value' })).toBeNull();
  await choose(
    user,
    within(editor).getByRole('combobox', { name: 'Condition 1: is it in the link' }),
    'No, it is not',
  );

  await user.click(within(editor).getByRole('button', { name: 'Add field' }));
  await user.click(within(editor).getByRole('combobox', { name: 'Field 1: which field' }));
  const offered = (await screen.findAllByRole('option')).map((option) => option.textContent);
  expect(offered).toEqual(['Choose a field', 'Campaign', 'Promo code']);
  await user.click(screen.getByRole('option', { name: 'Promo code' }));
  await user.type(within(editor).getByRole('textbox', { name: 'Field 1: text to write' }), 'none');

  await user.click(within(editor).getByRole('button', { name: 'Save rule' }));
  await waitFor(() => {
    expect(world.rules).toHaveLength(1);
  });
  expect(lastWrite(world)).toMatchObject({
    conditions: [{ fact: 'click_id_google', op: 'is_empty' }],
    source: null,
    fieldWrites: [{ fieldId: fieldId(2), value: 'none' }],
  });
  await waitFor(() => {
    expect(names()).toEqual([
      'Rule 1: Google clicks. When has no Google click ID → fills Promo code: none',
    ]);
  });
});

it('names an address parameter, and lists several values for "is one of"', async () => {
  const { world, user } = show();
  await user.click(await screen.findByRole('button', { name: 'Add rule' }));
  const editor = await screen.findByRole('form', { name: 'New rule' });
  await user.type(within(editor).getByLabelText('Name'), 'Promo codes');
  await choose(
    user,
    within(editor).getByRole('combobox', { name: 'Condition 1: what to look at' }),
    'Address parameter',
  );
  await user.type(
    within(editor).getByRole('textbox', { name: 'Condition 1: parameter name' }),
    'promo',
  );
  await choose(
    user,
    within(editor).getByRole('combobox', { name: 'Condition 1: how it is compared' }),
    'is one of',
  );
  await user.type(
    within(editor).getByRole('textbox', { name: 'Condition 1: values, separated by commas' }),
    'vip, gold',
  );
  await user.type(within(editor).getByLabelText('Name the Source'), 'Promo');
  await user.click(within(editor).getByRole('button', { name: 'Save rule' }));
  await waitFor(() => {
    expect(world.rules).toHaveLength(1);
  });
  expect(lastWrite(world)).toMatchObject({
    conditions: [{ fact: 'parameter', name: 'promo', op: 'is_one_of', values: ['vip', 'gold'] }],
  });
  await waitFor(() => {
    expect(names()).toEqual([
      'Rule 1: Promo codes. When address parameter promo is one of “vip” or “gold” → Source: Promo',
    ]);
  });
});

it('says what is missing at the box it is missing from, in the words of the API, and sends nothing', async () => {
  const { world, user } = show();
  await user.click(await screen.findByRole('button', { name: 'Add rule' }));
  const editor = await screen.findByRole('form', { name: 'New rule' });
  await user.click(within(editor).getByRole('button', { name: 'Save rule' }));
  expect(await within(editor).findByText('Give the rule a name.')).toBeTruthy();
  expect(within(editor).getByText('Enter a value.')).toBeTruthy();
  expect(
    within(editor).getByText('Say what the rule does: name the Source, add a tag or fill a field.'),
  ).toBeTruthy();
  expect(within(editor).getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
  // The keyboard goes to the first box that is wrong.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(editor).getByLabelText('Name'));
  });
  expect(world.writes).toHaveLength(0);

  // Typing takes the marks away.
  await user.type(within(editor).getByLabelText('Name'), 'x');
  expect(within(editor).queryByText('Give the rule a name.')).toBeNull();
});

it("shows the server's refusal at the box it names, and offers the saved version when someone else saved first", async () => {
  const { world, user } = show([springRule(), funnelRule()]);
  await user.click(await screen.findByRole('button', { name: 'Edit “Wedding funnel”' }));
  const editor = await screen.findByRole('form', { name: 'Edit rule Wedding funnel' });
  const name = within(editor).getByLabelText('Name');
  await user.clear(name);
  await user.type(name, 'Spring promo');
  await user.click(within(editor).getByRole('button', { name: 'Save rule' }));
  expect(await within(editor).findByText('Another rule already has this name.')).toBeTruthy();
  expect(name.getAttribute('aria-invalid')).toBe('true');

  // Someone else saves the same rule meanwhile.
  world.rules = world.rules.map((rule) =>
    rule.id === funnelRule().id ? { ...rule, name: 'Weddings', revision: 2 } : rule,
  );
  await user.clear(name);
  await user.type(name, 'Wedding leads');
  await user.click(within(editor).getByRole('button', { name: 'Save rule' }));
  expect(
    await within(editor).findByText('Someone else changed this rule. Reload it and try again.'),
  ).toBeTruthy();
  await user.click(within(editor).getByRole('button', { name: 'Reload saved version' }));
  await waitFor(() => {
    expect(within(editor).getByLabelText<HTMLInputElement>('Name').value).toBe('Weddings');
  });
  await user.click(within(editor).getByRole('button', { name: 'Save rule' }));
  await waitFor(() => {
    expect(world.rules[1]?.revision).toBe(3);
  });
});

it('says its own words when no answer comes, and keeps what was typed', async () => {
  const { user } = show([springRule()]);
  await user.click(await screen.findByRole('button', { name: 'Edit “Spring promo”' }));
  const editor = await screen.findByRole('form', { name: 'Edit rule Spring promo' });
  if (server.current !== undefined)
    server.current.instead = (operation) => {
      if (operation === 'updateLeadSourceRule') throw new TypeError('Failed to fetch');
      return undefined;
    };
  await user.click(within(editor).getByRole('button', { name: 'Save rule' }));
  expect(
    await within(editor).findByText("The rule wasn't saved. Check your connection and try again."),
  ).toBeTruthy();
  expect(within(editor).getByLabelText<HTMLInputElement>('Name').value).toBe('Spring promo');
  await user.click(within(editor).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('form', { name: 'Edit rule Spring promo' })).toBeNull();
});

it('moves a rule up and down, says where it went, and keeps the keyboard on it', async () => {
  const { world, user } = show([springRule(), funnelRule(), ruleOf(3, { name: 'Third' })]);
  const up = await screen.findByRole('button', { name: 'Move “Third” up' });
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Move “Spring promo” up' }).disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Move “Third” down' }).disabled,
  ).toBe(true);
  await user.click(up);
  expect(await screen.findByText('“Third” is now rule 2 of 3.')).toBeTruthy();
  expect(world.rules.map((rule) => rule.name)).toEqual(['Spring promo', 'Third', 'Wedding funnel']);
  expect(world.rules.map((rule) => rule.position)).toEqual([1, 2, 3]);
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move “Third” up' }));
  });
  await user.click(screen.getByRole('button', { name: 'Move “Third” up' }));
  expect(await screen.findByText('“Third” is now rule 1 of 3.')).toBeTruthy();
  // At the top its "up" is off: the keyboard is on its "down".
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move “Third” down' }));
  });
  await user.click(screen.getByRole('button', { name: 'Move “Spring promo” down' }));
  expect(await screen.findByText('“Spring promo” is now rule 3 of 3.')).toBeTruthy();
  expect(world.rules.map((rule) => rule.name)).toEqual(['Third', 'Wedding funnel', 'Spring promo']);
});

it('reads the rules again when they changed under a move, and says so', async () => {
  const { world, user } = show([springRule(), funnelRule()]);
  const down = await screen.findByRole('button', { name: 'Move “Spring promo” down' });
  // Someone else adds a rule: the list this page read is stale.
  createRule(world, {
    name: 'Elsewhere',
    conditions: [{ fact: 'utm_source', op: 'is', value: 'x' }],
    source: 'X',
  });
  await user.click(down);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain(
    'The rules changed since this page read them',
  );
  await waitFor(() => {
    expect(names()).toHaveLength(3);
  });
  expect(world.rules.map((rule) => rule.name)).toEqual([
    'Spring promo',
    'Wedding funnel',
    'Elsewhere',
  ]);
});

it('switches a rule off and on, duplicates it and deletes it after asking', async () => {
  const { world, user } = show([springRule(), funnelRule()]);
  const toggle = await screen.findByRole('switch', { name: 'Use “Spring promo”' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await user.click(toggle);
  expect(await screen.findByText('“Spring promo” is off.')).toBeTruthy();
  expect(world.rules[0]?.enabled).toBe(false);
  // The whole rule is sent back with its revision: nothing of it is lost by the switch.
  expect(lastWrite(world)).toMatchObject({
    revision: 1,
    name: 'Spring promo',
    enabled: false,
    conditions: springRule().conditions,
    tagIds: [tagId(1), tagId(2)],
  });
  await waitFor(() => {
    expect(
      screen.getByRole('switch', { name: 'Use “Spring promo”' }).getAttribute('aria-checked'),
    ).toBe('false');
  });
  expect(within(ownRules()).getByText('Off')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Duplicate “Wedding funnel”' }));
  expect(await screen.findByText('“Wedding funnel (copy)” was added last.')).toBeTruthy();
  expect(world.rules.map((rule) => rule.name)).toEqual([
    'Spring promo',
    'Wedding funnel',
    'Wedding funnel (copy)',
  ]);
  expect(world.rules[2]).toMatchObject({
    source: null,
    tagIds: [tagId(3)],
    fieldWrites: [{ fieldId: fieldId(1), value: 'wedding' }],
  });

  await user.click(screen.getByRole('button', { name: 'Delete “Wedding funnel”' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete rule' });
  expect(dialog.textContent).toContain('Leads it already named keep their Source and tags.');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(world.rules).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'Delete “Wedding funnel”' }));
  await user.click(
    within(await screen.findByRole('dialog', { name: 'Delete rule' })).getByRole('button', {
      name: 'Delete rule',
    }),
  );
  expect(await screen.findByText('“Wedding funnel” was deleted.')).toBeTruthy();
  expect(world.rules.map((rule) => rule.name)).toEqual(['Spring promo', 'Wedding funnel (copy)']);
});

it('says plainly when the limits are reached: fifty rules, five conditions', async () => {
  const fifty = Array.from({ length: LEAD_SOURCE_RULE_LIMITS.rules }, (_, index) =>
    ruleOf(index + 1),
  );
  const { user } = show(fifty);
  expect(
    await screen.findByText('50 of 50, which is the most. Delete a rule to add another.'),
  ).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add rule' }).disabled).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Duplicate “Rule 1”' }).disabled,
  ).toBe(true);

  await user.click(screen.getByRole('button', { name: 'Edit “Rule 1”' }));
  const editor = await screen.findByRole('form', { name: 'Edit rule Rule 1' });
  for (let count = 1; count < LEAD_SOURCE_RULE_LIMITS.conditions; count += 1)
    await user.click(within(editor).getByRole('button', { name: 'Add condition' }));
  expect(within(editor).queryByRole('button', { name: 'Add condition' })).toBeNull();
  expect(within(editor).getByText('A rule holds at most 5 conditions.')).toBeTruthy();
  // A row can be taken off again, and the last one cannot.
  await user.click(within(editor).getByRole('button', { name: 'Remove condition 5' }));
  expect(within(editor).getByRole('button', { name: 'Add condition' })).toBeTruthy();
});

it('tries a link against the rule as it stands in the editor, matching and not', async () => {
  const { world, user } = show([springRule()]);
  await user.click(await screen.findByRole('button', { name: 'Edit “Spring promo”' }));
  const editor = await screen.findByRole('form', { name: 'Edit rule Spring promo' });
  const trial = within(editor).getByRole('group', { name: 'Try a link' });
  const link = within(trial).getByRole('textbox', { name: 'Link to try' });

  await user.type(
    link,
    'www.example.com/offer?utm_source=facebook&utm_medium=paid_social&utm_campaign=Spring-2026',
  );
  await user.click(within(trial).getByRole('button', { name: 'Try' }));
  expect(await within(trial).findByText('This rule would match this link.')).toBeTruthy();
  expect(
    within(trial)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual([
    'Holds: UTM campaign contains “spring”',
    'Holds: Lead source (built-in) is Facebook Ads',
  ]);
  // The server read the address; it was sent with https put back, and nothing was saved.
  expect(world.checked.at(-1)?.url).toBe(
    'https://www.example.com/offer?utm_source=facebook&utm_medium=paid_social&utm_campaign=Spring-2026',
  );
  expect(world.writes).toHaveLength(0);

  await user.clear(link);
  await user.type(link, 'https://www.example.com/offer?gclid=abc&utm_campaign=spring{Enter}');
  expect(await within(trial).findByText('This rule would not match this link.')).toBeTruthy();
  expect(
    within(trial)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual([
    'Holds: UTM campaign contains “spring”',
    'Does not hold: Lead source (built-in) is Facebook Ads',
  ]);
  // Enter in the box tried the link: the rule was not saved.
  expect(world.writes).toHaveLength(0);
  expect(screen.getByRole('form', { name: 'Edit rule Spring promo' })).toBeTruthy();

  // The trial follows the rule as it is edited, before any save.
  await choose(
    user,
    within(editor).getByRole('combobox', { name: 'Condition 2: value' }),
    'Google Ads',
  );
  expect(await within(trial).findByText('This rule would match this link.')).toBeTruthy();

  await user.clear(link);
  await user.type(link, 'not a link');
  await user.click(within(trial).getByRole('button', { name: 'Try' }));
  expect(await within(trial).findByRole('alert')).toBeTruthy();
  expect(within(trial).queryByText(/This rule would/)).toBeNull();
});

it('shows the rules and no way to change them to someone who may only read', async () => {
  show([springRule(), funnelRule()], { canManage: false });
  await screen.findByText('Spring promo', { selector: 'p' });
  expect(names()).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.queryByRole('button', { name: /^(Edit|Delete|Duplicate|Move)/ })).toBeNull();
  expect(screen.getByText(/Changing them needs permission to manage forms/)).toBeTruthy();
});

it('says what a rule names that is no longer there', async () => {
  show([
    ruleOf(1, {
      name: 'Old tag',
      tagIds: ['tag_01k8e2wzr0e008000000009999'],
      problems: [
        {
          code: 'tag_missing',
          id: 'tag_01k8e2wzr0e008000000009999',
          message: 'A tag this rule adds was deleted: it is skipped.',
        },
      ],
    }),
  ]);
  expect(await screen.findByText('A tag this rule adds was deleted: it is skipped.')).toBeTruthy();
  expect(names()[0]).toContain('tags: a deleted tag');
});

it('says so when the rules cannot be read, and reads them again when asked', async () => {
  const { user } = show([springRule()]);
  if (server.current !== undefined) {
    let failures = 0;
    server.current.instead = (operation) => {
      if (operation !== 'listLeadSourceRules' || failures > 0) return undefined;
      failures += 1;
      throw new ApiError({ type: 'about:blank', title: 'Refused', status: 403, detail: 'No.' });
    };
  }
  expect(await screen.findByText("Your rules couldn't be loaded.")).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Spring promo', { selector: 'p' })).toBeTruthy();
});
