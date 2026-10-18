import type { PhoneNumberSettings, PhoneSystemSettings } from '@repo/contracts';

export type InboundDestination =
  | { readonly kind: 'client'; readonly address: string; readonly membershipId: string }
  | { readonly kind: 'number'; readonly address: string };
export type InboundRoute =
  | { readonly outcome: 'refused'; readonly reason: 'number_unavailable' | 'anonymous_caller' }
  | {
      readonly outcome: 'route';
      readonly steps: readonly (readonly InboundDestination[])[];
      readonly voicemail: boolean;
      readonly timeoutSeconds: number;
      readonly callerId: string;
    };

/**
 * Worker supplies current tenant-eligible, calling-enabled members and their server-
 * derived device identities, plus all of this business's registered numbers. Persist
 * this plan's steps under the call before returning Dial instructions; each action
 * must advance the stored step once, never generate the next step from request input.
 */
export function resolveInboundRoute(input: {
  readonly number: Pick<PhoneNumberSettings, 'ownerId' | 'voice' | 'e164' | 'status'> & {
    readonly capabilities: readonly string[];
  };
  readonly inbound: PhoneSystemSettings['inbound'];
  readonly caller: string;
  readonly contactOwnerMembershipId: string | null;
  readonly connectionReady: boolean;
  readonly members: ReadonlyMap<string, string>;
  readonly ownNumbers: readonly string[];
}): InboundRoute {
  const { number, inbound, members } = input;
  const voice = number.voice;
  if (
    !input.connectionReady ||
    number.status !== 'active' ||
    !number.capabilities.includes('voice') ||
    voice === null
  )
    return { outcome: 'refused', reason: 'number_unavailable' };
  const callerNumber = /^\+[1-9][0-9]{6,14}$/.test(input.caller);
  if (
    !inbound.allowAnonymousCallers &&
    !callerNumber &&
    !/^client:[A-Za-z0-9_]{1,121}$/.test(input.caller)
  )
    return { outcome: 'refused', reason: 'anonymous_caller' };
  const steps: InboundDestination[][] = [];
  const visited = new Set<string>();
  const group = (membershipIds: readonly (string | null)[]) => {
    const destinations: InboundDestination[] = [];
    for (const membershipId of membershipIds) {
      const identity = membershipId === null ? undefined : members.get(membershipId);
      if (
        membershipId === null ||
        identity === undefined ||
        !/^[A-Za-z0-9_]{1,121}$/.test(identity) ||
        visited.has(`client:${identity}`)
      )
        continue;
      visited.add(`client:${identity}`);
      destinations.push({ kind: 'client', address: identity, membershipId });
    }
    if (destinations.length > 0) steps.push(destinations);
  };
  if (voice.advanced.preferContactOwner) group([input.contactOwnerMembershipId]);
  if (inbound.preferAssignedUser) group([number.ownerId]);
  group([voice.routing.primaryMemberId, ...voice.routing.ringAlso]);
  const external = (address: string | null) => {
    if (
      address === null ||
      input.ownNumbers.includes(address) ||
      address === number.e164 ||
      visited.has(`number:${address}`)
    )
      return;
    visited.add(`number:${address}`);
    steps.push([{ kind: 'number', address }]);
  };
  external(voice.routing.forwardTo);
  if (voice.routing.useBusinessFallback) external(inbound.fallbackNumber);
  return {
    outcome: 'route',
    steps,
    voicemail: voice.routing.voicemailBackup,
    // Twilio adds roughly 5s. Its minimum is 5s, so settings below 10s cannot
    // promise that exact wall-clock duration, so short timeouts are warned about.
    // https://www.twilio.com/docs/voice/twiml/dial#timeout
    timeoutSeconds: Math.max(5, voice.routing.ringTimeoutSeconds - 5),
    callerId:
      voice.advanced.forwardedCallerId === 'caller' && callerNumber ? input.caller : number.e164,
  };
}
