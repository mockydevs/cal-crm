import { expect, it } from 'vitest';
import { contactSearch, contactSearchString, panelOf, sectionOf, tabOf } from './contact-search';

it('keeps the sections and tabs the page has, and drops anything else', () => {
  expect(contactSearch({ view: 'notes', tab: 'dnd' })).toEqual({ view: 'notes', tab: 'dnd' });
  expect(contactSearch({ view: 'conversation', tab: 'actions' })).toEqual({
    view: 'conversation',
    tab: 'actions',
  });
  expect(contactSearch({ view: 'appointments' })).toEqual({ view: 'appointments' });
  expect(contactSearch({ view: 'documents' })).toEqual({ view: 'documents' });
  expect(panelOf({ view: 'appointments' })).toBe('appointments');
  // Panels GoHighLevel has and this server doesn't: no address opens them.
  for (const view of ['payments', 'agent-logs', 'opportunities'])
    expect(contactSearch({ view })).toEqual({});
  expect(contactSearch({ view: 7, tab: ['dnd'], other: 'x' })).toEqual({});
  // All fields is what the tabs open with, so the address doesn't say it.
  expect(contactSearch({ tab: 'fields' })).toEqual({});
});

it('opens Activity beside the conversation, and Details where one section shows at a time', () => {
  expect(panelOf({})).toBe('activity');
  expect(sectionOf({})).toBe('details');
  expect(panelOf({ view: 'tasks' })).toBe('tasks');
  expect(sectionOf({ view: 'tasks' })).toBe('tasks');
  // Details and the conversation are always on a wide screen: the panel beside them is Activity.
  expect(panelOf({ view: 'details' })).toBe('activity');
  expect(panelOf({ view: 'conversation' })).toBe('activity');
  expect(sectionOf({ view: 'conversation' })).toBe('conversation');
  expect(tabOf({})).toBe('fields');
  expect(tabOf({ tab: 'dnd' })).toBe('dnd');
});

it('writes the address a search has, in a fixed order', () => {
  expect(contactSearchString({})).toBe('');
  expect(contactSearchString({ tab: 'actions', view: 'companies' })).toBe(
    '?view=companies&tab=actions',
  );
  expect(contactSearchString({ view: 'activity' })).toBe('?view=activity');
});
