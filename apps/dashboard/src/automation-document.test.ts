import {
  AUTOMATION_EXPORT_FORMAT,
  automation,
  automationCatalogResponse,
  automationDocument,
  automationDraftSaved,
  automationList,
  validateAutomation,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  automationOf,
  catalogOf,
  followUp,
  harborSetup,
  stamp,
  summaryOf,
  versionId,
  welcome,
} from '../e2e/automation-fixtures';
import {
  addStep,
  EXPORT_FORMAT,
  addTrigger,
  branchNamesOf,
  canRemoveTrigger,
  formatDraft,
  newStepId,
  outlineOf,
  reachableSteps,
  readDraft,
  readImport,
  removalEffect,
  removeStep,
  removeTrigger,
  renameAutomation,
  sameJson,
  startOf,
  stepOf,
  stepsOf,
  stopsOf,
  subjectOf,
  triggersOf,
  updateStepConfig,
  updateTriggerConfig,
  type Draft,
  type OutlineItem,
  type OutlinePath,
} from './automation-document';

/** A path as text: each step's id, its branches in brackets, and how the path ends. */
function sketch(path: OutlinePath): string {
  const item = (each: OutlineItem): string => {
    if (each.kind === 'end') return 'END';
    if (each.kind !== 'step') return `${each.kind}:${each.to}`;
    return each.branches.length === 0
      ? each.step.id
      : `${each.step.id}{${each.branches.map((branch) => `${branch.name}: ${sketch(branch)}`).join(' | ')}}`;
  };
  return path.items.map(item).join(' > ');
}

const shapeOf = (draft: Draft): boolean => automationDocument.safeParse(draft).success;

const steps = (chain: Record<string, unknown>): Draft => ({
  name: 'Test',
  triggers: [{ id: 'made', type: 'contact.created', config: {} }],
  start: Object.keys(chain)[0],
  steps: chain,
});
const wait = (next?: string): Record<string, unknown> => ({
  type: 'wait',
  config: { duration: 'P1D' },
  ...(next === undefined ? {} : { next }),
});

describe('the fixtures', () => {
  it('are valid automations for the business they are written for', () => {
    expect(validateAutomation(followUp, harborSetup).errors).toEqual([]);
    expect(validateAutomation(welcome, harborSetup).errors).toEqual([]);
  });

  // The end-to-end tests answer for the API with these, and the client checks each answer
  // against its contract: an answer the contract refuses would fail there as a load error.
  it('answer as the API contract says the API answers', () => {
    const one = automationOf();
    expect(automation.safeParse(one).error).toBeUndefined();
    expect(
      automationList.safeParse({ items: [summaryOf(one)], nextCursor: null, canManage: true })
        .error,
    ).toBeUndefined();
    expect(automationCatalogResponse.safeParse(catalogOf()).error).toBeUndefined();
    expect(
      automationDraftSaved.safeParse({
        automation: one,
        validation: { valid: true, errors: [], warnings: [] },
      }).error,
    ).toBeUndefined();
    expect(
      automation.safeParse(
        automationOf({
          status: 'active',
          liveVersion: 1,
          live: {
            id: versionId,
            version: 1,
            changeSummary: '',
            publishedAt: stamp,
            document: { ...followUp },
          },
        }),
      ).error,
    ).toBeUndefined();
  });
});

describe('reading a draft', () => {
  it('reads what is there', () => {
    expect(stepsOf(followUp).map((step) => step.id)).toEqual(Object.keys(followUp.steps));
    expect(stepOf(followUp, 'asked_about_video')?.next).toEqual({
      yes: 'send_reel',
      no: 'check_in',
    });
    expect(triggersOf(followUp)).toEqual([
      {
        index: 0,
        id: 'quote_form',
        type: 'form.submitted',
        config: { form: 'Request a quote' },
        condition: undefined,
      },
    ]);
    expect(stopsOf(followUp).map((stop) => [stop.event, stop.from])).toEqual([
      ['message.received', 'contact'],
      ['appointment.booked', undefined],
      ['deal.closed', undefined],
    ]);
  });

  it.each([
    [{}],
    [{ steps: [], triggers: {}, stopWhen: 'x', start: 4 }],
    [{ steps: { a: null, b: 'text', c: { next: 7, config: [] } }, triggers: [null, 3], start: '' }],
  ])('makes do with an unfinished draft: %j', (draft) => {
    expect(() => {
      outlineOf(draft);
      stepsOf(draft);
      triggersOf(draft);
      stopsOf(draft);
      reachableSteps(draft);
    }).not.toThrow();
    expect(outlineOf(draft).main.items).toEqual([{ kind: 'end' }]);
  });
});

describe('outlineOf', () => {
  it('lists the steps in the order a contact meets them, with each branch under its step', () => {
    const outline = outlineOf(followUp);
    expect(sketch(outline.main)).toBe(
      'send_guide > wait_2_days > asked_about_video{yes: send_reel > END | no: check_in > wait_3_days > last_check_in > END}',
    );
    expect(outline.detached).toEqual([]);
  });

  it('says a path goes back to an earlier step, and stops there', () => {
    const loop = steps({ a: wait('b'), b: wait('c'), c: wait('a') });
    expect(sketch(outlineOf(loop).main)).toBe('a > b > c > back:a');
  });

  it('stops at a step that leads to itself', () => {
    expect(sketch(outlineOf(steps({ a: wait('a') })).main)).toBe('a > back:a');
  });

  it('says a loop inside a branch goes back, however far up the step is', () => {
    const draft = steps({
      a: wait('check'),
      check: {
        type: 'condition',
        config: { if: { field: 'contact.email', operator: 'is_set' } },
        next: { yes: 'done', no: 'a' },
      },
      done: wait(),
    });
    expect(sketch(outlineOf(draft).main)).toBe('a > check{yes: done > END | no: back:a}');
  });

  it('lists a step two branches share once, and says where the second carries on', () => {
    const draft = steps({
      check: {
        type: 'condition',
        config: { if: { field: 'contact.email', operator: 'is_set' } },
        next: { yes: 'a', no: 'b' },
      },
      a: wait('shared'),
      b: wait('shared'),
      shared: wait(),
    });
    expect(sketch(outlineOf(draft).main)).toBe(
      'check{yes: a > shared > END | no: b > join:shared}',
    );
  });

  it('shows a link to a step that is not there', () => {
    expect(sketch(outlineOf(steps({ a: wait('gone') })).main)).toBe('a > missing:gone');
  });

  it('lists steps nothing leads to apart, so none is hidden', () => {
    const draft = steps({ a: wait(), orphan: wait('tail'), tail: wait() });
    const outline = outlineOf(draft);
    expect(sketch(outline.main)).toBe('a > END');
    expect(outline.detached.map(sketch)).toEqual(['orphan > tail > END']);
  });

  it('gives each branch a place to add its first step', () => {
    const [, , check] = outlineOf(followUp).main.items;
    if (check?.kind !== 'step') throw new Error('The third step branches.');
    expect(check.branches.map((branch) => branch.at)).toEqual([
      { kind: 'after', step: 'asked_about_video', branch: 'yes' },
      { kind: 'after', step: 'asked_about_video', branch: 'no' },
    ]);
  });
});

describe('branchNamesOf', () => {
  const split = {
    id: 's',
    type: 'split',
    label: undefined,
    config: {
      variants: [
        { name: 'a', percent: 50 },
        { name: 'b', percent: 50 },
      ],
    },
  };

  it("takes an A/B split's branches from its variants", () => {
    expect(branchNamesOf({ ...split, next: { a: 'x' } })).toEqual(['a', 'b']);
  });

  it('keeps a branch the type does not have in sight', () => {
    expect(branchNamesOf({ ...split, next: { a: 'x', stray: 'y' } })).toEqual(['a', 'b', 'stray']);
  });

  it('has none for a step that just leads on', () => {
    expect(branchNamesOf({ ...split, type: 'wait', next: 'x' })).toBeUndefined();
  });
});

describe('the export format', () => {
  it('is the one the contract names', () => {
    expect(EXPORT_FORMAT).toBe(AUTOMATION_EXPORT_FORMAT);
  });
});

describe('addStep', () => {
  const tag = { id: 'tag_add', type: 'tag.add', config: { tag: 'VIP' } };

  it('puts a step between two others', () => {
    const edited = addStep(followUp, { kind: 'after', step: 'send_guide' }, tag);
    expect(stepOf(edited, 'send_guide')?.next).toBe('tag_add');
    expect(stepOf(edited, 'tag_add')?.next).toBe('wait_2_days');
    expect(Object.keys(edited['steps'] as object).slice(0, 3)).toEqual([
      'send_guide',
      'tag_add',
      'wait_2_days',
    ]);
    expect(shapeOf(edited)).toBe(true);
    expect(followUp.steps.send_guide.next).toBe('wait_2_days');
  });

  it('adds a step at the end of a path', () => {
    const edited = addStep(followUp, { kind: 'after', step: 'last_check_in' }, tag);
    expect(stepOf(edited, 'last_check_in')?.next).toBe('tag_add');
    expect(stepOf(edited, 'tag_add')?.next).toBeUndefined();
    expect(shapeOf(edited)).toBe(true);
  });

  it('adds a step at the top of a branch, ahead of what was there', () => {
    const edited = addStep(
      followUp,
      { kind: 'after', step: 'asked_about_video', branch: 'no' },
      tag,
    );
    expect(stepOf(edited, 'asked_about_video')?.next).toEqual({ yes: 'send_reel', no: 'tag_add' });
    expect(stepOf(edited, 'tag_add')?.next).toBe('check_in');
    expect(shapeOf(edited)).toBe(true);
  });

  it('adds a step before one that several paths lead to, for all of them', () => {
    const joined: Draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        send_reel: { ...followUp.steps.send_reel, next: 'last_check_in' },
      },
    };
    const edited = addStep(joined, { kind: 'before', step: 'last_check_in' }, tag);
    expect(stepOf(edited, 'send_reel')?.next).toBe('tag_add');
    expect(stepOf(edited, 'wait_3_days')?.next).toBe('tag_add');
    expect(stepOf(edited, 'tag_add')?.next).toBe('last_check_in');
    // Listed just ahead of the step it comes before.
    const keys = Object.keys(edited['steps'] as object);
    expect(keys.indexOf('tag_add')).toBe(keys.indexOf('last_check_in') - 1);
    expect(shapeOf(edited)).toBe(true);
    // A branch that led there is turned too; the other branch is left alone.
    const branch = addStep(followUp, { kind: 'before', step: 'check_in' }, tag);
    expect(stepOf(branch, 'asked_about_video')?.next).toEqual({ yes: 'send_reel', no: 'tag_add' });
    // In front of the first step it becomes the start; a step that is not there changes nothing.
    expect(startOf(addStep(followUp, { kind: 'before', step: 'send_guide' }, tag))).toBe('tag_add');
    expect(addStep(followUp, { kind: 'before', step: 'nobody' }, tag)).toBe(followUp);
  });

  it('adds a new first step', () => {
    const edited = addStep(followUp, { kind: 'start' }, tag);
    expect(startOf(edited)).toBe('tag_add');
    expect(stepOf(edited, 'tag_add')?.next).toBe('send_guide');
    expect(shapeOf(edited)).toBe(true);
  });

  it('starts an automation that has no steps yet', () => {
    const empty: Draft = { name: 'New', triggers: followUp.triggers, steps: {} };
    const edited = addStep(empty, { kind: 'start' }, tag);
    expect(edited['start']).toBe('tag_add');
    expect(shapeOf(edited)).toBe(true);
  });

  it('hangs what came next on the first branch of a step that branches', () => {
    const edited = addStep(
      followUp,
      { kind: 'after', step: 'send_guide' },
      {
        id: 'replied',
        type: 'wait.event',
        config: { event: 'message.received', timeout: 'P1D' },
      },
    );
    expect(stepOf(edited, 'replied')?.next).toEqual({ received: 'wait_2_days' });
    expect(reachableSteps(edited).size).toBe(Object.keys(followUp.steps).length + 1);
    expect(shapeOf(edited)).toBe(true);
  });

  it('leaves the document alone when the id is taken or the step to follow is gone', () => {
    expect(addStep(followUp, { kind: 'start' }, { ...tag, id: 'send_guide' })).toBe(followUp);
    expect(addStep(followUp, { kind: 'after', step: 'nowhere' }, tag)).toBe(followUp);
  });

  it('names a new step after its type, without reusing an id', () => {
    expect(newStepId(followUp, 'sms.send')).toBe('sms_send');
    const once = addStep(
      followUp,
      { kind: 'start' },
      { ...tag, id: newStepId(followUp, 'tag.add') },
    );
    expect(newStepId(once, 'tag.add')).toBe('tag_add_2');
    expect(newStepId(followUp, '9 Odd!')).toBe('odd');
    expect(newStepId(followUp, '!!')).toBe('step');
  });
});

describe('removeStep', () => {
  it('joins the step before to the step after', () => {
    const edited = removeStep(followUp, 'wait_2_days');
    expect(stepOf(edited, 'wait_2_days')).toBeUndefined();
    expect(stepOf(edited, 'send_guide')?.next).toBe('asked_about_video');
    expect(reachableSteps(edited).size).toBe(Object.keys(followUp.steps).length - 1);
    expect(shapeOf(edited)).toBe(true);
    expect(followUp.steps.send_guide.next).toBe('wait_2_days');
  });

  it('moves the start on when the first step goes', () => {
    const edited = removeStep(followUp, 'send_guide');
    expect(startOf(edited)).toBe('wait_2_days');
    expect(shapeOf(edited)).toBe(true);
  });

  it('ends the path when the last step goes', () => {
    const edited = removeStep(followUp, 'last_check_in');
    expect(stepOf(edited, 'wait_3_days')?.next).toBeUndefined();
    expect('next' in ((edited['steps'] as Record<string, object>)['wait_3_days'] ?? {})).toBe(
      false,
    );
    expect(shapeOf(edited)).toBe(true);
  });

  it('joins a branch to what came after the step it led to', () => {
    const edited = removeStep(followUp, 'check_in');
    expect(stepOf(edited, 'asked_about_video')?.next).toEqual({
      yes: 'send_reel',
      no: 'wait_3_days',
    });
    expect(shapeOf(edited)).toBe(true);
  });

  it('drops a branch that led only to the step', () => {
    const edited = removeStep(followUp, 'send_reel');
    expect(stepOf(edited, 'asked_about_video')?.next).toEqual({ no: 'check_in' });
    expect(shapeOf(edited)).toBe(true);
  });

  it('replaces a step that branches with its first branch, and says what that cuts off', () => {
    expect(removalEffect(followUp, 'asked_about_video')).toEqual({
      joinsTo: 'send_reel',
      cutOff: ['check_in', 'wait_3_days', 'last_check_in'],
    });
    const edited = removeStep(followUp, 'asked_about_video');
    expect(stepOf(edited, 'wait_2_days')?.next).toBe('send_reel');
    expect(outlineOf(edited).detached.map(sketch)).toEqual([
      'check_in > wait_3_days > last_check_in > END',
    ]);
    expect(shapeOf(edited)).toBe(true);
  });

  it('cuts nothing off when a plain step goes', () => {
    expect(removalEffect(followUp, 'wait_2_days')).toEqual({
      joinsTo: 'asked_about_video',
      cutOff: [],
    });
  });

  it('keeps a loop a loop', () => {
    const loop = steps({ a: wait('b'), b: wait('a') });
    expect(stepOf(removeStep(loop, 'b'), 'a')?.next).toBe('a');
  });

  it("forgets the step's place on the canvas", () => {
    const placed = {
      ...followUp,
      layout: { send_guide: { x: 0, y: 0 }, wait_2_days: { x: 1, y: 1 } },
    };
    expect(removeStep(placed, 'wait_2_days')['layout']).toEqual({ send_guide: { x: 0, y: 0 } });
  });

  it('leaves no start when the only step goes, which the checks then report', () => {
    const edited = removeStep(welcome, 'add_tag');
    expect('start' in edited).toBe(false);
    expect(edited['steps']).toEqual({});
  });

  it('leaves the document alone for a step it does not have', () => {
    expect(removeStep(followUp, 'nowhere')).toBe(followUp);
  });
});

describe('other edits', () => {
  it('renames the automation', () => {
    const edited = renameAutomation(followUp, 'Quote follow-up');
    expect(edited['name']).toBe('Quote follow-up');
    expect(followUp.name).toBe('New lead follow-up');
    expect(shapeOf(edited)).toBe(true);
  });

  it('adds a trigger with an id of its own', () => {
    const once = addTrigger(followUp, { type: 'contact.created', config: {} });
    const twice = addTrigger(once, { type: 'contact.created', config: {} });
    expect(triggersOf(twice).map((trigger) => trigger.id)).toEqual([
      'quote_form',
      'contact_created',
      'contact_created_2',
    ]);
    expect(shapeOf(twice)).toBe(true);
  });

  it('removes a trigger, but never the last one', () => {
    const two = addTrigger(followUp, { type: 'contact.created', config: {} });
    const one = removeTrigger(two, 0);
    expect(triggersOf(one).map((trigger) => trigger.id)).toEqual(['contact_created']);
    expect(shapeOf(one)).toBe(true);
    expect(canRemoveTrigger(one)).toBe(false);
    expect(removeTrigger(one, 0)).toBe(one);
  });

  it("changes a trigger's settings", () => {
    const edited = updateTriggerConfig(followUp, 0, { form: 'frm_quote' });
    expect(triggersOf(edited)[0]).toMatchObject({
      id: 'quote_form',
      config: { form: 'frm_quote' },
    });
    expect(shapeOf(edited)).toBe(true);
  });

  it("changes a step's settings and nothing else about it", () => {
    const edited = updateStepConfig(followUp, 'wait_2_days', { duration: 'P5D' });
    expect(stepOf(edited, 'wait_2_days')).toMatchObject({
      config: { duration: 'P5D' },
      next: 'asked_about_video',
    });
    expect(shapeOf(edited)).toBe(true);
  });

  it("keeps each variant's path when a variant is renamed, and drops a removed one's", () => {
    const variants = (...names: string[]): Record<string, unknown> => ({
      variants: names.map((name) => ({ name, percent: 30 })),
    });
    const draft = steps({
      split: { type: 'split', config: variants('a', 'b', 'c'), next: { a: 'x', b: 'y', c: 'z' } },
      x: wait(),
      y: wait(),
      z: wait(),
    });
    const renamed = updateStepConfig(draft, 'split', variants('a', 'better', 'c'));
    expect(stepOf(renamed, 'split')?.next).toEqual({ a: 'x', better: 'y', c: 'z' });
    const fewer = updateStepConfig(draft, 'split', variants('a', 'c'));
    expect(stepOf(fewer, 'split')?.next).toEqual({ a: 'x', c: 'z' });
  });
});

describe("an If / else's branches and where they lead", () => {
  const hasEmail = { field: 'contact.email', operator: 'is_set' };
  const branches = (...names: string[]): Record<string, unknown> => ({
    branches: names.map((name) => ({ name, if: hasEmail })),
  });
  const draft = steps({
    check: {
      type: 'condition',
      config: branches('hot', 'warm'),
      next: { hot: 'x', warm: 'y', none: 'z' },
    },
    x: wait(),
    y: wait(),
    z: wait(),
  });

  it('keeps each path with its branch when they are put in another order', () => {
    const reordered = updateStepConfig(draft, 'check', branches('warm', 'hot'));
    expect(stepOf(reordered, 'check')?.next).toEqual({ warm: 'y', hot: 'x', none: 'z' });
  });

  it("drops a deleted branch's path, and gives a new one none, without touching None's", () => {
    const fewer = updateStepConfig(draft, 'check', branches('warm'));
    expect(stepOf(fewer, 'check')?.next).toEqual({ warm: 'y', none: 'z' });
    const swapped = updateStepConfig(draft, 'check', branches('warm', 'new'));
    expect(stepOf(swapped, 'check')?.next).toEqual({ warm: 'y', none: 'z' });
    const more = updateStepConfig(draft, 'check', branches('hot', 'warm', 'new'));
    expect(stepOf(more, 'check')?.next).toEqual({ hot: 'x', warm: 'y', none: 'z' });
  });

  it('moves yes and no to yes and none when a condition is given branches of its own', () => {
    const twoWay = steps({
      check: { type: 'condition', config: { if: hasEmail }, next: { yes: 'x', no: 'y' } },
      x: wait(),
      y: wait(),
    });
    const named = updateStepConfig(twoWay, 'check', branches('yes'));
    expect(stepOf(named, 'check')?.next).toEqual({ yes: 'x', none: 'y' });
    // And when more branches were added before it was saved.
    const more = updateStepConfig(twoWay, 'check', branches('yes', 'other', 'third'));
    expect(stepOf(more, 'check')?.next).toEqual({ yes: 'x', none: 'y' });
    expect(
      branchNamesOf({
        id: 'check',
        type: 'condition',
        config: branches('yes'),
        label: undefined,
        next: undefined,
      }),
    ).toEqual(['yes', 'none']);
  });
});

describe('the two views share one document', () => {
  it('turns a document into text and back without losing anything', () => {
    const text = formatDraft(followUp);
    const read = readDraft(text);
    expect(read.ok && read.draft).toEqual(followUp);
    expect(read.ok && formatDraft(read.draft)).toBe(text);
    expect(read.ok && Object.keys(read.draft)).toEqual(Object.keys(followUp));
  });

  it('shows in JSON what an edit in the Steps view made', () => {
    const edited = addStep(
      followUp,
      { kind: 'after', step: 'send_guide' },
      { id: 'tag_add', type: 'tag.add', config: { tag: 'VIP' } },
    );
    const text = formatDraft(edited);
    expect(text).toContain('"tag_add": {\n      "type": "tag.add"');
    const read = readDraft(text);
    expect(read.ok && read.draft).toEqual(edited);
  });

  it('shows in the Steps view what an edit to the JSON made', () => {
    const text = formatDraft(followUp).replace('"next": "wait_2_days"', '"next": "last_check_in"');
    const read = readDraft(text);
    if (!read.ok) throw new Error('The text is valid.');
    const outline = outlineOf(read.draft);
    const ids = outline.main.items.flatMap((item) => (item.kind === 'step' ? [item.step.id] : []));
    expect(ids).toEqual(['send_guide', 'last_check_in']);
    expect(outline.detached.length).toBeGreaterThan(0);
  });

  it('says what is wrong with text that is not a document', () => {
    expect(readDraft('[1, 2]')).toEqual({ ok: false, problem: 'not_an_object' });
    const broken = readDraft('{"name": }');
    expect(!broken.ok && broken.problem).toMatchObject({ kind: 'unexpected', line: 1, column: 10 });
  });

  it('imports a document, or the document inside an export', () => {
    const exported = JSON.stringify({
      format: 'crm.automation',
      formatVersion: 1,
      exportedAt: '2026-10-09T09:00:00Z',
      document: welcome,
      warnings: [],
    });
    const fromExport = readImport(exported);
    expect(fromExport.ok && fromExport.draft).toEqual(welcome);
    const plain = readImport(JSON.stringify(welcome));
    expect(plain.ok && plain.draft).toEqual(welcome);
  });

  it('compares documents whatever order their members are in', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: null }, { a: {} })).toBe(false);
  });
});

describe('subjectOf', () => {
  it('says which step or trigger an issue is about', () => {
    expect(subjectOf('/steps/check_in/config/message')).toEqual({ kind: 'step', id: 'check_in' });
    expect(subjectOf('/triggers/1/config/form')).toEqual({ kind: 'trigger', index: 1 });
    expect(subjectOf('/start')).toEqual({ kind: 'automation' });
    expect(subjectOf('/steps')).toEqual({ kind: 'automation' });
  });
});
