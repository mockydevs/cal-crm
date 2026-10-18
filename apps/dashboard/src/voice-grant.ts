// Asks the server for this person's calling token and waits for the worker to sign it: the
// first answer is the request, and the token arrives in a read shortly after. The token goes
// straight to the softphone, never into state, storage or logs.
import { getVoiceGrant, requestVoiceGrant, type VoiceGrant as Answer } from '@repo/contracts';
import type { RequestVoiceGrant, VoiceGrant } from './voice-browser';

/** The two calls this needs, as `apiIn(businessId)` makes them. */
export interface GrantClient {
  request(endpoint: typeof requestVoiceGrant, input: object): Promise<Answer>;
  request(endpoint: typeof getVoiceGrant, input: { params: { id: string } }): Promise<Answer>;
}

export interface GrantTiming {
  /** Between reads while the worker signs. */
  readonly intervalMs?: number;
  /** How long to wait in all before giving up; the server's request lasts two minutes. */
  readonly timeoutMs?: number;
}

/** Why no token came; the softphone shows a grant problem and can be started again. */
export class VoiceGrantRefused extends Error {
  constructor(readonly code: string) {
    super();
  }
}

/** Waits, or stops at once when the softphone is closed; the caller then sees the abort. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export function grantRequester(client: GrantClient, timing: GrantTiming = {}): RequestVoiceGrant {
  const intervalMs = timing.intervalMs ?? 250;
  const timeoutMs = timing.timeoutMs ?? 15_000;
  return async (signal): Promise<VoiceGrant> => {
    const started = Date.now();
    let answer = await client.request(requestVoiceGrant, {});
    for (;;) {
      signal.throwIfAborted();
      if (answer.status === 'issued' && answer.token !== null && answer.expiresAt !== null)
        return { token: answer.token, expiresAt: answer.expiresAt };
      if (answer.status === 'failed') throw new VoiceGrantRefused(answer.failure?.code ?? 'failed');
      if (answer.status === 'issued') throw new VoiceGrantRefused('expired');
      if (Date.now() - started >= timeoutMs) throw new VoiceGrantRefused('timeout');
      await pause(intervalMs, signal);
      signal.throwIfAborted();
      answer = await client.request(getVoiceGrant, { params: { id: answer.id } });
    }
  };
}
