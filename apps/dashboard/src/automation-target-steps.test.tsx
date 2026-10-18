// @vitest-environment jsdom
// "Start another automation", "Remove from automations" and a team notification's third
// recipient, through the step panel itself: what each form asks, what it saves, and where a
// refusal of the checks is said.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { catalogOf, harborSetup } from '../e2e/automation-fixtures';
import type { Draft } from './automation-document';
import type { ShownIssue } from './automation-issues';
import type { AutomationCatalogData } from './automation-step-dialog';
// Read before any test starts, so a test waits on React alone (see the builder's tests).
import './automation-step-dialog';
import './automation-target-fields';
import { useStepEditing } from './automation-step-editing';

vi.mock('./api', () => ({
  apiIn: () => ({
    request: () =>
      Promise.resolve({
        items: [
          { id: 'aut_self', status: 'active' },
          { id: 'aut_other', status: 'paused' },
          { id: 'aut_education', status: 'active' },
        ],
        nextCursor: null,
        canManage: true,
      }),
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

const setup = {
  ...harborSetup,
  automations: [
    { id: 'aut_self', name: 'Booked a consultation' },
    { id: 'aut_other', name: 'Win back' },
    { id: 'aut_education', name: 'Education' },
  ],
};
const booked = {
  name: 'Booked a consultation',
  triggers: [{ id: 'booked', type: 'appointment.booked', config: {} }],
  start: 'go',
  steps: { go: { type: 'automation.run', config: { automation: 'aut_other' } } },
} as const;

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

function show(issues: readonly ShownIssue[] = []): {
  draft: () => Draft;
  user: ReturnType<typeof userEvent.setup>;
} {
  let latest: Draft = booked;
  function Harness(): ReactElement {
    const [draft, setDraft] = useState<Draft>(booked);
    const editing = useStepEditing({
      draft,
      setup,
      catalog: catalogOf(setup) as AutomationCatalogData,
      automationId: 'aut_self',
      issues,
      onChange: (next) => {
        latest = next;
        setDraft(next);
      },
      onEditInJson: () => undefined,
    });
    return (
      <>
        <button
          type="button"
          onClick={() => {
            editing.editStep('go');
          }}
        >
          Edit the start
        </button>
        <button
          type="button"
          onClick={() => {
            editing.addTrigger();
          }}
        >
          Add a trigger
        </button>
        <button
          type="button"
          onClick={() => {
            editing.editTrigger(0);
          }}
        >
          Edit the trigger
        </button>
        {(['automation.remove', 'team.notify'] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => {
              editing.addStep({ kind: 'after', step: 'go' }, type);
            }}
          >
            Add {type}
          </button>
        ))}
        {editing.dialogs}
      </>
    );
  }
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { draft: () => latest, user: userEvent.setup({ delay: null }) };
}

const stepsOf = (draft: Draft): unknown => (draft as { steps?: unknown }).steps;

describe('Start another automation', () => {
  it('opens on the automation it starts, with its status, and never offers itself', async () => {
    const { user } = show();
    await user.click(screen.getByRole('button', { name: 'Edit the start' }));
    const form = await screen.findByRole('dialog', { name: 'Start another automation' });
    const box = within(form).getByRole<HTMLInputElement>('combobox', {
      name: 'Automation to start',
    });
    expect(box.value).toBe('Win back');
    expect(box).toBe(document.activeElement);
    expect(await within(form).findByRole('status')).toHaveProperty(
      'textContent',
      '“Win back” is paused. This action starts nothing until it is published again.',
    );
    await user.click(box);
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'EducationPublished',
      'Win backPaused',
    ]);
  });

  it("says a refusal of the checks under the setting, until it's changed, and saves the change", async () => {
    const { user, draft } = show([
      {
        level: 'error',
        path: '/steps/go/config/automation',
        code: 'automation_loop',
        message: 'Starting "Win back" would loop: Booked a consultation → Win back.',
      },
    ]);
    await user.click(screen.getByRole('button', { name: 'Edit the start' }));
    const form = await screen.findByRole('dialog', { name: 'Start another automation' });
    const box = within(form).getByRole('combobox', { name: 'Automation to start' });
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const said = within(form).getByText(
      'Starting "Win back" would loop: Booked a consultation → Win back.',
    );
    expect(box.getAttribute('aria-describedby')?.split(' ')).toContain(said.id);
    await user.click(box);
    await user.click(await screen.findByRole('option', { name: /Education/ }));
    expect(within(form).queryByText(/would loop/)).toBeNull();
    expect(box.getAttribute('aria-invalid')).toBe('false');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(stepsOf(draft())).toMatchObject({
      go: { type: 'automation.run', config: { automation: 'aut_education' } },
    });
  });

  it('asks for an automation before it can be saved', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Edit the start' }));
    const form = await screen.findByRole('dialog', { name: 'Start another automation' });
    await user.click(within(form).getByRole('button', { name: 'Clear the automation' }));
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(await within(form).findByText('Fill this in.')).toBeDefined();
    const box = within(form).getByRole('combobox', { name: 'Automation to start' });
    await waitFor(() => {
      expect(box).toBe(document.activeElement);
    });
    expect(draft()).toBe(booked);
  });
});

describe('Remove from automations', () => {
  it('starts on this automation, and saves each choice with only the list it uses', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Add automation.remove' }));
    const form = await screen.findByRole('dialog', { name: 'Remove from automations' });
    const choice = within(form).getByRole('radiogroup', { name: 'Remove the contact from' });
    expect(
      within(choice).getByRole<HTMLInputElement>('radio', { name: /^This automation/ }),
    ).toHaveProperty('checked', true);
    expect(within(form).queryByRole('checkbox')).toBeNull();

    // Chosen automations: at least one has to be chosen.
    await user.click(within(choice).getByRole('radio', { name: /^Chosen automations/ }));
    const chosen = within(form).getByRole('group', { name: 'Automations to remove them from' });
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(await within(form).findByText('Fill this in.')).toBeDefined();
    await waitFor(() => {
      expect(within(chosen).getByRole('searchbox', { name: 'Search automations' })).toBe(
        document.activeElement,
      );
    });
    await user.click(await within(chosen).findByRole('checkbox', { name: 'Win back (Paused)' }));
    expect(within(form).queryByText('Fill this in.')).toBeNull();

    // All other automations: the list is what to leave running, and it is optional.
    await user.click(within(choice).getByRole('radio', { name: /^All other automations/ }));
    expect(
      within(form).queryByRole('group', { name: 'Automations to remove them from' }),
    ).toBeNull();
    const except = within(form).getByRole('group', { name: 'Except' });
    await user.click(within(except).getByRole('checkbox', { name: 'Education (Published)' }));
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(stepsOf(draft())).toMatchObject({
      automation_remove: {
        type: 'automation.remove',
        config: { from: 'all_others', except: ['aut_education'] },
      },
    });
    expect(
      (stepsOf(draft()) as Record<string, { config: object }>)['automation_remove']?.config,
    ).not.toHaveProperty('automations');
  });
});

describe('Automation run ended', () => {
  it('is a trigger under Events: which automations, how it ended, and what stopped it', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Add a trigger' }));
    const picker = await screen.findByRole('dialog', { name: 'Add trigger' });
    await user.click(
      within(within(picker).getByRole('region', { name: 'Events' })).getByRole('button', {
        name: /^Automation run ended/,
      }),
    );
    const form = await screen.findByRole('dialog', { name: 'Automation run ended' });
    const which = within(form).getByRole('group', { name: 'When a run of one of these ends' });
    // Never the automation itself.
    await within(which).findByRole('checkbox', { name: 'Win back (Paused)' });
    expect(
      within(which)
        .getAllByRole<HTMLInputElement>('checkbox')
        .map((box) => box.labels?.[0]?.textContent),
    ).toEqual(['Education (Published)', 'Win back (Paused)']);
    await user.click(within(form).getByRole('button', { name: 'Save trigger' }));
    expect(await within(form).findByText('Fill this in.')).toBeDefined();
    await user.click(within(which).getByRole('checkbox', { name: 'Education (Published)' }));

    const how = within(form).getByRole('group', { name: 'How the run ended' });
    expect(within(how).getAllByRole('checkbox')).toHaveLength(4);
    // What stopped it is asked while a stopped run can count: for any ending, and for stopped.
    expect(within(form).getByRole('group', { name: 'Only when it was stopped by' })).toBeDefined();
    await user.click(within(how).getByRole('checkbox', { name: /^Completed/ }));
    expect(within(form).queryByRole('group', { name: 'Only when it was stopped by' })).toBeNull();
    await user.click(within(how).getByRole('checkbox', { name: /^Stopped/ }));
    const by = within(form).getByRole('group', { name: 'Only when it was stopped by' });
    await user.click(within(by).getByRole('checkbox', { name: 'A message arrives' }));
    await user.click(within(how).getByRole('checkbox', { name: /^Completed/ }));
    await user.click(within(form).getByRole('button', { name: 'Save trigger' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect((draft() as { triggers: unknown[] }).triggers.at(-1)).toMatchObject({
      type: 'automation.run_ended',
      config: {
        automations: ['aut_education'],
        how: ['stopped'],
        stoppedBy: ['message.received'],
      },
    });
  });
});

describe("a trigger's panel", () => {
  it('says a refusal of the checks under the setting it names, as a step does', async () => {
    const { user } = show([
      {
        level: 'error',
        path: '/triggers/0/config/calendar',
        code: 'unknown_reference',
        message: 'No calendar is "Gone".',
      },
    ]);
    await user.click(screen.getByRole('button', { name: 'Edit the trigger' }));
    const form = await screen.findByRole('dialog', { name: 'Appointment booked' });
    const calendar = within(form).getByRole('combobox', { name: /^Calendar/ });
    expect(calendar.getAttribute('aria-invalid')).toBe('true');
    expect(within(form).getByText('No calendar is "Gone".')).toBeDefined();
  });
});

describe('Notify the team', () => {
  it('can tell the owner, or everyone when the contact has none', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Add team.notify' }));
    const form = await screen.findByRole('dialog', { name: 'Notify the team' });
    await user.type(within(form).getByRole('textbox', { name: 'Message' }), 'Booked');
    await user.click(within(form).getByRole('combobox', { name: /^Who to tell/ }));
    // The list that opened: the form's own list of merge fields is not it.
    expect(
      within(await screen.findByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      "The contact's owner",
      'Everyone on the team',
      "The contact's owner, or everyone when there is none",
    ]);
    await user.click(
      screen.getByRole('option', { name: "The contact's owner, or everyone when there is none" }),
    );
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(stepsOf(draft())).toMatchObject({
      team_notify: { type: 'team.notify', config: { message: 'Booked', to: 'owner_or_everyone' } },
    });
  });
});
