import { SNIPPET_LIMITS } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { actionOf } from '../e2e/conversation-extras-fixtures';
import {
  assigneeChoice,
  assigneeInput,
  clickRange,
  nextPending,
  rangeBackwards,
  snippetBodyLimit,
  snippetDraftReady,
  snippetSubject,
} from './conversation-extras-rules';

describe('a snippet being written', () => {
  const text = {
    type: 'text',
    name: 'Directions',
    subject: '',
    body: 'Park at the back.',
  } as const;
  const email = {
    type: 'email',
    name: 'Welcome',
    subject: 'Welcome aboard',
    body: 'Hello',
  } as const;

  it('can be saved once it has a name and a body', () => {
    expect(snippetDraftReady(text)).toBe(true);
    expect(snippetDraftReady({ ...text, name: '   ' })).toBe(false);
    expect(snippetDraftReady({ ...text, body: '' })).toBe(false);
  });

  it('fits one text message when it is a text, and far more when it is an email', () => {
    expect(snippetBodyLimit('text')).toBe(SNIPPET_LIMITS.text);
    expect(snippetBodyLimit('email')).toBe(SNIPPET_LIMITS.email);
    const long = 'a'.repeat(SNIPPET_LIMITS.text + 1);
    expect(snippetDraftReady({ ...text, body: long })).toBe(false);
    expect(snippetDraftReady({ ...email, body: long })).toBe(true);
  });

  it('needs a one-line subject when it is an email, and sends none for a text', () => {
    expect(snippetDraftReady(email)).toBe(true);
    expect(snippetDraftReady({ ...email, subject: ' ' })).toBe(false);
    expect(snippetDraftReady({ ...email, subject: 'One\nTwo' })).toBe(false);
    expect(snippetSubject({ ...email, subject: '  Welcome aboard ' })).toBe('Welcome aboard');
    expect(snippetSubject({ ...text, subject: 'left over' })).toBeNull();
  });
});

describe('a range of days for the clicks of a link', () => {
  it('asks from the start of the first day to the start of the day after the last', () => {
    const range = clickRange('2026-10-01', '2026-10-03');
    expect(range.from).toBe(new Date(2026, 9, 1).toISOString());
    expect(range.to).toBe(new Date(2026, 9, 4).toISOString());
  });

  it('asks for nothing it was not given', () => {
    expect(clickRange('', '')).toEqual({});
    expect(clickRange('2026-10-01', '')).toEqual({ from: new Date(2026, 9, 1).toISOString() });
    expect(clickRange('not a day', '2026-10-31')).toEqual({
      to: new Date(2026, 10, 1).toISOString(),
    });
  });

  it('knows a range that ends before it starts', () => {
    expect(rangeBackwards('2026-10-03', '2026-10-01')).toBe(true);
    expect(rangeBackwards('2026-10-01', '2026-10-01')).toBe(false);
    expect(rangeBackwards('', '2026-10-01')).toBe(false);
  });
});

describe('the manual actions queue', () => {
  const first = actionOf(1, 'call', 'Ada Park');
  const second = actionOf(2, 'sms', 'Ben Cole', { status: 'completed' });
  const third = actionOf(3, 'call', 'Cy Dunn');

  it('goes on to the next pending action below, then to one above', () => {
    expect(nextPending([first, second, third], first.id)?.id).toBe(third.id);
    expect(nextPending([first, second, third], third.id)?.id).toBe(first.id);
    expect(nextPending([first, second], first.id)).toBeUndefined();
    expect(nextPending([first, third], 'mact_gone')?.id).toBe(first.id);
  });

  it('shows who an action is for, and sends what was chosen', () => {
    expect(assigneeChoice(first)).toBe('unassigned');
    expect(
      assigneeChoice({ assignee: { membershipId: 'mem_1', name: 'Dana Brooks', you: true } }),
    ).toBe('me');
    expect(
      assigneeChoice({ assignee: { membershipId: 'mem_2', name: 'Eli Frost', you: false } }),
    ).toBe('mem_2');
    expect(assigneeChoice({ assignee: { membershipId: null, name: null, you: false } })).toBe(
      'unassigned',
    );
    expect(assigneeInput('unassigned')).toBeNull();
    expect(assigneeInput('me')).toBe('me');
    expect(assigneeInput('mem_2')).toBe('mem_2');
  });
});
