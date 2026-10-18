// The exclusion constraints that refuse an overlapping appointment of one person: within
// one business (0040), and across every business the person belongs to (0102). Each stays
// the last word against any writer, whatever the slot search found.
const CONSTRAINTS: ReadonlySet<string> = new Set([
  'appointments_no_double_booking',
  'host_bookings_no_overlap',
]);

export const isDoubleBooking = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  error.code === '23P01' &&
  'constraint' in error &&
  typeof error.constraint === 'string' &&
  CONSTRAINTS.has(error.constraint);
