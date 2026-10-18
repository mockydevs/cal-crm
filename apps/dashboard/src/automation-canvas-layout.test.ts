import { validateAutomation } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { followUp, harborSetup } from '../e2e/automation-fixtures';
import {
  autoPositions,
  BRANCH_DROP,
  canvasGraph,
  GRID,
  hasLayout,
  moveStep,
  NODE,
  TRIGGER,
  nudgeStep,
  PITCH,
  placeAddedStep,
  positionsOf,
  savedPositions,
  tidyLayout,
  type Point,
} from './automation-canvas-layout';
import { addStep, formatDraft, readDraft, sameJson, type Draft } from './automation-document';

const draft: Draft = followUp;

describe('imported coordinate safety', () => {
  it('ignores finite coordinates that cannot advance by a canvas grid square', () => {
    const imported = { ...followUp, layout: { send_guide: { x: 1e308, y: -1e308 } } };
    expect([...savedPositions(imported)]).toEqual([]);
  });

  it('keeps fractional positions at ordinary precision', () => {
    const imported = { ...followUp, layout: { send_guide: { x: 12.5, y: -24.75 } } };
    expect([...savedPositions(imported)]).toEqual([['send_guide', { x: 12.5, y: -24.75 }]]);
  });

  it('refuses moves outside safe numeric precision without changing the draft', () => {
    expect(moveStep(draft, 'send_guide', { x: 1e308, y: 0 })).toBe(draft);
    expect(moveStep(draft, 'send_guide', { x: 0, y: Number.NaN })).toBe(draft);
  });
});
const at = (positions: ReadonlyMap<string, Point>, id: string): Point => {
  const point = positions.get(id);
  if (point === undefined) throw new Error(`${id} has no position.`);
  return point;
};
const boxesOverlap = (a: Point, b: Point): boolean =>
  Math.abs(a.x - b.x) < NODE.width && Math.abs(a.y - b.y) < NODE.height;
const noOverlaps = (positions: ReadonlyMap<string, Point>): boolean => {
  const all = [...positions.values()];
  return all.every((a, i) => all.every((b, j) => i === j || !boxesOverlap(a, b)));
};

describe('the automatic layout', () => {
  const positions = autoPositions(draft);

  it('places every step, none on top of another', () => {
    expect([...positions.keys()].toSorted()).toEqual(Object.keys(followUp.steps).toSorted());
    expect(noOverlaps(positions)).toBe(true);
  });

  it('reads from the top: each step under the one before it, one row apart', () => {
    const guide = at(positions, 'send_guide');
    expect(at(positions, 'wait_2_days')).toEqual({ x: guide.x, y: guide.y + PITCH.y });
    expect(at(positions, 'asked_about_video')).toEqual({ x: guide.x, y: guide.y + 2 * PITCH.y });
  });

  it('gives each branch a column of its own, either side of the step that branches', () => {
    const condition = at(positions, 'asked_about_video');
    const yes = at(positions, 'send_reel');
    const no = at(positions, 'check_in');
    // One column pitch apart, centred under the condition, with room for the fan-out.
    expect(no.x - yes.x).toBe(PITCH.x);
    expect((yes.x + no.x) / 2).toBe(condition.x);
    expect(yes.y).toBe(condition.y + PITCH.y + BRANCH_DROP);
    expect(no.y).toBe(yes.y);
    // The no branch carries on down its own column.
    expect(at(positions, 'wait_3_days')).toEqual({ x: no.x, y: no.y + PITCH.y });
    expect(at(positions, 'last_check_in')).toEqual({ x: no.x, y: no.y + 2 * PITCH.y });
  });

  it('widens a column for a branch that branches again, so nested branches never collide', () => {
    const nested: Draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        send_reel: {
          type: 'condition',
          config: { if: { field: 'contact.firstName', operator: 'is_set' } },
          next: { yes: 'reel_a', no: 'reel_b' },
        },
        reel_a: { type: 'wait', config: { duration: 'P1D' } },
        reel_b: { type: 'wait', config: { duration: 'P2D' } },
      },
    };
    const laid = autoPositions(nested);
    expect(noOverlaps(laid)).toBe(true);
    // The whole yes side, with its two columns, lies left of the no side.
    expect(at(laid, 'reel_b').x + NODE.width).toBeLessThanOrEqual(at(laid, 'check_in').x);
    expect((at(laid, 'reel_a').x + at(laid, 'reel_b').x) / 2).toBe(at(laid, 'send_reel').x);
  });

  it('lays out steps nothing leads to beside the flow, never on it', () => {
    const withStray: Draft = {
      ...followUp,
      steps: { ...followUp.steps, stray: { type: 'wait', config: { duration: 'P1D' } } },
    };
    const laid = autoPositions(withStray);
    expect(noOverlaps(laid)).toBe(true);
    const rightmost = Math.max(...Object.keys(followUp.steps).map((id) => at(laid, id).x));
    expect(at(laid, 'stray').x).toBeGreaterThan(rightmost);
    expect(canvasGraph(withStray).nodes.find((node) => node.step.id === 'stray')?.connected).toBe(
      false,
    );
  });

  it('lays out a loop once, with its way back as a line and not a second copy', () => {
    const looping: Draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        last_check_in: { ...followUp.steps.last_check_in, next: 'wait_3_days' },
      },
    };
    const graph = canvasGraph(looping);
    expect(graph.nodes).toHaveLength(Object.keys(followUp.steps).length);
    const back = graph.edges.find((edge) => edge.from === 'last_check_in');
    expect(back).toMatchObject({ to: { kind: 'step', id: 'wait_3_days' }, back: true });
    expect(graph.edges.filter((edge) => edge.back)).toHaveLength(1);
  });

  it('copes with an unfinished draft: no steps, no start, or a path to a step that is not there', () => {
    const empty = canvasGraph({ name: 'New', triggers: followUp.triggers, steps: {} });
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty.firstStep).toBeDefined();
    expect(empty.beforeStart).toBeUndefined();
    expect(empty.triggers).toHaveLength(1);
    expect(canvasGraph({}).triggers).toEqual([]);

    const dangling = canvasGraph({
      ...followUp,
      steps: { send_guide: { ...followUp.steps.send_guide, next: 'gone' } },
    });
    expect(dangling.edges).toMatchObject([
      { from: 'send_guide', to: { kind: 'missing', id: 'gone' } },
    ]);
    expect(dangling.edges[0]?.pill).toBeDefined();
  });
});

describe('the drawing', () => {
  const graph = canvasGraph(draft);

  it('lists the steps in the order a contact meets them', () => {
    expect(graph.nodes.map((node) => node.step.id)).toEqual([
      'send_guide',
      'wait_2_days',
      'asked_about_video',
      'send_reel',
      'check_in',
      'wait_3_days',
      'last_check_in',
    ]);
    expect(graph.nodes.every((node) => node.connected)).toBe(true);
  });

  it('keeps everything inside its own size, with a margin', () => {
    for (const node of graph.nodes) {
      expect(node.at.x).toBeGreaterThanOrEqual(40);
      expect(node.at.y).toBeGreaterThanOrEqual(40);
      expect(node.at.x + NODE.width).toBeLessThanOrEqual(graph.size.width - 40);
      expect(node.at.y + NODE.height).toBeLessThanOrEqual(graph.size.height - 40);
    }
    for (const edge of graph.edges)
      if (edge.pill !== undefined) expect(edge.pill.y + 36).toBeLessThanOrEqual(graph.size.height);
  });

  it('has a line for every path, each saying where a step added on it would go', () => {
    expect(
      graph.edges.map((edge) => [
        edge.from,
        edge.branch,
        edge.to.kind === 'step' ? edge.to.id : edge.to.kind,
      ]),
    ).toEqual([
      ['send_guide', undefined, 'wait_2_days'],
      ['wait_2_days', undefined, 'asked_about_video'],
      ['asked_about_video', 'yes', 'send_reel'],
      ['asked_about_video', 'no', 'check_in'],
      ['send_reel', undefined, 'end'],
      ['check_in', undefined, 'wait_3_days'],
      ['wait_3_days', undefined, 'last_check_in'],
      ['last_check_in', undefined, 'end'],
    ]);
    expect(graph.edges[2]?.at).toEqual({ kind: 'after', step: 'asked_about_video', branch: 'yes' });
    expect(graph.edges[0]?.at).toEqual({ kind: 'after', step: 'send_guide' });
    // Branch lines carry their name; the others don't.
    expect(graph.edges.map((edge) => edge.label !== undefined)).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    // A path that ends has an end marker under its last step.
    expect(graph.edges.filter((edge) => edge.pill !== undefined).map((edge) => edge.from)).toEqual([
      'send_reel',
      'last_check_in',
    ]);
  });

  it('puts each add button on its own line, between the two things it would come between', () => {
    const guide = graph.nodes.find((node) => node.step.id === 'send_guide');
    const wait = graph.nodes.find((node) => node.step.id === 'wait_2_days');
    const [first] = graph.edges;
    expect(first?.plus).toEqual({
      x: (guide?.at.x ?? 0) + NODE.width / 2,
      y: ((guide?.at.y ?? 0) + NODE.height + (wait?.at.y ?? 0)) / 2,
    });
    const spots = graph.edges.map((edge) => `${String(edge.plus?.x)},${String(edge.plus?.y)}`);
    expect(new Set(spots).size).toBe(spots.length);
  });

  it('stands the triggers above the first step, with room to add another', () => {
    const two = canvasGraph({
      ...followUp,
      triggers: [...followUp.triggers, { id: 'created', type: 'contact.created', config: {} }],
    });
    const start = two.nodes[0]?.at ?? { x: 0, y: 0 };
    // A trigger's card is taller than a step's; the gap under it is the gap under a step.
    const row = start.y - (PITCH.y - NODE.height) - TRIGGER.height;
    expect(two.triggers.map((trigger) => trigger.at)).toEqual([
      { x: start.x, y: row },
      { x: start.x + TRIGGER.width + 48, y: row },
    ]);
    expect(two.addTrigger).toEqual({ x: start.x + 2 * (TRIGGER.width + 48), y: row });
    expect(two.addTriggerPath).toBeUndefined();
    expect(two.beforeStart).toEqual({ x: start.x + NODE.width / 2, y: start.y - 30 });
    // Each trigger's line leaves the foot of its card; the second joins the first's, round a corner.
    const across = start.x + TRIGGER.width + 48 + 120;
    const foot = row + TRIGGER.height;
    expect(two.triggers[0]?.path).toBe(
      `M ${String(start.x + 120)} ${String(row + TRIGGER.height)} L ${String(start.x + 120)} ${String(start.y)}`,
    );
    expect(two.triggers[1]?.path).toBe(
      `M ${String(across)} ${String(foot)} L ${String(across)} ${String(foot + 8)} Q ${String(across)} ${String(foot + 16)} ${String(across - 8)} ${String(foot + 16)} L ${String(start.x + 120)} ${String(foot + 16)}`,
    );
    expect(two.addTrigger.x + NODE.width).toBeLessThanOrEqual(two.size.width);
  });

  it('draws a workflow with no trigger yet: the card that adds one, a line down, and where the first step goes', () => {
    const empty = canvasGraph({ name: 'New Workflow : 1', triggers: [], steps: {} });
    expect(empty.triggers).toEqual([]);
    expect(empty.nodes).toEqual([]);
    const card = empty.addTrigger;
    const pill = empty.firstStep?.pill ?? { x: 0, y: 0 };
    expect(pill.x).toBe(card.x + TRIGGER.width / 2);
    expect(pill.y).toBe(card.y + TRIGGER.height + (PITCH.y - NODE.height));
    expect(empty.addTriggerPath).toBe(
      `M ${String(pill.x)} ${String(card.y + TRIGGER.height)} L ${String(pill.x)} ${String(pill.y)}`,
    );
    expect(empty.firstStep?.plus).toEqual({ x: pill.x, y: pill.y - 30 });
    expect(empty.beforeStart).toBeUndefined();
  });
});

describe('placing steps by hand', () => {
  it('changes only the layout, and writes every step down so nothing else moves', () => {
    const before = positionsOf(draft);
    const moved = moveStep(draft, 'send_reel', { x: -613, y: 407 });
    const { layout, ...rest } = moved;
    const { layout: _none, ...original } = draft as Draft & { layout?: unknown };
    expect(sameJson(rest, original)).toBe(true);
    // On the grid, and in the order the document lists its steps.
    expect(Object.keys(layout as object)).toEqual(Object.keys(followUp.steps));
    expect((layout as Record<string, Point>)['send_reel']).toEqual({ x: -620, y: 400 });
    const after = positionsOf(moved);
    for (const [id, point] of before) if (id !== 'send_reel') expect(at(after, id)).toEqual(point);
    expect(hasLayout(moved)).toBe(true);
    expect(hasLayout(draft)).toBe(false);
  });

  it('moves by grid squares from the keyboard', () => {
    const start = at(positionsOf(draft), 'send_guide');
    const right = nudgeStep(draft, 'send_guide', { x: 1, y: 0 });
    expect(at(positionsOf(right), 'send_guide')).toEqual({ x: start.x + GRID, y: start.y });
    const up = nudgeStep(right, 'send_guide', { x: 0, y: -3 });
    expect(at(positionsOf(up), 'send_guide')).toEqual({ x: start.x + GRID, y: start.y - 3 * GRID });
    expect(nudgeStep(draft, 'nobody', { x: 1, y: 0 })).toBe(draft);
    expect(moveStep(draft, 'nobody', { x: 1, y: 0 })).toBe(draft);
  });

  it('is a valid document, which reads back from JSON exactly as it was', () => {
    const moved = moveStep(draft, 'check_in', { x: 500, y: 900 });
    const result = validateAutomation(moved, harborSetup);
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((warning) => warning.code === 'unknown_layout_step')).toEqual([]);
    const read = readDraft(formatDraft(moved));
    expect(read.ok && sameJson(read.draft, moved)).toBe(true);
    expect(read.ok ? positionsOf(read.draft) : undefined).toEqual(positionsOf(moved));
  });

  it('forgets every placement when tidied, back to the automatic layout', () => {
    const moved = moveStep(draft, 'check_in', { x: 500, y: 900 });
    const tidy = tidyLayout(moved);
    expect(Object.hasOwn(tidy, 'layout')).toBe(false);
    expect(positionsOf(tidy)).toEqual(autoPositions(draft));
  });

  it('ignores placements it cannot use: a step that is gone, or something that is not a point', () => {
    const odd: Draft = {
      ...followUp,
      layout: { gone: { x: 1, y: 2 }, send_guide: { x: 'left' }, wait_2_days: { x: 0, y: 40 } },
    };
    expect([...savedPositions(odd)]).toEqual([['wait_2_days', { x: 0, y: 40 }]]);
    expect([...savedPositions({ ...followUp, layout: 'top' }).keys()]).toEqual([]);
  });
});

describe('a drawing arranged by hand, when the document changes elsewhere', () => {
  // Only the first step was ever placed, as in the documentation's own example.
  const partly: Draft = { ...followUp, layout: { send_guide: { x: 0, y: 160 } } };

  it('lays the unplaced steps out from the placed one, none on top of another', () => {
    const positions = positionsOf(partly);
    expect(at(positions, 'send_guide')).toEqual({ x: 0, y: 160 });
    expect(at(positions, 'wait_2_days')).toEqual({ x: 0, y: 160 + PITCH.y });
    expect([...positions.keys()].toSorted()).toEqual(Object.keys(followUp.steps).toSorted());
    expect(noOverlaps(positions)).toBe(true);
  });

  it('finds a free place for a step added in another view, beside what is already there', () => {
    const arranged = moveStep(draft, 'send_guide', at(positionsOf(draft), 'send_guide'));
    const added = addStep(
      arranged,
      { kind: 'after', step: 'send_reel' },
      {
        id: 'thanks',
        type: 'wait',
        config: { duration: 'P1D' },
      },
    );
    const positions = positionsOf(added);
    expect(noOverlaps(positions)).toBe(true);
    expect(at(positions, 'thanks').y).toBe(at(positions, 'send_reel').y + PITCH.y);
    // A step nothing placed leads to goes below everything, still clear of the rest.
    const stray = positionsOf({
      ...arranged,
      steps: { ...followUp.steps, stray: { type: 'wait', config: { duration: 'P1D' } } },
    });
    expect(noOverlaps(stray)).toBe(true);
    expect(at(stray, 'stray').y).toBeGreaterThan(at(stray, 'last_check_in').y);
  });

  it('makes room for a step added between two placed steps: what follows moves down a row', () => {
    const arranged = moveStep(draft, 'send_guide', at(positionsOf(draft), 'send_guide'));
    const before = positionsOf(arranged);
    const added = placeAddedStep(
      arranged,
      addStep(
        arranged,
        { kind: 'after', step: 'send_guide' },
        {
          id: 'hello',
          type: 'wait',
          config: { duration: 'PT1H' },
        },
      ),
      'hello',
    );
    const positions = positionsOf(added);
    expect(at(positions, 'hello')).toEqual(at(before, 'wait_2_days'));
    for (const id of Object.keys(followUp.steps))
      expect(at(positions, id)).toEqual(
        id === 'send_guide'
          ? at(before, id)
          : { x: at(before, id).x, y: at(before, id).y + PITCH.y },
      );
    expect(noOverlaps(positions)).toBe(true);
    expect(validateAutomation(added, harborSetup).errors).toEqual([]);
  });

  it('puts a step added at the end of a path under the step before it', () => {
    const arranged = moveStep(draft, 'send_guide', at(positionsOf(draft), 'send_guide'));
    const added = placeAddedStep(
      arranged,
      addStep(
        arranged,
        { kind: 'after', step: 'last_check_in' },
        {
          id: 'bye',
          type: 'wait',
          config: { duration: 'PT1H' },
        },
      ),
      'bye',
    );
    const last = at(positionsOf(arranged), 'last_check_in');
    expect(at(savedPositions(added), 'bye')).toEqual({ x: last.x, y: last.y + PITCH.y });
  });

  it('leaves a drawing nobody arranged to the automatic layout, and a loop above where it is', () => {
    const plain = addStep(
      draft,
      { kind: 'after', step: 'send_guide' },
      {
        id: 'hello',
        type: 'wait',
        config: { duration: 'PT1H' },
      },
    );
    expect(placeAddedStep(draft, plain, 'hello')).toBe(plain);
    expect(placeAddedStep(draft, plain, 'nobody')).toBe(plain);

    // check_in leads back up to wait_2_days: adding after check_in must not move the top.
    const looping: Draft = {
      ...followUp,
      steps: { ...followUp.steps, check_in: { ...followUp.steps.check_in, next: 'wait_2_days' } },
    };
    const arranged = moveStep(looping, 'send_guide', at(positionsOf(looping), 'send_guide'));
    const before = positionsOf(arranged);
    const added = placeAddedStep(
      arranged,
      addStep(
        arranged,
        { kind: 'after', step: 'check_in' },
        {
          id: 'pause',
          type: 'wait',
          config: { duration: 'PT1H' },
        },
      ),
      'pause',
    );
    const positions = positionsOf(added);
    expect(at(positions, 'wait_2_days')).toEqual(at(before, 'wait_2_days'));
    expect(at(positions, 'send_guide')).toEqual(at(before, 'send_guide'));
    expect(noOverlaps(positions)).toBe(true);
  });
});
