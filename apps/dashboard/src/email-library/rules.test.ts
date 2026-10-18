import { describe, expect, it } from 'vitest';
import { folderTree, pageSelection, settleAtMost, toggled, withPage } from './rules';

const folder = (id: string, parentId: string | null, name = id) => ({ id, parentId, name });

describe('folderTree', () => {
  it('puts each folder under its parent, in the order given, with its depth', () => {
    const tree = folderTree([
      folder('a', null),
      folder('b', null),
      folder('a1', 'a'),
      folder('a1x', 'a1'),
      folder('b1', 'b'),
      folder('a2', 'a'),
    ]);
    expect(tree.map((each) => [each.id, each.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['a1x', 2],
      ['a2', 1],
      ['b', 0],
      ['b1', 1],
    ]);
  });

  it('shows a folder whose parent is missing at the top, and survives a loop', () => {
    const tree = folderTree([folder('lost', 'gone'), folder('x', 'y'), folder('y', 'x')]);
    expect(tree.map((each) => each.id)).toEqual(['lost', 'x', 'y']);
    expect(tree.find((each) => each.id === 'lost')?.depth).toBe(0);
  });
});

describe('selection', () => {
  it('ticks and unticks one', () => {
    const one = toggled(new Set(), 'a');
    expect([...one]).toEqual(['a']);
    expect([...toggled(one, 'a')]).toEqual([]);
  });

  it('says whether none, some or all of a page is ticked', () => {
    expect(pageSelection(new Set(), ['a', 'b'])).toBe('none');
    expect(pageSelection(new Set(['a']), ['a', 'b'])).toBe('some');
    expect(pageSelection(new Set(['a', 'b']), ['a', 'b'])).toBe('all');
    expect(pageSelection(new Set(['a']), [])).toBe('none');
  });

  it('ticks or unticks a whole page, keeping what is ticked elsewhere', () => {
    expect([...withPage(new Set(['z']), ['a', 'b'], true)].sort()).toEqual(['a', 'b', 'z']);
    expect([...withPage(new Set(['a', 'z']), ['a', 'b'], false)]).toEqual(['z']);
  });
});

describe('settleAtMost', () => {
  it('runs at most this many at once, and answers each in the order given', async () => {
    let running = 0;
    let most = 0;
    const results = await settleAtMost(
      Array.from({ length: 12 }, (_, index) => index),
      5,
      async (each) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        if (each % 4 === 3) throw new Error(`no ${String(each)}`);
        return each * 10;
      },
    );
    expect(most).toBe(5);
    expect(results.map((each) => (each.status === 'fulfilled' ? each.value : 'refused'))).toEqual([
      0,
      10,
      20,
      'refused',
      40,
      50,
      60,
      'refused',
      80,
      90,
      100,
      'refused',
    ]);
  });

  it('answers nothing for nothing', async () => {
    expect(await settleAtMost([], 5, () => Promise.resolve(1))).toEqual([]);
  });
});
