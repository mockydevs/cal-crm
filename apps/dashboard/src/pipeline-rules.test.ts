import { savePipelinesInput, type Pipeline, type PipelineConfiguration } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  copyOf,
  draftInput,
  draftOf,
  isReady,
  matching,
  moved,
  newDraft,
  newStage,
  probabilityIsValid,
  probabilityTyped,
  sameDraft,
  toInput,
  withArchived,
  withMoved,
} from './pipeline-rules';

const sales: Pipeline = {
  id: 'pipe_01h455vb4pex5vsknk084sn02q',
  name: 'Sales',
  description: '',
  archived: false,
  dealProbability: true,
  colorStyle: 'dot',
  showInFunnel: false,
  showInPie: true,
  stages: [
    {
      id: 'stage_01h455vb4pex5vsknk084sn02q',
      name: 'New',
      description: '',
      archived: false,
      probability: 25,
      color: '#12b76a',
      showInFunnel: true,
      showInPie: false,
    },
    {
      id: 'stage_01h455vb4pex5vsknk084sn02r',
      name: 'Won',
      description: 'Paid',
      archived: false,
      probability: null,
      color: null,
      showInFunnel: true,
      showInPie: true,
    },
  ],
};
const events: Pipeline = {
  id: 'pipe_01h455vb4pex5vsknk084sn02r',
  name: 'Events',
  description: 'Weddings',
  archived: true,
  dealProbability: true,
  colorStyle: 'tint',
  stages: [
    {
      id: 'stage_01h455vb4pex5vsknk084sn02s',
      name: 'Enquiry',
      description: '',
      archived: false,
      probability: 10,
      color: '#f79009',
      showInFunnel: false,
      showInPie: false,
    },
  ],
};
const firstStages = ['New Lead', 'Contacted', 'Proposal Sent', 'Closed'];
const configuration: PipelineConfiguration = {
  revision: 'a'.repeat(64),
  canManage: true,
  items: [sales, events],
};

describe('a pipeline being edited', () => {
  it('starts a new pipeline with four named stages and nothing saved', () => {
    const draft = newDraft(firstStages);
    expect(draft.id).toBeUndefined();
    expect(draft.stages.map((stage) => stage.name)).toEqual([
      'New Lead',
      'Contacted',
      'Proposal Sent',
      'Closed',
    ]);
    expect(draft.stages.every((stage) => stage.id === undefined)).toBe(true);
    expect(new Set(draft.stages.map((stage) => stage.key)).size).toBe(4);
  });

  it('starts a new pipeline as the server would: stage probabilities, no colours, in both charts', () => {
    const draft = newDraft(firstStages);
    expect(draft.dealProbability).toBe(false);
    expect(draft.colorStyle).toBe('none');
    expect(draft.stages.map((stage) => stage.probability)).toEqual(['20', '40', '60', '80']);
    expect(draft.stages.every((stage) => stage.color === null)).toBe(true);
    expect(draft.stages.every((stage) => stage.showInFunnel && stage.showInPie)).toBe(true);
    // A stage added afterwards has no probability until one is typed.
    expect(newStage()).toMatchObject({
      name: '',
      probability: '',
      color: null,
      showInFunnel: true,
      showInPie: true,
    });
  });

  it('reads what a saved pipeline and its stages are set to', () => {
    const draft = draftOf(sales);
    expect(draft).toMatchObject({ dealProbability: true, colorStyle: 'dot' });
    expect(draft.stages[0]).toMatchObject({
      probability: '25',
      color: '#12b76a',
      showInFunnel: true,
      showInPie: false,
    });
    expect(draft.stages[1]).toMatchObject({ probability: '', color: null });
    // A pipeline answered without the settings reads as the server starts one.
    const bare = draftOf({
      id: sales.id,
      name: 'Sales',
      description: '',
      archived: false,
      stages: [{ id: sales.stages[0]?.id ?? '', name: 'New', description: '', archived: false }],
    });
    expect(bare).toMatchObject({ dealProbability: false, colorStyle: 'none' });
    expect(bare.stages[0]).toMatchObject({
      probability: '',
      color: null,
      showInFunnel: true,
      showInPie: true,
    });
  });

  it('is ready once it and every stage have a name', () => {
    const draft = draftOf(sales);
    expect(isReady(draft)).toBe(true);
    expect(isReady({ ...draft, name: '   ' })).toBe(false);
    expect(
      isReady({
        ...draft,
        stages: draft.stages.map((stage, index) => (index === 1 ? { ...stage, name: '' } : stage)),
      }),
    ).toBe(false);
    expect(isReady({ ...draft, stages: [] })).toBe(true);
  });

  it('is not ready while a probability is more than 100', () => {
    const draft = draftOf(sales);
    const withProbability = (probability: string) => ({
      ...draft,
      stages: draft.stages.map((stage, index) => (index === 0 ? { ...stage, probability } : stage)),
    });
    expect(isReady(withProbability('101'))).toBe(false);
    expect(isReady(withProbability('100'))).toBe(true);
    expect(isReady(withProbability('0'))).toBe(true);
    expect(isReady(withProbability(''))).toBe(true);
  });

  it('keeps only the digits typed into a probability, three at most', () => {
    expect(probabilityTyped('4o5%')).toBe('45');
    expect(probabilityTyped('-12.5')).toBe('125');
    expect(probabilityTyped('10000')).toBe('100');
    expect(probabilityTyped('')).toBe('');
    expect(probabilityIsValid('')).toBe(true);
    expect(probabilityIsValid('100')).toBe(true);
    expect(probabilityIsValid('101')).toBe(false);
    expect(probabilityIsValid('1.5')).toBe(false);
  });

  it('is the same as what it started from until something in it changes', () => {
    const draft = draftOf(sales);
    expect(sameDraft(draft, draftOf(sales))).toBe(true);
    expect(sameDraft({ ...draft, description: 'Leads' }, draft)).toBe(false);
    expect(sameDraft({ ...draft, stages: moved(draft.stages, 0, 1) }, draft)).toBe(false);
    expect(sameDraft({ ...draft, dealProbability: false }, draft)).toBe(false);
    expect(sameDraft({ ...draft, colorStyle: 'tint' }, draft)).toBe(false);
  });

  it('moves an entry to another place, and leaves the list alone when there is none', () => {
    expect(moved(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moved(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 2, 3)).toEqual(['a', 'b', 'c']);
  });
});

describe('what is sent to save', () => {
  it('replaces the edited pipeline in place and keeps every other one', () => {
    const draft = { ...draftOf(sales), name: 'Sales team' };
    const input = draftInput(configuration, draft);
    expect(input.revision).toBe(configuration.revision);
    expect(input.items.map((item) => item.name)).toEqual(['Sales team', 'Events']);
    expect(input.items[0]?.id).toBe(sales.id);
    expect(input.items[0]?.stages.map((stage) => stage.id)).toEqual(
      sales.stages.map((stage) => stage.id),
    );
    expect(() => savePipelinesInput.parse(input)).not.toThrow();
  });

  it('sends every setting of the edited pipeline and of its stages', () => {
    const opened = draftOf(sales);
    const input = draftInput(configuration, {
      ...opened,
      dealProbability: false,
      colorStyle: 'tint',
      stages: opened.stages.map((stage, index) =>
        index === 1
          ? { ...stage, probability: '90', color: '#7a5af8', showInFunnel: false }
          : { ...stage, probability: '' },
      ),
    });
    expect(input.items[0]).toMatchObject({
      dealProbability: false,
      colorStyle: 'tint',
      // The pipeline's own place in the two charts, as it was read.
      showInFunnel: false,
      showInPie: true,
    });
    expect(input.items[0]?.stages).toEqual([
      {
        id: sales.stages[0]?.id,
        name: 'New',
        description: '',
        archived: false,
        probability: null,
        color: '#12b76a',
        showInFunnel: true,
        showInPie: false,
      },
      {
        id: sales.stages[1]?.id,
        name: 'Won',
        description: 'Paid',
        archived: false,
        probability: 90,
        color: '#7a5af8',
        showInFunnel: false,
        showInPie: true,
      },
    ]);
    expect(() => savePipelinesInput.parse(input)).not.toThrow();
    const switched = draftInput(configuration, { ...opened, showInFunnel: true, showInPie: false });
    expect(switched.items[0]).toMatchObject({ showInFunnel: true, showInPie: false });
    // A pipeline read without the two switches is shown in both, as the server starts one.
    const { showInFunnel: _funnel, showInPie: _pie, ...bare } = sales;
    expect(draftOf(bare)).toMatchObject({ showInFunnel: true, showInPie: true });
  });

  it('names no setting of a pipeline the dialog did not open, so the server keeps them', () => {
    const input = draftInput(configuration, { ...draftOf(sales), name: 'Sales team' });
    expect(input.items[1]).toEqual({
      id: events.id,
      name: 'Events',
      description: 'Weddings',
      archived: true,
      stages: [{ id: events.stages[0]?.id, name: 'Enquiry', description: '', archived: false }],
    });
  });

  it('adds a new pipeline last, with no ids for what is not saved yet', () => {
    const draft = { ...newDraft(firstStages), name: 'Bookings' };
    const input = draftInput(configuration, draft);
    expect(input.items).toHaveLength(3);
    expect(input.items[2]).toMatchObject({
      name: 'Bookings',
      archived: false,
      dealProbability: false,
      colorStyle: 'none',
      showInFunnel: true,
      showInPie: true,
    });
    expect(input.items[2]?.id).toBeUndefined();
    expect(input.items[2]?.stages.every((stage) => stage.id === undefined)).toBe(true);
    expect(input.items[2]?.stages[0]).toEqual({
      name: 'New Lead',
      description: '',
      archived: false,
      probability: 20,
      color: null,
      showInFunnel: true,
      showInPie: true,
    });
    expect(() => savePipelinesInput.parse(input)).not.toThrow();
  });

  it('moves a pipeline one place and archives or restores one', () => {
    expect(withMoved(configuration.items, events.id, -1).map((item) => item.name)).toEqual([
      'Events',
      'Sales',
    ]);
    expect(withMoved(configuration.items, events.id, 1)).toEqual(configuration.items);
    expect(withArchived(configuration.items, sales.id, true)[0]?.archived).toBe(true);
    expect(withArchived(configuration.items, events.id, false)[1]?.archived).toBe(false);
  });

  it('sends the list back with no setting named when only its order or an archive changes', () => {
    const input = toInput(withMoved(configuration.items, events.id, -1), configuration.revision);
    expect(input.items.map((item) => item.id)).toEqual([events.id, sales.id]);
    expect(Object.keys(input.items[1] ?? {}).sort()).toEqual([
      'archived',
      'description',
      'id',
      'name',
      'stages',
    ]);
    expect(() => savePipelinesInput.parse(input)).not.toThrow();
  });
});

describe('a duplicated pipeline', () => {
  it('is the one the list has afterwards and did not have before', () => {
    const copy: Pipeline = {
      ...sales,
      id: 'pipe_01h455vb4pex5vsknk084sn02s',
      name: 'Sales (copy)',
    };
    expect(copyOf(configuration.items, [sales, copy, events])).toBe(copy);
    expect(copyOf(configuration.items, configuration.items)).toBeUndefined();
  });
});

describe('searching the list', () => {
  it('keeps each pipeline with its place in the whole list', () => {
    expect(matching(configuration.items, ' ev ')).toEqual([{ pipeline: events, position: 2 }]);
    expect(matching(configuration.items, '').map((row) => row.position)).toEqual([1, 2]);
  });
});
