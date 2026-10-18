// Which value a merged contact keeps, field by field, as GoHighLevel's Merge Contacts picks
// it: the contact kept keeps its own value, unless the person merging picked another
// contact's; a field it has empty takes the first value the others have, in the order they
// were named. Do not disturb is never picked: the strictest setting of all of them is kept,
// so merging never loses an opt-out. Pure: the command reads the contacts and applies these.
import { dndChannels, type DndChannel } from '@repo/contracts';

export interface FieldChoice {
  /** The contact kept. */
  readonly survivorId: string;
  /** The contacts merged into it, in the order they were named. */
  readonly mergeIds: readonly string[];
  /** The contacts that have a value in the field. */
  readonly holders: ReadonlySet<string>;
  /** The contact whose value was picked, when one was. */
  readonly chosen?: string | undefined;
}

/**
 * The contact whose value the field keeps, or null when none has one. A picked contact is
 * kept even when it has no value: the person merging chose to leave the field empty.
 */
export function sourceOf(choice: FieldChoice): string | null {
  if (choice.chosen !== undefined) return choice.chosen;
  return [choice.survivorId, ...choice.mergeIds].find((id) => choice.holders.has(id)) ?? null;
}

/** A contact's do not disturb settings. */
export interface DndSettings {
  readonly doNotContact: boolean;
  readonly channels: readonly string[];
  readonly inbound: boolean;
}

/** The strictest of the settings: any contact's opt-out holds for the contact kept. */
export function strictestDnd(settings: readonly DndSettings[]): {
  readonly doNotContact: boolean;
  readonly channels: DndChannel[];
  readonly inbound: boolean;
} {
  return {
    doNotContact: settings.some((each) => each.doNotContact),
    // In the contract's order, each once, whatever order the contacts stored them in.
    channels: dndChannels.filter((channel) =>
      settings.some((each) => each.channels.includes(channel)),
    ),
    inbound: settings.some((each) => each.inbound),
  };
}

/** How a contact came to be: when, and how. */
export interface Creation {
  readonly id: string;
  readonly createdAt: Date;
}

/**
 * The contact that came first, whose creation the contact kept takes: GoHighLevel's own
 * merge keeps the older contact. Ties go to the earlier id.
 */
export function oldest<Row extends Creation>(rows: readonly [Row, ...Row[]]): Row {
  return rows.reduce((first, row) =>
    row.createdAt.getTime() < first.createdAt.getTime() ||
    (row.createdAt.getTime() === first.createdAt.getTime() && row.id < first.id)
      ? row
      : first,
  );
}

/**
 * The score of the contact kept: what every contact had scored, added up, within the
 * score's bounds. Null when none had a score.
 */
export function combinedScore(scores: readonly (number | null)[], limit: number): number | null {
  const scored = scores.filter((score): score is number => score !== null);
  if (scored.length === 0) return null;
  const total = scored.reduce((sum, score) => sum + score, 0);
  return Math.min(Math.max(total, -limit), limit);
}
