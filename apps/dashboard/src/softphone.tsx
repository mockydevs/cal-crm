// The in-browser softphone, mounted once per business. This file is all the business layout
// carries: it asks whether the person may place calls and whether calling is available, and
// only when both are true does it fetch the controller, the call bar and their words
// (softphone-active.tsx), so nobody else downloads them or loads the calling SDK.
import { getCallingAvailability, getMyPermissions } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { useQuery } from '@tanstack/react-query';
import {
  createContext,
  lazy,
  Suspense,
  use,
  type ComponentType,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { apiIn } from './api';
import type { ActiveSoftphoneProps, CreateVoice, SoftphoneValue } from './softphone-types';
import { loadSoftphoneWords } from './softphone-words';

export type { CreateVoice, SoftphoneValue } from './softphone-types';

const SoftphoneContext = createContext<SoftphoneValue | null>(null);

/** The softphone, or null while the person may not place calls or calling is unavailable. */
export function useSoftphone(): SoftphoneValue | null {
  return use(SoftphoneContext);
}

// A softphone that couldn't be fetched (a lost connection, a deploy since the page loaded)
// is left off until the next load: thrown, it would take the business's pages down with it.
const ActiveSoftphone = lazy(
  async (): Promise<{ default: ComponentType<ActiveSoftphoneProps> }> => {
    try {
      const [active] = await Promise.all([import('./softphone-active'), loadSoftphoneWords()]);
      return { default: active.ActiveSoftphone };
    } catch {
      return { default: () => null };
    }
  },
);

/** A refusal is the answer; a fault or a lost connection is worth two more tries. */
const retryFaults = (failures: number, error: unknown): boolean =>
  !(error instanceof ApiError && error.status < 500) && failures < 2;

export interface SoftphoneProviderProps {
  readonly businessId: string;
  readonly children: ReactNode;
  readonly createVoice?: CreateVoice | undefined;
}

/**
 * Gives the business's pages the softphone. The pages stay the same element whether or not
 * the softphone is on: the active part is a sibling that hands its value up, so turning it
 * on never mounts a page again (which would lose its state, focus and queries).
 */
export function SoftphoneProvider({
  businessId,
  children,
  createVoice,
}: SoftphoneProviderProps): ReactElement {
  const client = useMemo(() => apiIn(businessId), [businessId]);
  const grants = useQuery({
    queryKey: ['b', businessId, 'my-permissions'],
    queryFn: () => client.request(getMyPermissions, {}),
    retry: retryFaults,
  });
  const availability = useQuery({
    queryKey: ['b', businessId, 'calling-availability'],
    queryFn: () => client.request(getCallingAvailability, {}),
    retry: retryFaults,
  });
  const [value, setValue] = useState<SoftphoneValue | null>(null);
  const canCall =
    grants.data?.permissions.includes('calls.place') === true &&
    availability.data?.available === true;

  return (
    <SoftphoneContext value={canCall ? value : null}>
      {children}
      {canCall ? (
        <Suspense fallback={null}>
          <ActiveSoftphone businessId={businessId} createVoice={createVoice} onValue={setValue} />
        </Suspense>
      ) : null}
    </SoftphoneContext>
  );
}
