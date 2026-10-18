// What the autonomy control decides without drawing anything, with tests beside it. Kept
// apart from the Inbox's rules so Settings, which shows the same control, loads none of them.
import type { AutonomyLevel, AutonomySetting } from '@repo/contracts';

/**
 * Whether saving a level would change nothing, by what was last read: the level already
 * applies, or there is no level of the contact's own to give up (null).
 */
export function levelAlreadySet(
  autonomy: Pick<AutonomySetting, 'level' | 'source'>,
  level: AutonomyLevel | null,
  /** Where a level set here is kept: for one contact, or for the whole business. */
  scope: 'contact' | 'business',
): boolean {
  if (level === null) return scope === 'contact' ? autonomy.source !== 'contact' : false;
  return autonomy.level === level && (scope === 'business' || autonomy.source === 'contact');
}
