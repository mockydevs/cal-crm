// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { validateAutomation, type Automation } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automationId,
  automationOf,
  catalogOf,
  followUp,
  harborSetup,
  runList,
  stepRunList,
  stamp,
  versionId,
} from '../e2e/automation-fixtures';
import AutomationBuilder from './automation-builder';
// Loaded here, before any test starts: the page fetches these lazily, and a test that had to
// wait for their code to be read for the first time lost that race on a busy machine. With
// them loaded, a test waits on React alone.
import './automation-canvas';
import './automation-runs';
import './automation-logs';
import './automation-settings-tab';
import './automation-canvas-library';
import './automation-step-dialog';
import './automation-steps-view';
import './automation-resume-window';
import './automation-merge-insert';
import './automation-tile';
import './automation-email-copy';
import './automation-publish-dialog';
import './automation-test-dialog';
import { updateStepConfig, type Draft } from './automation-document';
import type { AutomationsSearch, AutomationView } from './automation-navigation';

// The builder's surroundings, stood in for: the API, the business the page is in, the page
// frame, and the router's leave-guard. Everything under test is the builder's own.
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
  usePageTitle: () => undefined,
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
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useBlocker: () => ({ status: 'idle' }),
  // A link is a link: only where it is matters here.
  Link: ({ children }: { children: ReactNode }) => <a href="/elsewhere">{children}</a>,
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  // jsdom lays nothing out, so it has no scrolling to do.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

/** The answers of a server holding one automation; a test replaces what it needs to. */
function serve(
  automation: Automation,
  more: Partial<Record<string, (input: unknown) => unknown>> = {},
  setup = harborSetup,
): void {
  server.answer = (operation, input) => {
    const custom = more[operation];
    if (custom !== undefined) return custom(input);
    if (operation === 'getAutomation') return automation;
    if (operation === 'getAutomationCatalog') return catalogOf(setup);
    // The template picker reads the library itself: the setup's templates, as its rows.
    if (operation === 'listMessageTemplates')
      return {
        canManage: true,
        nextCursor: null,
        items: setup.emailTemplates.map((template) => ({
          ...template,
          subject: `Subject of ${template.name}`,
          format: 'text',
          preheader: null,
          folder: null,
          preview: '',
          createdAt: '2026-10-09T09:00:00.000Z',
          updatedAt: '2026-10-09T09:00:00.000Z',
          archivedAt: null,
          revision: 'a'.repeat(64),
        })),
      };
    throw new Error(`Unexpected request: ${operation}`);
  };
}

/** Chooses a template in the action's panel: the list is opened, then the row pressed. */
async function chooseTemplate(
  user: ReturnType<typeof userEvent.setup>,
  form: HTMLElement,
  name: string,
): Promise<void> {
  await user.click(await within(form).findByRole('button', { name: /^Email template: / }));
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${name}`) }));
}

const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

/** Where a test starts: the Steps view unless it says another, the canvas by its own name. */
type Start = Omit<AutomationsSearch, 'view'> & { readonly view?: AutomationView };

function Harness({ start = {} }: { readonly start?: Start }): ReactElement {
  const [search, setSearch] = useState<Start>({ view: 'steps', ...start });
  return (
    <AutomationBuilder
      automationId={automationId}
      // As the page does: an address with no view is the canvas.
      view={search.view ?? 'canvas'}
      runId={search.run}
      navigation={{ hrefFor: (to) => `?view=${to.view ?? 'canvas'}`, go: setSearch }}
    />
  );
}

async function open(start: Start = {}): Promise<ReturnType<typeof userEvent.setup>> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <Harness start={start} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: followUp.name });
  // The Steps view's code arrives after the builder's own.
  await waitFor(() => {
    expect(screen.queryByText('Loading the steps…')).toBeNull();
  });
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return userEvent.setup({ delay: null });
}

const json = (): HTMLTextAreaElement => screen.getByLabelText('Automation JSON');
const stepCard = (id: string): HTMLElement => {
  const card = document.getElementById(`automation-step-${id}`);
  if (card === null) throw new Error(`No step ${id} is shown.`);
  return card;
};
const conflict = (): ApiError =>
  new ApiError({
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    detail: 'The draft moved on.',
  });

beforeEach(() => {
  server.calls.length = 0;
});

describe('the Steps view', () => {
  it('keeps the action open when Cancel is pressed during a template copy', async () => {
    let resolveCopy: (value: unknown) => void = () => {
      throw new Error('Copy has not started.');
    };
    const pending = new Promise<unknown>((resolve) => {
      resolveCopy = resolve;
    });
    const template = 'tmpl_01h455vb4pex5vsknk084sn02q';
    serve(
      automationOf(),
      {
        getMessageTemplate: () => ({ id: template, revision: 'a'.repeat(64) }),
        copyWorkflowEmailTemplate: () => pending,
      },
      {
        ...harborSetup,
        emailTemplates: [...harborSetup.emailTemplates, { id: template, name: 'Copy pending' }],
      },
    );
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Edit: Send the email “Pricing guide”' }));
    const form = await screen.findByRole('dialog', { name: 'Send email' });
    await chooseTemplate(user, form, 'Copy pending');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(callsTo('copyWorkflowEmailTemplate')).toHaveLength(1);
    });
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog', { name: 'Leave without saving?' })).toBeNull();
    expect(within(form).getByRole('button', { name: /^Delete$/ })).toHaveProperty('disabled', true);
    expect(within(form).getByRole('button', { name: 'Save action' })).toHaveProperty(
      'disabled',
      true,
    );
    resolveCopy({
      automation: automationOf({ draftVersion: 4 }),
      validation: { valid: true, errors: [], warnings: [] },
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
  it('keeps copied content and the entered name when saving a new template is refused', async () => {
    serve(
      automationOf({
        draft: updateStepConfig(followUp, 'send_guide', {
          mode: 'copy',
          subject: 'Copied subject',
          body: 'Independent welcome',
        }),
      }),
      {
        createMessageTemplate: () => {
          throw conflict();
        },
        listMessageTemplateFolders: () => ({ canManage: true, items: [] }),
      },
    );
    const user = await open();
    await user.click(within(stepCard('send_guide')).getByRole('button', { name: /^Edit:/ }));
    const form = await screen.findByRole('dialog', { name: 'Send email' });
    // Saving as a template is in the popup editor, which opens on the action's own email.
    await user.click(await within(form).findByRole('button', { name: 'Open in the editor' }));
    const editor = await screen.findByRole('dialog', { name: 'Email' });
    await user.click(within(editor).getByRole('button', { name: 'Save as new template' }));
    const saving = within(editor).getByRole('form', { name: 'Save as new template' });
    await user.click(within(saving).getByRole('button', { name: 'Save template' }));
    expect(await within(saving).findByText('Give the template a name.')).toBeDefined();
    expect(callsTo('createMessageTemplate')).toEqual([]);
    const name = within(saving).getByRole('textbox', { name: 'New template name' });
    await user.type(name, 'Existing name');
    await user.click(within(saving).getByRole('button', { name: 'Save template' }));
    expect(await within(saving).findByText('The draft moved on.')).toBeDefined();
    expect(name).toHaveProperty('value', 'Existing name');
    expect(within(editor).getByRole('textbox', { name: /^Subject/ })).toHaveProperty(
      'value',
      'Copied subject',
    );
    expect(callsTo('createMessageTemplate')).toHaveLength(1);
    expect(callsTo('replaceAutomationDraft')).toEqual([]);
  });
  it('saves copied email content as a new library template without reconnecting the action', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const copied = {
      mode: 'copy',
      subject: 'Copied subject',
      body: 'Independent welcome',
    };
    serve(automationOf({ draft: updateStepConfig(followUp, 'send_guide', copied) }), {
      createMessageTemplate: () => ({ id: 'tmpl_01h455vb4pex5vsknk084sn02r' }),
      listMessageTemplateFolders: () => ({ canManage: true, items: [] }),
    });
    const user = await open();
    await user.click(within(stepCard('send_guide')).getByRole('button', { name: /^Edit:/ }));
    const form = await screen.findByRole('dialog', { name: 'Send email' });
    await user.click(await within(form).findByRole('button', { name: 'Open in the editor' }));
    const editor = await screen.findByRole('dialog', { name: 'Email' });
    await user.click(within(editor).getByRole('button', { name: 'Save as new template' }));
    const saving = within(editor).getByRole('form', { name: 'Save as new template' });
    await user.type(
      within(saving).getByRole('textbox', { name: 'New template name' }),
      'Reusable welcome',
    );
    await user.click(within(saving).getByRole('button', { name: 'Save template' }));
    expect(
      await within(editor).findByText(
        'Saved “Reusable welcome” as a new template. This email is unchanged.',
      ),
    ).toBeDefined();
    expect(callsTo('createMessageTemplate')).toEqual([
      {
        body: {
          name: 'Reusable welcome',
          subject: 'Copied subject',
          content: { format: 'text', text: 'Independent welcome' },
        },
      },
    ]);
    expect(callsTo('copyWorkflowEmailTemplate')).toEqual([]);
    expect(callsTo('replaceAutomationDraft')).toEqual([]);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual([
      'b',
      'biz_test',
      'message-templates',
    ]);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual([
      'b',
      'biz_test',
      'automation-catalog',
    ]);
    invalidate.mockRestore();
  });
  it('edits copied email content without replacing its provenance or reconnecting the library', async () => {
    const copied = {
      mode: 'copy',
      source: { id: 'tmpl_01h455vb4pex5vsknk084sn02q', revision: 'a'.repeat(64) },
      subject: 'Copied subject',
      body: 'Independent welcome',
    };
    serve(automationOf({ draft: updateStepConfig(followUp, 'send_guide', copied) }));
    const user = await open();
    await user.click(within(stepCard('send_guide')).getByRole('button', { name: /^Edit:/ }));
    const form = await screen.findByRole('dialog', { name: 'Send email' });
    const subject = within(form).getByRole('textbox', { name: /^Subject/ });
    expect(subject).toHaveProperty('value', 'Copied subject');
    await user.clear(subject);
    await user.type(subject, 'Edited subject');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const written: unknown = JSON.parse(json().value);
    expect(written).toMatchObject({
      steps: {
        send_guide: {
          config: {
            mode: 'copy',
            source: { id: 'tmpl_01h455vb4pex5vsknk084sn02q', revision: 'a'.repeat(64) },
            subject: 'Edited subject',
            body: 'Independent welcome',
          },
          next: 'wait_2_days',
        },
      },
    });
    expect(callsTo('getMessageTemplate')).toEqual([]);
    expect(callsTo('copyWorkflowEmailTemplate')).toEqual([]);
  });
  it('copies a newly selected library template through the canonical API and adopts independent content', async () => {
    const template = 'tmpl_01h455vb4pex5vsknk084sn02q';
    const revision = 'a'.repeat(64);
    const copied = {
      mode: 'copy',
      source: { id: template, revision },
      subject: 'Welcome subject',
      body: 'Independent welcome',
    };
    serve(
      automationOf(),
      {
        getMessageTemplate: () => ({ id: template, revision }),
        copyWorkflowEmailTemplate: () => ({
          automation: automationOf({
            draftVersion: 4,
            draft: updateStepConfig(followUp, 'send_guide', copied),
          }),
          validation: { valid: true, errors: [], warnings: [] },
        }),
      },
      {
        ...harborSetup,
        emailTemplates: [...harborSetup.emailTemplates, { id: template, name: 'Copied welcome' }],
      },
    );
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Edit: Send the email “Pricing guide”' }));
    const form = await screen.findByRole('dialog', { name: 'Send email' });
    await chooseTemplate(user, form, 'Copied welcome');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(callsTo('getMessageTemplate')).toEqual([{ params: { id: template } }]);
    expect(callsTo('copyWorkflowEmailTemplate')).toHaveLength(1);
    expect(callsTo('copyWorkflowEmailTemplate')[0]).toMatchObject({
      params: { id: automationId },
      body: {
        baseDraftVersion: 3,
        step: 'send_guide',
        template,
        revision,
        document: {
          name: followUp.name,
          steps: { send_guide: { config: { template } } },
        },
      },
    });
    expect(screen.getByText('Draft · version 4')).toBeDefined();
    expect(callsTo('replaceAutomationDraft')).toEqual([]);
  });

  it('keeps template selections in the action form after copying fails', async () => {
    const template = 'tmpl_01h455vb4pex5vsknk084sn02q';
    serve(
      automationOf(),
      {
        getMessageTemplate: () => {
          throw new Error('Template changed');
        },
      },
      {
        ...harborSetup,
        emailTemplates: [...harborSetup.emailTemplates, { id: template, name: 'Copied welcome' }],
      },
    );
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Edit: Send the email “Pricing guide”' }));
    const form = await screen.findByRole('dialog', { name: 'Send email' });
    await chooseTemplate(user, form, 'Copied welcome');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(await within(form).findByText(/Your edits are still here/)).toBeDefined();
    expect(
      within(form).getByRole('button', { name: 'Email template: Copied welcome' }),
    ).toBeDefined();
    expect(callsTo('copyWorkflowEmailTemplate')).toEqual([]);
  });
  it('lets an empty workflow begin without errors but still refuses publishing it', async () => {
    serve(automationOf({ draft: { ...followUp, triggers: [], steps: {}, start: undefined } }));
    const user = await open({ view: 'canvas' });
    await screen.findByRole('button', { name: 'Add new trigger' });
    expect(screen.queryByRole('heading', { name: 'Checks' })).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Published' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    expect(
      within(dialog).getByRole('region', { name: 'Fix these before publishing' }),
    ).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Publish' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(callsTo('publishAutomation')).toEqual([]);
  });

  it('reads the automation in plain words, from what starts it to what stops it', async () => {
    serve(automationOf());
    await open();
    const starts = screen.getByRole('list', { name: 'What starts it' });
    expect(within(starts).getByText('Someone submits “Request a quote”')).toBeDefined();
    expect(
      within(stepCard('send_guide')).getByText('Send the email “Pricing guide”'),
    ).toBeDefined();
    expect(within(stepCard('wait_2_days')).getByText('Wait 2 days')).toBeDefined();
    const no = screen.getByRole('group', { name: 'If no' });
    expect(within(no).getByText('Wait 3 days')).toBeDefined();
    expect(within(no).getByText('Then it ends.')).toBeDefined();
    const stops = screen.getByRole('region', { name: 'Stops as soon as' });
    expect(within(stops).getByText('They reply')).toBeDefined();
    expect(screen.getByText('Draft · version 3')).toBeDefined();
    expect(screen.getByText('Not published yet')).toBeDefined();
  });

  it('says a path goes back to an earlier step, without listing it twice', async () => {
    const loop: Draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        last_check_in: { ...followUp.steps.last_check_in, next: 'wait_2_days' },
      },
    };
    serve(automationOf({ draft: loop }));
    await open();
    expect(screen.getByText('Then it goes back to: Wait 2 days')).toBeDefined();
    expect(screen.getAllByText('Wait 2 days')).toHaveLength(1);
  });

  it('adds a step after another, with the settings its form asks for', async () => {
    serve(automationOf());
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Add an action after: Wait 2 days' }));
    const picker = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(picker).getByRole('button', { name: /^Add tag/ }));
    const form = await screen.findByRole('dialog', { name: 'Add tag' });
    // The keyboard moves from the choice that's gone to the first setting.
    expect(document.activeElement).toBe(within(form).getByRole('combobox', { name: 'Tag' }));
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(within(form).getByText('Fill this in.')).toBeDefined();
    await user.click(within(form).getByRole('combobox', { name: 'Tag' }));
    await user.click(await screen.findByRole('option', { name: 'VIP' }));
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(within(stepCard('tag_add')).getByText('Add the tag VIP')).toBeDefined();
    // And lands on the step that was added: on its first control.
    await waitFor(() => {
      expect(stepCard('tag_add').contains(document.activeElement)).toBe(true);
    });
    expect(screen.getByTestId('automation-unsaved')).toBeDefined();
    // The same change is what the JSON view holds.
    const written = JSON.parse(json().value) as { steps: Record<string, { next?: unknown }> };
    expect(written.steps['wait_2_days']?.next).toBe('tag_add');
    expect(written.steps['tag_add']).toEqual({
      type: 'tag.add',
      config: { tag: 'tag_vip' },
      next: 'asked_about_video',
    });
  });

  it('starts an empty automation with its first step, keeping the unit chosen', async () => {
    serve(automationOf({ draft: { name: followUp.name, triggers: followUp.triggers, steps: {} } }));
    const user = await open();
    expect(screen.getByText('This automation has no steps yet.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Add the first action' }));
    const picker = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(picker).getByRole('button', { name: /^Wait\s*Wait for a length/ }));
    const form = await screen.findByRole('dialog', { name: 'Wait' });
    const amount = within(form).getByRole('spinbutton', { name: 'How long to wait' });
    expect(amount).toHaveProperty('value', '1');
    await user.clear(amount);
    await user.click(within(form).getByRole('combobox', { name: 'Unit for: How long to wait' }));
    await user.click(await screen.findByRole('option', { name: 'Hours' }));
    await user.type(amount, '4');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(within(stepCard('wait')).getByText('Wait 4 hours')).toBeDefined();
    expect(screen.queryByText('This automation has no steps yet.')).toBeNull();
    expect(JSON.parse(json().value)).toMatchObject({
      start: 'wait',
      steps: { wait: { type: 'wait', config: { duration: 'PT4H' } } },
    });
  });

  it('asks before removing a step, then joins the flow back up', async () => {
    serve(automationOf());
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Remove: Wait 2 days' }));
    const asking = await screen.findByRole('dialog', { name: 'Delete this action?' });
    await waitFor(() => {
      expect(document.activeElement).toBe(within(asking).getByRole('button', { name: 'Keep it' }));
    });
    expect(
      within(asking).getByText(/What came before it will lead straight to: If services includes/),
    ).toBeDefined();
    await user.click(within(asking).getByRole('button', { name: 'Keep it' }));
    expect(stepCard('wait_2_days')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Remove: Wait 2 days' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete action' }),
    );
    await waitFor(() => {
      expect(document.getElementById('automation-step-wait_2_days')).toBeNull();
    });
    // The button that opened the dialog went with the step: the keyboard goes to the list.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Steps' }));
    });
    const written = JSON.parse(json().value) as { steps: Record<string, { next?: unknown }> };
    expect(written.steps['send_guide']?.next).toBe('asked_about_video');
  });

  it('shows a setting too involved for a form as it reads, and leads to the JSON view', async () => {
    // Either of two things: rows hold comparisons that must all be true, and not this.
    const either = {
      ...followUp.steps.asked_about_video,
      config: {
        if: {
          any: [
            { field: 'contact.services', operator: 'includes', value: 'video' },
            { field: 'contact.email', operator: 'is_set' },
          ],
        },
      },
    };
    serve(
      automationOf({
        draft: { ...followUp, steps: { ...followUp.steps, asked_about_video: either } },
      }),
    );
    const user = await open();
    await user.click(
      screen.getByRole('button', {
        name: 'Edit: If services includes “video” or email is filled in',
      }),
    );
    const form = await screen.findByRole('dialog', { name: 'If / else' });
    expect(within(form).getByText('services includes “video” or email is filled in')).toBeDefined();
    expect(within(form).queryByRole('combobox', { name: 'Field of condition 1' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Edit in JSON' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(json());
    });
    // The dialog, closing, leaves the keyboard where the JSON view put it.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(json());
    const selected = json().value.slice(json().selectionStart, json().selectionEnd);
    expect(JSON.parse(selected)).toEqual(either);
  });

  it("edits an If / else's conditions as rows, and names the action", async () => {
    serve(automationOf());
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Edit: If services includes “video”' }));
    const form = await screen.findByRole('dialog', { name: 'If / else' });
    expect(
      within(form).getByText(
        'Take the first branch whose condition holds, in the order written; when none holds, take the branch kept for that. With a single condition, the branches are yes and no.',
      ),
    ).toBeDefined();
    expect(within(form).getByRole('combobox', { name: 'Field of condition 1' }).textContent).toBe(
      'Services',
    );
    // Services is a list of choices: a list "includes" where text "contains".
    expect(
      within(form).getByRole('combobox', { name: 'Comparison of condition 1' }).textContent,
    ).toBe('Includes');
    expect(within(form).getByRole('combobox', { name: 'Value of condition 1' }).textContent).toBe(
      'Video',
    );
    // A second condition, left unfinished, is refused where it is.
    await user.click(within(form).getByRole('button', { name: 'Add condition' }));
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(within(form).getByRole('alert').textContent).toBe(
      "Oops! Looks like you've missed out on some fields.",
    );
    expect(within(form).getByText('Choose a field.')).toBeDefined();
    await user.click(within(form).getByRole('combobox', { name: 'Field of condition 2' }));
    await user.click(await screen.findByRole('option', { name: 'Email' }));
    await user.click(within(form).getByRole('combobox', { name: 'Comparison of condition 2' }));
    await user.click(await screen.findByRole('option', { name: 'Is filled in' }));
    await user.type(within(form).getByRole('textbox', { name: /^Action name/ }), 'Wants video');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const written = JSON.parse(json().value) as { steps: Record<string, unknown> };
    expect(written.steps['asked_about_video']).toEqual({
      type: 'condition',
      config: {
        if: {
          all: [
            { field: 'contact.services', operator: 'includes', value: 'video' },
            { field: 'contact.email', operator: 'is_set' },
          ],
        },
      },
      next: { yes: 'send_reel', no: 'check_in' },
      label: 'Wants video',
    });
    expect(validateAutomation(JSON.parse(json().value), harborSetup).errors).toEqual([]);

    // With every condition taken away, an If / else has nothing to decide by.
    await user.click(screen.getByRole('button', { name: 'Edit: Wants video' }));
    const again = await screen.findByRole('dialog', { name: 'If / else' });
    await user.click(within(again).getByRole('button', { name: 'Remove condition 2' }));
    await user.click(within(again).getByRole('button', { name: 'Remove condition 1' }));
    await user.click(within(again).getByRole('button', { name: 'Save action' }));
    expect(within(again).getByText('Add at least one condition.')).toBeDefined();
  });

  it('offers SMS authoring without a channel and keeps unconfigured AI unavailable', async () => {
    const setup = { ...harborSetup, channels: { ...harborSetup.channels, sms: false }, ai: false };
    serve(automationOf(), {}, setup);
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Add an action at the start' }));
    const picker = await screen.findByRole('dialog', { name: 'Actions' });
    expect(within(picker).getByRole('button', { name: /^Send email/ })).toBeDefined();
    expect(within(picker).getByRole('button', { name: /^Send text/ })).toBeDefined();
    expect(within(picker).queryByRole('button', { name: /^Ask AI/ })).toBeNull();
    const unavailable = within(picker).getByRole('region', { name: 'Not available yet' });
    expect(within(unavailable).queryByText('Send text')).toBeNull();
    expect(within(unavailable).getByText('Ask AI')).toBeDefined();
    expect(within(unavailable).queryByRole('button')).toBeNull();
  });
});

describe('the two views', () => {
  it("show each other's changes, both ways", async () => {
    serve(automationOf());
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Edit: Wait 2 days' }));
    const form = await screen.findByRole('dialog', { name: 'Wait' });
    const amount = within(form).getByRole('spinbutton', { name: 'How long to wait' });
    await waitFor(() => {
      expect(document.activeElement).toBe(amount);
    });
    await user.clear(amount);
    await user.type(amount, '5');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));

    await user.click(screen.getByRole('link', { name: 'JSON' }));
    expect(json().value).toContain('"duration": "P5D"');
    expect(json().value).not.toContain('"duration": "P2D"');

    fireEvent.change(json(), { target: { value: json().value.replace('"P5D"', '"PT6H"') } });
    await user.click(screen.getByRole('link', { name: 'Steps' }));
    expect(within(stepCard('wait_2_days')).getByText('Wait 6 hours')).toBeDefined();
  });

  it('say where JSON goes wrong, keep the last good version in Steps, and refuse to save it', async () => {
    serve(automationOf());
    const user = await open({ view: 'json' });
    fireEvent.change(json(), { target: { value: '{\n  "name": "Broken",\n  "steps": ,\n}' } });
    expect(screen.getByText(/Line 3, column 12: “,” doesn't belong here\./)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(json().getAttribute('aria-invalid')).toBe('true');

    await user.click(screen.getByRole('link', { name: 'Steps' }));
    expect(within(stepCard('wait_2_days')).getByText('Wait 2 days')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Edit: Wait 2 days' })).toBeNull();
    expect(screen.getByText(/The JSON view holds text that can't be read/)).toBeDefined();

    await user.click(screen.getByRole('link', { name: 'JSON' }));
    await user.click(screen.getByRole('button', { name: 'Undo my JSON changes' }));
    expect(JSON.parse(json().value)).toEqual(followUp);
    expect(screen.queryByTestId('automation-unsaved')).toBeNull();
  });

  it('check the document as it is typed, and point at the place', async () => {
    serve(automationOf());
    const user = await open({ view: 'json' });
    fireEvent.change(json(), {
      target: { value: json().value.replace('"next": "wait_3_days"', '"next": "wait_30_days"') },
    });
    const problems = screen.getByRole('list', { name: 'Problems found' });
    const local = validateAutomation(JSON.parse(json().value), harborSetup);
    const [first] = local.errors;
    if (first === undefined) throw new Error('A link to a missing step is an error.');
    expect(within(problems).getByText(first.path)).toBeDefined();
    expect(
      within(problems).getAllByText(new RegExp(first.message.slice(0, 20))).length,
    ).toBeGreaterThan(0);
    const [show] = within(problems).getAllByRole('button', { name: /^Show where/ });
    if (show === undefined) throw new Error('Each problem can be shown.');
    await user.click(show);
    expect(document.activeElement).toBe(json());
    expect(json().selectionStart).toBeGreaterThan(0);
  });

  it('import a pasted automation into the draft, unsaved', async () => {
    serve(automationOf());
    const user = await open({ view: 'json' });
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import an automation' });
    const paste = within(dialog).getByLabelText('Or paste the JSON');
    fireEvent.change(paste, { target: { value: '{"name": "Imported"' } });
    await user.click(within(dialog).getByRole('button', { name: 'Import pasted JSON' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(
      /Line 1, column 20: The JSON stops too early/,
    );
    fireEvent.change(paste, {
      target: {
        value: JSON.stringify({
          format: 'crm.automation',
          formatVersion: 1,
          document: { name: 'Imported', steps: {} },
        }),
      },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Import pasted JSON' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(JSON.parse(json().value)).toEqual({ name: 'Imported', steps: {} });
    expect(screen.getByRole('heading', { level: 1, name: 'Imported' })).toBeDefined();
    expect(callsTo('replaceAutomationDraft')).toEqual([]);
  });
});

describe('saving', () => {
  const edited = updateStepConfig(followUp, 'wait_2_days', { duration: 'P5D' });
  const editInJson = (): void => {
    fireEvent.change(json(), { target: { value: JSON.stringify(edited) } });
  };

  it('calls a draft saved with warnings only saved, lists them as warnings, and leads to the profile that lacks an address', async () => {
    serve(automationOf(), {
      replaceAutomationDraft: () => ({
        automation: automationOf({ draft: edited, draftVersion: 4 }),
        validation: {
          valid: true,
          errors: [],
          warnings: [
            {
              path: '/triggers/0/config/form',
              code: 'form_draft',
              message: 'This form is a draft: publish it to receive submissions.',
            },
            {
              path: '/steps/send_reel',
              code: 'no_postal_address',
              message: 'Your business profile has no postal address.',
            },
          ],
        },
      }),
    });
    // The page is inside a business: the warning can say where its profile is.
    const before = location.pathname;
    history.replaceState(null, '', '/b/harbor/automations/x');
    try {
      const user = await open({ view: 'json' });
      editInJson();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      // A warning stops nothing: it is not called a problem to fix.
      await screen.findByText('Draft saved.');
      expect(screen.queryByRole('list', { name: 'Problems found' })).toBeNull();
      const warnings = screen.getByRole('list', { name: 'Warnings' });
      expect(within(warnings).getAllByText('Warning:')).toHaveLength(2);
      expect(
        within(warnings).getByText(/This form is a draft: publish it to receive submissions\./),
      ).toBeDefined();
      const profile = within(warnings).getByRole('link', {
        name: 'Open Business Profile in a new tab',
      });
      expect(profile.getAttribute('href')).toBe('/b/harbor/settings/business');
      expect(profile.getAttribute('target')).toBe('_blank');
      // Only the warning about the address leads there.
      expect(within(warnings).getAllByRole('link')).toHaveLength(1);
    } finally {
      history.replaceState(null, '', before);
    }
  });

  it('sends the draft with the version it started from, and shows what the server found', async () => {
    const saved = automationOf({ draft: edited, draftVersion: 4 });
    serve(automationOf(), {
      replaceAutomationDraft: () => ({
        automation: saved,
        validation: {
          valid: false,
          errors: [
            {
              path: '/steps/check_in/config/message',
              code: 'unknown_merge_field',
              message: 'contact.firstname is not a field.',
              suggestion: 'Did you mean contact.firstName?',
            },
          ],
          warnings: [
            {
              path: '/steps/send_reel',
              code: 'no_follow_up',
              message: 'This path ends right after a message.',
            },
          ],
        },
      }),
    });
    const user = await open({ view: 'json' });
    expect(screen.getByRole('button', { name: 'Saved' })).toHaveProperty('disabled', true);
    editInJson();
    expect(screen.getByTestId('automation-unsaved')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Draft saved. It has problems to fix before it can be published.');
    expect(callsTo('replaceAutomationDraft')).toEqual([
      { params: { id: automationId }, body: { baseDraftVersion: 3, document: edited } },
    ]);
    expect(screen.getByText('Draft · version 4')).toBeDefined();
    expect(screen.queryByTestId('automation-unsaved')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Checks' })).toBeNull();
    const problems = screen.getByRole('list', { name: 'Problems found' });
    expect(within(problems).getByText('/steps/check_in/config/message')).toBeDefined();
    expect(within(problems).getByText(/Did you mean contact\.firstName\?/)).toBeDefined();
    expect(within(problems).getByText('Warning:')).toBeDefined();

    // Each problem stays on its step in the Steps view.
    await user.click(screen.getByRole('link', { name: 'Steps' }));
    expect(
      within(stepCard('check_in')).getByText(/contact\.firstname is not a field\./),
    ).toBeDefined();
    await user.click(screen.getByRole('switch', { name: 'Published' }));
    const publish = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    expect(within(publish).getByText('/steps/check_in/config/message')).toBeDefined();
    expect(within(publish).getByRole('button', { name: 'Publish' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('tells the person when someone else saved first, and overwrites nothing', async () => {
    const theirs = automationOf({
      draft: updateStepConfig(followUp, 'wait_2_days', { duration: 'P9D' }),
      draftVersion: 4,
    });
    let current = automationOf();
    serve(current, {
      getAutomation: () => current,
      replaceAutomationDraft: () => {
        current = theirs;
        throw conflict();
      },
    });
    const user = await open({ view: 'json' });
    editInJson();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByText(
      'Someone else saved this workflow while you were editing.',
    );
    expect(alert).toBeDefined();
    // Their save stands, and mine is still in front of me.
    expect(JSON.parse(json().value)).toEqual(edited);
    expect(screen.getByTestId('automation-unsaved')).toBeDefined();
    expect(callsTo('replaceAutomationDraft')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Keep my version open' }));
    expect(JSON.parse(json().value)).toEqual(edited);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Someone else saved this workflow while you were editing.');
    // Still sent against the version it started from: it can't slip past their save.
    expect(callsTo('replaceAutomationDraft').at(-1)).toMatchObject({
      body: { baseDraftVersion: 3 },
    });

    await user.click(screen.getByRole('button', { name: 'Load the latest and drop my changes' }));
    await screen.findByText('Loaded the latest saved version.');
    expect(json().value).toContain('"duration": "P9D"');
    expect(screen.getByText('Draft · version 4')).toBeDefined();
    expect(screen.queryByTestId('automation-unsaved')).toBeNull();
  });

  it('renames the automation in the draft', async () => {
    serve(automationOf());
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Rename workflow' }));
    const name = screen.getByRole('textbox', { name: 'Workflow name' });
    expect(document.activeElement).toBe(name);
    await user.clear(name);
    await user.type(name, 'Quote follow-up{Enter}');
    expect(screen.getByRole('heading', { level: 1, name: 'Quote follow-up' })).toBeDefined();
    expect((JSON.parse(json().value) as { name: string }).name).toBe('Quote follow-up');
    expect(screen.getByTestId('automation-unsaved')).toBeDefined();
  });
});

describe('publishing', () => {
  const live = validateAutomation(followUp, harborSetup).document;
  if (live === undefined) throw new Error('The fixture is valid.');
  const published = {
    id: versionId,
    version: 2,
    changeSummary: 'First',
    publishedAt: stamp,
    document: live as unknown as Record<string, unknown>,
  };
  const draft = updateStepConfig(followUp, 'wait_2_days', { duration: 'P5D' });
  const withDraft = automationOf({
    status: 'active',
    liveVersion: 2,
    live: published,
    draft,
    draftVersion: 5,
  });

  it('shows what changes from the live version, before and after, then publishes with a note', async () => {
    serve(withDraft, {
      publishAutomation: () => ({
        ...withDraft,
        liveVersion: 3,
        live: { ...published, version: 3, document: draft },
      }),
    });
    const user = await open();
    // Live already: the switch is on, and what the draft changed is published by its own button.
    expect(screen.getByRole('switch', { name: 'Published' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.click(await screen.findByRole('button', { name: 'Publish changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    const changed = within(dialog).getByRole('region', { name: 'Changed' });
    expect(within(changed).getByText('Wait 2 days')).toBeDefined();
    expect(within(changed).getByText('Wait 5 days')).toBeDefined();
    expect(within(changed).getByText('How long to wait')).toBeDefined();
    expect(within(changed).getByText('2 days')).toBeDefined();
    expect(within(changed).getByText('5 days')).toBeDefined();
    expect(within(changed).getAllByRole('listitem')).toHaveLength(2);
    expect(within(dialog).queryByRole('region', { name: 'Added' })).toBeNull();
    expect(within(dialog).queryByRole('region', { name: 'Removed' })).toBeNull();

    await user.type(within(dialog).getByLabelText(/Note for the version history/), 'Longer wait');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await screen.findByText(/^Published\. New contacts start version 3;/);
    expect(callsTo('publishAutomation')).toEqual([
      { params: { id: automationId }, body: { baseDraftVersion: 5, changeSummary: 'Longer wait' } },
    ]);
    expect(screen.getByText('Live · version 3')).toBeDefined();
    // Nothing is left to publish.
    expect(screen.queryByRole('button', { name: 'Publish changes' })).toBeNull();
  });

  it('lists a first version as everything going live', async () => {
    serve(automationOf());
    const user = await open();
    // Never published: the switch is on Draft, and switching it to Publish asks first.
    const toggle = screen.getByRole('switch', { name: 'Published' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Publish changes' })).toBeNull();
    await user.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    const going = within(dialog).getByRole('region', { name: 'Going live' });
    expect(within(going).getByText('Someone submits “Request a quote”')).toBeDefined();
    expect(within(going).getByText('Send the email “Pricing guide”')).toBeDefined();
    expect(within(going).getByText('They reply')).toBeDefined();
  });

  it('shows the errors instead of the way forward when the draft is not valid', async () => {
    const broken = updateStepConfig(followUp, 'send_guide', { template: 'No such template' });
    serve(automationOf({ draft: broken }));
    const user = await open();
    await user.click(screen.getByRole('switch', { name: 'Published' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    const errors = within(dialog).getByRole('region', { name: 'Fix these before publishing' });
    expect(within(errors).getByText('/steps/send_guide/config/template')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Publish' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(callsTo('publishAutomation')).toEqual([]);
  });

  it('asks for unsaved changes to be saved first', async () => {
    serve(withDraft);
    const user = await open({ view: 'json' });
    fireEvent.change(json(), { target: { value: JSON.stringify(followUp) } });
    await user.click(await screen.findByRole('button', { name: 'Publish changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    expect(within(dialog).getByRole('alert').textContent).toMatch(/Save the draft first/);
    expect(within(dialog).getByRole('button', { name: 'Publish' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows why the server refused, when it does', async () => {
    serve(withDraft, {
      publishAutomation: () => {
        throw new ApiError({
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          errors: [
            {
              path: '/steps/send_guide',
              code: 'no_provider',
              message: 'Connect a mailbox before sending from this step.',
            },
          ],
        });
      },
    });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Publish changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    const refused = await within(dialog).findByRole('list', { name: "Why it wasn't published" });
    expect(
      within(refused).getByText(/Connect a mailbox before sending from this step\./),
    ).toBeDefined();
  });

  it('pauses and resumes without touching the draft being edited', async () => {
    serve(withDraft, {
      pauseAutomation: () => ({ ...withDraft, status: 'paused', draftVersion: 9, draft: followUp }),
      resumeAutomation: () => ({ ...withDraft, status: 'active' }),
    });
    const user = await open({ view: 'json' });
    const mine = JSON.stringify(updateStepConfig(draft, 'wait_3_days', { duration: 'P1D' }));
    fireEvent.change(json(), { target: { value: mine } });
    const toggle = screen.getByRole('switch', { name: 'Published' });
    await user.click(toggle);
    await screen.findByText(
      'Switched to draft. Nobody new starts; contacts already in it carry on.',
    );
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(json().value).toBe(mine);
    // The draft version it will save against is still the one it loaded.
    expect(screen.getByText('Draft · version 5')).toBeDefined();
    expect(screen.getByText('Paused')).toBeDefined();
    // It has a live version: switching back on resumes it, with no dialog.
    await user.click(toggle);
    await screen.findByText('Published again. New contacts can start.');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('Paused')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo('resumeAutomation')).toEqual([{ params: { id: automationId } }]);
  });
});

describe('without permission', () => {
  it('is read-only without automations.manage, and offers no publishing', async () => {
    serve(automationOf({ canManage: false, canPublish: false, status: 'active', liveVersion: 1 }));
    const user = await open();
    expect(
      screen.getByText(
        "You can look at this workflow, but you don't have permission to change it.",
      ),
    ).toBeDefined();
    expect(within(stepCard('wait_2_days')).getByText('Wait 2 days')).toBeDefined();
    for (const name of [
      /^Edit/,
      /^Remove/,
      /^Add a/,
      'Save',
      'Saved',
      'Publish changes',
      'Rename workflow',
      'Test workflow',
    ])
      expect(screen.queryAllByRole('button', { name })).toEqual([]);
    expect(screen.queryByRole('switch', { name: 'Published' })).toBeNull();
    await user.click(screen.getByRole('link', { name: 'JSON' }));
    expect(json().readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Download' })).toBeDefined();
  });

  it('lets someone who may edit but not publish save, and nothing more', async () => {
    serve(automationOf({ canManage: true, canPublish: false, status: 'active', liveVersion: 1 }));
    await open();
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Test workflow' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Edit: Wait 2 days' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Publish changes' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Published' })).toBeNull();
  });

  it('is read-only when the API does not say what the person may do', async () => {
    const { canManage: _manage, canPublish: _publish, ...silent } = automationOf();
    serve(silent);
    await open();
    expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Published' })).toBeNull();
  });
});

describe('the view switcher', () => {
  it('offers the canvas, the steps and the JSON, and the tabs of a workflow, and marks what is open', async () => {
    serve(automationOf());
    const user = await open();
    const views = screen.getByRole('navigation', { name: 'Automation views' });
    expect(
      within(views)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Canvas', 'Steps', 'JSON']);
    expect(within(views).getByRole('link', { name: 'Steps' }).getAttribute('aria-current')).toBe(
      'page',
    );
    for (const other of ['Canvas', 'JSON'])
      expect(
        within(views).getByRole('link', { name: other }).getAttribute('aria-current'),
      ).toBeNull();
    expect(within(views).getByRole('link', { name: 'Canvas' }).getAttribute('href')).toBe(
      '?view=canvas',
    );
    const tabs = screen.getByRole('navigation', { name: 'Workflow' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('aria-current')]),
    ).toEqual([
      ['Builder', 'page'],
      ['Settings', null],
      ['Enrollment history', null],
      ['Execution logs', null],
    ]);
    // The Builder tab comes back to the view it was left in.
    await user.click(within(tabs).getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('switch', { name: 'Allow re-entry' })).toBeDefined();
    expect(within(tabs).getByRole('link', { name: 'Builder' }).getAttribute('href')).toBe(
      '?view=steps',
    );
    expect(within(tabs).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await user.click(within(tabs).getByRole('link', { name: 'Builder' }));
    expect(screen.getByRole('list', { name: 'What starts it' })).toBeDefined();
  });

  it('changes the settings in the draft, from the Settings tab', async () => {
    serve(automationOf());
    const user = await open({ view: 'settings' });
    const reEntry = await screen.findByRole('switch', { name: 'Allow re-entry' });
    expect(reEntry.getAttribute('aria-checked')).toBe('true');
    await user.click(reEntry);
    expect(screen.getByTestId('automation-unsaved')).toBeDefined();
    expect((JSON.parse(json().value) as { settings: unknown }).settings).toEqual({
      reEnrollment: 'never',
      timezone: 'contact',
    });
    expect(screen.queryByRole('heading', { level: 2, name: 'Checks' })).toBeNull();
  });

  it('shows the execution logs, narrowed to the actions the workflow has', async () => {
    serve(automationOf(), { listAutomationStepRuns: () => stepRunList });
    const user = await open({ view: 'logs' });
    const table = await screen.findByRole('table', { name: 'Execution logs' });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'All actions',
      'Send the email “Pricing guide”',
      'Wait 2 days',
      'If services includes “video”',
      'Text them “Here’s our video sample reel: {{values.sample_reel_url}}”',
      'Text them “Hi {{contact.firstName}}, did the pricing guide come through?”',
      'Wait 3 days',
      'Text them “Last check-in from Harbor Lights.”',
    ]);
    expect(screen.queryByRole('heading', { level: 2, name: 'Checks' })).toBeNull();
  });

  it('tests the saved draft from the second bar, once its code has come', async () => {
    serve(automationOf(), {
      createAutomationTestRun: () => ({
        id: 'atest_01k8e2wzr0e008000000000071',
        draftVersion: 3,
        status: 'passed',
        contactId: null,
        createdAt: stamp,
        steps: [],
        outcome: { kind: 'completed' },
      }),
    });
    const user = await open();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Test workflow' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Run test' }));
    expect((await within(dialog).findByRole('status')).textContent).toBe(
      'The test reached the end of the workflow.',
    );
    expect(callsTo('createAutomationTestRun')).toEqual([
      { params: { id: automationId }, body: {} },
    ]);
  });

  it('says when the automation cannot be found', async () => {
    serve(automationOf(), {
      getAutomation: () => {
        throw new ApiError({ type: 'about:blank', title: 'Not Found', status: 404 });
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider i18n={i18n}>
          <Harness />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/This workflow doesn't exist/);
    expect(screen.getByRole('link', { name: 'Workflows list' })).toBeDefined();
  });
});

describe('the three views of one document', () => {
  const canvasBox = (name: string): HTMLElement => screen.getByRole('group', { name });
  const goTo = async (user: ReturnType<typeof userEvent.setup>, view: string): Promise<void> => {
    await user.click(screen.getByRole('link', { name: view }));
  };

  it('loads the canvas when it is opened, and draws the draft the other views hold', async () => {
    serve(automationOf());
    const user = await open();
    await goTo(user, 'Canvas');
    expect(await screen.findByRole('heading', { level: 2, name: 'Canvas' })).toBeDefined();
    expect(canvasBox('Wait 2 days')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'What starts it' })).toBeNull();
  });

  it('shows on the canvas what the Steps view changed, and in the Steps and JSON views what the canvas changed', async () => {
    serve(automationOf());
    const user = await open();
    // In the Steps view: the wait becomes five days.
    await user.click(screen.getByRole('button', { name: 'Edit: Wait 2 days' }));
    const form = await screen.findByRole('dialog', { name: 'Wait' });
    const amount = within(form).getByLabelText('How long to wait');
    await user.clear(amount);
    await user.type(amount, '5');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));

    await goTo(user, 'Canvas');
    expect(await screen.findByRole('group', { name: 'Wait 5 days' })).toBeDefined();
    // On the canvas: a step is added, and another is moved.
    await user.click(screen.getByRole('button', { name: 'Add an action after: Wait 5 days' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Actions' })).getByRole('button', {
        name: /^Add tag/,
      }),
    );
    await user.click(screen.getByRole('combobox', { name: 'Tag' }));
    await user.click(await screen.findByRole('option', { name: 'VIP' }));
    await user.click(screen.getByRole('button', { name: 'Save action' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    screen.getByRole('button', { name: 'Move: Add the tag VIP' }).focus();
    await user.keyboard('{ArrowRight}');

    await goTo(user, 'JSON');
    const document = JSON.parse(json().value) as Draft & {
      steps: Record<string, unknown>;
      layout: Record<string, { x: number; y: number }>;
    };
    expect(document.steps).toMatchObject({
      wait_2_days: { config: { duration: 'P5D' }, next: 'tag_add' },
      tag_add: { type: 'tag.add', config: { tag: 'tag_vip' }, next: 'asked_about_video' },
    });
    // The move is in the document itself, as its layout: one place for every step.
    expect(Object.keys(document.layout)).toEqual(Object.keys(document.steps));
    expect(validateAutomation(document, harborSetup).errors).toEqual([]);

    await goTo(user, 'Steps');
    expect(within(stepCard('tag_add')).getByText('Add the tag VIP')).toBeDefined();
    expect(within(stepCard('wait_2_days')).getByText('Wait 5 days')).toBeDefined();

    // And the JSON view's own edit is what the canvas then draws.
    await goTo(user, 'JSON');
    const edited = { ...document, layout: { ...document.layout, send_guide: { x: 900, y: 0 } } };
    fireEvent.change(json(), { target: { value: JSON.stringify(edited, null, 2) } });
    await goTo(user, 'Canvas');
    const moved = canvasBox('Send the email “Pricing guide”');
    const others = canvasBox('Wait 5 days');
    expect(Number.parseInt(moved.style.left, 10)).toBeGreaterThan(
      Number.parseInt(others.style.left, 10) + 800,
    );
    // Saving sends exactly that document, layout included.
    serve(automationOf(), {
      replaceAutomationDraft: (input) => ({
        automation: automationOf({
          draft: (input as { body: { document: Draft } }).body.document,
          draftVersion: 4,
        }),
        validation: { valid: true, errors: [], warnings: [] },
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Draft saved.');
    expect(callsTo('replaceAutomationDraft')).toEqual([
      { params: { id: automationId }, body: { baseDraftVersion: 3, document: edited } },
    ]);
  });

  it('keeps invalid canvas steps from publishing without a lower checks section', async () => {
    const broken: Draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        send_guide: { type: 'email.send', config: {}, next: 'wait_2_days' },
      },
    };
    serve(automationOf({ draft: broken }));
    const user = await open({ view: 'canvas' });
    await screen.findByRole('heading', { level: 2, name: 'Canvas' });
    expect(screen.queryByRole('heading', { name: 'Checks' })).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Published' }));
    const publish = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    expect(within(publish).getByText('/steps/send_guide/config')).toBeDefined();
    expect(within(publish).getByRole('button', { name: 'Publish' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(callsTo('publishAutomation')).toEqual([]);
  });

  it('shows the automation’s runs beside its views, without the checks of the draft', async () => {
    serve(automationOf(), { listAutomationRuns: () => runList });
    const user = await open();
    await goTo(user, 'Enrollment history');
    const runs = await screen.findByRole('table', { name: 'Enrollment history' });
    expect(within(runs).getAllByRole('row')).toHaveLength(4);
    // What enrolled each is named as the builder names the trigger.
    expect(within(runs).getAllByText('Someone submits “Request a quote”')).toHaveLength(3);
    expect(callsTo('listAutomationRuns')).toEqual([{ params: { id: automationId }, query: {} }]);
    expect(screen.queryByRole('heading', { level: 2, name: 'Checks', hidden: true })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Checks' })).toBeNull();
    // The draft is still open behind it: going back shows it as it was.
    await goTo(user, 'Steps');
    expect(within(stepCard('wait_2_days')).getByText('Wait 2 days')).toBeDefined();
  });

  it('says the canvas cannot be changed while the JSON view holds text that cannot be read', async () => {
    serve(automationOf());
    const user = await open({ view: 'json' });
    fireEvent.change(json(), { target: { value: '{ "name": ' } });
    await goTo(user, 'Canvas');
    await screen.findByRole('heading', { level: 2, name: 'Canvas' });
    expect(screen.getByText(/this view shows the last version that could/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(canvasBox('Wait 2 days')).toBeDefined();
  });
});
