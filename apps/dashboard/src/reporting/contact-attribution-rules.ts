// What the contact page's Attribution group works out before it draws
// (contact-attribution.tsx): which facts a touch holds, in the order they are shown, whose
// click ids it holds, and whether the first and the latest touch are one and the same.
import type { ContactAttribution } from '@repo/contracts';
import { platformsOf } from '../click-id-platforms';

/** What a visit can say beyond its sources, in the order the page lists it. */
export const touchFactKeys = [
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
  'matchType',
  'campaignId',
  'adGroupId',
  'adId',
  'referrerDomain',
  'landingUrl',
  'pageUrl',
] as const;
export type TouchFactKey = (typeof touchFactKeys)[number];

export interface TouchFact {
  readonly key: TouchFactKey;
  readonly value: string;
}

/**
 * How the visitor arrived was handed on from the page the visit began on to the page the
 * lead was taken on: the two pages are then both said, even when they are one and the same
 * address.
 */
export const isCarried = (touch: Pick<ContactAttribution, 'arrivalCarried'>): boolean =>
  touch.arrivalCarried === true;

/**
 * The facts a touch holds: what it did not say is left out, and so is the page of the
 * interaction while it is the page they landed on, which is said once. A carried arrival
 * says both pages.
 */
export function touchFacts(touch: ContactAttribution): TouchFact[] {
  const facts: TouchFact[] = [];
  for (const key of touchFactKeys) {
    const value = touch[key];
    if (value === null || value === '') continue;
    if (key === 'pageUrl' && value === touch.landingUrl && !isCarried(touch)) continue;
    facts.push({ key, value });
  }
  return facts;
}

export interface TouchRow {
  readonly key: TouchFactKey;
  /** Null for what the visit did not say. */
  readonly value: string | null;
}

/** Every fact a touch can hold, in the page's order, said or not: what "Show all fields" lists. */
export const allTouchRows = (touch: ContactAttribution): TouchRow[] =>
  touchFactKeys.map((key) => {
    const value = touch[key];
    return { key, value: value === '' ? null : value };
  });

/** The rows the page lists: what the visit said, or everything when all fields are asked for. */
export const touchRows = (touch: ContactAttribution, all: boolean): TouchRow[] =>
  all ? allTouchRows(touch) : touchFacts(touch);

/** Whose click ids the touch holds, by platform: names, never the ids themselves. */
export const heldClickIds = (touch: Pick<ContactAttribution, 'clickIds'>): string[] =>
  platformsOf(touch.clickIds);

/** The contact has one touch recorded: its first and its latest are the same one. */
export const isOneTouch = (
  first: Pick<ContactAttribution, 'touchedAt'> | null,
  latest: Pick<ContactAttribution, 'touchedAt'> | null,
): boolean => first !== null && latest !== null && first.touchedAt === latest.touchedAt;
