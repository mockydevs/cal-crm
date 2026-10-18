// @vitest-environment jsdom
// What a contact's activity calls the events External Tracking puts on its timeline.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, expect, it } from 'vitest';
import { useEventLabel } from '../activity';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

it('names a page visit, an external form and the earlier visits a form linked', () => {
  const { result } = renderHook(() => useEventLabel(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    ),
  });
  expect(result.current('external_tracking.page_viewed')).toBe('Page visited');
  expect(result.current('external_tracking.form_submitted')).toBe('External form submitted');
  expect(result.current('external_tracking.visitor_identified')).toBe('Earlier page visits linked');
});
