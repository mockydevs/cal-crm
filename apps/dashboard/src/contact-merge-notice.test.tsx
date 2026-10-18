// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { mergedIntoOf, noteMerge } from './contact-merge/notice';
import { ContactMergeNotice } from './contact-merge-notice';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const kept = 'con_01m4bd9fteedat3be9bqgx2047';

function show(contactId: string): HTMLElement {
  return render(
    <I18nProvider i18n={i18n}>
      <ContactMergeNotice contactId={contactId} />
    </I18nProvider>,
  ).container;
}

describe("the contact page's word on a merge", () => {
  it('says how many contacts were just merged into this one, once', () => {
    noteMerge(kept, { kind: 'merged', count: 2 });
    show(kept);
    expect(screen.getByRole('status').textContent).toBe('2 contacts were merged into this one.');
    cleanup();
    expect(show(kept).textContent).toBe('');
  });

  it('says the contact opened was merged into this one', () => {
    noteMerge(kept, { kind: 'followed' });
    show(kept);
    expect(screen.getByRole('status').textContent).toBe(
      'The contact you opened was merged into this one.',
    );
  });

  it("says nothing on another contact's page", () => {
    noteMerge(kept, { kind: 'merged', count: 1 });
    expect(show('con_01m4bd188ff82s0add91b7pz63').textContent).toBe('');
  });
});

describe('a contact read that answers merged', () => {
  it('names the contact kept only for a 404 that says so', () => {
    const notFound = (rest: object) =>
      new ApiError({ type: 'about:blank', title: 'Not Found', status: 404, ...rest });
    expect(mergedIntoOf(notFound({ mergedInto: kept }))).toBe(kept);
    expect(mergedIntoOf(notFound({}))).toBeUndefined();
    expect(
      mergedIntoOf(
        new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, mergedInto: kept }),
      ),
    ).toBeUndefined();
    expect(mergedIntoOf(new Error('offline'))).toBeUndefined();
  });
});
