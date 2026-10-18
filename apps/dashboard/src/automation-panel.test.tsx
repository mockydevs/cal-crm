// @vitest-environment jsdom
// The right-hand panel of an action or a trigger: its filters, its name, its ways around
// (back, previous, next, delete), and the question it asks before changes are dropped.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { validateAutomation } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { catalogOf, followUp, harborSetup, welcome } from '../e2e/automation-fixtures';
import type { Draft } from './automation-document';
import type { AutomationCatalogData } from './automation-step-dialog';
import { useStepEditing } from './automation-step-editing';
// Loaded before any test starts, so a test waits on React alone.
import './automation-step-dialog';

vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
// Nothing answers: a panel that reads says so, and the rest of it works.
vi.mock('./api', () => ({
  apiIn: () => ({ request: () => Promise.reject(new Error('No server in this test.')) }),
}));

beforeAll(async () => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  await import('./email-step/panel');
});
afterEach(cleanup);

const setup = {
  ...harborSetup,
  fields: {
    contact: [
      ...harborSetup.fields.contact,
      { key: 'budget', aliases: [], type: 'number' as const, options: [] },
      { key: 'newsletter', aliases: [], type: 'boolean' as const, options: [] },
    ],
    deal: [],
  },
};

const seen: { draft: Draft; inJson: string[] } = { draft: {}, inJson: [] };

function Harness({ initial }: { readonly initial: Draft }): ReactElement {
  const [draft, setDraft] = useState(initial);
  const editing = useStepEditing({
    draft,
    setup,
    catalog: catalogOf(setup) as AutomationCatalogData,
    onChange: (next) => {
      seen.draft = next;
      setDraft(next);
    },
    onEditInJson: (pointer) => {
      seen.inJson.push(pointer);
    },
  });
  const opened =
    editing.selected === undefined
      ? 'nothing'
      : editing.selected.kind === 'step'
        ? editing.selected.id
        : `trigger ${String(editing.selected.index)}`;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          editing.addTrigger();
        }}
      >
        New trigger
      </button>
      <button
        type="button"
        onClick={() => {
          editing.editTrigger(0);
        }}
      >
        First trigger
      </button>
      <button
        type="button"
        onClick={() => {
          editing.duplicateTrigger(0);
        }}
      >
        Copy first trigger
      </button>
      <button
        type="button"
        onClick={() => {
          editing.editStep('wait_2_days');
        }}
      >
        The wait
      </button>
      <button
        type="button"
        onClick={() => {
          editing.addStep({ kind: 'start' });
        }}
      >
        New action
      </button>
      <output>{opened}</output>
      {editing.dialogs}
    </>
  );
}

function open(initial: Draft = followUp): ReturnType<typeof userEvent.setup> {
  seen.draft = initial;
  seen.inJson = [];
  render(
    // A Send email action's panel reads the business's templates: it has somewhere to ask.
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <Harness initial={initial} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}

const triggers = (): unknown => seen.draft['triggers'];
const closed = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
};
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  within_: HTMLElement,
  name: string,
  option: string,
): Promise<void> {
  await user.click(within(within_).getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe("a trigger's panel", () => {
  it('lists the triggers under their categories, and adds one with filters of every kind', async () => {
    const user = open(welcome);
    await user.click(screen.getByRole('button', { name: 'New trigger' }));
    const picker = await screen.findByRole('dialog', { name: 'Add trigger' });
    expect(
      within(picker)
        .getAllByRole('region')
        .map((section) => section.getAttribute('aria-label')),
    ).toEqual(['Contact', 'Events', 'Appointments', 'Opportunities', 'Payments']);
    await user.type(within(picker).getByLabelText('Search triggers'), 'zzz');
    expect(within(picker).getByText('No trigger matches that.')).toBeDefined();
    await user.clear(within(picker).getByLabelText('Search triggers'));
    await user.click(within(picker).getByRole('button', { name: /^Contact created/ }));

    const panel = await screen.findByRole('dialog', { name: 'Contact created' });
    expect(
      within(panel).getByRole('combobox', { name: 'Choose a workflow trigger' }).textContent,
    ).toBe('Contact created');
    const filters = within(panel).getByRole('group', { name: 'Filters' });
    expect(filters.textContent).toContain(
      'No filters applied: every event of this kind starts the workflow.',
    );

    // A filter with nothing chosen is refused, with the banner and a line at the row.
    await user.click(within(panel).getByRole('button', { name: 'Add filters' }));
    await user.click(within(panel).getByRole('button', { name: 'Save trigger' }));
    expect(within(panel).getByRole('alert').textContent).toBe(
      "Oops! Looks like you've missed out on some fields.",
    );
    expect(within(panel).getByText('Choose a field.')).toBeDefined();
    expect(triggers()).toEqual(welcome.triggers);
  });

  // Each kind of value a filter can hold, two at a time, on the trigger a workflow has.
  const kinds: readonly (readonly [
    string,
    (user: ReturnType<typeof userEvent.setup>, panel: HTMLElement) => Promise<void>,
    readonly unknown[],
  ])[] = [
    [
      'text and one of a field’s own options',
      async (user, panel) => {
        await choose(user, panel, 'Field of filter 1', 'Email');
        await choose(user, panel, 'Comparison of filter 1', 'Contains');
        await user.click(within(panel).getByRole('button', { name: 'Save trigger' }));
        expect(within(panel).getByText('Enter what to compare with.')).toBeDefined();
        await user.type(within(panel).getByRole('textbox', { name: 'Value of filter 1' }), 'gmail');
        await user.click(within(panel).getByRole('button', { name: 'Add filters' }));
        await choose(user, panel, 'Field of filter 2', 'Services');
        await choose(user, panel, 'Value of filter 2', 'Photo');
      },
      [
        { field: 'contact.email', operator: 'includes', value: 'gmail' },
        { field: 'contact.custom.services', operator: 'includes', value: 'photo' },
      ],
    ],
    [
      'a number, and yes or no',
      async (user, panel) => {
        await choose(user, panel, 'Field of filter 1', 'Budget');
        await choose(user, panel, 'Comparison of filter 1', 'Is greater than');
        await user.type(
          within(panel).getByRole('spinbutton', { name: 'Value of filter 1' }),
          '500',
        );
        await user.click(within(panel).getByRole('button', { name: 'Add filters' }));
        await choose(user, panel, 'Field of filter 2', 'Newsletter');
        await choose(user, panel, 'Value of filter 2', 'Yes');
      },
      [
        { field: 'contact.custom.budget', operator: 'greater_than', value: 500 },
        { field: 'contact.custom.newsletter', operator: 'equals', value: true },
      ],
    ],
    [
      'a date, and a length of time',
      async (user, panel) => {
        await choose(user, panel, 'Field of filter 1', 'Created on');
        fireEvent.change(within(panel).getByLabelText('Value of filter 1'), {
          target: { value: '2026-12-01' },
        });
        await user.click(within(panel).getByRole('button', { name: 'Add filters' }));
        await choose(user, panel, 'Field of filter 2', 'Last updated');
        await choose(user, panel, 'Comparison of filter 2', 'Is in the last');
        await user.type(within(panel).getByRole('spinbutton', { name: 'Value of filter 2' }), '2');
        await choose(user, panel, 'Unit for: Value of filter 2', 'Weeks');
      },
      [
        { field: 'contact.createdAt', operator: 'before', value: '2026-12-01' },
        { field: 'contact.updatedAt', operator: 'within_last', value: 'P2W' },
      ],
    ],
  ];

  it.each(kinds)('saves filters that hold %s', async (_, fill, all) => {
    const user = open(welcome);
    await user.click(screen.getByRole('button', { name: 'First trigger' }));
    const panel = await screen.findByRole('dialog', { name: 'Contact created' });
    await user.click(within(panel).getByRole('button', { name: 'Add filters' }));
    await fill(user, panel);
    await user.click(within(panel).getByRole('button', { name: 'Save trigger' }));
    await closed();
    expect(triggers()).toEqual([{ ...welcome.triggers[0], if: { all } }]);
    expect(validateAutomation(seen.draft, setup).errors).toEqual([]);
  });

  it('takes a filter away again before it is saved', async () => {
    const user = open(welcome);
    await user.click(screen.getByRole('button', { name: 'First trigger' }));
    const panel = await screen.findByRole('dialog', { name: 'Contact created' });
    await user.click(within(panel).getByRole('button', { name: 'Add filters' }));
    await user.click(within(panel).getByRole('button', { name: 'Add filters' }));
    expect(
      within(within(panel).getByRole('list', { name: 'Filters' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    await user.click(within(panel).getByRole('button', { name: 'Remove filter 2' }));
    await user.click(within(panel).getByRole('button', { name: 'Remove filter 1' }));
    expect(within(panel).queryByRole('list', { name: 'Filters' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Save trigger' }));
    await closed();
    expect(triggers()).toEqual(welcome.triggers);
  });

  it('opens a saved trigger on its filters, changes them, and takes them away', async () => {
    const filtered = {
      ...followUp,
      triggers: [
        {
          ...followUp.triggers[0],
          if: {
            all: [
              { field: 'contact.services', operator: 'includes', value: 'Video' },
              { field: 'contact.shoe_size', operator: 'equals', value: '44' },
              { field: 'contact.custom.newsletter', operator: 'equals', value: false },
              { field: 'contact.custom.services', operator: 'includes', value: 'drone' },
            ],
          },
        },
      ],
    };
    const user = open(filtered);
    await user.click(screen.getByRole('button', { name: 'First trigger' }));
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe('trigger 0');
    const panel = await screen.findByRole('dialog', { name: 'Form submitted' });
    // A field written the short way is the field; an option named by its label is the option.
    expect(within(panel).getByRole('combobox', { name: 'Field of filter 1' }).textContent).toBe(
      'Services',
    );
    expect(within(panel).getByRole('combobox', { name: 'Value of filter 1' }).textContent).toBe(
      'Video',
    );
    // What this business does not have is kept in sight, and said to be missing.
    expect(within(panel).getByRole('combobox', { name: 'Field of filter 2' }).textContent).toBe(
      'contact.shoe_size (not found)',
    );
    expect(within(panel).getByRole('textbox', { name: 'Value of filter 2' })).toHaveProperty(
      'value',
      '44',
    );
    expect(within(panel).getByRole('combobox', { name: 'Value of filter 3' }).textContent).toBe(
      'No',
    );
    expect(within(panel).getByRole('combobox', { name: 'Value of filter 4' }).textContent).toBe(
      'drone (not found)',
    );
    // Its only trigger: there is nothing to delete it for.
    expect(within(panel).queryByRole('button', { name: 'Delete' })).toBeNull();

    await user.click(within(panel).getByRole('button', { name: 'Remove filter 4' }));
    await user.click(within(panel).getByRole('button', { name: 'Remove filter 3' }));
    await user.click(within(panel).getByRole('button', { name: 'Remove filter 2' }));
    await choose(user, panel, 'Comparison of filter 1', 'Is empty');
    expect(within(panel).queryByRole('combobox', { name: 'Value of filter 1' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Save trigger' }));
    await closed();
    expect(triggers()).toEqual([
      { ...followUp.triggers[0], if: { field: 'contact.services', operator: 'is_empty' } },
    ]);

    await user.click(screen.getByRole('button', { name: 'First trigger' }));
    const again = await screen.findByRole('dialog', { name: 'Form submitted' });
    await user.click(within(again).getByRole('button', { name: 'Remove filter 1' }));
    await user.click(within(again).getByRole('button', { name: 'Save trigger' }));
    await closed();
    expect(triggers()).toEqual(followUp.triggers);
  });

  it('gives a saved trigger another type, with that type’s own settings', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'First trigger' }));
    const panel = await screen.findByRole('dialog', { name: 'Form submitted' });
    await choose(user, panel, 'Choose a workflow trigger', 'Tag added');
    const retyped = await screen.findByRole('dialog', { name: 'Tag added' });
    expect(within(retyped).queryByRole('combobox', { name: 'Form' })).toBeNull();
    await choose(user, retyped, 'Tag', 'VIP');
    await user.click(within(retyped).getByRole('button', { name: 'Save trigger' }));
    await closed();
    expect(triggers()).toEqual([
      { id: 'quote_form', type: 'tag.added', config: { tag: 'tag_vip' } },
    ]);
    expect(validateAutomation(seen.draft, setup).errors).toEqual([]);
  });

  it('shows filters written another way as they read, and leads to the JSON view', async () => {
    const either = {
      any: [
        { field: 'contact.email', operator: 'is_set' },
        { field: 'contact.phone', operator: 'is_set' },
      ],
    };
    const user = open({ ...followUp, triggers: [{ ...followUp.triggers[0], if: either }] });
    await user.click(screen.getByRole('button', { name: 'First trigger' }));
    const panel = await screen.findByRole('dialog', { name: 'Form submitted' });
    const filters = within(panel).getByRole('group', { name: 'Filters' });
    expect(filters.textContent).toContain('email is filled in or phone is filled in');
    expect(filters.textContent).toContain('These filters are edited in the JSON view.');
    // A form's trigger can still be narrowed by source, which is a setting of its own; no
    // row of a field can be added to a condition the rows can't hold.
    await user.click(within(panel).getByRole('button', { name: 'Add filters' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Lead source',
      'Session source',
    ]);
    await user.keyboard('{Escape}');
    // Saving the rest of the trigger keeps them as written.
    await user.click(within(panel).getByRole('button', { name: 'Save trigger' }));
    await closed();
    expect(triggers()).toEqual([{ ...followUp.triggers[0], if: either }]);

    await user.click(screen.getByRole('button', { name: 'First trigger' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Form submitted' })).getByRole('button', {
        name: 'Edit in JSON',
      }),
    );
    await closed();
    expect(seen.inJson).toEqual(['/triggers/0']);
  });

  it('copies a trigger, and then either can be deleted from its panel', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'Copy first trigger' }));
    expect(triggers()).toEqual([
      followUp.triggers[0],
      { ...followUp.triggers[0], id: 'form_submitted' },
    ]);
    await user.click(screen.getByRole('button', { name: 'First trigger' }));
    const panel = await screen.findByRole('dialog', { name: 'Form submitted' });
    await user.click(within(panel).getByRole('button', { name: 'Delete' }));
    const asking = await screen.findByRole('dialog', { name: 'Delete this trigger?' });
    await user.click(within(asking).getByRole('button', { name: 'Delete trigger' }));
    await closed();
    expect(triggers()).toEqual([{ ...followUp.triggers[0], id: 'form_submitted' }]);
  });
});

describe("an action's panel", () => {
  it('names the action, says what it does, and walks to the action before and after', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'The wait' }));
    const panel = await screen.findByRole('dialog', { name: 'Wait' });
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe('wait_2_days');
    expect(
      within(panel).getByText(
        'Wait for a length of time before the next step. With a resume window, the run goes on only inside it.',
      ),
    ).toBeDefined();
    const name = within(panel).getByRole('textbox', { name: /^Action name/ });
    expect(name.getAttribute('placeholder')).toBe('Wait');

    await user.click(within(panel).getByRole('button', { name: 'Next action' }));
    const next = await screen.findByRole('dialog', { name: 'If / else' });
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe('asked_about_video');
    await user.click(within(next).getByRole('button', { name: 'Previous action' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Wait' })).getByRole('button', {
        name: 'Previous action',
      }),
    );
    const first = await screen.findByRole('dialog', { name: 'Send email' });
    expect(within(first).getByRole('button', { name: 'Previous action' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.type(within(first).getByRole('textbox', { name: /^Action name/ }), 'The guide');
    await user.click(within(first).getByRole('button', { name: 'Save action' }));
    await closed();
    expect(seen.draft['steps']).toEqual({
      ...followUp.steps,
      send_guide: { ...followUp.steps.send_guide, label: 'The guide' },
    });
  });

  it('asks before changes are dropped, whichever way the panel is left', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'The wait' }));
    const panel = await screen.findByRole('dialog', { name: 'Wait' });
    // Nothing changed: Cancel just closes.
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await closed();

    await user.click(screen.getByRole('button', { name: 'The wait' }));
    const changed = await screen.findByRole('dialog', { name: 'Wait' });
    const amount = within(changed).getByRole('spinbutton', { name: 'How long to wait' });
    await user.clear(amount);
    await user.type(amount, '9');
    await user.click(within(changed).getByRole('button', { name: 'Next action' }));
    const asking = within(changed).getByRole('alertdialog', { name: 'Leave without saving?' });
    await user.click(within(asking).getByRole('button', { name: 'Keep editing' }));
    expect(within(changed).queryByRole('alertdialog')).toBeNull();
    expect(amount).toHaveProperty('value', '9');
    // Escape asks too, and nothing is lost by it.
    await user.keyboard('{Escape}');
    expect(
      within(changed).getByRole('alertdialog', { name: 'Leave without saving?' }),
    ).toBeDefined();
    await user.click(within(changed).getByRole('button', { name: 'Keep editing' }));
    await user.click(within(changed).getByRole('button', { name: 'Next action' }));
    await user.click(within(changed).getByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('dialog', { name: 'If / else' })).toBeDefined();
    expect(seen.draft).toBe(followUp);

    // The same when going back to the list from an action being added.
    await user.keyboard('{Escape}');
    await closed();
    await user.click(screen.getByRole('button', { name: 'New action' }));
    const picker = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(picker).getByRole('button', { name: /^Send text/ }));
    const adding = await screen.findByRole('dialog', { name: 'Send text' });
    expect(within(adding).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(adding).queryByRole('button', { name: 'Next action' })).toBeNull();
    await user.type(within(adding).getByRole('textbox', { name: 'Message' }), 'Hello');
    await user.click(within(adding).getByRole('button', { name: 'Back' }));
    await user.click(within(adding).getByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('dialog', { name: 'Actions' })).toBeDefined();
    await user.keyboard('{Escape}');
    await closed();
    expect(seen.draft).toBe(followUp);
  });

  it('deletes the action it is on, after the builder asks', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: 'The wait' }));
    const panel = await screen.findByRole('dialog', { name: 'Wait' });
    await user.click(within(panel).getByRole('button', { name: 'Delete' }));
    const asking = await screen.findByRole('dialog', { name: 'Delete this action?' });
    await user.click(within(asking).getByRole('button', { name: 'Delete action' }));
    await closed();
    expect(Object.keys(seen.draft['steps'] as object)).not.toContain('wait_2_days');
  });
});
