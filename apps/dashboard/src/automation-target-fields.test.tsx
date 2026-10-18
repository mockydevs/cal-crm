// @vitest-environment jsdom
// The settings that name other automations, as a person and a screen reader meet them: a
// box to type into for one, a list that ticks each for several, and the choice of what a
// removal takes the contact out of.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { MAX_REMOVE_AUTOMATIONS } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { choiceDetails } from './automation-choice-details';
import { fieldsOf } from './automation-fields';
import { AutomationTargets, ChoiceRadios } from './automation-target-fields';

interface Server {
  calls: string[];
  answer: () => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => ({ items: [] }) }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }) => {
      server.calls.push(endpoint.operationId);
      return Promise.resolve().then(() => server.answer());
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

const named = (id: string, name: string): { id: string; name: string } => ({ id, name });
const automations = [
  named('aut_self', 'New lead follow-up'),
  named('aut_draft', 'Birthday'),
  named('aut_paused', 'Win back'),
  named('aut_live', 'Welcome'),
];
const listed = {
  items: [
    { id: 'aut_self', status: 'active' },
    { id: 'aut_draft', status: 'draft' },
    { id: 'aut_paused', status: 'paused' },
    { id: 'aut_live', status: 'active' },
  ],
};
const control = { id: 'setting', 'aria-invalid': false, 'data-field-control': true } as const;

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls = [];
  server.answer = () => listed;
});
afterEach(cleanup);

function show(ui: ReactElement): ReturnType<typeof userEvent.setup> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <label htmlFor="setting">Setting</label>
        {ui}
      </QueryClientProvider>
    </I18nProvider>,
  );
  return userEvent.setup({ delay: null });
}

describe('choosing one automation', () => {
  it('lists the others, published first, each with its status, and takes the one chosen', async () => {
    const onChange = vi.fn();
    const user = show(
      <AutomationTargets
        {...control}
        label="Setting"
        many={false}
        value={undefined}
        automations={automations}
        self="aut_self"
        onChange={onChange}
      />,
    );
    const box = screen.getByRole('combobox', { name: 'Setting' });
    expect(box.getAttribute('data-field-control')).toBe('');
    expect(box.getAttribute('aria-invalid')).toBe('false');
    await user.click(box);
    await screen.findByRole('option', { name: /Welcome\s*Published/ });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'WelcomePublished',
      'Win backPaused',
      'BirthdayDraft',
    ]);
    expect(server.calls).toEqual(['listAutomations']);
    await user.click(screen.getByRole('option', { name: /Win back/ }));
    expect(onChange).toHaveBeenCalledWith('aut_paused');
  });

  it('is found by typing part of a name', async () => {
    const user = show(
      <AutomationTargets
        {...control}
        label="Setting"
        many={false}
        value={undefined}
        automations={automations}
        self="aut_self"
        onChange={() => undefined}
      />,
    );
    const box = screen.getByRole('combobox', { name: 'Setting' });
    await user.type(box, 'birth');
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'BirthdayDraft',
    ]);
    await user.clear(box);
    await user.type(box, 'zzz');
    expect(await screen.findByText('No automation matches.')).toBeTruthy();
  });

  it('says what starting one that is not published does, and marks a refusal', async () => {
    show(
      <AutomationTargets
        {...control}
        aria-invalid
        aria-describedby="why"
        label="Setting"
        many={false}
        value="Win back"
        automations={automations}
        self="aut_self"
        onChange={() => undefined}
      />,
    );
    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Setting' });
    expect(box.value).toBe('Win back');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toBe('why');
    expect((await screen.findByRole('status')).textContent).toBe(
      '“Win back” is paused. This action starts nothing until it is published again.',
    );
  });

  it('keeps a reference the business lacks, saying so, and lets it be cleared', async () => {
    const onChange = vi.fn();
    const user = show(
      <AutomationTargets
        {...control}
        label="Setting"
        many={false}
        value="Gone"
        automations={automations}
        self="aut_self"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Setting' }).value).toBe(
      'Gone (not found)',
    );
    await user.click(screen.getByRole('button', { name: 'Clear the automation' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('still offers them by name when their statuses cannot be read', async () => {
    server.answer = () => {
      throw new Error('offline');
    };
    const user = show(
      <AutomationTargets
        {...control}
        label="Setting"
        many={false}
        value={undefined}
        automations={automations}
        self="aut_self"
        onChange={() => undefined}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Setting' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Birthday',
      'Welcome',
      'Win back',
    ]);
  });

  it('says so when the business has no other automation', () => {
    show(
      <AutomationTargets
        {...control}
        label="Setting"
        many={false}
        value={undefined}
        automations={[named('aut_self', 'New lead follow-up')]}
        self="aut_self"
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText('This business has no other automations yet.')).toBeTruthy();
  });
});

describe('choosing several automations', () => {
  it('ticks each, in the order ticked, by id, and gives nothing once none is chosen', async () => {
    const onChange = vi.fn();
    const user = show(
      <AutomationTargets
        {...control}
        label="Automations"
        many
        value={['aut_live']}
        automations={automations}
        self="aut_self"
        onChange={onChange}
      />,
    );
    const list = screen.getByRole('group', { name: 'Automations' });
    expect(
      within(list).getByRole('searchbox', { name: 'Search automations' }).dataset['fieldControl'],
    ).toBe('true');
    await within(list).findByRole('checkbox', { name: 'Win back (Paused)' });
    expect(
      within(list)
        .getAllByRole<HTMLInputElement>('checkbox')
        .map((box) => [box.labels?.[0]?.textContent, box.checked]),
    ).toEqual([
      ['Welcome (Published)', true],
      ['Win back (Paused)', false],
      ['Birthday (Draft)', false],
    ]);
    expect(within(list).getByRole('status').textContent).toBe('1 chosen.');
    await user.click(within(list).getByRole('checkbox', { name: 'Win back (Paused)' }));
    expect(onChange).toHaveBeenLastCalledWith(['aut_live', 'aut_paused']);
    await user.click(within(list).getByRole('checkbox', { name: 'Welcome (Published)' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('narrows the list to what is typed, and says when nothing fits', async () => {
    const user = show(
      <AutomationTargets
        {...control}
        aria-invalid
        aria-describedby="why"
        label="Automations"
        many
        value={undefined}
        automations={automations}
        self="aut_self"
        onChange={() => undefined}
      />,
    );
    const list = screen.getByRole('group', { name: 'Automations' });
    expect(list.getAttribute('aria-describedby')).toBe('why');
    expect(within(list).getByRole('status').textContent).toBe('None chosen.');
    const search = within(list).getByRole('searchbox', { name: 'Search automations' });
    expect(search.getAttribute('aria-invalid')).toBe('true');
    await user.type(search, 'WIN');
    expect(within(list).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(list).getByRole('checkbox', { name: /^Win back/ })).toBeDefined();
    await user.type(search, 'zzz');
    expect(within(list).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(list).getByText('No automation matches.')).toBeDefined();
  });

  it('stops at the most a setting may list, and says why', () => {
    const many = Array.from({ length: MAX_REMOVE_AUTOMATIONS + 1 }, (_, index) =>
      named(`aut_${String(index)}`, `Sequence ${String(index).padStart(2, '0')}`),
    );
    show(
      <AutomationTargets
        {...control}
        label="Automations"
        many
        value={many.slice(0, MAX_REMOVE_AUTOMATIONS).map((each) => each.id)}
        automations={many}
        self="aut_self"
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'You have chosen 20, the most one setting can list. Take one off to choose another.',
    );
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Sequence 20' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Sequence 00' }).disabled).toBe(
      false,
    );
  });

  it('keeps a reference the business lacks among the chosen, saying so', async () => {
    show(
      <AutomationTargets
        {...control}
        label="Automations"
        many
        value={['Gone', 'Welcome']}
        automations={automations}
        self="aut_self"
        onChange={() => undefined}
      />,
    );
    await screen.findByRole('checkbox', { name: 'Welcome (Published)' });
    expect(
      screen
        .getAllByRole<HTMLInputElement>('checkbox')
        .filter((box) => box.checked)
        .map((box) => box.labels?.[0]?.textContent),
    ).toEqual(['Gone (not found)', 'Welcome (Published)']);
  });

  it('says so when the business has no other automation', () => {
    show(
      <AutomationTargets
        {...control}
        label="Automations"
        many
        value={undefined}
        automations={[named('aut_self', 'New lead follow-up')]}
        self="aut_self"
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText('This business has no other automations yet.')).toBeTruthy();
    expect(screen.queryByText('No automation matches.')).toBeNull();
  });
});

describe('ticking several of a few choices', () => {
  const how = fieldsOf('trigger', 'automation.run_ended')?.find((field) => field.key === 'how');
  const options = how?.input.kind === 'choices' ? how.input.options : [];

  it('offers each with its sentence, keeps their own order, and gives nothing for none', async () => {
    const onChange = vi.fn();
    const user = show(
      <ChoiceRadios
        {...control}
        several
        label="How the run ended"
        options={options}
        details={choiceDetails['how']}
        value={['failed']}
        onChange={onChange}
      />,
    );
    const group = screen.getByRole('group', { name: 'How the run ended' });
    const boxes = within(group).getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((box) => box.checked)).toEqual([false, false, false, true]);
    for (const box of boxes)
      expect(
        document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent,
      ).toMatch(/\.$/);
    expect(boxes.map((box) => box.hasAttribute('data-field-control'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    await user.click(within(group).getByRole('checkbox', { name: /^Stopped/ }));
    expect(onChange).toHaveBeenLastCalledWith(['stopped', 'failed']);
    await user.click(within(group).getByRole('checkbox', { name: /^Failed/ }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});

describe('choosing what a removal takes the contact out of', () => {
  const [from] = fieldsOf('step', 'automation.remove') ?? [];
  const options = from?.input.kind === 'choice' ? from.input.options : [];

  it('offers each choice with its sentence, and takes the one chosen', async () => {
    const onChange = vi.fn();
    const user = show(
      <ChoiceRadios
        {...control}
        label="Remove the contact from"
        options={options}
        details={choiceDetails['from']}
        value="current"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Remove the contact from' });
    const radios = within(group).getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((radio) => radio.labels?.[0]?.textContent)).toEqual([
      expect.stringMatching(/^This automation/),
      expect.stringMatching(/^Chosen automations/),
      expect.stringMatching(/^All other automations/),
      expect.stringMatching(/^All automations/),
    ]);
    for (const radio of radios) {
      const sentence = document.getElementById(radio.getAttribute('aria-describedby') ?? '');
      expect(sentence?.textContent).toMatch(/\.$/);
    }
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false, false]);
    // The keyboard starts on the choice that is taken.
    expect(radios.map((radio) => radio.hasAttribute('data-field-control'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    await user.click(screen.getByRole('radio', { name: /^All other automations/ }));
    expect(onChange).toHaveBeenCalledWith('all_others');
  });

  it('starts the keyboard on the first choice when none is taken, and marks a refusal', () => {
    show(
      <ChoiceRadios
        {...control}
        aria-invalid
        aria-describedby="why"
        label="Remove the contact from"
        options={options}
        details={choiceDetails['from']}
        value="elsewhere"
        onChange={() => undefined}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Remove the contact from' });
    expect(group.getAttribute('aria-invalid')).toBe('true');
    expect(group.getAttribute('aria-describedby')).toBe('why');
    const radios = within(group).getAllByRole<HTMLInputElement>('radio');
    expect(radios.some((radio) => radio.checked)).toBe(false);
    expect(radios[0]?.hasAttribute('data-field-control')).toBe(true);
  });
});
