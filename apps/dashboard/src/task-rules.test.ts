import { describe, expect, it } from 'vitest';
import {
  dueInstant,
  listQueryOf,
  localTime,
  rangeBackwards,
  sortOf,
  tasksSearchOf,
  withAssignee,
  withList,
  withRange,
  withSort,
  withStatus,
  withTitle,
} from './task-rules';

const lee = 'mem_01m4bd188ff82s0add91b7pz64';
const first = { limit: 20, after: undefined };

describe('the address of the tasks page', () => {
  it('keeps only the choices the list has', () => {
    expect(tasksSearchOf({})).toEqual({});
    expect(
      tasksSearchOf({
        list: 'upcoming',
        assignee: lee,
        status: 'completed',
        q: '  venue ',
        sort: 'due',
        direction: 'desc',
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    ).toEqual({
      list: 'upcoming',
      assignee: lee,
      status: 'completed',
      q: 'venue',
      sort: 'due',
      direction: 'desc',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(tasksSearchOf({ list: 'today', assignee: 'unassigned', status: 'open' })).toEqual({
      list: 'today',
      assignee: 'unassigned',
      status: 'open',
    });
    expect(
      tasksSearchOf({
        list: 'someday',
        assignee: 'mem_1',
        status: 'all',
        q: '   ',
        sort: 'created',
        direction: 'desc',
        from: 'October',
        to: 20261031,
      }),
    ).toEqual({});
    // Upwards is how a column first sorts, so it is not written.
    expect(tasksSearchOf({ sort: 'title', direction: 'asc' })).toEqual({ sort: 'title' });
    expect(tasksSearchOf({ q: 'a'.repeat(250) }).q).toHaveLength(200);
  });

  it('asks the server for every task by default, a page at a time', () => {
    expect(listQueryOf({}, first)).toEqual({ scope: 'all', status: 'all', limit: 20 });
    expect(
      listQueryOf({ assignee: 'mine', status: 'open' }, { limit: 50, after: 'task_1' }),
    ).toEqual({ scope: 'mine', status: 'open', limit: 50, after: 'task_1' });
    expect(listQueryOf({ list: 'today', status: 'open' }, first)).toEqual({
      scope: 'all',
      status: 'open',
      due: 'today',
      limit: 20,
    });
  });

  it('names one person beside every scope, a title and an order', () => {
    expect(listQueryOf({ assignee: lee, q: 'venue', sort: 'due' }, first)).toEqual({
      scope: 'all',
      status: 'all',
      assignee: lee,
      q: 'venue',
      sort: 'due',
      direction: 'asc',
      limit: 20,
    });
    expect(listQueryOf({ sort: 'title', direction: 'desc' }, first)).toMatchObject({
      sort: 'title',
      direction: 'desc',
    });
  });

  it('asks for a range of due days up to the end of its last day, where the reader is', () => {
    const query = listQueryOf({ from: '2026-10-01', to: '2026-10-31' }, first);
    expect(query.dueFrom).toBe(new Date(2026, 9, 1).toISOString());
    expect(query.dueBefore).toBe(new Date(2026, 10, 1).toISOString());
    expect(listQueryOf({ to: '2026-10-31' }, first).dueFrom).toBeUndefined();
    expect(rangeBackwards({ from: '2026-10-02', to: '2026-10-01' })).toBe(true);
    expect(rangeBackwards({ from: '2026-10-01', to: '2026-10-01' })).toBe(false);
    expect(rangeBackwards({ from: '2026-10-01' })).toBe(false);
    expect(withRange({ status: 'open', from: '2026-10-01' }, { to: '2026-10-05' })).toEqual({
      status: 'open',
      from: '2026-10-01',
      to: '2026-10-05',
    });
    expect(withRange({ from: '2026-10-01', to: '2026-10-05' }, { from: '' })).toEqual({
      to: '2026-10-05',
    });
  });

  it('opens a dated list on the tasks still open, and leaves the rest alone going back', () => {
    expect(withList({ assignee: 'mine', status: 'completed', q: 'venue' }, 'overdue')).toEqual({
      list: 'overdue',
      assignee: 'mine',
      status: 'open',
      q: 'venue',
    });
    expect(withList({}, 'today')).toEqual({ list: 'today', status: 'open' });
    expect(withList({}, 'upcoming')).toEqual({ list: 'upcoming', status: 'open' });
    expect(withList({ list: 'overdue', assignee: 'mine', status: 'open' }, 'all')).toEqual({
      assignee: 'mine',
      status: 'open',
    });
  });

  it('drops a chip from the address when it is back at its default', () => {
    expect(withAssignee({ assignee: 'mine', status: 'open' }, 'all')).toEqual({ status: 'open' });
    expect(withAssignee({}, 'unassigned')).toEqual({ assignee: 'unassigned' });
    expect(withAssignee({}, lee)).toEqual({ assignee: lee });
    expect(withStatus({ list: 'overdue', status: 'open' }, 'all')).toEqual({ list: 'overdue' });
    expect(withStatus({}, 'completed')).toEqual({ status: 'completed' });
    expect(withStatus({}, 'nonsense')).toEqual({});
    expect(withAssignee({ assignee: 'mine' }, 'nonsense')).toEqual({});
    expect(withTitle({ status: 'open' }, ' quote ')).toEqual({ status: 'open', q: 'quote' });
    expect(withTitle({ status: 'open', q: 'quote' }, '')).toEqual({ status: 'open' });
  });

  it('sorts a column upwards, then downwards, then not at all', () => {
    const up = withSort({ status: 'open' }, 'title');
    expect(up).toEqual({ status: 'open', sort: 'title' });
    expect(sortOf(up, 'title')).toBe('ascending');
    expect(sortOf(up, 'due')).toBe('none');
    const down = withSort(up, 'title');
    expect(down).toEqual({ status: 'open', sort: 'title', direction: 'desc' });
    expect(sortOf(down, 'title')).toBe('descending');
    expect(withSort(down, 'title')).toEqual({ status: 'open' });
    // Another column starts upwards again.
    expect(withSort(down, 'due')).toEqual({ status: 'open', sort: 'due' });
  });
});

describe('a due time', () => {
  it('is shown as the wall time of this machine and read back as the same instant', () => {
    expect(localTime(null)).toBe('');
    const wall = localTime('2026-10-09T06:30:00.000Z');
    expect(wall).toMatch(/^2026-10-0\dT\d\d:\d\d:00\.000$/);
    expect(dueInstant(wall)).toBe('2026-10-09T06:30:00.000Z');
  });

  it('is refused when it is not a time at all', () => {
    expect(dueInstant('2026-10-09')).toBeUndefined();
    expect(dueInstant('nonsense')).toBeUndefined();
  });
});
