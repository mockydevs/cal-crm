// Proposals, as rules with no database in them: what may become of a stored command an
// assistant wants run. Every caller decides the same way, because these are the only
// decisions there are: a proposal is applied once, never when it is stale or its time is
// up; a waiting one can be dismissed; and an applied one is undone only when something can
// reverse it, and only once.
import type { ProposalKind, ProposalStatus } from '@repo/contracts';

/** A plain JSON object, as a proposal's row keeps a command's input and its outcome. */
export type JsonRecord = Readonly<Record<string, unknown>>;

/**
 * How to reverse an applied proposal: the kind of proposable whose command undoes it, with
 * that command's input, or the reason nothing can.
 */
export type UndoPlan =
  { readonly kind: ProposalKind; readonly input: JsonRecord } | { readonly impossible: string };

export interface ProposalState {
  readonly status: ProposalStatus;
  readonly expiresAt: Date | null;
  /** What the proposal was made on, as its proposable fingerprinted it then. */
  readonly revision: string;
}

export type ApplyDecision =
  | { readonly action: 'run' }
  /** Already applied: answer with what the first Apply made, and run nothing. */
  | { readonly action: 'repeat' }
  | {
      readonly action: 'refuse';
      readonly reason: 'dismissed' | 'expired' | 'undone' | 'stale';
    };

/**
 * What Apply does with a proposal in this state, given the time and the record's
 * fingerprint now. Only a waiting proposal runs, and only while its time is not up and
 * what it was made on has not changed.
 */
export function decideApply(state: ProposalState, now: Date, revisionNow: string): ApplyDecision {
  switch (state.status) {
    case 'applied':
      return { action: 'repeat' };
    case 'dismissed':
    case 'expired':
    case 'undone':
      return { action: 'refuse', reason: state.status };
    case 'pending':
      if (state.expiresAt !== null && state.expiresAt.getTime() <= now.getTime())
        return { action: 'refuse', reason: 'expired' };
      if (state.revision !== revisionNow) return { action: 'refuse', reason: 'stale' };
      return { action: 'run' };
  }
}

export type DismissDecision =
  | { readonly action: 'dismiss' }
  | { readonly action: 'repeat' }
  | { readonly action: 'refuse'; readonly reason: 'applied' | 'expired' | 'undone' };

/** What Dismiss does: a waiting proposal is dismissed, stale or not; a decided one stays. */
export function decideDismiss(
  state: Pick<ProposalState, 'status' | 'expiresAt'>,
  now: Date,
): DismissDecision {
  switch (state.status) {
    case 'dismissed':
      return { action: 'repeat' };
    case 'applied':
    case 'expired':
    case 'undone':
      return { action: 'refuse', reason: state.status };
    case 'pending':
      return state.expiresAt !== null && state.expiresAt.getTime() <= now.getTime()
        ? { action: 'refuse', reason: 'expired' }
        : { action: 'dismiss' };
  }
}

export type UndoDecision =
  | { readonly action: 'run'; readonly kind: ProposalKind; readonly input: JsonRecord }
  | { readonly action: 'repeat' }
  | { readonly action: 'refuse'; readonly reason: 'not_applied' }
  | { readonly action: 'refuse'; readonly reason: 'impossible'; readonly why: string };

/** What Undo does: only an applied proposal with a way back is reversed, and only once. */
export function decideUndo(state: {
  readonly status: ProposalStatus;
  readonly undo: UndoPlan | null;
}): UndoDecision {
  if (state.status === 'undone') return { action: 'repeat' };
  if (state.status !== 'applied' || state.undo === null)
    return { action: 'refuse', reason: 'not_applied' };
  if ('impossible' in state.undo)
    return { action: 'refuse', reason: 'impossible', why: state.undo.impossible };
  return { action: 'run', kind: state.undo.kind, input: state.undo.input };
}
