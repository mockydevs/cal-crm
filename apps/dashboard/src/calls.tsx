// Calls: the business's call history, newest first, as `listCalls`
// pages it, filtered by direction and, opened from a contact, by contact. A call's panel
// reads `getCall` for its legs and, for someone who may place calls, asks `hangUpCall` to
// end it. The page shows the call as the server has it: a requested call is waiting, never
// connected; one whose provider answer was lost is unknown; and a hang-up is only asked
// for, so the call ends when the provider reports that it has. Reading needs calls.read;
// hanging up, calls.place.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getCall,
  getMyPermissions,
  hangUpCall,
  listCalls,
  type Call,
  type CallDetail,
  type CallFailureCode,
  type CallLeg,
  type CallLegStatus,
  type CallOutcome,
  type CallState,
  type Permission,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Eye } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { useTeam } from './calendar-shared';
import {
  callsQueryOf,
  canHangUp,
  durationOf,
  durationText,
  isLive,
  stateTone,
  type CallFilters,
} from './calls-rules';
import { RightPanel, sidePanelBodyClassName } from './conversation-extras-panel';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  iconButtonClassName,
  listCardClassName,
  ListProblem,
  retryFaults,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import { emptyTrail, trailBack, trailCursor, trailForward } from './settings-rules';
import { Page } from './shell/page';
import { useSoftphone } from './softphone';
import { useBusiness } from './workspace';

/** While a call's panel is open and the call is going, it is read again this often. */
const LIVE_REFRESH_MS = 5_000;

const ANY = 'any';

/** The words for a call's state, outcome, failure and legs, shared by the list and panel. */
function useCallWords(): {
  readonly state: (call: Pick<Call, 'state' | 'outcome'>) => string;
  readonly failure: (code: CallFailureCode) => string;
  readonly leg: (status: CallLegStatus) => string;
} {
  const { t } = useLingui();
  const outcomes: Readonly<Record<CallOutcome, string>> = {
    completed: t`Ended: completed`,
    busy: t`Ended: busy`,
    no_answer: t`Ended: no answer`,
    failed: t`Ended: failed`,
    canceled: t`Ended: canceled`,
  };
  const states: Readonly<Record<CallState, string>> = {
    requested: t`Requested`,
    reserved: t`Placing`,
    unknown: t`Outcome unknown`,
    dialing: t`Dialing`,
    ringing: t`Ringing`,
    connected: t`Connected`,
    ended: t`Ended`,
    refused: t`Refused`,
    rejected: t`Rejected by the provider`,
    canceled: t`Canceled`,
  };
  const failures: Readonly<Record<CallFailureCode, string>> = {
    contact_unavailable: t`The contact or their number is no longer available, so the call was not placed.`,
    do_not_call: t`The contact asked not to be called, so the call was not placed.`,
    call_consent_withdrawn: t`The contact withdrew consent to calls, so the call was not placed.`,
    number_unavailable: t`The business number can't make calls now, so the call was not placed.`,
    connection_unavailable: t`The Twilio connection isn't working, so the call was not placed.`,
    member_unavailable: t`The person who asked for the call can no longer place calls, so it was not placed.`,
    provider_rejected: t`The provider refused to place the call.`,
  };
  const legs: Readonly<Record<CallLegStatus, string>> = {
    reserved: t`Being placed`,
    unknown: t`Unknown`,
    rejected: t`Rejected`,
    queued: t`Queued`,
    initiated: t`Initiated`,
    ringing: t`Ringing`,
    'in-progress': t`In progress`,
    completed: t`Completed`,
    busy: t`Busy`,
    failed: t`Failed`,
    'no-answer': t`No answer`,
    canceled: t`Canceled`,
  };
  return {
    state: (call) =>
      call.state === 'ended' && call.outcome !== null ? outcomes[call.outcome] : states[call.state],
    failure: (code) => failures[code],
    leg: (status) => legs[status],
  };
}

/** The member a membership id names, from the business team, which anyone may read. */
function useMemberName(businessId: string): (membershipId: string | null) => string {
  const { t } = useLingui();
  const team = useTeam(businessId);
  return (membershipId) => {
    if (membershipId === null) return t`No one`;
    const member = team.data?.members.find((each) => each.id === membershipId);
    if (member === undefined) return t`A team member`;
    return member.name === '' ? member.email : member.name;
  };
}

export function CallsPage({
  contactId,
}: {
  readonly contactId?: string | undefined;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const grants = useQuery({
    queryKey: ['b', business.id, 'my-permissions'],
    queryFn: () => apiIn(business.id).request(getMyPermissions, {}),
    retry: retryFaults,
  });
  const may = (permission: Permission): boolean =>
    grants.data?.permissions.includes(permission) === true;
  return (
    <Page title={t`Calls`}>
      <p className="text-md text-muted-foreground">
        {contactId === undefined ? (
          <Trans>Calls to and from the business's numbers, newest first.</Trans>
        ) : (
          <Trans>This contact's calls.</Trans>
        )}
      </p>
      {grants.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : grants.isError ? (
        <ListProblem
          onRetry={() => {
            void grants.refetch();
          }}
        >
          <Trans>We couldn't check what you may see here.</Trans>
        </ListProblem>
      ) : may('calls.read') ? (
        <CallList contactId={contactId} mayPlace={may('calls.place')} />
      ) : (
        <Refused />
      )}
    </Page>
  );
}

function Refused(): ReactElement {
  return (
    <p role="alert" className="text-md">
      <Trans>You need permission to read calls.</Trans>
    </p>
  );
}

function CallList({
  contactId,
  mayPlace,
}: {
  readonly contactId: string | undefined;
  readonly mayPlace: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const words = useCallWords();
  const memberName = useMemberName(business.id);
  const [direction, setDirection] = useState<CallFilters['direction']>('');
  const [trail, setTrail] = useState(emptyTrail);
  const [viewing, setViewing] = useState<Call>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const filters: CallFilters = { direction, contactId };
  // Another question starts at its first page.
  const askedKey = JSON.stringify(filters);
  const [shownKey, setShownKey] = useState(askedKey);
  if (shownKey !== askedKey) {
    setShownKey(askedKey);
    setTrail(emptyTrail);
  }
  const query = callsQueryOf(filters, trailCursor(trail));
  const list = useQuery({
    queryKey: ['b', business.id, 'calls', query],
    queryFn: () => api.request(listCalls, { query }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const forbidden = list.error instanceof ApiError && list.error.status === 403;
  const listed = list.isError ? undefined : list.data;
  const items = listed?.items ?? [];
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const turning = list.isFetching && list.isPlaceholderData;
  const pageNumber = trail.index + 1;
  if (forbidden) return <Refused />;
  return (
    <section aria-label={t`Calls`} className={listCardClassName}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
          <Trans>Direction</Trans>
          <Select
            aria-label={t`Direction`}
            className="w-auto min-w-40"
            value={direction === '' ? ANY : direction}
            onValueChange={(value) => {
              setDirection(value === 'inbound' || value === 'outbound' ? value : '');
            }}
          >
            <option value={ANY}>{t`All calls`}</option>
            <option value="outbound">{t`Outgoing`}</option>
            <option value="inbound">{t`Incoming`}</option>
          </Select>
        </label>
      </div>
      {list.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading calls…</Trans>
        </p>
      ) : null}
      {list.isError ? (
        <ListProblem
          onRetry={() => {
            if (trail.index > 0) setTrail(emptyTrail);
            else void list.refetch();
          }}
        >
          <Trans>The calls couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {listed !== undefined && items.length === 0 ? (
        <p className="py-6 text-center text-md text-muted-foreground">
          {direction === '' ? <Trans>No calls yet.</Trans> : <Trans>No calls match.</Trans>}
        </p>
      ) : null}
      {items.length === 0 ? null : (
        <div role="region" aria-label={t`Calls table`} className={tableRegionClassName}>
          <table className={`${tableClassName} min-w-[880px] table-fixed`}>
            <caption className="sr-only">
              <Trans>Calls</Trans>
            </caption>
            <thead>
              <tr>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Number</Trans>
                </th>
                <th scope="col" className={`${headerCellClassName} w-28`}>
                  <Trans>Direction</Trans>
                </th>
                <th scope="col" className={`${headerCellClassName} w-[24%]`}>
                  <Trans>Status</Trans>
                </th>
                <th scope="col" className={`${headerCellClassName} w-[16%]`}>
                  <Trans>Team member</Trans>
                </th>
                <th scope="col" className={`${headerCellClassName} w-44`}>
                  <Trans>Started</Trans>
                </th>
                <th scope="col" className={`${headerCellClassName} w-24`}>
                  <Trans>Duration</Trans>
                </th>
                <th scope="col" className={`${headerCellClassName} w-16`}>
                  <span className="sr-only">
                    <Trans>Details</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((call) => {
                const remote = call.remoteNumber ?? t`Hidden number`;
                const when = moment.format(new Date(call.createdAt));
                const seconds = durationOf(call);
                return (
                  <tr key={call.id} className="hover:bg-muted">
                    <th scope="row" className={`${cellClassName} text-left font-normal`}>
                      <span className="flex min-w-0 flex-col">
                        <span className="wrap-anywhere text-foreground">{remote}</span>
                        {call.contactId === null ? null : (
                          <Link
                            to="/b/$slug/contacts/$contactId"
                            params={{ slug: business.slug, contactId: call.contactId }}
                            className="text-xs text-link hover:underline"
                          >
                            <Trans>Open contact</Trans>
                          </Link>
                        )}
                      </span>
                    </th>
                    <td className={cellClassName}>
                      {call.direction === 'outbound' ? t`Outgoing` : t`Incoming`}
                    </td>
                    <td className={cellClassName}>
                      <CallStatus call={call} words={words} />
                    </td>
                    <td className={`${cellClassName} wrap-anywhere`}>
                      {memberName(call.membershipId)}
                    </td>
                    <td className={`${cellClassName} whitespace-nowrap`}>
                      <time dateTime={call.createdAt}>{when}</time>
                    </td>
                    <td className={`${cellClassName} whitespace-nowrap`}>
                      {seconds === null ? '—' : durationText(seconds)}
                    </td>
                    <td className={`${cellClassName} text-right`}>
                      <button
                        type="button"
                        className={iconButtonClassName}
                        aria-label={t`Details of the call with ${remote}, ${when}`}
                        onClick={(event) => {
                          returnFocusRef.current = event.currentTarget;
                          setViewing(call);
                        }}
                      >
                        <Eye aria-hidden className="size-4" strokeWidth={1.8} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {listed === undefined ? null : (
        <nav
          aria-label={t`Pages`}
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-body"
        >
          <p role="status" aria-busy={turning}>
            <Trans>Page {pageNumber}</Trans>
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="quiet"
              size="small"
              aria-label={t`Previous page`}
              disabled={trail.index === 0 || turning}
              onClick={() => {
                setTrail(trailBack);
              }}
            >
              <Trans>Previous</Trans>
            </Button>
            <Button
              variant="quiet"
              size="small"
              aria-label={t`Next page`}
              disabled={listed.nextCursor === null || turning}
              onClick={() => {
                setTrail(trailForward(trail, listed.nextCursor));
              }}
            >
              <Trans>Next</Trans>
            </Button>
          </div>
        </nav>
      )}
      <RightPanel
        open={viewing !== undefined}
        onClose={() => {
          setViewing(undefined);
        }}
        returnFocus={returnFocusRef}
        title={<Trans>Call details</Trans>}
      >
        {viewing === undefined ? null : (
          <CallPanel key={viewing.id} listed={viewing} mayPlace={mayPlace} />
        )}
      </RightPanel>
    </section>
  );
}

function CallStatus({
  call,
  words,
}: {
  readonly call: Call;
  readonly words: ReturnType<typeof useCallWords>;
}): ReactElement {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <Badge variant={stateTone(call.state)}>{words.state(call)}</Badge>
      {call.needsReconciliation ? (
        <span className="text-xs text-destructive">
          <Trans>Needs checking with the provider</Trans>
        </span>
      ) : null}
    </span>
  );
}

/** A call with its legs, read again while it is going; the hang-up for who may place calls. */
function CallPanel({
  listed,
  mayPlace,
}: {
  readonly listed: Call;
  readonly mayPlace: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const cache = useQueryClient();
  const words = useCallWords();
  const memberName = useMemberName(business.id);
  const softphone = useSoftphone();
  const [refusal, setRefusal] = useState<string | null>(null);
  // One request at a time, and none while a call is on: a second click would place a second
  // call, which rings this browser while it is busy and so never reaches the contact.
  const [placing, setPlacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const hangUpRef = useRef<HTMLButtonElement | null>(null);
  const key = ['b', business.id, 'call', listed.id] as const;
  const detail = useQuery({
    queryKey: key,
    queryFn: () => api.request(getCall, { params: { id: listed.id } }),
    refetchInterval: (query) =>
      query.state.data === undefined || isLive(query.state.data.state) ? LIVE_REFRESH_MS : false,
    retry: retryFaults,
  });
  const call: Call = detail.data ?? listed;
  const hangUp = useMutation({
    mutationFn: () => api.request(hangUpCall, { params: { id: listed.id } }),
    onSuccess: (answer) => {
      // The call as the server answers it: canceled if it was not placed yet, otherwise
      // still going with the hang-up asked for, until the provider reports the end.
      cache.setQueryData<CallDetail>(key, (before) => ({ ...answer, legs: before?.legs ?? [] }));
      void cache.invalidateQueries({ queryKey: ['b', business.id, 'calls'] });
      setConfirming(false);
    },
  });
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'medium' });
  const at = (value: string | null): string =>
    value === null ? '—' : moment.format(new Date(value));
  const seconds = durationOf(call);
  const notPlaced = call.state === 'requested';
  return (
    <div className={sidePanelBodyClassName}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={stateTone(call.state)}>{words.state(call)}</Badge>
        <span className="text-sm text-muted-foreground">
          {call.direction === 'outbound' ? t`Outgoing` : t`Incoming`}
        </span>
      </div>
      {call.failure === null ? null : <p className="text-sm">{words.failure(call.failure)}</p>}
      {call.state === 'unknown' ? (
        <p className="text-sm">
          <Trans>
            The provider's answer was lost, so this call may or may not have rung. It is never
            placed again by itself.
          </Trans>
        </p>
      ) : null}
      {call.needsReconciliation ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>
            The provider's reports disagree with this record. Check the call in your Twilio console.
          </Trans>
        </p>
      ) : null}
      {call.hangUpRequested && isLive(call.state) ? (
        <p role="status" className="text-sm">
          <Trans>Hang-up requested. The call ends when the provider reports it has.</Trans>
        </p>
      ) : null}
      {mayPlace && call.contactIdentityId !== null ? (
        <div className="flex flex-col items-start gap-1">
          <Button
            variant="secondary"
            disabled={
              placing || softphone?.state.device !== 'ready' || softphone.state.call !== null
            }
            onClick={() => {
              const identityId = call.contactIdentityId;
              if (identityId === null || softphone === null) return;
              setRefusal(null);
              setPlacing(true);
              void softphone
                .placeCall(identityId)
                .then((problem) => {
                  setRefusal(problem ?? null);
                })
                .finally(() => {
                  setPlacing(false);
                });
            }}
          >
            <Trans>Call back</Trans>
          </Button>
          {refusal !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {refusal}
            </p>
          ) : null}
        </div>
      ) : null}
      {mayPlace && canHangUp(call) ? (
        <Button
          ref={hangUpRef}
          variant="secondary"
          className="self-start border-destructive text-destructive"
          onClick={() => {
            hangUp.reset();
            setConfirming(true);
          }}
        >
          <Trans>Hang up</Trans>
        </Button>
      ) : null}
      {detail.isError ? (
        <ListProblem
          onRetry={() => {
            void detail.refetch();
          }}
        >
          <Trans>The call's latest details couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">
          <Trans>Other party</Trans>
        </dt>
        <dd className="wrap-anywhere">{call.remoteNumber ?? t`Hidden number`}</dd>
        <dt className="text-muted-foreground">
          <Trans>Business number</Trans>
        </dt>
        <dd className="wrap-anywhere">{call.localNumber}</dd>
        <dt className="text-muted-foreground">
          <Trans>Team member</Trans>
        </dt>
        <dd className="wrap-anywhere">{memberName(call.membershipId)}</dd>
        <dt className="text-muted-foreground">
          <Trans>Started</Trans>
        </dt>
        <dd>{at(call.createdAt)}</dd>
        <dt className="text-muted-foreground">
          <Trans>Answered</Trans>
        </dt>
        <dd>{at(call.connectedAt)}</dd>
        <dt className="text-muted-foreground">
          <Trans>Ended</Trans>
        </dt>
        <dd>{at(call.endedAt)}</dd>
        <dt className="text-muted-foreground">
          <Trans>Duration</Trans>
        </dt>
        <dd>{seconds === null ? '—' : durationText(seconds)}</dd>
        <dt className="text-muted-foreground">
          <Trans>Call ID</Trans>
        </dt>
        <dd>
          <code className="font-mono text-xs wrap-anywhere">{call.id}</code>
        </dd>
      </dl>
      <Legs
        legs={detail.data?.legs}
        loading={detail.isPending}
        words={words}
        memberName={memberName}
      />
      <ConfirmDialog
        open={confirming}
        title={notPlaced ? <Trans>Cancel this call?</Trans> : <Trans>Hang up this call?</Trans>}
        description={
          notPlaced ? (
            <Trans>It hasn't been placed yet, so it won't be.</Trans>
          ) : (
            <Trans>
              The provider is asked to end it. It shows as ended once the provider reports so.
            </Trans>
          )
        }
        confirmLabel={notPlaced ? t`Cancel the call` : t`Hang up`}
        destructive
        busy={hangUp.isPending}
        problem={
          hangUp.isError
            ? hangUp.error instanceof ApiError
              ? hangUp.error.message
              : t`The hang-up wasn't sent. Check your connection and try again.`
            : undefined
        }
        returnFocus={hangUpRef}
        onConfirm={() => {
          hangUp.mutate();
        }}
        onClose={() => {
          setConfirming(false);
        }}
      />
    </div>
  );
}

function Legs({
  legs,
  loading,
  words,
  memberName,
}: {
  readonly legs: readonly CallLeg[] | undefined;
  readonly loading: boolean;
  readonly words: ReturnType<typeof useCallWords>;
  readonly memberName: (membershipId: string | null) => string;
}): ReactElement {
  const { t } = useLingui();
  return (
    <section aria-label={t`Call legs`} className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-medium">
        <Trans>Call legs</Trans>
      </h3>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading call legs…</Trans>
        </p>
      ) : legs === undefined ? null : legs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No call legs yet.</Trans>
        </p>
      ) : (
        <div
          role="region"
          aria-label={t`Call legs table`}
          // The scrolling table must be reachable by keyboard (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
          tabIndex={0}
          className={tableRegionClassName}
        >
          <table aria-label={t`Call legs`} className={`${tableClassName} min-w-[440px]`}>
            <thead>
              <tr>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Reaches</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Status</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Duration</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg) => (
                <tr key={leg.id}>
                  <th scope="row" className={`${cellClassName} text-left font-normal`}>
                    {leg.party === 'remote' ? t`The other party` : memberName(leg.membershipId)}
                  </th>
                  <td className={cellClassName}>
                    <span className="flex min-w-0 flex-col">
                      <span>{words.leg(leg.status)}</span>
                      {leg.conflict ? (
                        <span className="text-xs text-destructive">
                          <Trans>Reports disagree</Trans>
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className={cellClassName}>
                    {leg.durationSeconds === null ? '—' : durationText(leg.durationSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
