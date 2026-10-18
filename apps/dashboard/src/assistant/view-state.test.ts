// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  forgetAssistantViews,
  readAssistantView,
  setAssistantView,
  useAssistantView,
} from './view-state';

const closed = { open: false, threadId: null, from: null, fromPage: null };

beforeEach(() => {
  window.sessionStorage.clear();
  forgetAssistantViews();
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('starts closed, with no conversation', () => {
  expect(readAssistantView('biz_1')).toEqual(closed);
});

it('keeps what changed for the tab, one business apart from another', () => {
  setAssistantView('biz_1', { open: true, threadId: 'athr_1' });
  forgetAssistantViews();
  expect(readAssistantView('biz_1')).toEqual({ ...closed, open: true, threadId: 'athr_1' });
  expect(readAssistantView('biz_2')).toEqual(closed);
});

it('keeps the page the full-screen view was opened from', () => {
  const fromPage = { route: '/forms', selection: [] };
  setAssistantView('biz_1', { from: '/b/harbor/settings/forms', fromPage });
  forgetAssistantViews();
  expect(readAssistantView('biz_1')).toEqual({
    ...closed,
    from: '/b/harbor/settings/forms',
    fromPage,
  });
});

it.each([['not json'], ['7'], ['null'], ['{"open":"yes","threadId":7,"from":{}}']])(
  'reads %s as a closed panel',
  (kept) => {
    window.sessionStorage.setItem('assistant:biz_1', kept);
    expect(readAssistantView('biz_1')).toEqual(closed);
  },
);

it('works in a browser that keeps nothing, until the page is reloaded', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage is blocked.');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage is blocked.');
  });
  expect(readAssistantView('biz_1')).toEqual(closed);
  setAssistantView('biz_1', { open: true });
  expect(readAssistantView('biz_1').open).toBe(true);
});

it('draws again when the view changes, and stops when it is gone', () => {
  const { result, unmount } = renderHook(() => useAssistantView('biz_1'));
  expect(result.current.open).toBe(false);
  act(() => {
    setAssistantView('biz_1', { open: true });
  });
  expect(result.current.open).toBe(true);
  unmount();
  setAssistantView('biz_1', { open: false });
  expect(result.current.open).toBe(true);
});
