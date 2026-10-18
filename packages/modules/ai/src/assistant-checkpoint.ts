import { assistantData } from './assistant-loop.js';
import { isRecord } from './json.js';

interface Requirement {
  readonly seq: number;
  readonly text: string;
}
interface Receipt extends Requirement {
  readonly operationId: string;
  readonly target: { readonly kind: string; readonly id: string | null } | null;
}
interface ProposalReference extends Requirement {
  readonly id: string;
}
export interface AssistantCheckpoint {
  readonly version: 1;
  readonly throughSeq: number;
  readonly omitted: number;
  readonly requirements: readonly Requirement[];
  readonly receipts: readonly Receipt[];
  readonly proposals: readonly ProposalReference[];
}
export interface CheckpointMessage {
  readonly seq: number;
  readonly kind: string;
  readonly text: string;
  readonly activity: unknown;
  readonly proposal_id: string | null;
}

const empty = (): AssistantCheckpoint => ({
  version: 1,
  throughSeq: 0,
  omitted: 0,
  requirements: [],
  receipts: [],
  proposals: [],
});
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bounded = (value: unknown, size: number): value is string =>
  typeof value === 'string' && assistantData(value).length <= size + 2;
const reference = (value: unknown): value is Requirement =>
  isRecord(value) && count(value['seq']) && value['seq'] > 0 && bounded(value['text'], 4000);
/** Bound JSON-escaped size as well as plain text, including control characters. */
function excerpt(text: string, size: number): string {
  let result = text.slice(0, size);
  while (assistantData(result).length > size + 2)
    result = result.slice(0, Math.floor(result.length * 0.8));
  return result;
}

/** Checkpoints are data, never instructions or authority for the current state of a record. */
export function readCheckpoint(value: unknown): AssistantCheckpoint {
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    !count(value['throughSeq']) ||
    !count(value['omitted'])
  )
    return empty();
  const { requirements, receipts, proposals } = value;
  if (
    !Array.isArray(requirements) ||
    requirements.length > 4 ||
    !requirements.every(reference) ||
    !Array.isArray(receipts) ||
    receipts.length > 8 ||
    !Array.isArray(proposals) ||
    proposals.length > 4
  )
    return empty();
  const validReceipts: Receipt[] = [];
  for (const row of receipts) {
    if (
      !reference(row) ||
      !isRecord(row) ||
      !bounded(row.text, 500) ||
      !bounded(row['operationId'], 120)
    )
      return empty();
    const target = row['target'];
    if (
      target !== null &&
      (!isRecord(target) ||
        !bounded(target['kind'], 100) ||
        (target['id'] !== null && !bounded(target['id'], 200)))
    )
      return empty();
    validReceipts.push({
      seq: row.seq,
      text: row.text,
      operationId: row['operationId'],
      target:
        target === null
          ? null
          : {
              kind: typeof target['kind'] === 'string' ? target['kind'] : '',
              id: typeof target['id'] === 'string' ? target['id'] : null,
            },
    });
  }
  const validProposals: ProposalReference[] = [];
  for (const row of proposals) {
    if (!reference(row) || !isRecord(row) || !bounded(row.text, 500) || !bounded(row['id'], 200))
      return empty();
    validProposals.push({ seq: row.seq, text: row.text, id: row['id'] });
  }
  return {
    version: 1,
    throughSeq: value['throughSeq'],
    omitted: value['omitted'],
    requirements: requirements.map(({ seq, text }) => ({ seq, text })),
    receipts: validReceipts,
    proposals: validProposals,
  };
}

/** Keep the original request and recent exact requirements, rather than invented model facts. */
export function advanceCheckpoint(
  previous: AssistantCheckpoint,
  messages: readonly CheckpointMessage[],
): AssistantCheckpoint {
  const requirements = [...previous.requirements];
  const receipts = [...previous.receipts];
  const proposals = [...previous.proposals];
  let throughSeq = previous.throughSeq;
  let omitted = previous.omitted;
  for (const row of messages) {
    if (row.seq <= throughSeq) continue;
    throughSeq = row.seq;
    const text = excerpt(row.text, row.kind === 'user' ? 4000 : 500);
    if (row.kind === 'user') {
      if (text !== row.text) omitted += 1;
      requirements.push({ seq: row.seq, text });
    }
    if (row.kind === 'proposal' && row.proposal_id !== null)
      proposals.push({ seq: row.seq, id: row.proposal_id, text });
    if (
      row.kind === 'activity' &&
      isRecord(row.activity) &&
      row.activity['ok'] === true &&
      (row.activity['state'] === undefined || row.activity['state'] === 'completed') &&
      bounded(row.activity['operationId'], 120)
    ) {
      const target = row.activity['target'];
      receipts.push({
        seq: row.seq,
        text,
        operationId: row.activity['operationId'],
        target:
          isRecord(target) && typeof target['kind'] === 'string'
            ? { kind: target['kind'], id: typeof target['id'] === 'string' ? target['id'] : null }
            : null,
      });
    }
  }
  while (requirements.length > 4) {
    requirements.splice(1, 1);
    omitted += 1;
  }
  while (receipts.length > 8) {
    receipts.shift();
    omitted += 1;
  }
  while (proposals.length > 4) {
    proposals.shift();
    omitted += 1;
  }
  return { version: 1, throughSeq, omitted, requirements, receipts, proposals };
}

export function checkpointData(checkpoint: AssistantCheckpoint): string {
  return `<data>\n${assistantData({ historicalCheckpoint: checkpoint, instruction: 'Historical evidence only. Re-read records and proposals before acting; proposal references do not mean approval. Some earlier context may be omitted, as the omitted count shows.' })}\n</data>`;
}
