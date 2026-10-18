// How the canvas draws its lines (automation-canvas-layout.ts): each branch in a column of
// its own, paths that come together again joined under the lowest of them, and no line over
// a card or along another line.
import { describe, expect, it } from 'vitest';
import { validateAutomation } from '@repo/contracts';
import { followUp, harborSetup, leadIntake, threeDeals } from '../e2e/automation-fixtures';
import {
  canvasGraph,
  JOIN_DROP,
  LANE_RISE,
  linePath,
  moveStep,
  NODE,
  PITCH,
  type CanvasEdge,
  type CanvasGraph,
  type Point,
} from './automation-canvas-layout';
import type { Draft } from './automation-document';

interface Rect {
  readonly x1: number;
  readonly x2: number;
  readonly y1: number;
  readonly y2: number;
}
type Segment = readonly [Point, Point];

const cardOf = (at: Point): Rect => ({
  x1: at.x,
  x2: at.x + NODE.width,
  y1: at.y,
  y2: at.y + NODE.height,
});
const segmentsOf = (edge: CanvasEdge): Segment[] =>
  edge.points.slice(1).map((point, index): Segment => [edge.points[index] ?? point, point]);
// Through the inside of the box: touching its edge, as a line does where it leaves or
// arrives, is not crossing it.
const crosses = ([a, b]: Segment, box: Rect): boolean =>
  Math.max(a.x, b.x) > box.x1 &&
  Math.min(a.x, b.x) < box.x2 &&
  Math.max(a.y, b.y) > box.y1 &&
  Math.min(a.y, b.y) < box.y2;
// Lying along each other for some length, not just crossing or meeting at a point.
const liesOn = ([a, b]: Segment, [c, d]: Segment): boolean => {
  const upright = a.x === b.x && c.x === d.x && a.x === c.x;
  const level = a.y === b.y && c.y === d.y && a.y === c.y;
  if (upright)
    return (
      Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <
      Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y))
    );
  if (level)
    return (
      Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <
      Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
    );
  return false;
};
const farFrom = (point: Point, [a, b]: Segment, least: number): boolean => {
  const x = Math.min(Math.max(point.x, Math.min(a.x, b.x)), Math.max(a.x, b.x));
  const y = Math.min(Math.max(point.y, Math.min(a.y, b.y)), Math.max(a.y, b.y));
  return Math.hypot(point.x - x, point.y - y) >= least;
};
const onLine = (point: Point, edge: CanvasEdge): boolean =>
  segmentsOf(edge).some((segment) => !farFrom(point, segment, 0.001));
const targetOf = (edge: CanvasEdge): string | undefined =>
  edge.to.kind === 'step' ? edge.to.id : undefined;
// Lines that leave one step together, or arrive at one step together, are one line there.
const together = (a: CanvasEdge, b: CanvasEdge): boolean =>
  a.from === b.from || (targetOf(a) !== undefined && targetOf(a) === targetOf(b));

/** Everything wrong with a drawing, in words; none when it is clean. */
function faults(graph: CanvasGraph): string[] {
  const found: string[] = [];
  const cards = graph.nodes.map((node) => ({ id: node.step.id, box: cardOf(node.at) }));
  cards.forEach((a, i) => {
    for (const b of cards.slice(i + 1))
      if (a.box.x1 < b.box.x2 && b.box.x1 < a.box.x2 && a.box.y1 < b.box.y2 && b.box.y1 < a.box.y2)
        found.push(`${a.id} lies on ${b.id}`);
  });
  for (const edge of graph.edges) {
    const name = `${edge.from}${edge.branch === undefined ? '' : `:${edge.branch}`}`;
    for (const segment of segmentsOf(edge))
      for (const card of cards)
        if (crosses(segment, card.box)) found.push(`the line from ${name} crosses ${card.id}`);
    const { plus } = edge;
    if (plus !== undefined && !onLine(plus, edge))
      found.push(`the add button of ${name} is off its line`);
    if (edge.label !== undefined && !onLine(edge.label, edge))
      found.push(`the name of ${name} is off its line`);
    // The round mark of an add button is 24 across; a branch's name is 20 tall.
    for (const card of cards) {
      const { box } = card;
      const near = (point: Point, by: number): boolean =>
        point.x > box.x1 - by &&
        point.x < box.x2 + by &&
        point.y > box.y1 - by &&
        point.y < box.y2 + by;
      if (plus !== undefined && near(plus, 12))
        found.push(`the add button of ${name} is on ${card.id}`);
      if (edge.label !== undefined && near(edge.label, 10))
        found.push(`the name of ${name} is on ${card.id}`);
    }
    for (const other of graph.edges) {
      if (other === edge) continue;
      if (!together(edge, other))
        for (const segment of segmentsOf(edge))
          for (const theirs of segmentsOf(other))
            if (liesOn(segment, theirs) && edge.key < other.key)
              found.push(`the line from ${name} lies along the line from ${other.from}`);
      if (
        plus !== undefined &&
        other.from !== edge.from &&
        segmentsOf(other).some((s) => !farFrom(plus, s, 12))
      )
        found.push(`the add button of ${name} is on the line from ${other.from}`);
    }
  }
  // No two add buttons within 40 of each other, and the one of a join under its lane.
  const buttons = [
    ...graph.edges.flatMap((edge) =>
      edge.plus === undefined ? [] : [{ name: `${edge.from}:${edge.branch ?? ''}`, at: edge.plus }],
    ),
    ...graph.joins.map((join) => ({ name: `before ${join.step}`, at: join.plus })),
    ...(graph.beforeStart === undefined ? [] : [{ name: 'start', at: graph.beforeStart }]),
  ];
  buttons.forEach((a, i) => {
    for (const b of buttons.slice(i + 1))
      if (Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) < 40)
        found.push(`the add buttons ${a.name} and ${b.name} are too close`);
  });
  if (new Set(graph.joins.map((join) => join.step)).size !== graph.joins.length)
    found.push('a join has more than one add button');
  for (const join of graph.joins) {
    const arriving = graph.edges.filter((edge) => targetOf(edge) === join.step && !edge.back);
    const lane = (cards.find((card) => card.id === join.step)?.box.y1 ?? 0) - LANE_RISE;
    for (const edge of arriving) {
      if (!onLine(join.plus, edge))
        found.push(`the add button before ${join.step} is off its line`);
      if (join.plus.y - lane < 20) found.push(`the add button before ${join.step} is on its lane`);
      // One button where paths join: a step's line into the join has none of its own.
      if (edge.plus !== undefined && edge.branch === undefined)
        found.push(`${edge.from} has a second add button at the join ${join.step}`);
      if (edge.plus !== undefined && lane - edge.plus.y < 20)
        found.push(`the add button of ${edge.from} is on the lane of ${join.step}`);
    }
  }
  return found;
}

const wait = (next?: string): Record<string, unknown> => ({
  type: 'wait',
  config: { duration: 'P1D' },
  ...(next === undefined ? {} : { next }),
});
const condition = (yes: string | undefined, no: string | undefined): Record<string, unknown> => ({
  type: 'condition',
  config: { if: { field: 'contact.firstName', operator: 'is_set' } },
  next: { ...(yes === undefined ? {} : { yes }), ...(no === undefined ? {} : { no }) },
});
const draftOf = (start: string, steps: Record<string, unknown>): Draft => ({
  name: 'Drawn',
  triggers: followUp.triggers,
  start,
  steps,
});
const nodeAt = (graph: CanvasGraph, id: string): Point => {
  const node = graph.nodes.find((each) => each.step.id === id);
  if (node === undefined) throw new Error(`${id} is not drawn.`);
  return node.at;
};
const edgeOf = (graph: CanvasGraph, from: string, branch?: string): CanvasEdge => {
  const edge = graph.edges.find((each) => each.from === from && each.branch === branch);
  if (edge === undefined) throw new Error(`${from} has no such line.`);
  return edge;
};

describe('branches that come together again', () => {
  const graph = canvasGraph(threeDeals);

  it('gives each branch its own column and puts the step they join at under all of them', () => {
    expect(faults(graph)).toEqual([]);
    const [photo, video, other] = ['deal_photo', 'deal_video', 'deal_other'].map((id) =>
      nodeAt(graph, id),
    );
    expect(video && photo && video.x - photo.x).toBe(PITCH.x);
    expect(video && other && other.x - video.x).toBe(PITCH.x);
    expect(new Set([photo?.y, video?.y, other?.y]).size).toBe(1);
    // Under the step that branched, below the cards of every branch.
    const join = nodeAt(graph, 'thanks');
    expect(join.x).toBe(nodeAt(graph, 'which_service').x);
    expect(join.y).toBe((photo?.y ?? 0) + NODE.height + JOIN_DROP);
    expect(nodeAt(graph, 'later')).toEqual({ x: join.x, y: join.y + PITCH.y });
  });

  it('brings every branch straight down to one lane above the join, and in at its top centre', () => {
    const join = nodeAt(graph, 'thanks');
    const lane = join.y - LANE_RISE;
    const top = { x: join.x + NODE.width / 2, y: join.y };
    for (const from of ['deal_photo', 'deal_video', 'deal_other']) {
      const edge = edgeOf(graph, from);
      const foot = {
        x: nodeAt(graph, from).x + NODE.width / 2,
        y: nodeAt(graph, from).y + NODE.height,
      };
      expect(edge.back).toBe(false);
      expect(edge.points[0]).toEqual(foot);
      expect(edge.points[1]).toEqual(foot.x === top.x ? top : { x: foot.x, y: lane });
      expect(edge.points.at(-1)).toEqual(top);
      // The one add button here is the join's own.
      expect(edge.plus).toBeUndefined();
    }
    expect(edgeOf(graph, 'deal_photo').points).toHaveLength(4);
    // The middle branch stands over the join: its line is one straight run.
    expect(edgeOf(graph, 'deal_video').points).toHaveLength(2);
  });

  it('has exactly one add button where the branches join: under the lane, on the shared run', () => {
    const join = nodeAt(graph, 'thanks');
    expect(graph.joins).toEqual([
      { step: 'thanks', plus: { x: join.x + NODE.width / 2, y: join.y - 30 } },
    ]);
    expect(join.y - LANE_RISE).toBe((graph.joins[0]?.plus.y ?? 0) - 30);
    const arriving = graph.edges.filter((edge) => targetOf(edge) === 'thanks');
    expect(arriving.map((edge) => edge.plus)).toEqual([undefined, undefined, undefined]);
    // Every other line keeps its one button.
    expect(graph.edges.filter((edge) => edge.plus === undefined)).toEqual(arriving);
  });

  it('draws two branches that share a follow-up, then all three joining again', () => {
    expect(validateAutomation(leadIntake, harborSetup).errors).toEqual([]);
    expect(validateAutomation(threeDeals, harborSetup).errors).toEqual([]);
    const shared = canvasGraph(leadIntake);
    expect(faults(shared)).toEqual([]);
    const task = nodeAt(shared, 'follow_up');
    // The shared step stands under the two branches that lead to it, between them.
    expect(task.x).toBe((nodeAt(shared, 'deal_photo').x + nodeAt(shared, 'deal_video').x) / 2);
    expect(task.y).toBe(nodeAt(shared, 'deal_photo').y + NODE.height + JOIN_DROP);
    const email = nodeAt(shared, 'thanks');
    expect(email.x).toBe(nodeAt(shared, 'which_service').x);
    expect(email.y).toBe(task.y + NODE.height + JOIN_DROP);
    expect(shared.joins.map((join) => join.step)).toEqual(['follow_up', 'thanks']);
    // One add button at each join, and none on the four lines that arrive at them.
    expect(shared.edges.filter((edge) => edge.plus === undefined).map((edge) => edge.from)).toEqual(
      ['deal_photo', 'deal_video', 'deal_other', 'follow_up'],
    );
    // The third branch runs down its own column, beside the shared step, to the last lane.
    const other = edgeOf(shared, 'deal_other');
    expect(other.points[1]).toEqual({ x: other.points[0]?.x, y: email.y - LANE_RISE });
    expect(other.points[0]?.x).toBeGreaterThan(task.x + NODE.width);
  });

  it('names each branch on its own column, under the bar they leave by', () => {
    const edges = ['photo', 'video', 'none'].map((name) => edgeOf(graph, 'which_service', name));
    const foot = nodeAt(graph, 'which_service').y + NODE.height;
    expect(edges.map((edge) => edge.label?.x)).toEqual(
      ['deal_photo', 'deal_video', 'deal_other'].map((id) => nodeAt(graph, id).x + NODE.width / 2),
    );
    for (const edge of edges) {
      expect(edge.label?.y).toBeGreaterThan(foot);
      expect(edge.plus?.y).toBeGreaterThan(edge.label?.y ?? 0);
    }
  });

  it('rounds every corner of a line', () => {
    expect(
      linePath([
        { x: 0, y: 0 },
        { x: 0, y: 100 },
      ]),
    ).toBe('M 0 0 L 0 100');
    expect(
      linePath([
        { x: 0, y: 0 },
        { x: 0, y: 50 },
        { x: 0, y: 50 },
        { x: 0, y: 100 },
      ]),
    ).toBe('M 0 0 L 0 100');
    expect(
      linePath([
        { x: 0, y: 0 },
        { x: 0, y: 40 },
        { x: 60, y: 40 },
        { x: 60, y: 80 },
      ]),
    ).toBe('M 0 0 L 0 30 Q 0 40 10 40 L 50 40 Q 60 40 60 50 L 60 80');
    // A short run bends by half its length at most, so two corners never overlap.
    expect(
      linePath([
        { x: 0, y: 0 },
        { x: 0, y: 8 },
        { x: 60, y: 8 },
      ]),
    ).toBe('M 0 0 L 0 4 Q 0 8 4 8 L 60 8');
    expect(linePath([])).toBe('');
    expect(edgeOf(graph, 'deal_photo').path).toContain(' Q ');
  });

  it('joins a branch with no step of its own by its empty column', () => {
    const skipping = canvasGraph(
      draftOf('ask', { ask: condition('nudge', 'done'), nudge: wait('done'), done: wait() }),
    );
    expect(faults(skipping)).toEqual([]);
    const no = edgeOf(skipping, 'ask', 'no');
    const done = nodeAt(skipping, 'done');
    // Out along the bar, down its own column past the other branch's card, then across.
    expect(no.points).toHaveLength(6);
    expect(no.points[3]).toEqual({ x: no.label?.x, y: done.y - LANE_RISE });
    expect(no.label?.x).toBe(nodeAt(skipping, 'nudge').x + NODE.width / 2 + PITCH.x);
    expect(done.x).toBe(nodeAt(skipping, 'ask').x);
    expect(done.y).toBeGreaterThan(nodeAt(skipping, 'nudge').y + NODE.height);
  });
});

describe('harder drawings', () => {
  it('nests conditions: the inner join under the inner branches, the outer under everything', () => {
    const nested = canvasGraph(
      draftOf('outer', {
        outer: condition('inner', 'plain'),
        inner: condition('a', 'b'),
        a: wait('inner_done'),
        b: wait('b_more'),
        b_more: wait('inner_done'),
        inner_done: wait('all_done'),
        plain: wait('all_done'),
        all_done: wait(),
      }),
    );
    expect(faults(nested)).toEqual([]);
    const innerDone = nodeAt(nested, 'inner_done');
    expect(innerDone.x).toBe(nodeAt(nested, 'inner').x);
    expect(innerDone.y).toBe(nodeAt(nested, 'b_more').y + NODE.height + JOIN_DROP);
    const allDone = nodeAt(nested, 'all_done');
    expect(allDone.x).toBe(nodeAt(nested, 'outer').x);
    expect(allDone.y).toBe(innerDone.y + NODE.height + JOIN_DROP);
    // The whole inner side lies left of the outer condition's other branch.
    expect(nodeAt(nested, 'b').x + NODE.width).toBeLessThanOrEqual(nodeAt(nested, 'plain').x);
  });

  it('waits for a reply with one branch longer than the other', () => {
    const waiting = canvasGraph(
      draftOf('ask', {
        ask: { type: 'sms.send', config: { message: 'Still interested?' }, next: 'reply' },
        reply: {
          type: 'wait.event',
          config: { event: 'message.received', timeout: 'P2D' },
          next: { received: 'thank', timed_out: 'nudge' },
        },
        thank: { type: 'sms.send', config: { message: 'Thanks!' }, next: 'close' },
        nudge: { type: 'sms.send', config: { message: 'Just checking.' }, next: 'pause' },
        pause: wait('last'),
        last: { type: 'sms.send', config: { message: 'Last one.' }, next: 'close' },
        close: wait(),
      }),
    );
    expect(faults(waiting)).toEqual([]);
    const close = nodeAt(waiting, 'close');
    expect(close.y).toBe(nodeAt(waiting, 'last').y + NODE.height + JOIN_DROP);
    // The short branch's line runs down its own column, beside the long branch's cards.
    const short = edgeOf(waiting, 'thank');
    expect(short.points[1]).toEqual({
      x: nodeAt(waiting, 'thank').x + NODE.width / 2,
      y: close.y - LANE_RISE,
    });
  });

  it('reaches a goal from several places, some of them deep inside other branches', () => {
    const goal = canvasGraph(
      draftOf('first', {
        first: condition('second', 'slow'),
        second: condition('quick', 'other'),
        quick: wait('booked'),
        other: wait('other_more'),
        other_more: wait(),
        slow: wait('slow_more'),
        slow_more: wait('booked'),
        booked: {
          type: 'goal',
          config: { events: [{ type: 'appointment.booked' }], otherwise: 'continue' },
          next: 'after',
        },
        after: wait(),
      }),
    );
    expect(faults(goal)).toEqual([]);
    const booked = nodeAt(goal, 'booked');
    expect(booked.x).toBe(nodeAt(goal, 'first').x);
    expect(booked.y).toBeGreaterThan(nodeAt(goal, 'other_more').y + NODE.height);
    expect(
      goal.edges.filter((edge) => edge.to.kind === 'step' && edge.to.id === 'booked'),
    ).toHaveLength(2);
  });

  it('keeps a join clear of a path that passes it on the way to a lower join', () => {
    // The middle branch goes on to the last step; the outer two join first, right under it.
    const passing = canvasGraph(
      draftOf('three', {
        three: {
          type: 'split',
          config: {
            variants: [
              { name: 'a', percent: 34 },
              { name: 'b', percent: 33 },
              { name: 'c', percent: 33 },
            ],
          },
          next: { a: 'left', b: 'middle', c: 'right' },
        },
        left: wait('sides'),
        right: wait('sides'),
        middle: wait('end'),
        sides: wait('end'),
        end: wait(),
      }),
    );
    expect(faults(passing)).toEqual([]);
    expect(nodeAt(passing, 'sides').x).toBeGreaterThan(
      nodeAt(passing, 'middle').x + NODE.width / 2,
    );
    expect(nodeAt(passing, 'end').y).toBeGreaterThan(nodeAt(passing, 'sides').y + NODE.height);
  });

  it('sets two joins side by side on lanes of their own', () => {
    const pairs = canvasGraph(
      draftOf('four', {
        four: {
          type: 'split',
          config: {
            variants: ['a', 'b', 'c', 'd'].map((name) => ({ name, percent: 25 })),
          },
          next: { a: 'a1', b: 'b1', c: 'c1', d: 'd1' },
        },
        a1: wait('ab'),
        b1: wait('ab'),
        c1: wait('cd'),
        d1: wait('cd'),
        ab: wait(),
        cd: wait(),
      }),
    );
    expect(faults(pairs)).toEqual([]);
    expect(nodeAt(pairs, 'ab').y).toBe(nodeAt(pairs, 'cd').y);
    expect(nodeAt(pairs, 'ab').x).toBe((nodeAt(pairs, 'a1').x + nodeAt(pairs, 'b1').x) / 2);
  });

  it('draws a loop as a broken line round the side, clear of every card beside it', () => {
    const looping = canvasGraph(
      draftOf('ask', {
        ask: condition('nudge', 'stop'),
        nudge: wait('again'),
        again: wait('ask'),
        stop: wait(),
      }),
    );
    const back = edgeOf(looping, 'again');
    expect(back.back).toBe(true);
    expect(faults(looping).filter((fault) => fault.includes('crosses'))).toEqual([]);
    const side = Math.max(...back.points.map((point) => point.x));
    expect(side).toBeGreaterThan(nodeAt(looping, 'stop').x + NODE.width);
  });

  it('draws steps nothing leads to, and what they lead to, without throwing', () => {
    const stray = canvasGraph(
      draftOf('one', {
        one: wait('two'),
        two: wait(),
        lost: condition('two', 'lost_more'),
        lost_more: wait(),
      }),
    );
    expect(stray.nodes.map((node) => [node.step.id, node.connected])).toEqual([
      ['one', true],
      ['two', true],
      ['lost', false],
      ['lost_more', false],
    ]);
    expect(nodeAt(stray, 'lost').x).toBeGreaterThan(nodeAt(stray, 'one').x + NODE.width);
    expect(stray.edges).toHaveLength(5);
  });
});

// A small generator of workflows, the same each run: every step leads only to later steps,
// to an end, or (a condition) to two of them, so branches join in every way they can.
function scrambled(seed: number, count: number): Draft {
  let state = seed;
  const random = (below: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % below;
  };
  const steps: Record<string, unknown> = {};
  const later = (index: number): string | undefined => {
    const reach = Math.min(count - 1 - index, 4);
    return reach <= 0 || random(6) === 0 ? undefined : `s${String(index + 1 + random(reach))}`;
  };
  for (let index = 0; index < count; index += 1)
    steps[`s${String(index)}`] =
      random(3) === 0 ? condition(later(index), later(index)) : wait(later(index));
  // Only what a contact can reach: steps nothing leads to are drawn apart, by other rules.
  const reached = new Set<string>();
  const waiting = ['s0'];
  for (let id = waiting.pop(); id !== undefined; id = waiting.pop()) {
    if (reached.has(id)) continue;
    reached.add(id);
    const next = (steps[id] as { next?: string | Record<string, string> }).next;
    waiting.push(...(typeof next === 'string' ? [next] : Object.values(next ?? {})));
  }
  return draftOf('s0', Object.fromEntries(Object.entries(steps).filter(([id]) => reached.has(id))));
}

describe('any workflow, laid out automatically', () => {
  it('never puts a card on a card, a line through a card, or a line along another', () => {
    const broken: string[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const found = faults(canvasGraph(scrambled(seed, 6 + (seed % 14))));
      if (found.length > 0) broken.push(`${String(seed)}: ${found.slice(0, 3).join('; ')}`);
    }
    expect(broken).toEqual([]);
  });
});

describe('a drawing arranged by hand', () => {
  it('keeps a moved step where it was put and still joins its paths by a lane above the join', () => {
    const before = canvasGraph(threeDeals);
    const joinAt = nodeAt(before, 'thanks');
    // Drawing positions and the document's differ by the drawing's origin.
    const moved = moveStep(threeDeals, 'thanks', {
      x: joinAt.x + before.origin.x + 500,
      y: joinAt.y + before.origin.y,
    });
    const graph = canvasGraph(moved);
    expect(nodeAt(graph, 'thanks').x - nodeAt(graph, 'which_service').x).toBe(500);
    expect(faults(graph)).toEqual([]);
    const lane = nodeAt(graph, 'thanks').y - LANE_RISE;
    for (const from of ['deal_photo', 'deal_video', 'deal_other'])
      expect(edgeOf(graph, from).points[1]?.y).toBe(lane);
  });

  it('takes a line round a card moved into its way', () => {
    const before = canvasGraph(threeDeals);
    const photo = nodeAt(before, 'deal_photo');
    // The last step, put right under the first branch, in the way of its line down.
    const moved = moveStep(threeDeals, 'later', {
      x: photo.x + before.origin.x,
      y: photo.y + before.origin.y + 120,
    });
    const graph = canvasGraph(moved);
    expect(faults(graph).filter((fault) => fault.includes('crosses'))).toEqual([]);
    expect(edgeOf(graph, 'deal_photo').points.length).toBeGreaterThan(4);
  });

  it('sets apart two lanes that would lie on each other', () => {
    const crossed = draftOf('ask', {
      ask: condition('a', 'b'),
      a: condition('x', 'y'),
      b: condition('x', 'y'),
      x: wait(),
      y: wait(),
    });
    const laid = canvasGraph(crossed);
    // Both joins put on one row by hand, each fed from both sides.
    const row = nodeAt(laid, 'a').y + laid.origin.y + 400;
    const moved = moveStep(
      moveStep(crossed, 'x', { x: nodeAt(laid, 'a').x + laid.origin.x, y: row }),
      'y',
      { x: nodeAt(laid, 'b').x + laid.origin.x, y: row },
    );
    const graph = canvasGraph(moved);
    expect(nodeAt(graph, 'x').y).toBe(nodeAt(graph, 'y').y);
    const lanes = ['x', 'y'].map(
      (id) => graph.edges.find((edge) => targetOf(edge) === id)?.points.at(-2)?.y,
    );
    expect(lanes[0]).not.toBe(lanes[1]);
    expect(graph.edges.filter((edge) => edge.back)).toEqual([]);
  });
});
