// A model handle that answers from a function instead of a provider: the harness's tests
// use it where a socket would add nothing. It records as the eval gateway does.
import type { GatewayRequest } from '../../gateway.js';
import type { EvalProvider } from '../eval-gateway.js';
import {
  requestHash,
  toGatewayResult,
  type EvalSession,
  type RecordedCall,
  type RecordedResult,
} from '../recording.js';
import { buildReport, type RunReport } from '../report.js';
import { runSuite } from '../runner.js';
import type { EvalSuite } from '../types.js';

export const SCRIPTED_PROVIDER: EvalProvider = 'anthropic';
export const SCRIPTED_MODEL = 'claude-sonnet-5-5';

/** A recorded answer of plain text. */
export function says(text: string): RecordedResult {
  return { outcome: 'ok', parts: [{ type: 'text', text }], stop: 'end' };
}

export type ScriptedAnswer = (
  request: GatewayRequest,
  caseId: string,
) => RecordedResult | Promise<RecordedResult>;

/** Answers "Hello!", as the stand-ins do, unless told otherwise. */
export function scriptedSession(answer: ScriptedAnswer = () => says('Hello!')): EvalSession {
  let caseId = '';
  let calls: RecordedCall[] = [];
  return {
    async generate(_context, request) {
      // Kept from before the wait: an answer that arrives after its case belongs to that case.
      const mine = calls;
      const id = caseId;
      const call: RecordedCall = {
        request: requestHash(request),
        attempts: 1,
        usage: null,
        cost: null,
        result: await answer(request, id),
      };
      mine.push(call);
      return toGatewayResult(call, {
        provider: SCRIPTED_PROVIDER,
        model: SCRIPTED_MODEL,
        requestId: `eval-${id}-${String(mine.length)}`,
      });
    },
    begin(id) {
      caseId = id;
      calls = [];
    },
    end() {
      return { calls, stale: false, costMicros: 0n };
    },
    stop() {
      calls = [];
    },
  };
}

export interface ScriptedReportOptions {
  readonly answer?: ScriptedAnswer;
  readonly provider?: EvalProvider;
  readonly model?: string;
  readonly mode?: 'live' | 'replay';
  readonly at?: Date;
}

/** A run of the suite against scripted answers, as the report a live run would write. */
export async function scriptedReport(
  suite: EvalSuite,
  options: ScriptedReportOptions = {},
): Promise<RunReport> {
  const result = await runSuite(suite, scriptedSession(options.answer));
  const at = options.at ?? new Date('2026-10-10T08:00:00.000Z');
  return buildReport({
    suite,
    result,
    provider: options.provider ?? SCRIPTED_PROVIDER,
    model: options.model ?? SCRIPTED_MODEL,
    mode: options.mode ?? 'live',
    startedAt: at,
    finishedAt: new Date(at.getTime() + 1000),
    budgetMicros: 1_000_000n,
    spentMicros: 0n,
    masked: false,
  });
}
