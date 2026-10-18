// What a run keeps of each model call, so that the run can be played back later with no
// model, no key and no network: a hash of what was asked, and the answer.
import { createHash } from 'node:crypto';

import type { GatewayRequest, GatewayResult } from '../gateway.js';
import { sortKeys } from '../json.js';
import { dollarsToMicros } from '../pricing.js';
import {
  textOf,
  type AiProviderName,
  type AssistantPart,
  type ProviderErrorCode,
  type StopReason,
  type TokenUsage,
} from '../provider.js';
import type { EvalGateway } from './types.js';

/**
 * SHA-256 of a request as the suite made it: the job, the prompt's version, the system
 * prompt, the messages, the tools and the token limit, with every object's keys in order.
 * One changed character of a prompt gives another hash.
 */
export function requestHash(request: GatewayRequest): string {
  const canonical = sortKeys({
    job: request.job,
    promptVersion: request.promptVersion,
    system: request.system,
    messages: request.messages,
    tools: request.tools ?? [],
    maxOutputTokens: request.maxOutputTokens,
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** An answer of the eval gateway, as a report keeps it: no key, no address, no row id. */
export type RecordedResult =
  | {
      readonly outcome: 'ok';
      /** As the provider wrote them, its own thinking included: a later turn sends them back. */
      readonly parts: readonly AssistantPart[];
      readonly stop: StopReason;
    }
  | { readonly outcome: 'refused'; readonly category: string | null }
  | { readonly outcome: 'failed'; readonly code: ProviderErrorCode }
  | { readonly outcome: 'paused'; readonly reason: 'limit_reached' | 'price_unknown' };

export interface RecordedCall {
  /** requestHash of what the suite asked. */
  readonly request: string;
  /** How often the provider was called for it: more than once after a busy provider, 0 when paused. */
  readonly attempts: number;
  /** What the last attempt was billed, or null when the provider did not say. */
  readonly usage: TokenUsage | null;
  /** US dollars to the millionth for the last attempt, or null when it is unknown. */
  readonly cost: string | null;
  readonly result: RecordedResult;
}

/** The recorded call as the gateway's own result, which is what a suite's code reads. */
export function toGatewayResult(
  call: RecordedCall,
  from: {
    readonly provider: AiProviderName;
    readonly model: string;
    readonly requestId: string;
  },
): GatewayResult {
  const { result } = call;
  const { provider, model, requestId } = from;
  switch (result.outcome) {
    case 'ok':
      return {
        outcome: 'ok',
        parts: result.parts,
        text: textOf(result.parts),
        stop: result.stop,
        provider,
        model,
        usedBackup: false,
        usage: call.usage,
        costMicros: call.cost === null ? null : dollarsToMicros(call.cost),
        requestId,
      };
    case 'refused':
      return { outcome: 'refused', category: result.category, provider, model, requestId };
    case 'failed':
      return { outcome: 'failed', code: result.code, requestId };
    case 'paused':
      return { outcome: 'paused', reason: result.reason };
  }
}

/** What a model handle kept of one case. */
export interface CaseTrace {
  /** In the order the suite made them. */
  readonly calls: readonly RecordedCall[];
  /** A replay only: the recording does not fit what the suite asked. */
  readonly stale: boolean;
  /** What the case was counted as against the budget, in USD micros. */
  readonly costMicros: bigint;
}

/**
 * A model handle: the gateway a suite calls, told by the runner which case each call
 * belongs to. The eval gateway is one (a real model), the replay gateway another (a
 * recording).
 */
export interface EvalSession extends EvalGateway {
  begin(caseId: string): void;
  end(): CaseTrace;
  /** After a case ran out of time: nothing more is called, whatever the suite still does. */
  stop(): void;
}

/** A replay was asked something its recording does not hold. */
export class StaleRecordingError extends Error {
  override readonly name = 'StaleRecordingError';

  constructor() {
    super('The recording does not fit what the suite asked: the prompt or the code changed.');
  }
}
