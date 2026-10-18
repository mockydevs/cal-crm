/** What every duplicate query of a business starts with, so a rejection refreshes them all. */
export const duplicatesKey = (businessId: string) =>
  ['b', businessId, 'contact-duplicates'] as const;
