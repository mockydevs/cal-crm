import { createHash } from 'node:crypto';

/** What sending checks, as the API names it. */
export interface QuietHoursValues {
  readonly quietHoursEnabled: boolean;
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
  readonly contactDailyLimit: number;
}

/**
 * What applies to a business that never saved settings. These are the table's defaults
 * (0006, 0032), which sending also falls back to when there is no row.
 */
export const quietHoursDefaults: QuietHoursValues = {
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  contactDailyLimit: 10,
};

/** A PostgreSQL time such as 21:00:00 as the API's 21:00. */
export function clockOf(time: string): string {
  return time.slice(0, 5);
}

/** Names the values a save was based on, so a save over someone else's is refused. */
export function quietHoursRevision(values: QuietHoursValues): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        values.quietHoursEnabled,
        values.quietHoursStart,
        values.quietHoursEnd,
        values.contactDailyLimit,
      ]),
    )
    .digest('hex');
}
