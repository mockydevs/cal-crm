// @vitest-environment jsdom
// The Send email action's panel in each of its states: who the email is from and copied
// to, a template found by its subject among many, an email that syncs with a template and
// the other workflows that use it, attachments, and the Statistics tab.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { catalogOf, harborSetup } from '../../e2e/automation-fixtures';
import { SettingsDialog, type AutomationCatalogData } from '../automation-step-dialog';
import type { EmailStepContext } from './panel';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

const templateId = 'tmpl_01h455vb4pex5vsknk084sn02q';
const revision = 'a'.repeat(64);
const summary = (index: number) => ({
  id: index === 0 ? templateId : `tmpl_${String(index).padStart(26, '0')}`,
  name: index === 0 ? 'Pricing guide' : `Wedding ${String(index)}`,
  subject: index === 0 ? 'Your guide, {{contact.firstName}}' : `Save the date ${String(index)}`,
  format: index % 2 === 0 ? 'html' : 'text',
  preheader: null,
  folder: index % 3 === 0 ? null : { id: 'fld', name: 'Sales', path: ['Sales'] },
  preview: '',
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z',
  archivedAt: null,
  revision,
});
const sixty = Array.from({ length: 60 }, (_, index) => summary(index));
const setup = {
  ...harborSetup,
  emailTemplates: [{ id: templateId, name: 'Pricing guide' }, ...harborSetup.emailTemplates],
};

beforeAll(async () => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  Element.prototype.scrollIntoView = vi.fn();
  await Promise.all([import('./panel'), import('./statistics'), import('./tabs')]);
});
beforeEach(() => {
  server.calls.length = 0;
  server.answer = (operation, input) => {
    if (operation === 'listMessageTemplates')
      return { canManage: true, items: sixty, nextCursor: null };
    if (operation === 'renderEmailPreview')
      return {
        subject: 'Your guide',
        preheader: null,
        html: '<p>Hello</p>',
        text: 'Hello',
        mergeFields: [],
        missingFields: [],
        subjectLineBreak: [],
      };
    if (operation === 'listTemplateWorkflowActions')
      return {
        nextCursor: null,
        items: [
          {
            automation: { id: 'aut_self', name: 'This workflow', status: 'active' },
            scope: 'draft',
            version: null,
            step: 'send_guide',
            label: null,
            mode: 'sync',
            sourceRevision: revision,
            current: null,
          },
          {
            automation: { id: 'aut_other', name: 'DJ enquiry', status: 'active' },
            scope: 'published',
            version: null,
            step: 'email',
            label: 'Reminder',
            mode: 'copy',
            sourceRevision: revision,
            current: true,
          },
        ],
      };
    if (operation === 'getMediaFile')
      return {
        id: (input as { params: { id: string } }).params.id,
        name: 'price-list.pdf',
        size: 840 * 1024,
      };
    if (operation === 'getWorkflowEmailStepStatistics')
      return {
        step: 'send_guide',
        from: null,
        to: null,
        total: 12,
        waiting: 1,
        sent: 9,
        delivered: null,
        bounced: 0,
        failed: 1,
        skipped: { total: 2, reasons: [{ reason: 'no_consent', count: 2 }] },
        unsubscribed: 0,
        opened: null,
        clicked: null,
      };
    throw new Error(`Unexpected request: ${operation}`);
  };
});
afterEach(cleanup);

function surroundings({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    </QueryClientProvider>
  );
}

function open(config: Record<string, unknown>, context?: EmailStepContext) {
  const saved = vi.fn();
  render(
    <SettingsDialog
      open
      onOpenChange={() => undefined}
      owner="step"
      editing={{ key: 'step:send_guide', type: 'email.send', config }}
      catalog={catalogOf(setup) as AutomationCatalogData}
      setup={setup}
      email={context}
      onSubmit={saved}
    />,
    { wrapper: surroundings },
  );
  return { saved, user: userEvent.setup({ delay: null }) };
}
const panel = (): Promise<HTMLElement> => screen.findByRole('dialog', { name: 'Send email' });
/** What was saved: the action says what it saves once its own check has been fetched. */
async function savedConfig(saved: ReturnType<typeof vi.fn>): Promise<unknown> {
  await waitFor(() => {
    expect(saved).toHaveBeenCalled();
  });
  return saved.mock.calls[0]?.[1];
}

it('sets who it is from, Cc behind its button, a subject with an inserted field, and saves each as written', async () => {
  const { saved, user } = open({ subject: 'Hello', body: 'Welcome.' });
  const form = await panel();
  await user.type(await within(form).findByLabelText('From name'), 'Dana');
  // Cc and Bcc are not on the panel until asked for.
  expect(within(form).queryByLabelText('Cc')).toBeNull();
  await user.click(within(form).getByRole('button', { name: 'Cc' }));
  const cc = within(form).getByLabelText('Cc');
  await user.type(cc, 'not an address{Enter}');
  expect(
    within(form).getByText('Give an email address, or insert one field that holds one.'),
  ).toBeDefined();
  await user.clear(cc);
  await user.type(cc, 'owner@harbor.example{Enter}');
  await user.click(within(form).getByRole('button', { name: 'Insert a field into: Cc' }));
  await user.type(await screen.findByRole('combobox', { name: 'Search fields' }), 'email');
  await user.click(await screen.findByRole('option', { name: /^Email\s*\{\{contact\.email\}\}$/ }));
  expect(
    within(within(form).getByRole('list', { name: 'Cc' }))
      .getAllByRole('listitem')
      .map((chip) => chip.textContent),
  ).toEqual(['owner@harbor.example', '{{contact.email}}']);

  const subject = within(form).getByLabelText('Subject');
  await user.click(subject);
  await user.click(within(form).getByRole('button', { name: 'Insert a field into: Subject' }));
  await user.click(await screen.findByRole('option', { name: /^First name/ }));
  expect(subject).toHaveProperty('value', 'Hello{{contact.firstName}}');
  // A plain-text email has no preview line: the box is not offered.
  expect(within(form).queryByLabelText('Preview text (optional)')).toBeNull();

  await user.click(within(form).getByRole('button', { name: 'Save action' }));
  expect(await savedConfig(saved)).toEqual({
    subject: 'Hello{{contact.firstName}}',
    body: 'Welcome.',
    fromName: 'Dana',
    cc: ['owner@harbor.example', '{{contact.email}}'],
  });
});

it('finds a template by its subject among sixty, under its folder, and names it to be copied on save', async () => {
  const { saved, user } = open({ template: '' });
  const form = await panel();
  await user.click(await within(form).findByRole('button', { name: /^Email template: / }));
  const search = await screen.findByRole('combobox', { name: 'Search by name or subject' });
  // Every template is in hand: the list shows a first screenful and says how many there are.
  expect(await screen.findByText('Showing 50 of 60. Type to narrow the list.')).toBeDefined();
  await user.type(search, 'save the date 41');
  const options = within(screen.getByRole('listbox', { name: 'Email template' })).getAllByRole(
    'option',
  );
  expect(options).toHaveLength(1);
  expect(options[0]?.textContent).toBe('Wedding 41Save the date 41Plain text');
  expect(screen.getByRole('group', { name: 'Sales' })).toBeDefined();
  expect(screen.getByRole('link', { name: 'Manage templates' }).getAttribute('href')).toBe(
    '/b/harbor/marketing/emails/templates',
  );
  await user.keyboard('{Enter}');
  expect(
    await within(form).findByText(/^“Wedding 41” is copied into this action when you save it\./),
  ).toBeDefined();
  // The preview is of the template as it is.
  await waitFor(() => {
    expect(
      server.calls.filter((call) => call.operation === 'renderEmailPreview').at(-1)?.input,
    ).toEqual({ body: { template: sixty[41]?.id } });
  });
  await user.click(within(form).getByRole('button', { name: 'Save action' }));
  expect(await savedConfig(saved)).toEqual({ template: sixty[41]?.id });
});

it('shows a syncing email with the other workflows that use its template, and unlinks to a copy', async () => {
  const sync = { mode: 'sync', source: { id: templateId, revision }, mailbox: 'mbx_hello' };
  const { saved, user } = open(sync, { automationId: 'aut_self', step: 'send_guide', saved: sync });
  const form = await panel();
  const box = await within(form).findByRole('checkbox', { name: 'Sync edits to template' });
  expect(box).toHaveProperty('checked', true);
  expect(
    within(form).getByText(
      'Syncing with “Pricing guide”: every send uses the template as it is then.',
    ),
  ).toBeDefined();
  const others = await within(form).findByRole('list', {
    name: 'Other workflow actions that use this template',
  });
  // This action itself is not among them.
  expect(
    within(others)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['DJ enquiry · Reminder (holds a copy)']);
  // The template's own subject stands unless one is written here.
  expect(within(form).getByLabelText('Subject (optional)')).toHaveProperty('value', '');
  // The action is in the draft, but nothing here may save the template: no way to edit it.
  expect(within(form).queryByRole('button', { name: 'Edit the email' })).toBeNull();

  await user.click(box);
  expect(
    await within(form).findByText(/^“Pricing guide” is copied into this action when you save it\./),
  ).toBeDefined();
  await user.click(within(form).getByRole('button', { name: 'Save action' }));
  expect(await savedConfig(saved)).toEqual({ template: templateId, mailbox: 'mbx_hello' });
});

it('asks before syncing a copy, says what is replaced, and links it with the template as read', async () => {
  server.answer = ((before) => (operation: string, input: unknown) =>
    operation === 'getMessageTemplate'
      ? { id: templateId, revision: 'c'.repeat(64), name: 'Pricing guide' }
      : before(operation, input))(server.answer);
  const copy = {
    mode: 'copy',
    source: { id: templateId, revision },
    subject: 'Copied',
    body: 'Text',
    fromName: 'Dana',
  };
  const { saved, user } = open(copy);
  const form = await panel();
  const box = await within(form).findByRole('checkbox', { name: 'Sync edits to template' });
  expect(box).toHaveProperty('checked', false);
  await user.click(box);
  const asking = within(form).getByRole('alertdialog', { name: 'Sync with the template?' });
  expect(asking.textContent).toContain("The template itself isn't changed.");
  // Cancelling changes nothing.
  await user.click(within(asking).getByRole('button', { name: 'Cancel' }));
  expect(box).toHaveProperty('checked', false);
  await user.click(box);
  await user.click(
    within(within(form).getByRole('alertdialog')).getByRole('button', { name: 'Turn on sync' }),
  );
  await waitFor(() => {
    expect(box).toHaveProperty('checked', true);
  });
  await user.click(within(form).getByRole('button', { name: 'Save action' }));
  expect(await savedConfig(saved)).toEqual({
    mode: 'sync',
    source: { id: templateId, revision: 'c'.repeat(64) },
    fromName: 'Dana',
  });
});

it('lists attachments with their size, and takes one off', async () => {
  const files = ['file_01h455vb4pex5vsknk084sn02q', 'file_01h455vb4pex5vsknk084sn02r'];
  const { saved, user } = open({ subject: 'Hello', body: 'Welcome.', attachments: files });
  const form = await panel();
  const list = await within(form).findByRole('list', { name: 'Attachments' });
  await waitFor(() => {
    expect(within(list).getAllByText('840 KB')).toHaveLength(2);
  });
  expect(within(form).getByText('Up to 5 files from Media Storage, 15 MB together.')).toBeDefined();
  const [first] = within(list).getAllByRole('button', { name: 'Remove price-list.pdf' });
  if (first === undefined) throw new Error('No attachment is listed.');
  await user.click(first);
  await user.click(within(form).getByRole('button', { name: 'Save action' }));
  expect(await savedConfig(saved)).toEqual({
    subject: 'Hello',
    body: 'Welcome.',
    attachments: [files[1]],
  });
});

it('says what is missing under its own control, and saves nothing', async () => {
  const { saved, user } = open({ subject: '', body: '' });
  const form = await panel();
  await within(form).findByLabelText('Message');
  await user.click(within(form).getByRole('button', { name: 'Save action' }));
  expect(await within(form).findByText('Give the email a subject.')).toBeDefined();
  expect(within(form).getByText('Write the message, or choose a template.')).toBeDefined();
  expect(saved).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(document.activeElement).toBe(within(form).getByLabelText('From name'));
  });
});

it('has a Statistics tab for an action in the draft, where nothing unmeasured reads as zero', async () => {
  const config = { subject: 'Hello', body: 'Welcome.' };
  const { user } = open(config, { automationId: 'aut_self', step: 'send_guide', saved: config });
  const form = await panel();
  const tabs = await within(form).findByRole('tablist', { name: 'Send email' });
  expect(
    within(tabs)
      .getAllByRole('tab')
      .map((tab) => tab.textContent),
  ).toEqual(['Edit action', 'Statistics']);
  await user.click(within(tabs).getByRole('tab', { name: 'Statistics' }));
  await within(form).findByText('Reached this action');
  const shown = (key: string): string =>
    form.querySelector(`[data-statistic="${key}"] dd`)?.textContent ?? '';
  expect(shown('sent')).toBe('9');
  expect(shown('bounced')).toBe('0');
  expect(shown('delivered')).toBe('Not measured');
  expect(shown('opened')).toBe('Not tracked yet');
  expect(shown('clicked')).toBe('Not tracked yet');
  expect(within(form).getByText('No consent to marketing email')).toBeDefined();
  expect(
    server.calls.find((call) => call.operation === 'getWorkflowEmailStepStatistics')?.input,
  ).toMatchObject({ params: { id: 'aut_self', step: 'send_guide' } });
  // The settings are still there behind the tab, and still save.
  await user.click(within(tabs).getByRole('tab', { name: 'Edit action' }));
  expect(within(form).getByLabelText('Subject')).toHaveProperty('value', 'Hello');
});

it('has no Statistics tab for an action that is being added', async () => {
  open(
    { subject: 'Hello', body: 'Welcome.' },
    { automationId: 'aut_self', step: undefined, saved: undefined },
  );
  const form = await panel();
  await within(form).findByLabelText('From name');
  expect(within(form).queryByRole('tablist')).toBeNull();
});
