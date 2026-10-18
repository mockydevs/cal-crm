// What Settings → Integrations works out before it draws: the chips above the grid, which
// cards a chip and a search leave, where an operator's guide is read, which outcome the
// provider's sign-in came back with, and how the Manage panel asks for older activity.
// Every choice comes from the contract's own lists, never one kept here.
import {
  integrationCategories,
  integrationConnectOutcomes,
  type IntegrationActivity,
  type IntegrationCategory,
  type IntegrationConnection,
  type IntegrationConnectOutcome,
  type IntegrationEntry,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';

/** A chip above the grid: everything, what is connected, or one category. */
export type Chip = 'all' | 'connected' | IntegrationCategory;

/** The public repository, where an operator reads the project's docs to set an integration up. */
export const DOCS_BASE = 'https://github.com/mockydevs/cal-crm/blob/main/';

/** Connected, for the Connected chip: working or needing someone, not still checking. */
export const isConnected = (entry: Pick<IntegrationEntry, 'state'>): boolean =>
  entry.state === 'connected' || entry.state === 'needs_attention';

/** All and Connected, then each category in the contract's order that has a card. */
export function chipsOf(entries: readonly Pick<IntegrationEntry, 'category'>[]): Chip[] {
  const present = new Set(entries.map((each) => each.category));
  return ['all', 'connected', ...integrationCategories.filter((each) => present.has(each))];
}

/**
 * The cards a chip and a search leave, in the order the server sent them. The search looks
 * through what the card says, its name and description in the reader's language.
 */
export function shownOf<Entry extends Pick<IntegrationEntry, 'category' | 'state'>>(
  entries: readonly Entry[],
  chip: Chip,
  query: string,
  textOf: (entry: Entry) => string,
): Entry[] {
  const words = query.trim().toLocaleLowerCase();
  return entries.filter(
    (entry) =>
      (chip === 'all' || (chip === 'connected' ? isConnected(entry) : entry.category === chip)) &&
      (words === '' || textOf(entry).toLocaleLowerCase().includes(words)),
  );
}

/** Whether a card is waiting for its account's first check: the page asks again soon. */
export const anyConnecting = (entries: readonly Pick<IntegrationEntry, 'state'>[]): boolean =>
  entries.some((each) => each.state === 'connecting');

/** An operator's guide, a path in the project's docs, as a link to read it on GitHub. */
export const guideUrl = (path: string): string => DOCS_BASE + path.replace(/^\/+/, '');

/** The outcome the address carries, when it is one the callback sends. */
export const outcomeOf = (value: string | undefined): IntegrationConnectOutcome | undefined =>
  integrationConnectOutcomes.find((each) => each === value);

/** When an account was last checked, whichever way the check went. */
export function lastCheckedOf(
  connection: Pick<IntegrationConnection, 'lastOkAt' | 'lastErrorAt'>,
): string | null {
  const { lastOkAt, lastErrorAt } = connection;
  if (lastOkAt === null) return lastErrorAt;
  if (lastErrorAt === null) return lastOkAt;
  return Date.parse(lastOkAt) >= Date.parse(lastErrorAt) ? lastOkAt : lastErrorAt;
}

/** Where an account's older activity starts: before the oldest of it the panel shows. */
export interface ActivityCursor {
  readonly connectionId: string;
  readonly before: string;
}

/**
 * The first "Older" asks each account for what came before the oldest of its own the panel
 * shows. The panel shows the latest of all its accounts together, so an account with none
 * shown has nothing newer than the oldest shown: it is asked from there. Nothing shown,
 * nothing older.
 */
export function firstCursors(
  connectionIds: readonly string[],
  shown: readonly Pick<IntegrationActivity, 'connectionId' | 'at'>[],
): ActivityCursor[] {
  const oldest = shown.at(-1);
  if (oldest === undefined) return [];
  return connectionIds.map((connectionId) => ({
    connectionId,
    before: shown.findLast((each) => each.connectionId === connectionId)?.at ?? oldest.at,
  }));
}

/** Activity from several accounts as one list, newest first. */
export const newestFirst = <Item extends Pick<IntegrationActivity, 'at'>>(
  items: readonly Item[],
): Item[] => [...items].sort((one, other) => Date.parse(other.at) - Date.parse(one.at));

/** What the server said, or the page's own words when no answer came. */
export const saidBy = (error: unknown, fallback: string): string =>
  error instanceof ApiError
    ? (error.problem.errors?.[0]?.message ?? error.problem.detail ?? error.message)
    : fallback;
