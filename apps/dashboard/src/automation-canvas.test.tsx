// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { automationCatalog, validateAutomation, type AutomationSetup } from '@repo/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  catalogOf,
  followUp,
  followUpStats,
  harborSetup,
  leadIntake,
  welcome,
} from '../e2e/automation-fixtures';
import CanvasView, { type CanvasViewProps } from './automation-canvas';
import { GRID, positionsOf, savedPositions } from './automation-canvas-layout';
import { sameJson, type Draft } from './automation-document';
import type { ShownIssue } from './automation-issues';
import { issuesOf } from './automation-issues';
import type { AutomationCatalogData } from './automation-step-dialog';
import { useStepEditing } from './automation-step-editing';
// Loaded here, before any test starts: the page fetches these lazily, and a test that had to
// wait for their code to be read for the first time lost that race on a busy machine. With
// them loaded, a test waits on React alone.
import './automation-canvas-library';
import './automation-filter-editor';
import './automation-step-dialog';
import './automation-trigger-filters-panel';

const catalog = automationCatalog();
const STEP_MIME = 'application/x-crm-automation-step';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  // jsdom lays nothing out and captures no pointers.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
});
afterEach(cleanup);

interface Shown {
  /** The draft as the canvas last changed it. */
  readonly draft: () => Draft;
  readonly inJson: string[];
  readonly user: ReturnType<typeof userEvent.setup>;
}

/** The canvas with the builder's own step forms behind it, holding the draft as the builder does. */
function show(
  initial: Draft = followUp,
  {
    editable = true,
    setup = harborSetup,
    issues,
  }: { editable?: boolean; setup?: AutomationSetup; issues?: readonly ShownIssue[] } = {},
): Shown {
  let latest = initial;
  const inJson: string[] = [];
  function Harness(): ReactElement {
    const [draft, setDraft] = useState(initial);
    const change = (next: Draft): void => {
      latest = next;
      setDraft(next);
    };
    const onEditInJson = (pointer: string): void => {
      inJson.push(pointer);
    };
    const editing = useStepEditing({
      draft,
      setup,
      catalog: catalogOf(setup) as AutomationCatalogData,
      onChange: change,
      onEditInJson,
    });
    return (
      <>
        <CanvasView
          draft={draft}
          setup={setup}
          steps={catalog.steps}
          stepGroups={catalog.stepGroups}
          issues={issues ?? issuesOf(validateAutomation(draft, setup))}
          editable={editable}
          editing={editing}
          onChange={change}
          onEditInJson={onEditInJson}
        />
        {editing.dialogs}
      </>
    );
  }
  render(
    <I18nProvider i18n={i18n}>
      <Harness />
    </I18nProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return { draft: () => latest, inJson, user: userEvent.setup({ delay: null }) };
}

/** The canvas by itself, given its numbers as the builder gives them when they come. */
function showWithStats(
  draft: Draft,
  given: Pick<CanvasViewProps, 'onWantStats'>,
): {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly rerender: (more: Pick<CanvasViewProps, 'stats' | 'statsFailed'>) => void;
} {
  const nothing = (): void => undefined;
  const element = (more: Pick<CanvasViewProps, 'stats' | 'statsFailed'>): ReactElement => (
    <I18nProvider i18n={i18n}>
      <CanvasView
        draft={draft}
        setup={harborSetup}
        steps={catalog.steps}
        stepGroups={catalog.stepGroups}
        issues={[]}
        editable
        editing={{
          addStep: nothing,
          editStep: nothing,
          removeStep: nothing,
          addTrigger: nothing,
          editTrigger: nothing,
          removeTrigger: nothing,
          duplicateTrigger: nothing,
          selected: undefined,
        }}
        onChange={nothing}
        onEditInJson={nothing}
        {...given}
        {...more}
      />
    </I18nProvider>
  );
  const view = render(element({}));
  return {
    user: userEvent.setup({ delay: null }),
    rerender: (more) => {
      view.rerender(element(more));
    },
  };
}

const box = (name: string): HTMLElement => screen.getByRole('group', { name });
const guide = 'Send the email “Pricing guide”';
const canvas = (): HTMLElement => screen.getByTestId('automation-canvas');
/** Opens the list of actions beside the canvas, from its Add menu. */
async function openLibrary(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Add' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Add action' }));
  const library = await screen.findByRole('region', { name: 'Actions' });
  // Its list is fetched when first asked for.
  await within(library).findByLabelText('Search actions');
  return library;
}

describe('what the canvas draws', () => {
  it('shows what starts the automation, every step in the order a contact meets it, and what stops it', () => {
    show();
    expect(screen.getByRole('heading', { level: 2, name: 'Canvas' })).toBeDefined();
    expect(box('Trigger: Someone submits “Request a quote”')).toBeDefined();
    const steps = [...canvas().querySelectorAll('[data-canvas-box][id^="automation-step-"]')].map(
      (each) => each.getAttribute('aria-label'),
    );
    expect(steps).toEqual([
      guide,
      'Wait 2 days',
      'If services includes “video”',
      'Text them “Here’s our video sample reel: {{values.sample_reel_url}}”',
      'Text them “Hi {{contact.firstName}}, did the pricing guide come through?”',
      'Wait 3 days',
      'Text them “Last check-in from Harbor Lights.”',
    ]);
    expect(screen.getByText('They reply')).toBeDefined();
    expect(screen.getByText('Their opportunity is won or lost')).toBeDefined();
    // Two paths end, each with its marker.
    expect(screen.getAllByText('END')).toHaveLength(2);
  });

  it('says in words what each step leads to, since the lines are only drawn', () => {
    show();
    expect(box(guide).textContent).toContain('Then: Wait 2 days');
    const condition = box('If services includes “video”');
    expect(condition.textContent).toContain(
      'If yes: Text them “Here’s our video sample reel: {{values.sample_reel_url}}”; If no: Text them “Hi {{contact.firstName}}, did the pricing guide come through?”',
    );
    expect(box('Text them “Last check-in from Harbor Lights.”').textContent).toContain(
      'Then: it ends',
    );
    expect(canvas().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks what is wrong on the step it is wrong with, and steps nothing leads to', () => {
    const draft: Draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        send_guide: { ...followUp.steps.send_guide, next: 'nowhere' },
        stray: { type: 'wait', config: {} },
      },
    };
    show(draft, {
      issues: [
        { level: 'error', path: '/steps/send_guide/next', code: 'unknown_step', message: 'Gone.' },
        { level: 'error', path: '/steps/send_guide', code: 'x', message: 'Twice.' },
        { level: 'warning', path: '/steps/stray', code: 'unreachable', message: 'Never runs.' },
        { level: 'warning', path: '/triggers/0', code: 'w', message: 'Check the form.' },
        { level: 'warning', path: '/name', code: 'n', message: 'About the automation.' },
      ],
    });
    expect(within(box(guide)).getByText('2 errors')).toBeDefined();
    expect(box(guide).textContent).toContain('Gone. Twice.');
    expect(box(guide).textContent).toContain("Then: a step that isn't there: nowhere");
    expect(screen.getByText('Missing step: nowhere')).toBeDefined();
    const stray = box('Wait');
    expect(within(stray).getByText('1 warning')).toBeDefined();
    expect(within(stray).getByText('Not connected · never runs')).toBeDefined();
    expect(within(stray).getByText('Not set up yet')).toBeDefined();
    expect(
      within(box('Trigger: Someone submits “Request a quote”')).getByText('1 warning'),
    ).toBeDefined();
  });

  it('says what nothing stops, and starts an empty automation from its first step', async () => {
    const { user, draft } = show({ name: 'New', triggers: welcome.triggers, steps: {} });
    expect(screen.getByText('Nothing stops it early.')).toBeDefined();
    expect(screen.getByText('No actions yet.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Add the first action' }));
    const dialog = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(dialog).getByRole('button', { name: /^Wait\s*Wait for a length/ }));
    await user.click(screen.getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({ start: 'wait', steps: { wait: { type: 'wait' } } });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
  });

  it('shows a step or a trigger this version does not know, and sends its editing to the JSON view', async () => {
    const { user, inJson } = show({
      ...followUp,
      triggers: [{ id: 'odd', type: 'something.new', config: {} }],
      steps: {
        ...followUp.steps,
        send_guide: { type: 'teleport', config: {}, next: 'wait_2_days' },
      },
    });
    const step = box('send_guide');
    expect(within(step).getByText('Unknown step: teleport')).toBeDefined();
    await user.click(within(step).getByRole('button', { name: 'Edit in JSON: send_guide' }));
    const trigger = box('Trigger: something.new');
    expect(within(trigger).getByText('Unknown trigger: something.new')).toBeDefined();
    await user.click(within(trigger).getByRole('button', { name: 'Edit in JSON: something.new' }));
    expect(inJson).toEqual(['/steps/send_guide', '/triggers/0']);
  });

  it('is for looking only when the person may not change the draft', () => {
    show(followUp, { editable: false });
    expect(box(guide)).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    // Zooming changes nothing, so it stays.
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDefined();
    // With nothing in it to press, the drawing itself can be reached and scrolled by keyboard.
    expect(canvas().getAttribute('tabindex')).toBe('0');
    expect(canvas().getAttribute('aria-label')).toBe('The workflow, drawn');
    cleanup();
    show();
    expect(canvas().getAttribute('tabindex')).toBeNull();
  });
});

describe('adding steps on the canvas', () => {
  it('adds a step with the + between two steps, through the same form as the Steps view', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: `Add an action after: ${guide}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(dialog).getByRole('button', { name: /^Add tag/ }));
    await user.click(screen.getByRole('combobox', { name: 'Tag' }));
    await user.click(await screen.findByRole('option', { name: 'VIP' }));
    await user.click(screen.getByRole('button', { name: 'Save action' }));

    expect(draft()).toMatchObject({
      steps: {
        send_guide: { next: 'tag_add' },
        tag_add: { type: 'tag.add', config: { tag: 'tag_vip' }, next: 'wait_2_days' },
      },
    });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
    // Nobody arranged the drawing, so the document gains no layout by it.
    expect(Object.hasOwn(draft(), 'layout')).toBe(false);
    expect(box('Add the tag VIP').textContent).toContain('Then: Wait 2 days');
  });

  it('has one + where branches join, which adds before the joined step for every one of them', async () => {
    const { user, draft } = show(leadIntake);
    const joins = screen.getAllByRole('button', { name: /^Add an action before: / });
    expect(joins.map((button) => button.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(
        /^Add an action before: .*Follow up tomorrow.*, for every path that joins here$/,
      ),
      expect.stringMatching(/^Add an action before: .*Welcome.*, for every path that joins here$/),
    ]);
    // The last step of a branch has no + of its own at the join.
    expect(screen.queryAllByRole('button', { name: /^Add an action after: Create/ })).toEqual([]);
    const [first] = joins;
    if (first === undefined) throw new Error('No join has an add button.');
    await user.click(first);
    const dialog = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(dialog).getByRole('button', { name: /^Add tag/ }));
    await user.click(screen.getByRole('combobox', { name: 'Tag' }));
    await user.click(await screen.findByRole('option', { name: 'VIP' }));
    await user.click(screen.getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({
      steps: {
        deal_photo: { next: 'tag_add' },
        deal_video: { next: 'tag_add' },
        deal_other: { next: 'thanks' },
        tag_add: { next: 'follow_up' },
      },
    });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
  });

  it('adds to one joining branch alone from the menu of its last step', async () => {
    const { user, draft } = show(leadIntake);
    const [photo] = screen.getAllByRole('button', { name: /^Actions for: Create an opportunity/ });
    if (photo === undefined) throw new Error('No deal step is drawn.');
    await user.click(photo);
    await user.click(await screen.findByRole('menuitem', { name: 'Add an action after this one' }));
    const dialog = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(dialog).getByRole('button', { name: /^Add tag/ }));
    await user.click(screen.getByRole('combobox', { name: 'Tag' }));
    await user.click(await screen.findByRole('option', { name: 'VIP' }));
    await user.click(screen.getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({
      steps: {
        deal_photo: { next: 'tag_add' },
        deal_video: { next: 'follow_up' },
        tag_add: { next: 'follow_up' },
      },
    });
  });

  it('offers no "add after" in the menu of a step that branches: each branch has its own +', async () => {
    const { user } = show(leadIntake);
    await user.click(screen.getByRole('button', { name: /^Actions for: Take the first branch/ }));
    await screen.findByRole('menuitem', { name: 'Edit' });
    expect(screen.queryByRole('menuitem', { name: 'Add an action after this one' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Add an action to: / })).toHaveLength(3);
  });

  it('adds to a branch, and at the very start', async () => {
    const { user, draft } = show();
    await user.click(
      screen.getByRole('button', {
        name: 'Add an action to: If yes of If services includes “video”',
      }),
    );
    await user.click(await screen.findByRole('button', { name: /^Wait\s*Wait for a length/ }));
    await user.click(screen.getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({
      steps: {
        asked_about_video: { next: { yes: 'wait', no: 'check_in' } },
        wait: { type: 'wait', next: 'send_reel' },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Add an action at the start' }));
    await user.click(await screen.findByRole('button', { name: /^Wait\s*Wait for a length/ }));
    await user.click(screen.getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({ start: 'wait_2', steps: { wait_2: { next: 'send_guide' } } });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
  });

  it('lists the steps there are in a library that can be searched, and those not available apart', async () => {
    const { user } = show(followUp, {
      setup: { ...harborSetup, ai: false, unavailableSteps: ['owner.assign'] },
    });
    const library = await openLibrary(user);
    expect(
      within(library)
        .getAllByRole('region')
        .map((section) => section.getAttribute('aria-label')),
    ).toEqual([
      'Contact',
      'Communication',
      'Send data',
      'Internal',
      'Opportunity',
      'Not available yet',
    ]);
    expect(
      within(within(library).getByRole('region', { name: 'Communication' }))
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual([
      'Communication',
      expect.stringMatching(/^Send email/),
      expect.stringMatching(/^Send text/),
      expect.stringMatching(/^Send WhatsApp/),
      expect.stringMatching(/^Manual call/),
      expect.stringMatching(/^Manual text/),
      expect.stringMatching(/^Notify the team/),
    ]);
    expect(within(library).queryByRole('button', { name: /^Ask AI/ })).toBeNull();
    expect(within(library).queryByRole('button', { name: /^Assign owner/ })).toBeNull();
    const apart = within(library).getByRole('region', { name: 'Not available yet' });
    expect(apart.textContent).toContain("Assign ownerThis action isn't available yet.");
    expect(apart.textContent).toContain('Ask AIAdd an AI key in Settings to use this action.');

    // A section folds, and opens again.
    const fold = within(library).getByRole('button', { name: 'Contact' });
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    await user.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(within(library).queryByRole('button', { name: /^Add tag/ })).toBeNull();
    await user.click(fold);
    expect(within(library).getByRole('button', { name: /^Add tag/ })).toBeDefined();

    // One category alone, then every one again.
    await user.click(within(library).getByRole('combobox', { name: 'Categories' }));
    await user.click(await screen.findByRole('option', { name: 'Internal' }));
    expect(
      within(library)
        .getAllByRole('region')
        .map((section) => section.getAttribute('aria-label')),
    ).toEqual(['Internal', 'Not available yet']);
    await user.click(within(library).getByRole('combobox', { name: 'Categories' }));
    await user.click(await screen.findByRole('option', { name: 'All categories' }));

    await user.type(within(library).getByLabelText('Search actions'), 'TEXT');
    expect(
      within(library)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual([
      '',
      'Communication',
      expect.stringMatching(/^Send text/),
      expect.stringMatching(/^Manual text/),
    ]);
    await user.clear(within(library).getByLabelText('Search actions'));
    await user.type(within(library).getByLabelText('Search actions'), 'zzz');
    expect(within(library).getByText('No action matches that.')).toBeDefined();

    await user.click(within(library).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Actions' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add' }));
    await openLibrary(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Actions' })).toBeNull();
  });

  it('puts a step chosen in the library where the person says, without any dragging', async () => {
    const { user, draft } = show();
    await user.click(within(await openLibrary(user)).getByRole('button', { name: /^Send text/ }));
    // The library makes way, the canvas says what it waits for, and the keyboard is on
    // the first place the step could go.
    expect(screen.queryByRole('region', { name: 'Actions' })).toBeNull();
    expect(screen.getByText('Choose where to put: Send text')).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe(
      'Choose where to put: Send text. Use an Add button on the canvas.',
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Add an action at the start' }),
    );

    await user.click(screen.getByRole('button', { name: 'Add an action after: Wait 3 days' }));
    // Straight to the settings of the step chosen, not back to the list of steps.
    const dialog = await screen.findByRole('dialog', { name: 'Send text' });
    await user.type(within(dialog).getByLabelText('Message'), 'Still there?');
    await user.click(within(dialog).getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({
      steps: {
        wait_3_days: { next: 'sms_send' },
        sms_send: {
          type: 'sms.send',
          config: { message: 'Still there?' },
          next: 'last_check_in',
        },
      },
    });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
    expect(screen.queryByText('Choose where to put: Send text')).toBeNull();
  });

  it('lets the person change their mind: about the place, and about the step', async () => {
    const { user, draft } = show();
    const chooseText = async (): Promise<void> => {
      await user.click(within(await openLibrary(user)).getByRole('button', { name: /^Send text/ }));
    };
    await chooseText();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Choose where to put: Send text')).toBeNull();
    await chooseText();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Choose where to put: Send text')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');

    // With the settings open, "Choose another step" goes back to every step there is.
    await chooseText();
    await user.click(screen.getByRole('button', { name: `Add an action after: ${guide}` }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Send text' })).getByRole('button', {
        name: 'Back',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(dialog).getByRole('button', { name: /^Wait\s*Wait for a length/ }));
    await user.click(screen.getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({ steps: { wait: { type: 'wait', next: 'wait_2_days' } } });
  });

  it('drops a step dragged from the library at the add point nearest to where it lands', async () => {
    const { user, draft } = show();
    const item = within(await openLibrary(user)).getByRole('button', {
      name: /^Wait\s*Wait for a length/,
    });
    expect(item.getAttribute('draggable')).toBe('true');
    const carried = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => carried.set(type, value),
      getData: (type: string) => carried.get(type) ?? '',
      get types() {
        return [...carried.keys()];
      },
      effectAllowed: 'none',
      dropEffect: 'none',
    };
    fireEvent.dragStart(item, { dataTransfer });
    expect(carried.get(STEP_MIME)).toBe('wait');
    // jsdom places everything at the top-left, so the nearest add point is the first.
    fireEvent.dragOver(canvas(), { dataTransfer, clientX: 0, clientY: 0 });
    expect(dataTransfer.dropEffect).toBe('copy');
    fireEvent.drop(canvas(), { dataTransfer, clientX: 0, clientY: 0 });
    fireEvent.dragEnd(item, { dataTransfer });

    const dialog = await screen.findByRole('dialog', { name: 'Wait' });
    await user.click(within(dialog).getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({ start: 'wait', steps: { wait: { next: 'send_guide' } } });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);

    // Something else dragged over the canvas, such as a file, is none of its business.
    const file = { types: ['Files'], getData: () => '', dropEffect: 'none' };
    fireEvent.dragOver(canvas(), { dataTransfer: file });
    fireEvent.drop(canvas(), { dataTransfer: file });
    expect(file.dropEffect).toBe('none');
    expect(screen.queryByRole('dialog', { name: 'Wait' })).toBeNull();
  });

  it('adds and removes ways to start', async () => {
    const { user, draft } = show();
    // The only way to start can't be removed.
    expect(screen.queryByRole('button', { name: /^Delete: Someone submits/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add new trigger' }));
    await user.click(await screen.findByRole('button', { name: /^Contact created/ }));
    await user.click(await screen.findByRole('button', { name: 'Save trigger' }));
    expect(draft()).toMatchObject({
      triggers: [{ type: 'form.submitted' }, { id: 'contact_created', type: 'contact.created' }],
    });
    await user.click(
      screen.getByRole('button', { name: 'Delete: Someone submits “Request a quote”' }),
    );
    await user.click(screen.getByRole('button', { name: 'Delete trigger' }));
    expect(draft()).toMatchObject({ triggers: [{ type: 'contact.created' }] });

    await user.click(screen.getByRole('button', { name: 'Edit: A contact is created' }));
    expect(await screen.findByRole('dialog', { name: 'Contact created' })).toBeDefined();
  });
});

describe('a trigger on the canvas', () => {
  // Found also while a panel is open, when everything behind it is hidden from a reader.
  const group = (name: string | RegExp): HTMLElement =>
    screen.getByRole('group', { name, hidden: true });
  const trigger = (): HTMLElement => group(/^Trigger: Someone submits “Request a quote”/);

  it('is a card with its type, what it listens for, its filters in a line, and a footer', () => {
    show();
    expect(within(trigger()).getByText('Form submitted')).toBeDefined();
    expect(within(trigger()).getByText('Someone submits “Request a quote”')).toBeDefined();
    expect(within(trigger()).getByText('No filters applied')).toBeDefined();
    cleanup();

    show({
      ...followUp,
      triggers: [
        {
          ...followUp.triggers[0],
          if: { field: 'contact.email', operator: 'is_set' },
        },
      ],
    });
    expect(within(trigger()).getAllByText(/email is filled in/).length).toBeGreaterThan(0);
    cleanup();

    show({ ...followUp, triggers: [{ ...followUp.triggers[0], if: 'not a condition' }] });
    expect(within(trigger()).getByText('Filters set in JSON')).toBeDefined();
  });

  it('is copied from its footer, and then either can be deleted', async () => {
    const { user, draft } = show();
    expect(screen.queryByRole('button', { name: /^Delete: / })).toBeNull();
    await user.click(
      screen.getByRole('button', { name: 'Duplicate: Someone submits “Request a quote”' }),
    );
    expect(screen.getByRole('status').textContent).toBe('Added a copy of the trigger.');
    expect((draft() as { triggers: unknown[] }).triggers).toEqual([
      followUp.triggers[0],
      { ...followUp.triggers[0], id: 'form_submitted' },
    ]);
    expect(screen.getAllByRole('button', { name: /^Delete: / })).toHaveLength(2);
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
  });

  it('shows how many it has enrolled when its Stats are asked for', async () => {
    const asked: string[] = [];
    const counted = {
      ...followUpStats,
      triggers: [
        ...followUpStats.triggers,
        {
          trigger: 'never_live',
          type: 'tag.added',
          inLiveVersion: false,
          allTime: { enrolled: 2 },
          live: null,
        },
      ],
    };
    const draft = {
      ...followUp,
      triggers: [
        ...followUp.triggers,
        { id: 'never_live', type: 'tag.added', config: { tag: 'tag_vip' } },
        { id: 'brand_new', type: 'contact.created', config: {} },
      ],
    };
    const { user, rerender } = showWithStats(draft, {
      onWantStats: () => {
        asked.push('stats');
      },
    });
    const stats = screen.getByRole('button', {
      name: 'Stats: Someone submits “Request a quote”',
    });
    expect(stats.getAttribute('aria-expanded')).toBe('false');
    await user.click(stats);
    expect(asked).toEqual(['stats']);
    expect(stats.getAttribute('aria-expanded')).toBe('true');
    expect(within(trigger()).getByRole('status').textContent).toBe('Loading the numbers…');
    expect(within(trigger()).queryByText('No filters applied')).toBeNull();

    rerender({ statsFailed: true });
    expect(within(trigger()).getByRole('status').textContent).toBe(
      "The numbers couldn't be loaded.",
    );
    rerender({ stats: counted });
    expect(within(trigger()).getByRole('status').textContent).toBe(
      'Enrolled: 12 (live version: 5)',
    );
    // One the live version does not have, and one nothing has counted yet.
    await user.click(
      screen.getByRole('button', { name: 'Stats: The tag VIP is added to a contact' }),
    );
    await user.click(screen.getByRole('button', { name: 'Stats: A contact is created' }));
    expect(
      within(box('Trigger: The tag VIP is added to a contact')).getByRole('status').textContent,
    ).toBe('Enrolled: 2');
    expect(within(box('Trigger: A contact is created')).getByRole('status').textContent).toBe(
      'Enrolled: 0',
    );
    await user.click(stats);
    expect(within(trigger()).getByText('No filters applied')).toBeDefined();
  });

  it('has the accent border while its panel is open, as an action does', async () => {
    const { user } = show();
    expect(trigger().hasAttribute('data-selected')).toBe(false);
    await user.click(
      screen.getByRole('button', { name: 'Edit: Someone submits “Request a quote”' }),
    );
    await screen.findByRole('dialog', { name: 'Form submitted' });
    expect(trigger().hasAttribute('data-selected')).toBe(true);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Actions for: Wait 2 days' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    await screen.findByRole('dialog', { name: 'Wait' });
    expect(group('Wait 2 days').hasAttribute('data-selected')).toBe(true);
    expect(trigger().hasAttribute('data-selected')).toBe(false);
  });

  it('is added from the Add menu, and a workflow with none yet starts from the card that adds one', async () => {
    const { user, draft } = show({ name: 'New Workflow : 1', triggers: [], steps: {} });
    expect(screen.queryByRole('group', { name: /^Trigger: / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add new trigger' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add the first action' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add trigger' }));
    const picker = await screen.findByRole('dialog', { name: 'Add trigger' });
    await user.click(within(picker).getByRole('button', { name: /^Contact created/ }));
    await user.click(screen.getByRole('button', { name: 'Save trigger' }));
    expect((draft() as { triggers: unknown[] }).triggers).toEqual([
      { id: 'contact_created', type: 'contact.created', config: {} },
    ]);
    expect(box('Trigger: A contact is created')).toBeDefined();
  });
});

describe('changing and removing steps on the canvas', () => {
  it('opens a step for editing from its box, and keeps what the form changes', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Edit: Wait 2 days' }));
    const dialog = await screen.findByRole('dialog', { name: 'Wait' });
    const amount = within(dialog).getByLabelText('How long to wait');
    await user.clear(amount);
    await user.type(amount, '5');
    await user.click(within(dialog).getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({ steps: { wait_2_days: { config: { duration: 'P5D' } } } });
    expect(box('Wait 5 days')).toBeDefined();
  });

  it('sets a wait in seconds, with one less and one more, and the hours it may go on in', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Edit: Wait 2 days' }));
    const dialog = await screen.findByRole('dialog', { name: 'Wait' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Unit for: How long to wait' }));
    await user.click(await screen.findByRole('option', { name: 'Seconds' }));
    await user.click(within(dialog).getByRole('button', { name: 'One more: How long to wait' }));
    await user.click(within(dialog).getByRole('button', { name: 'One more: How long to wait' }));
    await user.click(within(dialog).getByRole('button', { name: 'One less: How long to wait' }));
    expect(within(dialog).getByLabelText<HTMLInputElement>('How long to wait').value).toBe('3');

    // Off until asked for; on, it starts from office hours.
    const only = within(dialog).getByRole('switch', { name: 'Only go on during certain hours' });
    expect(only.getAttribute('aria-checked')).toBe('false');
    expect(within(dialog).queryByRole('group', { name: 'Days' })).toBeNull();
    await user.click(only);
    const days = within(dialog).getByRole('group', { name: 'Days' });
    expect(
      within(days)
        .getAllByRole('button', { pressed: true })
        .map((day) => day.getAttribute('aria-label')),
    ).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
    await user.click(within(days).getByRole('button', { name: 'Saturday' }));
    await user.click(within(days).getByRole('button', { name: 'Monday' }));
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '22:00' } });
    fireEvent.change(within(dialog).getByLabelText('To'), { target: { value: '06:30' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save action' }));
    expect(draft()).toMatchObject({
      steps: {
        wait_2_days: {
          config: {
            duration: 'PT3S',
            resumeWindow: {
              days: ['tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
              start: '22:00',
              end: '06:30',
            },
          },
        },
      },
    });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
  });

  it('keeps the last day of a window, and leaves the setting out when switched off', async () => {
    const windowed: Draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        wait_2_days: {
          ...followUp.steps.wait_2_days,
          config: {
            duration: 'P2D',
            resumeWindow: { days: ['sunday'], start: '10:00', end: '12:00' },
          },
        },
      },
    };
    const { user, draft } = show(windowed);
    await user.click(screen.getByRole('button', { name: 'Edit: Wait 2 days' }));
    const dialog = await screen.findByRole('dialog', { name: 'Wait' });
    const sunday = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Sunday' });
    expect(sunday.disabled).toBe(true);
    // An emptied time is not a time: the one it had stays.
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '' } });
    expect(within(dialog).getByLabelText<HTMLInputElement>('From').value).toBe('10:00');
    await user.click(
      within(dialog).getByRole('switch', { name: 'Only go on during certain hours' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save action' }));
    const config = (draft() as { steps: Record<string, { config: object }> }).steps['wait_2_days']
      ?.config;
    expect(config).toEqual({ duration: 'P2D' });
  });

  it('shows a window it cannot hold as it reads, to be edited in JSON', async () => {
    const odd: Draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        wait_2_days: {
          ...followUp.steps.wait_2_days,
          config: {
            duration: 'P2D',
            resumeWindow: { days: ['monday'], start: '9am', end: '17:00' },
          },
        },
      },
    };
    const { user } = show(odd);
    await user.click(screen.getByRole('button', { name: 'Edit: Wait 2 days' }));
    const dialog = await screen.findByRole('dialog', { name: 'Wait' });
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(within(dialog).getByText('This setting is edited in the JSON view.')).toBeDefined();
  });

  it('asks before removing a step, then joins the flow back up', async () => {
    const { user, draft } = show();
    await user.click(screen.getByRole('button', { name: 'Actions for: Wait 2 days' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this action?' });
    expect(dialog.textContent).toContain(
      'What came before it will lead straight to: If services includes “video”',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete action' }));
    expect(draft()).toMatchObject({ steps: { send_guide: { next: 'asked_about_video' } } });
    expect(Object.keys((draft() as { steps: object }).steps)).not.toContain('wait_2_days');
    expect(screen.queryByRole('group', { name: 'Wait 2 days' })).toBeNull();
  });
});

describe('moving steps', () => {
  const layoutOf = (draft: Draft): Record<string, { x: number; y: number }> =>
    (draft as { layout: Record<string, { x: number; y: number }> }).layout;

  it('moves a step with the arrow keys from its Move button, changing only the layout', async () => {
    const { user, draft } = show();
    const before = positionsOf(followUp);
    const move = screen.getByRole('button', { name: `Move: ${guide}` });
    expect(move.getAttribute('aria-describedby')).not.toBeNull();
    move.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('status').textContent).toBe(`Moved ${guide} right.`);
    const moved = draft();
    const { layout, ...rest } = moved;
    expect(sameJson(rest, followUp)).toBe(true);
    const from = before.get('send_guide') ?? { x: 0, y: 0 };
    expect(layoutOf(moved)['send_guide']).toEqual({ x: from.x + GRID, y: from.y });
    // Everything else is written down exactly where it was.
    for (const [id, point] of before)
      if (id !== 'send_guide') expect((layout as Record<string, unknown>)[id]).toEqual(point);
    // The keyboard is still on the same button, so the next key moves it again.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Move: ${guide}` }));

    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(layoutOf(draft())['send_guide']).toEqual({ x: from.x + GRID, y: from.y + 5 * GRID });
    expect(screen.getByRole('status').textContent).toBe(`Moved ${guide} down.`);
    await user.keyboard('{ArrowLeft}{ArrowUp}');
    expect(layoutOf(draft())['send_guide']).toEqual({ x: from.x, y: from.y + 4 * GRID });
    // Any other key is left alone.
    await user.keyboard('a');
    expect(layoutOf(draft())['send_guide']).toEqual({ x: from.x, y: from.y + 4 * GRID });
    expect(validateAutomation(draft(), harborSetup).errors).toEqual([]);
  });

  it('offers to lay everything out automatically again once something was placed by hand', async () => {
    const { user, draft } = show();
    expect(screen.queryByRole('button', { name: 'Tidy layout' })).toBeNull();
    screen.getByRole('button', { name: 'Move: Wait 2 days' }).focus();
    await user.keyboard('{ArrowRight}');
    await user.click(screen.getByRole('button', { name: 'Tidy layout' }));
    expect(Object.hasOwn(draft(), 'layout')).toBe(false);
    expect(sameJson(draft(), followUp)).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Laid out automatically again.');
    expect(screen.queryByRole('button', { name: 'Tidy layout' })).toBeNull();
  });

  it('makes room for a step added to a drawing arranged by hand', async () => {
    const { user, draft } = show();
    screen.getByRole('button', { name: `Move: ${guide}` }).focus();
    await user.keyboard('{ArrowRight}');
    const before = savedPositions(draft());
    await user.click(screen.getByRole('button', { name: `Add an action after: ${guide}` }));
    await user.click(await screen.findByRole('button', { name: /^Wait\s*Wait for a length/ }));
    await user.click(screen.getByRole('button', { name: 'Save action' }));
    const after = savedPositions(draft());
    expect(after.get('wait')).toEqual(before.get('wait_2_days'));
    expect(after.get('wait_2_days')?.y).toBe((before.get('wait_2_days')?.y ?? 0) + 140);
    expect(after.get('send_guide')).toEqual(before.get('send_guide'));
  });

  it('moves a step dragged by its box or by its Move button, and a click still opens it', async () => {
    const { user, draft } = show();
    const before = positionsOf(followUp).get('wait_2_days') ?? { x: 0, y: 0 };
    const open = screen.getByRole('button', { name: 'Edit: Wait 2 days' });
    fireEvent.pointerDown(open, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    // A wobble of a pixel or two is still a click.
    fireEvent.pointerMove(open, { pointerId: 1, clientX: 101, clientY: 101 });
    fireEvent.pointerMove(open, { pointerId: 1, clientX: 163, clientY: 141 });
    fireEvent.pointerUp(open, { pointerId: 1, clientX: 163, clientY: 141 });
    expect(layoutOf(draft())['wait_2_days']).toEqual({ x: before.x + 60, y: before.y + 40 });
    // The click a browser sends after a drag does not open the step.
    fireEvent.click(open);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit: Wait 2 days' }));
    expect(await screen.findByRole('dialog', { name: 'Wait' })).toBeDefined();
    await user.keyboard('{Escape}');

    const handle = screen.getByRole('button', { name: 'Move: Wait 3 days' });
    const three = positionsOf(draft()).get('wait_3_days') ?? { x: 0, y: 0 };
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 2,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 50, clientY: 10 });
    fireEvent.pointerUp(handle, { pointerId: 2 });
    expect(layoutOf(draft())['wait_3_days']).toEqual({ x: three.x + 40, y: three.y });
  });

  it('leaves alone a press that never moves, a finger on a box, and another button', () => {
    const { draft } = show();
    const open = screen.getByRole('button', { name: 'Edit: Wait 2 days' });
    fireEvent.pointerDown(open, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(open, { pointerId: 1 });
    // A finger on a box scrolls the canvas; a right click is the browser's.
    fireEvent.pointerDown(open, {
      button: 0,
      pointerId: 2,
      pointerType: 'touch',
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(open, { pointerId: 2, clientX: 80, clientY: 80 });
    fireEvent.pointerUp(open, { pointerId: 2 });
    fireEvent.pointerDown(open, { button: 2, pointerId: 3, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(open, { pointerId: 3, clientX: 80, clientY: 80 });
    fireEvent.pointerUp(open, { pointerId: 3 });
    // A drag that comes back to where it began changes nothing.
    fireEvent.pointerDown(open, { button: 0, pointerId: 4, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(open, { pointerId: 4, clientX: 160, clientY: 100 });
    fireEvent.pointerMove(open, { pointerId: 4, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(open, { pointerId: 4 });
    expect(draft()).toBe(followUp);
  });
});

describe('zooming', () => {
  it('leaves ordinary wheel scrolling native and zooms only with a modifier', () => {
    const { draft } = show();
    const before = draft();
    const percent = (): string | null | undefined =>
      screen.getByRole('button', { name: 'Zoom in' }).nextElementSibling?.textContent;
    const scrolling = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    fireEvent(canvas(), scrolling);
    expect(scrolling.defaultPrevented).toBe(false);
    expect(percent()).toBe('Zoom 100%');
    fireEvent.wheel(canvas(), { deltaY: -100, ctrlKey: true });
    expect(percent()).toBe('Zoom 125%');
    for (let turns = 0; turns < 10; turns += 1)
      fireEvent.wheel(canvas(), { deltaY: -100, ctrlKey: true });
    expect(percent()).toBe('Zoom 150%');
    for (let turns = 0; turns < 10; turns += 1)
      fireEvent.wheel(canvas(), { deltaY: 100, metaKey: true });
    expect(percent()).toBe('Zoom 50%');
    expect(draft()).toEqual(before);
  });

  it('zooms in steps between half and one and a half times, and fits the drawing to the screen', async () => {
    const { user } = show();
    const percent = (): string | null | undefined =>
      screen.getByRole('button', { name: 'Zoom in' }).nextElementSibling?.textContent;
    expect(percent()).toBe('Zoom 100%');
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(percent()).toBe('Zoom 150%');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Zoom in' }).disabled).toBe(true);
    for (let presses = 0; presses < 4; presses += 1)
      await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(percent()).toBe('Zoom 50%');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Zoom out' }).disabled).toBe(true);

    // The canvas is 560 pixels wide here; the drawing is wider, so it is shrunk to fit.
    Object.defineProperty(canvas(), 'clientWidth', { configurable: true, value: 560 });
    await user.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(percent()).toMatch(/^Zoom [3-9]\d%$/);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(percent()).toBe('Zoom 75%');
    // A drawing that already fits is shown life-size, never larger.
    Object.defineProperty(canvas(), 'clientWidth', { configurable: true, value: 5000 });
    await user.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(percent()).toBe('Zoom 100%');
  });
});
