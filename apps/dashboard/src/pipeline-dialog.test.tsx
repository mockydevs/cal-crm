// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Pipeline, PipelineConfiguration } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import PipelineDialog from './pipeline-dialog';

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
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const sales: Pipeline = {
  id: 'pipe_01h455vb4pex5vsknk084sn02q',
  name: 'Sales',
  description: 'Every enquiry that asks for a price',
  archived: false,
  dealProbability: false,
  colorStyle: 'dot',
  showInFunnel: true,
  showInPie: false,
  stages: [
    {
      id: 'stage_01h455vb4pex5vsknk084sn02q',
      name: 'New',
      description: '',
      archived: false,
      probability: 25,
      color: '#12b76a',
      showInFunnel: true,
      showInPie: true,
    },
    {
      id: 'stage_01h455vb4pex5vsknk084sn02r',
      name: 'Quoted',
      description: 'A price was sent',
      archived: false,
      probability: null,
      color: null,
      showInFunnel: false,
      showInPie: true,
    },
  ],
};
const events: Pipeline = {
  id: 'pipe_01h455vb4pex5vsknk084sn02r',
  name: 'Events',
  description: 'Weddings',
  archived: false,
  dealProbability: true,
  colorStyle: 'tint',
  stages: [],
};
const configurationOf = (canManage = true): PipelineConfiguration => ({
  revision: 'a'.repeat(64),
  canManage,
  items: [sales, events],
});

interface Shown {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly dialog: HTMLElement;
  readonly saved: { configuration: PipelineConfiguration; created: boolean }[];
}

async function show(pipeline: Pipeline | undefined, canManage = true): Promise<Shown> {
  const saved: Shown['saved'] = [];
  const configuration = configurationOf(canManage);
  server.answer = (operation) => (operation === 'savePipelines' ? configuration : undefined);
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <PipelineDialog
          configuration={configuration}
          pipeline={pipeline}
          businessId="biz_test"
          returnFocus={createRef<HTMLElement>()}
          onClose={() => undefined}
          onSaved={(next, created) => {
            saved.push({ configuration: next, created });
          }}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), dialog: await screen.findByRole('dialog'), saved };
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement;
function control(element: Element): Control {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLButtonElement
  )
    return element;
  throw new Error('Not a control.');
}
const valueOf = (element: Element): string => control(element).value;
const disabledOf = (element: Element): boolean => control(element).disabled;
const checkedOf = (element: Element): boolean =>
  element instanceof HTMLInputElement && element.checked;

const bodyOf = (call: Server['calls'][number] | undefined): unknown =>
  (call?.input as { body?: unknown } | undefined)?.body;

describe('the dialog that creates a pipeline', () => {
  it('is laid out as GoHighLevel has it, with the four stages and their probabilities', async () => {
    const { dialog } = await show(undefined);
    const inside = within(dialog);
    expect(inside.getByRole('heading', { name: 'Create pipeline' })).toBeTruthy();
    const name = inside.getByLabelText(/^Pipeline name/);
    expect(name.getAttribute('placeholder')).toBe('Marketing pipeline');
    expect(
      inside.getByText('Use a unique, descriptive name so you can find this pipeline later'),
    ).toBeTruthy();
    const probability = inside.getByRole('switch', { name: 'Use opportunity-level probability' });
    expect(probability.getAttribute('aria-checked')).toBe('false');
    const colors = inside.getByRole('radiogroup', { name: 'Set pipeline display colors' });
    expect(
      within(colors)
        .getAllByRole('radio')
        .map((radio) => checkedOf(radio)),
    ).toEqual([true, false, false]);
    expect(within(colors).getByRole('radio', { name: 'Default (no color)' })).toBeTruthy();
    expect(within(colors).getByRole('radio', { name: 'Colored dot' })).toBeTruthy();
    expect(within(colors).getByRole('radio', { name: 'Background tint' })).toBeTruthy();
    expect(inside.getByRole('heading', { name: 'Pipeline stages (4)' })).toBeTruthy();
    expect(inside.getAllByLabelText('Stage name').map((input) => valueOf(input))).toEqual([
      'New Lead',
      'Contacted',
      'Proposal Sent',
      'Closed',
    ]);
    expect(
      inside.getAllByLabelText(/^Probability of .+ \(%\)$/).map((input) => valueOf(input)),
    ).toEqual(['20', '40', '60', '80']);
    // What GoHighLevel's dialog does not have is out of the way until asked for.
    expect(inside.queryByLabelText('Pipeline description')).toBeNull();
    expect(inside.queryByLabelText('Stage description')).toBeNull();
    // Nothing to create until the pipeline has a name.
    expect(disabledOf(inside.getByRole('button', { name: 'Create' }))).toBe(true);
  });

  it('sends the switch, the color style and each stage’s report toggles and probability', async () => {
    const { user, dialog, saved } = await show(undefined);
    const inside = within(dialog);
    await user.type(inside.getByLabelText(/^Pipeline name/), 'Bookings');
    await user.click(inside.getByRole('switch', { name: 'Use opportunity-level probability' }));
    await user.click(inside.getByRole('radio', { name: 'Background tint' }));
    await user.click(inside.getByRole('button', { name: 'Show New Lead in the funnel chart' }));
    await user.click(
      inside.getByRole('button', { name: 'Show Contacted in the stage distribution chart' }),
    );
    const closed = inside.getByLabelText('Probability of Closed (%)');
    await user.clear(closed);
    await user.type(closed, '9x5');
    await user.clear(inside.getByLabelText('Probability of Proposal Sent (%)'));
    await user.click(inside.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.created).toBe(true);
    const body = bodyOf(server.calls.find((call) => call.operation === 'savePipelines')) as {
      revision: string;
      items: unknown[];
    };
    expect(body.revision).toBe('a'.repeat(64));
    expect(body.items).toHaveLength(3);
    expect(body.items[2]).toEqual({
      name: 'Bookings',
      description: '',
      archived: false,
      dealProbability: true,
      colorStyle: 'tint',
      showInFunnel: true,
      showInPie: true,
      stages: [
        {
          name: 'New Lead',
          description: '',
          archived: false,
          probability: 20,
          color: null,
          showInFunnel: false,
          showInPie: true,
        },
        {
          name: 'Contacted',
          description: '',
          archived: false,
          probability: 40,
          color: null,
          showInFunnel: true,
          showInPie: false,
        },
        {
          name: 'Proposal Sent',
          description: '',
          archived: false,
          probability: null,
          color: null,
          showInFunnel: true,
          showInPie: true,
        },
        {
          name: 'Closed',
          description: '',
          archived: false,
          probability: 95,
          color: null,
          showInFunnel: true,
          showInPie: true,
        },
      ],
    });
  });

  it('asks for a name beside a box that was emptied, and never just for leaving it', async () => {
    const { user, dialog } = await show(undefined);
    const inside = within(dialog);
    await user.click(inside.getByLabelText(/^Pipeline name/));
    await user.tab();
    // Leaving the box moves nothing in the dialog: a press elsewhere lands where it was aimed.
    expect(inside.queryByText('Give the pipeline a name.')).toBeNull();
    await user.type(inside.getByLabelText(/^Pipeline name/), 'B');
    await user.clear(inside.getByLabelText(/^Pipeline name/));
    expect(inside.getByText('Give the pipeline a name.')).toBeTruthy();
    expect(inside.getByLabelText(/^Pipeline name/).getAttribute('aria-invalid')).toBe('true');
    const first = control(inside.getAllByLabelText('Stage name')[0] ?? dialog);
    expect(inside.queryByText('Give the stage a name.')).toBeNull();
    await user.clear(first);
    expect(inside.getByText('Give the stage a name.')).toBeTruthy();
  });

  it('refuses a probability over 100 beside its box, and saves nothing', async () => {
    const { user, dialog } = await show(undefined);
    const inside = within(dialog);
    await user.type(inside.getByLabelText(/^Pipeline name/), 'Bookings');
    const box = inside.getByLabelText('Probability of New Lead (%)');
    await user.clear(box);
    await user.type(box, '150');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const message = inside.getByText('Enter 0 to 100.');
    expect(box.getAttribute('aria-describedby')).toBe(message.id);
    expect(disabledOf(inside.getByRole('button', { name: 'Create' }))).toBe(true);
    await user.clear(box);
    await user.type(box, '15');
    expect(inside.queryByText('Enter 0 to 100.')).toBeNull();
    expect(disabledOf(inside.getByRole('button', { name: 'Create' }))).toBe(false);
  });

  it('explains the two columns from their information marks', async () => {
    const { user, dialog } = await show(undefined);
    const inside = within(dialog);
    const reports = inside.getByRole('button', { name: 'About Show in reports' });
    expect(reports.getAttribute('aria-expanded')).toBe('false');
    await user.click(reports);
    expect(reports.getAttribute('aria-expanded')).toBe('true');
    expect(
      inside.getByText(/Use the funnel icon to show a stage in the funnel chart/),
    ).toBeTruthy();
    await user.click(inside.getByRole('button', { name: 'About Probability (%)' }));
    expect(reports.getAttribute('aria-expanded')).toBe('false');
    expect(inside.getByText(/The chance, in percent, that an opportunity/)).toBeTruthy();
  });
});

describe('the dialog that edits a pipeline', () => {
  it('opens on what is saved, and keeps the descriptions behind their buttons', async () => {
    const { user, dialog } = await show(sales);
    const inside = within(dialog);
    expect(inside.getByRole('heading', { name: 'Edit pipeline' })).toBeTruthy();
    expect(checkedOf(inside.getByRole('radio', { name: 'Colored dot' }))).toBe(true);
    expect(valueOf(inside.getByLabelText('Probability of New (%)'))).toBe('25');
    expect(valueOf(inside.getByLabelText('Probability of Quoted (%)'))).toBe('');
    expect(
      inside
        .getByRole('button', { name: 'Show Quoted in the funnel chart' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    expect(
      inside
        .getByRole('button', { name: 'Show Quoted in the stage distribution chart' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    // Nothing to save until something changes.
    expect(disabledOf(inside.getByRole('button', { name: 'Save' }))).toBe(true);

    const more = inside.getByRole('button', { name: 'More options' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await user.click(more);
    expect(valueOf(inside.getByLabelText('Pipeline description'))).toBe(
      'Every enquiry that asks for a price',
    );
    const details = inside.getByRole('button', { name: 'Stage details for Quoted' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    await user.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(valueOf(inside.getByLabelText('Stage description'))).toBe('A price was sent');
  });

  it('saves the descriptions it never showed, the stage colors, and no setting of another pipeline', async () => {
    const { user, dialog, saved } = await show(sales);
    const inside = within(dialog);
    await user.click(inside.getByRole('switch', { name: 'Use opportunity-level probability' }));
    await user.click(inside.getByRole('button', { name: 'Archive Quoted' }));
    expect(inside.getByRole('button', { name: 'Restore Quoted' })).toBeTruthy();
    expect(inside.getByText('Archived')).toBeTruthy();
    await user.click(inside.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.created).toBe(false);
    expect(bodyOf(server.calls.find((call) => call.operation === 'savePipelines'))).toEqual({
      revision: 'a'.repeat(64),
      items: [
        {
          id: sales.id,
          name: 'Sales',
          description: 'Every enquiry that asks for a price',
          archived: false,
          dealProbability: true,
          colorStyle: 'dot',
          showInFunnel: true,
          showInPie: false,
          stages: [
            {
              id: sales.stages[0]?.id,
              name: 'New',
              description: '',
              archived: false,
              probability: 25,
              color: '#12b76a',
              showInFunnel: true,
              showInPie: true,
            },
            {
              id: sales.stages[1]?.id,
              name: 'Quoted',
              description: 'A price was sent',
              archived: true,
              probability: null,
              color: null,
              showInFunnel: false,
              showInPie: true,
            },
          ],
        },
        { id: events.id, name: 'Events', description: 'Weddings', archived: false, stages: [] },
      ],
    });
  });

  it('gives a stage a color from the design tokens where the pipeline draws colors', async () => {
    document.documentElement.style.setProperty('--danger', '#B42318');
    document.documentElement.style.setProperty('--success', '#027a48');
    const { user, dialog, saved } = await show(sales);
    const inside = within(dialog);
    // Closed until asked for: a row is one line.
    expect(inside.queryByRole('group', { name: 'Color of New' })).toBeNull();
    await user.click(inside.getByRole('button', { name: 'Color of Quoted' }));
    const colors = within(inside.getByRole('group', { name: 'Color of Quoted' }));
    // Only tokens the page gives a plain color are offered.
    expect(
      colors.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Green', 'Red', null]);
    expect(colors.getByRole('button', { name: 'No color' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await user.click(colors.getByRole('button', { name: 'Red' }));
    expect(colors.getByRole('button', { name: 'Red' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(inside.getByRole('button', { name: 'Color of New' }));
    await user.click(
      within(inside.getByRole('group', { name: 'Color of New' })).getByRole('button', {
        name: 'No color',
      }),
    );
    await user.click(inside.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const body = bodyOf(server.calls.find((call) => call.operation === 'savePipelines')) as {
      items: { stages: { color: string | null }[] }[];
    };
    expect(body.items[0]?.stages.map((stage) => stage.color)).toEqual([null, '#b42318']);
    // With "Default (no color)" the colors are kept and not shown.
    await user.click(inside.getByRole('radio', { name: 'Default (no color)' }));
    expect(inside.queryByRole('button', { name: /^Color of/ })).toBeNull();
    expect(inside.queryByRole('group', { name: /^Color of/ })).toBeNull();
    document.documentElement.style.removeProperty('--danger');
    document.documentElement.style.removeProperty('--success');
  });

  it('saves whether the pipeline itself shows in the two charts', async () => {
    const { user, dialog, saved } = await show(sales);
    const inside = within(dialog);
    // Not in GoHighLevel's dialog, so with the other extras.
    expect(inside.queryByRole('group', { name: 'Show this pipeline in reports' })).toBeNull();
    await user.click(inside.getByRole('button', { name: 'More options' }));
    const charts = within(inside.getByRole('group', { name: 'Show this pipeline in reports' }));
    const funnel = charts.getByRole('switch', { name: 'Visible in funnel chart' });
    const pie = charts.getByRole('switch', { name: 'Visible in stage distribution chart' });
    expect([funnel, pie].map((each) => each.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
    ]);
    await user.click(funnel);
    await user.click(pie);
    await user.click(inside.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const body = bodyOf(server.calls.find((call) => call.operation === 'savePipelines')) as {
      items: Record<string, unknown>[];
    };
    expect(body.items[0]).toMatchObject({ id: sales.id, showInFunnel: false, showInPie: true });
    expect(Object.keys(body.items[1] ?? {})).not.toContain('showInFunnel');
  });

  it('removes a stage that was never saved, and only archives one that was', async () => {
    const { user, dialog } = await show(sales);
    const inside = within(dialog);
    await user.click(inside.getByRole('button', { name: 'Add stage' }));
    expect(inside.getByRole('heading', { name: 'Pipeline stages (3)' })).toBeTruthy();
    const added = control(inside.getAllByLabelText('Stage name')[2] ?? dialog);
    expect(document.activeElement).toBe(added);
    await user.type(added, 'Won');
    expect(inside.queryByRole('button', { name: 'Remove New' })).toBeNull();
    expect(inside.queryByRole('button', { name: 'Archive Won' })).toBeNull();
    await user.click(inside.getByRole('button', { name: 'Remove Won' }));
    expect(inside.getByRole('heading', { name: 'Pipeline stages (2)' })).toBeTruthy();
  });

  it('moves a stage with the arrow keys on its handle, says so, and keeps the keyboard there', async () => {
    const { user, dialog } = await show(sales);
    const inside = within(dialog);
    const handle = inside.getByRole('button', { name: 'Reorder Quoted' });
    const instructions = document.getElementById(handle.getAttribute('aria-describedby') ?? '');
    expect(instructions?.textContent).toContain('press the up or down arrow key');
    handle.focus();
    await user.keyboard('{ArrowUp}');
    expect(inside.getAllByLabelText('Stage name').map((input) => valueOf(input))).toEqual([
      'Quoted',
      'New',
    ]);
    expect(inside.getByText('Quoted moved to position 1 of 2.')).toBeTruthy();
    expect(document.activeElement).toBe(inside.getByRole('button', { name: 'Reorder Quoted' }));
  });

  it('shows everything and changes nothing for someone who may not manage pipelines', async () => {
    const { user, dialog } = await show(sales, false);
    const inside = within(dialog);
    expect(inside.getByRole('heading', { name: 'Sales' })).toBeTruthy();
    expect(disabledOf(inside.getByLabelText(/^Pipeline name/))).toBe(true);
    expect(
      disabledOf(
        inside.getByRole('switch', {
          name: 'Use opportunity-level probability',
        }),
      ),
    ).toBe(true);
    expect(inside.getAllByRole('radio').every((radio) => disabledOf(radio))).toBe(true);
    expect(disabledOf(inside.getByLabelText('Probability of New (%)'))).toBe(true);
    expect(
      disabledOf(
        inside.getByRole('button', {
          name: 'Show New in the funnel chart',
        }),
      ),
    ).toBe(true);
    expect(inside.queryByRole('button', { name: /^Reorder/ })).toBeNull();
    expect(inside.queryByRole('button', { name: /^Archive/ })).toBeNull();
    expect(inside.queryByRole('button', { name: 'Add stage' })).toBeNull();
    expect(inside.queryByRole('button', { name: 'Save' })).toBeNull();
    // What is kept can still be read.
    await user.click(inside.getByRole('button', { name: 'Stage details for Quoted' }));
    const description = control(inside.getByLabelText('Stage description'));
    expect(description.value).toBe('A price was sent');
    expect(description.disabled).toBe(true);
    await user.click(inside.getByRole('button', { name: 'More options' }));
    expect(disabledOf(inside.getByLabelText('Pipeline description'))).toBe(true);
    expect(disabledOf(inside.getByRole('switch', { name: 'Visible in funnel chart' }))).toBe(true);
  });
});
