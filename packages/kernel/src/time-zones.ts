/**
 * Whether the value names an IANA time zone, such as Africa/Nairobi, or one of its
 * aliases. Fixed UTC offsets such as +05:30 are refused: they have no daylight-saving
 * rules, so bookings and quiet hours would drift twice a year.
 *
 * The name is kept as given. ICU would rename current IANA names to its older ones
 * (Asia/Kolkata to Asia/Calcutta), so it isn't used to rewrite them.
 */
export function isTimeZone(value: string): boolean {
  if (value.startsWith('+') || value.startsWith('-')) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
