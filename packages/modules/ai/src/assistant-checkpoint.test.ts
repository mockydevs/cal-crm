import { describe, expect, it } from 'vitest';
import { advanceCheckpoint, checkpointData, readCheckpoint } from './assistant-checkpoint.js';

describe('assistant continuity', () => {
  it('discloses a shortened requirement even when no messages were dropped', () => {
    const checkpoint = advanceCheckpoint(readCheckpoint(null), [
      { seq: 1, kind: 'user', text: '<'.repeat(4000), activity: null, proposal_id: null },
    ]);
    expect(checkpoint.requirements).toHaveLength(1);
    expect(checkpoint.omitted).toBe(1);
  });
  it('restores only validated checkpoint fields, dropping untrusted extra data', () => {
    const checkpoint = readCheckpoint({
      ...readCheckpoint(null),
      throughSeq: 1,
      requirements: [{ seq: 1, text: 'Keep my original request', extra: 'x'.repeat(100000) }],
    });
    expect(checkpoint.requirements).toEqual([{ seq: 1, text: 'Keep my original request' }]);
  });
  it('rejects corrupt counters, oversized references and unbounded restored context', () => {
    const base = readCheckpoint(null);
    for (const corrupt of [
      { ...base, throughSeq: -1 },
      { ...base, omitted: -1 },
      { ...base, requirements: [{ seq: -1, text: 'bad' }] },
      { ...base, requirements: Array.from({ length: 5 }, () => ({ seq: 1, text: 'bad' })) },
      { ...base, proposals: [{ seq: 1, text: 'bad', id: 'x'.repeat(501) }] },
    ])
      expect(readCheckpoint(corrupt)).toEqual(base);
  });

  it('bounds serialized control characters and excludes starts, failures and uncertain outcomes', () => {
    const checkpoint = advanceCheckpoint(
      readCheckpoint(null),
      Array.from({ length: 30 }, (_, index) => ({
        seq: index + 1,
        kind: index < 10 ? 'user' : index < 20 ? 'activity' : 'proposal',
        text: '\u0000<&>'.repeat(1000),
        proposal_id: 'proposal_123',
        activity: { operationId: 'createForm', ok: true, state: 'completed', target: null },
      })),
    );
    expect(JSON.stringify(checkpoint).length).toBeLessThan(24000);
    expect(checkpointData(checkpoint).length).toBeLessThan(24000);
    const result = advanceCheckpoint(
      checkpoint,
      ['started', 'failed', 'uncertain'].map((state, index) => ({
        seq: 31 + index,
        kind: 'activity',
        text: 'not proven',
        proposal_id: null,
        activity: { operationId: 'createForm', ok: true, state, target: null },
      })),
    );
    expect(result.receipts).toEqual(checkpoint.receipts);
  });
  it('keeps original requirements and authoritative activity receipts after recent text is discarded', () => {
    const checkpoint = advanceCheckpoint(readCheckpoint(null), [
      {
        seq: 1,
        kind: 'user',
        text: 'Collect a wedding date and never publish without approval',
        activity: null,
        proposal_id: null,
      },
      {
        seq: 2,
        kind: 'activity',
        text: 'Created Wedding enquiry',
        activity: {
          operationId: 'createForm',
          effect: 'draft',
          ok: true,
          target: { kind: 'form', id: 'form_123' },
        },
        proposal_id: null,
      },
      {
        seq: 3,
        kind: 'proposal',
        text: 'Publish Wedding enquiry',
        activity: null,
        proposal_id: 'proposal-123',
      },
    ]);
    const next = advanceCheckpoint(checkpoint, [
      { seq: 40, kind: 'user', text: 'Also collect a budget', activity: null, proposal_id: null },
    ]);
    expect(next.requirements.map((row) => row.text)).toEqual([
      'Collect a wedding date and never publish without approval',
      'Also collect a budget',
    ]);
    expect(next.receipts).toEqual([
      {
        seq: 2,
        text: 'Created Wedding enquiry',
        operationId: 'createForm',
        target: { kind: 'form', id: 'form_123' },
      },
    ]);
    expect(next.proposals).toEqual([
      { seq: 3, id: 'proposal-123', text: 'Publish Wedding enquiry' },
    ]);
    expect(checkpointData(next)).toContain('Re-read records and proposals');
    expect(next.throughSeq).toBe(40);
    expect(
      advanceCheckpoint(next, [
        { seq: 1, kind: 'user', text: 'old replay', activity: null, proposal_id: null },
      ]),
    ).toEqual(next);
  });

  it('bounds stored context, preserves the initial request and discloses dropped context', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      seq: i + 1,
      kind: 'user',
      text: `Requirement ${String(i)} ${'x'.repeat(4000)}`,
      activity: null,
      proposal_id: null,
    }));
    const checkpoint = advanceCheckpoint(readCheckpoint({ malicious: true }), rows);
    expect(checkpoint.requirements[0]?.seq).toBe(1);
    expect(checkpoint.requirements.at(-1)?.seq).toBe(100);
    expect(checkpoint.omitted).toBeGreaterThan(0);
    expect(JSON.stringify(checkpoint).length).toBeLessThan(24000);
    expect(readCheckpoint(checkpoint)).toEqual(checkpoint);
  });
});
