export interface RoundRobinCandidate {
  readonly userId: string;
  readonly available: boolean;
  readonly order: number;
  readonly priority: 'high' | 'medium' | 'low';
  readonly weight: number;
  readonly weightedCount: bigint;
  readonly monthlyCount: bigint;
}
export interface RoundRobinSelection {
  readonly mode: 'weighted' | 'availability' | 'equal';
  readonly candidates: readonly RoundRobinCandidate[];
  readonly requestedUserId?: string;
  readonly preferredOwnerUserId?: string;
}

const priority = { high: 0, medium: 1, low: 2 } as const;

/** Calendar commands validate current membership, availability and saved configuration. */
export function selectRoundRobinMember(input: RoundRobinSelection): string | undefined {
  if (input.requestedUserId !== undefined)
    return input.candidates.find(
      (member) => member.userId === input.requestedUserId && member.available,
    )?.userId;
  if (input.preferredOwnerUserId !== undefined) {
    const owner = input.candidates.find((member) => member.userId === input.preferredOwnerUserId);
    if (owner !== undefined) return owner.available ? owner.userId : undefined;
  }
  const first = input.candidates[0];
  if (first === undefined) return undefined;
  if (input.mode === 'weighted')
    return chooseWeightedMember(
      input.candidates
        .filter((member) => member.available)
        .map((member) => ({
          id: member.userId,
          weight: member.weight,
          assignedCount: member.weightedCount,
        })),
    );
  const minimum = input.candidates.reduce(
    (count, member) => (member.monthlyCount < count ? member.monthlyCount : count),
    first.monthlyCount,
  );
  return [...input.candidates]
    .filter(
      (member) =>
        member.available && (input.mode !== 'equal' || member.monthlyCount - minimum < 3n),
    )
    .sort((a, b) => {
      if (input.mode === 'equal' && a.monthlyCount !== b.monthlyCount)
        return a.monthlyCount < b.monthlyCount ? -1 : 1;
      return (
        (input.mode === 'availability' ? priority[a.priority] - priority[b.priority] : 0) ||
        a.order - b.order ||
        a.userId.localeCompare(b.userId)
      );
    })
    .at(0)?.userId;
}
import { chooseWeightedMember } from './slots.js';
