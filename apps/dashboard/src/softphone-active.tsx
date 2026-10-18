// The softphone while it is on: one controller for the business, the placing of calls, and
// the bar at the bottom of the screen while a call is going or the device has a problem.
// Fetched only for someone who may place calls while calling is available (softphone.tsx).
// A placed call rings this browser first; that call is answered without a click, because
// the person asked for it. Any other incoming call waits for Answer or Decline.
import { Trans, useLingui } from '@lingui/react/macro';
import { getCall, getContact, requestCall, type Call, type CallDetail } from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Device } from '@twilio/voice-sdk';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
} from 'react';

import { apiIn } from './api';
import { durationText, isLive } from './calls-rules';
import type { ActiveSoftphoneProps, SoftphoneValue } from './softphone-types';
import {
  createBrowserVoice,
  type BrowserVoice,
  type BrowserVoiceState,
  type VoiceCallView,
  type VoiceProblemKind,
} from './voice-browser';
import { grantRequester, type GrantClient } from './voice-grant';
import { useBusiness } from './workspace';

/** Between reads of a placed call until its first leg has the provider's id. */
const POLL_MS = 500;
/** How long a placed call is read before this browser stops expecting it. */
const POLL_FOR_MS = 30_000;

/**
 * When the call first opened, kept while it reconnects, so its duration runs on. It is noted
 * as the controller reports each change, not while drawing.
 */
function openedAtOf(voice: BrowserVoice): {
  readonly subscribe: (changed: () => void) => () => void;
  readonly get: () => number | null;
} {
  let opened: { readonly sid: string | null; readonly at: number } | null = null;
  const note = () => {
    const call = voice.getState().call;
    if (call === null) opened = null;
    else if (call.phase === 'open' && opened?.sid !== call.sid)
      opened = { sid: call.sid, at: Date.now() };
  };
  note();
  return {
    subscribe: (changed) =>
      voice.subscribe(() => {
        note();
        changed();
      }),
    get: () => opened?.at ?? null,
  };
}

/** A controller and its own key, so a new one starts with nothing expected or answered. */
interface Running {
  readonly voice: BrowserVoice;
  readonly key: number;
}

/**
 * The controller in use, made by the effect that starts it and disposed by its cleanup. A
 * disposed controller is finished, so one made while drawing would be dead after React runs
 * the effects a second time, as it does in development.
 */
function controllerSlot(): {
  readonly subscribe: (changed: () => void) => () => void;
  readonly get: () => Running | null;
  readonly run: (voice: BrowserVoice) => () => void;
} {
  let current: Running | null = null;
  let made = 0;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (changed) => {
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
    get: () => current,
    run: (voice) => {
      made += 1;
      const running = { voice, key: made };
      current = running;
      tell();
      void voice.start();
      return () => {
        voice.dispose();
        if (current === running) {
          current = null;
          tell();
        }
      };
    },
  };
}

export function ActiveSoftphone({
  businessId,
  createVoice = createBrowserVoice,
  onValue,
}: ActiveSoftphoneProps): ReactElement | null {
  // apiIn makes a new client on every call: one made per render would make a new controller
  // on every render, and each would dispose the last and start again without end.
  const client = useMemo(() => apiIn(businessId), [businessId]);
  const slot = useMemo(() => controllerSlot(), []);
  useEffect(
    () =>
      slot.run(
        // The SDK's one generic request is what GrantClient's two overloads describe;
        // TypeScript can't match a generic signature against overloads, so it is named as
        // the narrower one.
        createVoice({
          requestGrant: grantRequester(client as unknown as GrantClient),
          // The SDK is part of this chunk, which only someone who may place calls fetches.
          // As a chunk of its own it needs the bundler's CommonJS helpers apart from React's
          // chunk, which holds them otherwise, and the bundler then moves them into a file
          // that every chunk of the dashboard imports, so each page grows.
          loadSdk: () => Promise.resolve({ Device }),
        }),
      ),
    [slot, client, createVoice],
  );
  const running = useSyncExternalStore(slot.subscribe, slot.get, slot.get);
  return running === null ? null : (
    <RunningSoftphone
      key={running.key}
      businessId={businessId}
      client={client}
      voice={running.voice}
      onValue={onValue}
    />
  );
}

function RunningSoftphone({
  businessId,
  client,
  voice,
  onValue,
}: {
  readonly businessId: string;
  readonly client: Client;
  readonly voice: BrowserVoice;
  readonly onValue: (value: SoftphoneValue | null) => void;
}): ReactElement {
  const { t } = useLingui();
  const subscribe = useCallback((changed: () => void) => voice.subscribe(changed), [voice]);
  const snapshot = useCallback(() => voice.getState(), [voice]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const call = state.call;

  // The provider's id of the call this person placed, once known, and the one answered, so
  // a call is answered once whichever comes first: the ring or the id.
  const expectedSidRef = useRef<string | null>(null);
  const answeredSidRef = useRef<string | null>(null);
  const answerIfExpected = useCallback(() => {
    const ringing = voice.getState().call;
    if (
      ringing?.phase === 'incoming' &&
      ringing.sid !== null &&
      ringing.sid === expectedSidRef.current &&
      ringing.sid !== answeredSidRef.current
    ) {
      answeredSidRef.current = ringing.sid;
      expectedSidRef.current = null;
      voice.accept();
    }
  }, [voice]);
  useEffect(() => {
    if (call !== null) answerIfExpected();
  }, [call, answerIfExpected]);

  const pollsRef = useRef(new Set<ReturnType<typeof setInterval>>());
  useEffect(() => {
    const running = pollsRef.current;
    return () => {
      for (const each of running) clearInterval(each);
      running.clear();
    };
  }, []);

  const placeCall = useCallback(
    async (contactIdentityId: string): Promise<string | undefined> => {
      let placed: Call;
      try {
        placed = await client.request(requestCall, {
          body: { contactIdentityId, idempotencyKey: crypto.randomUUID() },
        });
      } catch (error) {
        if (error instanceof ApiError && typeof error.problem.detail === 'string') {
          return error.problem.detail;
        }
        return t`The call couldn't be requested. Try again.`;
      }
      const since = Date.now();
      const poll = setInterval(() => {
        const stop = () => {
          clearInterval(poll);
          pollsRef.current.delete(poll);
        };
        if (Date.now() - since >= POLL_FOR_MS) {
          stop();
          return;
        }
        void client.request(getCall, { params: { id: placed.id } }).then(
          (detail: CallDetail) => {
            if (!pollsRef.current.has(poll)) return;
            if (!isLive(detail.state)) {
              stop();
              return;
            }
            const providerCallId = detail.legs.find((leg) => leg.parentId === null)?.providerCallId;
            if (providerCallId === undefined || providerCallId === null) return;
            stop();
            expectedSidRef.current = providerCallId;
            answerIfExpected();
          },
          // A read that failed is tried again on the next tick, until the time is up.
          () => undefined,
        );
      }, POLL_MS);
      pollsRef.current.add(poll);
      return undefined;
    },
    [client, t, answerIfExpected],
  );

  const opened = useMemo(() => openedAtOf(voice), [voice]);
  const openedAt = useSyncExternalStore(opened.subscribe, opened.get, opened.get);

  const value = useMemo((): SoftphoneValue => ({ state, placeCall }), [state, placeCall]);
  useEffect(() => {
    onValue(value);
    return () => {
      onValue(null);
    };
  }, [onValue, value]);

  return (
    <>
      <PhaseAnnouncement call={call} />
      {call !== null ? (
        <CallBar
          businessId={businessId}
          client={client}
          call={call}
          voice={voice}
          openedAt={openedAt}
          problem={state.problem}
        />
      ) : state.problem !== null ? (
        <ProblemBar kind={state.problem.kind} voice={voice} />
      ) : null}
    </>
  );
}

const barClassName =
  'fixed bottom-4 left-4 right-4 z-50 flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-sm shadow-lg sm:left-auto sm:w-80';

function useProblemWords(): Record<VoiceProblemKind, string> {
  const { t } = useLingui();
  return {
    unsupported: t`Your browser does not support calling.`,
    load_failed: t`The calling software could not be loaded.`,
    grant_failed: t`A calling token could not be obtained.`,
    token_rejected: t`The calling token was rejected.`,
    microphone_denied: t`Microphone permission was denied.`,
    microphone_unavailable: t`No microphone is available.`,
    network: t`Network connection failed.`,
    provider: t`The call provider reported an error.`,
  };
}

function usePhaseWords(): Record<VoiceCallView['phase'], string> {
  const { t } = useLingui();
  return {
    incoming: t`Incoming call`,
    connecting: t`Connecting…`,
    open: t`In call`,
    reconnecting: t`Reconnecting…`,
  };
}

/**
 * Says what the call is doing to a screen reader. It is always there, empty between calls,
 * because a live region that appears with its words in it is often not read out.
 */
function PhaseAnnouncement({ call }: { readonly call: VoiceCallView | null }): ReactElement {
  const { t } = useLingui();
  const phases = usePhaseWords();
  const caller = call?.from ?? t`Unknown caller`;
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {call === null
        ? ''
        : call.phase === 'incoming'
          ? t`Incoming call from ${caller}`
          : phases[call.phase]}
    </p>
  );
}

/**
 * Where focus was before it came into a bar. When the bar goes (the call ends, the problem
 * clears) with focus inside, it is removed under it, so focus goes back there instead of to
 * the page's start. Focus that is elsewhere is left alone.
 */
function useFocusReturn(): RefObject<HTMLElement | null> {
  const barRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null) return;
    const before = document.activeElement;
    let returnTo = before instanceof HTMLElement && before !== document.body ? before : null;
    const cameIn = (event: FocusEvent) => {
      const from = event.relatedTarget;
      if (from instanceof HTMLElement && !bar.contains(from)) returnTo = from;
    };
    bar.addEventListener('focusin', cameIn);
    return () => {
      bar.removeEventListener('focusin', cameIn);
      if (bar.contains(document.activeElement) && returnTo?.isConnected === true) returnTo.focus();
    };
  }, []);
  return barRef;
}

function ProblemBar({
  kind,
  voice,
}: {
  readonly kind: VoiceProblemKind;
  readonly voice: BrowserVoice;
}): ReactElement {
  const { t } = useLingui();
  const problems = useProblemWords();
  const barRef = useFocusReturn();
  return (
    <aside ref={barRef} aria-label={t`Phone problem`} className={barClassName}>
      <p role="alert">{problems[kind]}</p>
      <Button
        variant="secondary"
        size="small"
        className="self-start"
        onClick={() => {
          void voice.refresh();
        }}
      >
        <Trans>Try again</Trans>
      </Button>
    </aside>
  );
}

/** Ticks once a second; the time itself comes from when the call first opened. */
function CallDuration({ since }: { readonly since: number }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <>{durationText(Math.max(0, Math.floor((now - since) / 1000)))}</>;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

function CallBar({
  businessId,
  client,
  call,
  voice,
  openedAt,
  problem,
}: {
  readonly businessId: string;
  readonly client: Client;
  readonly call: VoiceCallView;
  readonly voice: BrowserVoice;
  readonly openedAt: number | null;
  readonly problem: BrowserVoiceState['problem'];
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const phases = usePhaseWords();
  const problems = useProblemWords();
  const [keypad, setKeypad] = useState(false);
  const barRef = useFocusReturn();
  const caller = call.from ?? t`Unknown caller`;
  const open = call.phase === 'open';

  const callId = call.callId ?? null;
  const callQuery = useQuery({
    queryKey: ['b', businessId, 'call', callId],
    queryFn: () => {
      if (!callId) {
        throw new Error('callId required');
      }
      return client.request(getCall, { params: { id: callId } });
    },
    enabled: callId !== null,
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 3,
  });

  const contactId = callQuery.data?.contactId ?? null;
  const contactQuery = useQuery({
    queryKey: ['b', businessId, 'contacts', contactId],
    queryFn: () => {
      if (!contactId) {
        throw new Error('contactId required');
      }
      return client.request(getContact, { params: { id: contactId } });
    },
    enabled: contactId !== null,
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 3,
  });

  const contactName =
    contactQuery.data?.name ??
    ([contactQuery.data?.firstName, contactQuery.data?.lastName].filter(Boolean).join(' ') || null);
  const hasContact = contactId !== null && contactName !== null && !contactQuery.isError;

  return (
    <aside ref={barRef} aria-label={t`Phone call`} className={barClassName}>
      <div className="flex items-center justify-between gap-2">
        {hasContact ? (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-semibold">{contactName}</span>
            <span className="truncate text-xs text-muted-foreground">{caller}</span>
            <Link
              to="/b/$slug/contacts/$contactId"
              params={{ slug: business.slug, contactId }}
              className="text-xs text-link hover:underline"
            >
              <Trans>Open contact</Trans>
            </Link>
          </div>
        ) : (
          <span className="truncate font-semibold">{caller}</span>
        )}
        <Badge variant={open ? 'assistant' : 'neutral'}>{phases[call.phase]}</Badge>
      </div>
      {openedAt !== null && (open || call.phase === 'reconnecting') ? (
        <p className="font-mono text-xs text-muted-foreground">
          <CallDuration since={openedAt} />
        </p>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {problems[problem.kind]}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {call.phase === 'incoming' ? (
          <>
            <Button
              variant="primary"
              size="small"
              onClick={() => {
                voice.accept();
              }}
            >
              <Trans>Answer</Trans>
            </Button>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                voice.reject();
              }}
            >
              <Trans>Decline</Trans>
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              size="small"
              aria-pressed={call.muted}
              onClick={() => {
                voice.setMuted(!call.muted);
              }}
            >
              <Trans>Mute</Trans>
            </Button>
            {open ? (
              <Button
                variant="secondary"
                size="small"
                aria-expanded={keypad}
                onClick={() => {
                  setKeypad((shown) => !shown);
                }}
              >
                <Trans>Keypad</Trans>
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="small"
              className="border-destructive text-destructive"
              onClick={() => {
                voice.hangUp();
              }}
            >
              <Trans>Hang up</Trans>
            </Button>
          </>
        )}
      </div>
      {keypad && open ? (
        <div
          role="group"
          aria-label={t`Dial pad`}
          className="grid grid-cols-3 gap-1.5 border-t border-border pt-2"
        >
          {DIGITS.map((digit) => (
            <Button
              key={digit}
              variant="secondary"
              size="small"
              onClick={() => {
                voice.sendDigits(digit);
              }}
            >
              {digit}
            </Button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
