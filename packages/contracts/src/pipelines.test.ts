import { describe, expect, it } from 'vitest';
import { toPublicId } from '@repo/kernel';

import { savePipelinesInput } from './pipelines.js';

const id = toPublicId('pipeline', '01890a5d-ac96-774b-bcce-b302099a8057');
const stageId = toPublicId('stage', '01890a5d-ac96-774b-bcce-b302099a8057');
const pipeline = { name: ' Sales ', description: '', archived: false, stages: [] };
const revision = 'a'.repeat(64);
describe('pipeline configuration validation', () => {
  it('trims names and permits new IDs to be omitted', () => {
    expect(savePipelinesInput.parse({ revision, items: [pipeline] }).items[0]?.name).toBe('Sales');
  });
  it('rejects duplicate pipeline and stage IDs, including across pipelines', () => {
    const stage = { id: stageId, name: 'New', description: '', archived: false };
    expect(
      savePipelinesInput.safeParse({
        revision,
        items: [
          { ...pipeline, id },
          { ...pipeline, id },
        ],
      }).success,
    ).toBe(false);
    expect(
      savePipelinesInput.safeParse({ revision, items: [{ ...pipeline, stages: [stage, stage] }] })
        .success,
    ).toBe(false);
    expect(
      savePipelinesInput.safeParse({
        revision,
        items: [
          { ...pipeline, stages: [stage] },
          { ...pipeline, stages: [stage] },
        ],
      }).success,
    ).toBe(false);
  });
  it.each([
    { revision: 'old', items: [] },
    { revision, items: [{ ...pipeline, name: ' ' }] },
    { revision, items: [{ ...pipeline, description: 'x'.repeat(2001) }] },
    { revision, items: [{ ...pipeline, id: stageId }] },
    { revision, items: Array.from({ length: 101 }, () => pipeline) },
    {
      revision,
      items: [
        {
          ...pipeline,
          stages: Array.from({ length: 101 }, () => ({
            name: 'New',
            description: '',
            archived: false,
          })),
        },
      ],
    },
    { revision, items: [], extra: 'ignored' },
  ])('rejects invalid or unbounded configuration %#', (input) => {
    expect(savePipelinesInput.safeParse(input).success).toBe(false);
  });
});
