// @vitest-environment jsdom
// The flow-control steps through the step panel itself: an If / else given branches of its
// own, a Go To that names an action by its card, and a goal with its events.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { validateAutomation } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { catalogOf, followUp, harborSetup } from '../e2e/automation-fixtures';
import type { Draft, InsertAt } from './automation-document';
import type { ShownIssue } from './automation-issues';
import type { AutomationCatalogData } from './automation-step-dialog';
// Read before any test starts, so a test waits on React alone (see the builder's tests).
import './automation-step-dialog';
import './automation-target-fields';
import { useStepEditing } from './automation-step-editing';

vi.mock('./api', () => ({
  apiIn: () => ({ request: () => Promise.resolve({ items: [], nextCursor: null }) }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const last: InsertAt = { kind: 'after', step: 'last_check_in' };

function show(
  initial: Draft = followUp,
  issues: readonly ShownIssue[] = [],
): { draft: () => Draft; user: ReturnType<typeof userEvent.setup> } {
  let latest = initial;
  function Harness(): ReactElement {
    const [draft, setDraft] = useState(initial);
    const editing = useStepEditing({
      draft,
      setup: harborSetup,
      catalog: catalogOf() as AutomationCatalogData,
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
        {['asked_about_video', 'back'].map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              editing.editStep(id);
            }}
          >
            Edit {id}
          </button>
        ))}
        {(['goto', 'goal'] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => {
              editing.addStep(last, type);
            }}
          >
            Add {type}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            editing.addStep(last);
          }}
        >
          Add an action
        </button>
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

const stepsOf = (draft: Draft): Record<string, { config: unknown; next?: unknown }> =>
  (draft as { steps: Record<string, { config: unknown; next?: unknown }> }).steps;
const closed = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
};

describe('If / else with branches of its own', () => {
  it('stays yes and no until asked, then keeps the yes path first and the no path as None', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Edit asked_about_video' }));
    const form = await screen.findByRole('dialog', { name: 'If / else' });
    // As it was: its conditions as rows, and nothing named.
    expect(within(form).getByRole('combobox', { name: 'Field of condition 1' })).toBeDefined();
    expect(within(form).queryByRole('group', { name: /^Branch / })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Use branches I name' }));

    const first = within(form).getByRole('group', { name: 'Branch 1: yes' });
    expect(within(first).getByRole('combobox', { name: 'Field of condition 1' }).textContent).toBe(
      'Services',
    );
    expect(within(form).getByRole('group', { name: 'Branch None' }).textContent).toContain(
      "Taken when none of the branches above holds. It has no conditions and can't be removed.",
    );
    await user.type(
      within(first).getByRole('textbox', { name: 'Name of branch 1' }),
      'Asked about video',
    );
    expect(within(form).getByRole('group', { name: 'Branch 1: Asked about video' })).toBeDefined();
    // The only branch can't be deleted, nor moved.
    for (const name of [/^Move branch 1 up/, /^Move branch 1 down/, /^Delete branch 1/])
      expect(within(form).getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);

    // A second, moved first, then a third: tried in the order shown, None last.
    await user.click(within(form).getByRole('button', { name: 'Add branch' }));
    await user.click(within(form).getByRole('button', { name: /^Move branch 2 up/ }));
    await user.click(within(form).getByRole('button', { name: 'Add branch' }));
    expect(
      within(form)
        .getAllByRole('group', { name: /^Branch / })
        .map((group) => group.getAttribute('aria-label')),
    ).toEqual([
      'Branch 1: branch_2',
      'Branch 2: Asked about video',
      'Branch 3: branch_3',
      'Branch None',
    ]);

    // A branch with nothing to compare is refused, where it is.
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    const empty = within(form).getByRole('group', { name: 'Branch 1: branch_2' });
    expect(await within(empty).findByText('Choose a field.')).toBeDefined();
    expect(draft()).toBe(followUp);
    await user.click(within(form).getByRole('button', { name: /^Delete branch 3/ }));
    await user.click(within(form).getByRole('button', { name: /^Delete branch 1/ }));
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await closed();
    expect(stepsOf(draft())['asked_about_video']).toEqual({
      type: 'condition',
      config: {
        branches: [
          {
            name: 'yes',
            label: 'Asked about video',
            if: { field: 'contact.services', operator: 'includes', value: 'video' },
          },
        ],
      },
      next: { yes: 'send_reel', none: 'check_in' },
    });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
  });
});

describe('Go To', () => {
  it("names another action by what its card says, and saves that action's id", async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Add goto' }));
    const form = await screen.findByRole('dialog', { name: 'Go to' });
    const box = within(form).getByRole<HTMLInputElement>('combobox', { name: 'Action to go to' });
    expect(box).toBe(document.activeElement);
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(await within(form).findByText('Fill this in.')).toBeDefined();
    await user.type(box, 'wait 3');
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Wait 3 days',
    ]);
    await user.click(screen.getByRole('option', { name: 'Wait 3 days' }));
    expect(box.value).toBe('Wait 3 days');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await closed();
    expect(stepsOf(draft())['goto']).toEqual({
      type: 'goto',
      config: { target: 'wait_3_days' },
    });
    expect(stepsOf(draft())['last_check_in']?.next).toBe('goto');
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
  });

  it("says the checks' refusal of the jump under the action it names, in their words", async () => {
    const looping = {
      ...followUp,
      steps: {
        ...followUp.steps,
        last_check_in: { ...followUp.steps.last_check_in, next: 'back' },
        back: { type: 'goto', config: { target: 'gone' } },
      },
    };
    const { user } = show(looping, [
      {
        level: 'error',
        path: '/steps/back/next',
        code: 'goto_has_next',
        message: 'A Go To ends its path: it leads to its target and nowhere else.',
      },
    ]);
    await user.click(screen.getByRole('button', { name: 'Edit back' }));
    const form = await screen.findByRole('dialog', { name: 'Go to' });
    const box = within(form).getByRole<HTMLInputElement>('combobox', { name: 'Action to go to' });
    expect(box.value).toBe('gone (not found)');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(
      within(form).getByText('A Go To ends its path: it leads to its target and nowhere else.'),
    ).toBeDefined();
    // The step itself is never one it can go to.
    await user.click(box);
    await user.clear(box);
    expect(
      (await screen.findAllByRole('option')).map((option) => option.textContent),
    ).not.toContain('Go to the action gone');
  });
});

describe('Goal', () => {
  it('lists the events that meet it, each with its filters, and what happens otherwise', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Add goal' }));
    const form = await screen.findByRole('dialog', { name: 'Goal' });
    const first = within(form).getByRole('group', { name: 'Event 1' });
    expect(within(first).getByRole('combobox', { name: 'What happens, event 1' }).textContent).toBe(
      'Appointment booked',
    );
    expect(within(first).getByRole('combobox', { name: 'Calendar of event 1' }).textContent).toBe(
      'Any calendar',
    );
    expect(
      within(first).getByRole<HTMLButtonElement>('button', { name: 'Remove event 1' }).disabled,
    ).toBe(true);

    // A second event: a tag, which has to be chosen.
    await user.click(within(form).getByRole('button', { name: 'Add event' }));
    const second = within(form).getByRole('group', { name: 'Event 2' });
    await user.click(within(second).getByRole('combobox', { name: 'What happens, event 2' }));
    await user.click(await screen.findByRole('option', { name: 'Tag added' }));
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(await within(second).findByText('Fill this in.')).toBeDefined();
    await user.click(within(second).getByRole('combobox', { name: 'Tag of event 2' }));
    await user.click(await screen.findByRole('option', { name: 'VIP' }));

    const otherwise = within(form).getByRole('radiogroup', {
      name: 'A contact who gets here before the goal is met',
    });
    expect(
      within(otherwise).getByRole<HTMLInputElement>('radio', { name: /^Continues anyway/ }).checked,
    ).toBe(true);
    await user.click(
      within(otherwise).getByRole('radio', { name: /^Waits until the goal is met/ }),
    );
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await closed();
    expect(stepsOf(draft())['goal']?.config).toEqual({
      events: [
        { type: 'appointment.booked', config: {} },
        { type: 'tag.added', config: { tag: 'tag_vip' } },
      ],
      otherwise: 'wait',
    });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);

    // One goal is the most: the list of actions says so, and no longer offers it.
    await user.click(screen.getByRole('button', { name: 'Add an action' }));
    const picker = await screen.findByRole('dialog', { name: 'Actions' });
    expect(within(picker).queryByRole('button', { name: /^Goal/ })).toBeNull();
    expect(within(picker).getByRole('region', { name: 'Not available yet' }).textContent).toContain(
      'This workflow already has one, and one is the most. Add what else meets the goal to it.',
    );
  });
});
