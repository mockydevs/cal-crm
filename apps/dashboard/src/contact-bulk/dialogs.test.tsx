// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComponentType } from 'react';

import { bulkActionOf } from '../../e2e/contact-bulk-fixtures';
import DndDialog from './dnd';
import ExportDialog from './export';
import OpportunityDialog from './opportunity';
import type { BulkDialogProps } from './parts';
import SmsDialog from './sms';
import TrashDialog from './trash';

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

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  server.answer = (operation) =>
    operation === 'bulkUpdateContacts'
      ? bulkActionOf(1)
      : operation === 'getPipelines'
        ? {
            items: [
              {
                id: 'pipe_1',
                name: 'Sales',
                archived: false,
                stages: [
                  { id: 'stg_1', name: 'New lead', archived: false },
                  { id: 'stg_2', name: 'Proposal', archived: false },
                ],
              },
            ],
            revision: 'r',
            canManage: true,
          }
        : operation === 'listPhoneNumbers'
          ? { data: [] }
          : { items: [], nextCursor: null };
});
afterEach(cleanup);

const sent = (): unknown =>
  (
    server.calls.findLast((call) => call.operation === 'bulkUpdateContacts')?.input as {
      body: unknown;
    }
  ).body;

const dialogs = {
  send_sms: SmsDialog,
  set_dnd: DndDialog,
  add_opportunity: OpportunityDialog,
  trash: TrashDialog,
  export: (props: BulkDialogProps) => (
    <ExportDialog
      {...props}
      columns={['name', 'email']}
      fields={[{ id: 'fld_1', label: 'City' }]}
    />
  ),
} satisfies Record<string, ComponentType<BulkDialogProps>>;

function show(props: Partial<BulkDialogProps> & { readonly action: keyof typeof dialogs }) {
  const done = vi.fn();
  const { action, ...rest } = props;
  const Dialog = dialogs[action];
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <Dialog
          businessId="biz_test"
          selection={{ ids: ['con_1', 'con_2'] }}
          count={2}
          more={false}
          returnFocus={{ current: null }}
          onClose={() => undefined}
          onDone={done}
          {...rest}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), done };
}

describe('the contact list’s bulk action dialogs', () => {
  it('sends a text message now, with how many contacts it is for', async () => {
    const { user, done } = show({ action: 'send_sms' });
    expect(screen.getByText(/2 contacts are selected/)).toBeDefined();
    const send = screen.getByRole('button', { name: 'Send to 2 contacts' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText('Message'), 'Hi there');
    await user.click(send);
    await waitFor(() => {
      expect(done).toHaveBeenCalled();
    });
    expect(sent()).toMatchObject({
      action: 'send_sms',
      message: 'Hi there',
      selection: { ids: ['con_1', 'con_2'] },
      requestId: expect.any(String) as unknown,
    });
    expect(sent()).not.toHaveProperty('delivery');
  });

  it('drips a send in batches, and says how long it takes', async () => {
    const { user } = show({ action: 'send_sms', count: 250 });
    await user.type(screen.getByLabelText('Message'), 'Hi');
    await user.click(screen.getByRole('radio', { name: 'Drip mode: in batches' }));
    await user.clear(screen.getByLabelText('Batch quantity'));
    await user.type(screen.getByLabelText('Batch quantity'), '100');
    await user.clear(screen.getByLabelText('Repeat after'));
    await user.type(screen.getByLabelText('Repeat after'), '30');
    await user.click(screen.getByRole('combobox', { name: 'Unit' }));
    await user.click(await screen.findByRole('option', { name: 'Minutes' }));
    expect(screen.getByText(/Estimated duration: 1 hour from the first batch/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Send to 250 contacts' }));
    await waitFor(() => {
      expect(sent()).toMatchObject({
        delivery: { drip: { batchSize: 100, intervalMinutes: 30 } },
      });
    });
  });

  it('exports the columns the list shows, and the fields chosen', async () => {
    const { user } = show({ action: 'export' });
    await user.click(screen.getByRole('checkbox', { name: 'City' }));
    await user.click(screen.getByRole('checkbox', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Export 2 contacts' }));
    await waitFor(() => {
      expect(sent()).toMatchObject({ action: 'export', columns: ['name', 'fld_1'] });
    });
  });

  it('turns do not disturb on for chosen channels, with a reason', async () => {
    const { user } = show({ action: 'set_dnd' });
    await user.click(screen.getByRole('checkbox', { name: 'All channels' }));
    await user.click(screen.getByRole('checkbox', { name: 'Text messages' }));
    const apply = screen.getByRole('button', { name: 'Apply to 2 contacts' });
    expect(apply.hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText('Reason'), 'Asked at the fair to stop texts.');
    await user.click(apply);
    await waitFor(() => {
      expect(sent()).toMatchObject({
        action: 'set_dnd',
        dnd: 'on',
        channels: ['sms'],
        reason: 'Asked at the fair to stop texts.',
      });
    });
  });

  it('adds an opportunity in the first pipeline, in its first stage unless one is chosen', async () => {
    const { user } = show({ action: 'add_opportunity' });
    await screen.findByLabelText('Pipeline');
    await user.type(screen.getByLabelText('Opportunity value (optional)'), '1500');
    await user.click(screen.getByRole('button', { name: 'Apply to 2 contacts' }));
    await waitFor(() => {
      expect(sent()).toMatchObject({
        action: 'add_opportunity',
        pipelineId: 'pipe_1',
        amount: '1500',
        status: 'open',
        allowDuplicates: false,
      });
    });
    expect(sent()).not.toHaveProperty('stageId');
  });

  it('deletes every contact of the list less the ones unticked, said as more than counted', () => {
    show({
      action: 'trash',
      selection: { all: true, q: 'ada', except: ['con_3'] },
      count: 10_000,
      more: true,
    });
    expect(
      screen.getByText(/More than 10000 contacts are selected: the action counts them/),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Delete all contacts' })).toBeDefined();
  });

  it('says what is missing beside a disabled button, and a start time only once it is left', async () => {
    const { user } = show({ action: 'send_sms' });
    const send = screen.getByRole('button', { name: 'Send to 2 contacts' });
    expect(send.hasAttribute('disabled')).toBe(true);
    expect(send.getAttribute('aria-describedby')).not.toBeNull();
    expect(screen.getByText('Write the message.')).toBeDefined();
    await user.type(screen.getByLabelText('Message'), 'Hi');
    await user.click(screen.getByRole('radio', { name: 'Start at a set time' }));
    // Picking it says nothing aloud yet; the button says what is missing.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Choose when to start.')).toBeDefined();
    await user.click(screen.getByLabelText('Start on'));
    await user.tab();
    expect(screen.getByRole('alert').textContent).toBe('Choose when to start.');
  });
});
