// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it } from 'vitest';

import SimulatedOutput from './automation-simulated-output';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

it('labels a simulated note reference without linking to a real record', () => {
  const { container } = render(
    <I18nProvider i18n={i18n}>
      <SimulatedOutput
        step={{
          step: 'note',
          type: 'note.create',
          simulated: true,
          output: { noteId: 'simulated:note:note:1' },
        }}
      />
    </I18nProvider>,
  );
  expect(screen.getByText('Simulated output')).toBeDefined();
  expect(screen.getByText('Note reference')).toBeDefined();
  expect(screen.getByText('This reference only exists in this test.')).toBeDefined();
  expect(screen.getByText('simulated:note:note:1')).toBeDefined();
  expect(container.querySelector('a')).toBeNull();
});

it.each([
  { simulated: false, output: { noteId: 'simulated:note:note:1' } },
  { simulated: true, output: { noteId: 'note_01h455vb4pex5vsknk084sn02q' } },
  { simulated: true, output: { noteId: 'simulated:task:note:1' } },
  { simulated: true, output: { noteId: 'simulated:note:other:1' } },
  { simulated: true, output: { noteId: 'simulated:note:note:0' } },
  { simulated: true, output: { noteId: '<script>alert(1)</script>' } },
  { simulated: true, output: null },
  { simulated: true, output: ['simulated:note:note:1'] },
  { simulated: true, output: { noteId: { id: 'simulated:note:note:1' } } },
])('does not expose an unmarked, live or malformed reference %#', (metadata) => {
  const { container } = render(
    <I18nProvider i18n={i18n}>
      <SimulatedOutput step={{ step: 'note', type: 'note.create', ...metadata }} />
    </I18nProvider>,
  );
  expect(container.textContent).toBe('');
  expect(container.querySelector('script')).toBeNull();
});
