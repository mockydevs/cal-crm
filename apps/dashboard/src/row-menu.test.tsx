// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';

import { RowMenu } from './settings-list';

afterEach(cleanup);

it('keeps an open row menu inside the page landmark and returns keyboard focus', async () => {
  const user = userEvent.setup();
  const { container } = render(
    <main>
      <RowMenu
        label="Actions for Booking page"
        actions={[{ label: 'Analyze', immediate: true, onSelect: () => undefined }]}
        onOpen={() => undefined}
      />
    </main>,
  );
  const trigger = screen.getByRole('button', { name: 'Actions for Booking page' });
  await user.click(trigger);
  const menu = await screen.findByRole('menu');
  expect(container.querySelector('main')?.contains(menu)).toBe(true);
  await user.click(screen.getByRole('menuitem', { name: 'Analyze' }));
  await waitFor(() => {
    expect(screen.queryByRole('menu')).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(trigger);
  });
});
