import * as z from 'zod';

/** A moment in time, in ISO 8601 with its UTC offset. The API sends UTC, ending in Z. */
export const timestamp = z.iso
  .datetime({ offset: true })
  .meta({ id: 'Timestamp', examples: ['2026-10-07T09:30:00.000Z'] });
