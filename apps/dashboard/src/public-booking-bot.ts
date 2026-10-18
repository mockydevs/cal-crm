// A calendar's bot protection on its booking page. For a calendar that asks for it,
// the page asks the server for a challenge bound to the showing it holds (its render token)
// as soon as it opens, and solves it while the visitor chooses a time and types: ALTCHA's
// proof of work, with nothing to see or do. The proof goes with the booking. The solver is
// loaded only here, only then (a chunk of its own).
import {
  getPublicCalendarChallenge,
  type AltchaChallenge,
  type BotProof,
  type PublicCalendarPage,
  type PublicCalendarParams,
} from '@repo/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { againWhenBusy, requestOrBusy } from './public-booking-busy';

/** How the check is going: off for a calendar that asks for none. */
export type BotCheck = 'off' | 'working' | 'done' | 'failed';

export interface BotPorts {
  readonly challenge: (
    params: PublicCalendarParams,
    renderToken: string,
  ) => Promise<{ readonly challenge: AltchaChallenge }>;
  readonly solve: (challenge: AltchaChallenge) => Promise<BotProof | undefined>;
}

const defaultPorts: BotPorts = {
  challenge: (params, renderToken) =>
    againWhenBusy(() =>
      requestOrBusy(getPublicCalendarChallenge, { params, body: { renderToken } }),
    ),
  solve: async (challenge) => (await import('./public-booking-solver')).solveAltcha(challenge),
};

/** Seconds before a challenge's expiry when it is no longer sent, but solved again. */
const EXPIRY_MARGIN_SECONDS = 30;

/** Whether a proof is about to expire, by the challenge's own expiry (in seconds). */
export function expiresSoon(proof: BotProof, now = Date.now()): boolean {
  const { expiresAt } = proof.challenge.parameters;
  return expiresAt !== undefined && (expiresAt - EXPIRY_MARGIN_SECONDS) * 1000 < now;
}

/**
 * The page's bot check: how it is going, and the proof to send with a booking (undefined
 * for a calendar that asks for none, or when the check did not finish).
 */
export function useBotProof(
  params: PublicCalendarParams,
  page: Pick<PublicCalendarPage, 'renderToken' | 'botProtection'>,
  ports: BotPorts = defaultPorts,
): { readonly check: BotCheck; readonly proof: () => Promise<BotProof | undefined> } {
  const asks = page.botProtection === 'altcha';
  const { renderToken } = page;
  // What the latest attempt found, for the showing it was for.
  const [found, setFound] = useState<{
    readonly token: string;
    readonly settled: boolean;
    readonly ok: boolean;
  }>();
  const attemptRef = useRef<Promise<BotProof | undefined> | undefined>(undefined);
  const { agencySlug, businessSlug, calendarSlug } = params;

  const start = useCallback((): Promise<BotProof | undefined> => {
    const made: Promise<BotProof | undefined> = ports
      .challenge({ agencySlug, businessSlug, calendarSlug }, renderToken)
      .then((given) => ports.solve(given.challenge))
      .catch(() => undefined)
      .then((proof) => {
        // Only the latest attempt is reported.
        if (attemptRef.current === made)
          setFound({ token: renderToken, settled: true, ok: proof !== undefined });
        return proof;
      });
    attemptRef.current = made;
    return made;
  }, [ports, agencySlug, businessSlug, calendarSlug, renderToken]);

  useEffect(() => {
    if (!asks) {
      attemptRef.current = undefined;
      return;
    }
    void start();
  }, [asks, start]);

  const proof = useCallback(async (): Promise<BotProof | undefined> => {
    if (!asks) return undefined;
    let proved = await (attemptRef.current ?? start());
    if (proved === undefined || expiresSoon(proved)) {
      // Did not finish, or about to expire: once more, now.
      setFound({ token: renderToken, settled: false, ok: false });
      proved = await start();
    }
    return proved;
  }, [asks, start, renderToken]);

  const check: BotCheck = !asks
    ? 'off'
    : found?.token !== renderToken || !found.settled
      ? 'working'
      : found.ok
        ? 'done'
        : 'failed';
  return { check, proof };
}
