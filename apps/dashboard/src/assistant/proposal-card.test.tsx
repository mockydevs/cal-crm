// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { publishProposalOf } from '../../e2e/assistant-panel-fixtures';
import { ProposalCard } from './proposal-card';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

it('shows readable complete change details, escapes record text and requires an explicit decision', async () => {
  const onDecide = vi.fn();
  const proposal = publishProposalOf({
    kind: 'pipeline_save',
    summary: 'Save wedding stages',
    change: {
      kind: 'crm_change',
      operationId: 'savePipelines',
      name: 'Weddings',
      details: {
        pipelines: [
          {
            name: '<img src=x onerror=alert(1)>',
            archived: false,
            stages: [{ name: 'Enquiry', probability: 25 }],
          },
        ],
      },
    },
  });
  const { container } = render(
    <I18nProvider i18n={i18n}>
      <ProposalCard proposal={proposal} busy={false} failure={null} onDecide={onDecide} />
    </I18nProvider>,
  );
  await userEvent.click(screen.getByText('Review the proposed changes'));
  expect(screen.getByText('Probability')).toBeDefined();
  expect(screen.getByText('25')).toBeDefined();
  expect(screen.getByText('Enquiry')).toBeDefined();
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeDefined();
  expect(container.querySelector('img')).toBeNull();
  expect(onDecide).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(onDecide).toHaveBeenCalledWith('apply', proposal);
});
