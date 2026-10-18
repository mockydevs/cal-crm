// The replay gateway: the deterministic way to run a suite. Each call of a case is answered
// from a report's recording, in order, after checking that the suite asks what it asked
// then. It costs nothing and needs no key and no network, which is what lets the gate run
// in CI.
//
// A different request, a call the recording does not have, or a recorded call the suite
// no longer makes means the job's prompt or code changed since the model was evaluated:
// the case is stale, and the model has to be run again before it can be called Tested.
import { dollarsToMicros } from '../pricing.js';
import {
  requestHash,
  StaleRecordingError,
  toGatewayResult,
  type EvalSession,
  type RecordedCall,
} from './recording.js';
import type { RunReport } from './report.js';

export function createReplaySession(
  report: Pick<RunReport, 'provider' | 'model' | 'cases'>,
): EvalSession {
  const recordings = new Map(report.cases.map((each) => [each.id, each.calls]));
  let current:
    | { readonly id: string; readonly calls: readonly RecordedCall[]; next: number; stale: boolean }
    | undefined;

  return {
    generate(_context, request) {
      const mine = current;
      if (mine === undefined)
        return Promise.reject(new Error('The replay gateway was called outside a case.'));
      const call = mine.calls[mine.next];
      if (call?.request !== requestHash(request)) {
        mine.stale = true;
        return Promise.reject(new StaleRecordingError());
      }
      mine.next += 1;
      return Promise.resolve(
        toGatewayResult(call, {
          provider: report.provider,
          model: report.model,
          requestId: `eval-${mine.id}-${String(mine.next)}`,
        }),
      );
    },
    begin(caseId) {
      current = { id: caseId, calls: recordings.get(caseId) ?? [], next: 0, stale: false };
    },
    end() {
      const done = current;
      current = undefined;
      if (done === undefined) return { calls: [], stale: false, costMicros: 0n };
      const calls = done.calls.slice(0, done.next);
      return {
        calls,
        // A case the recording never saw is stale too, though it asked nothing.
        stale: done.stale || done.next < done.calls.length || !recordings.has(done.id),
        costMicros: calls.reduce(
          (sum, call) => sum + (call.cost === null ? 0n : dollarsToMicros(call.cost)),
          0n,
        ),
      };
    },
    stop() {
      // Nothing is held open, and a replay cannot spend.
    },
  };
}
