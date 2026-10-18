// The rules of a notification that need no database: who is left to tell once the person
// who caused it is taken out, who holds a permission, what a preference is when nobody
// chose, and how an event's payload is read.
import {
  formNotify,
  NOTIFICATION_DEFAULT_IN_APP,
  notificationKinds,
  permissionsOf,
  type FormNotify,
  type NotificationKind,
  type NotificationPreferences,
  type Permission,
  type PermissionScope,
} from '@repo/contracts';
import { isUuidV7, type ActorKind } from '@repo/kernel';

/** Who or what caused something, as an event records its actor. */
export interface Cause {
  readonly kind: ActorKind;
  readonly id: string | null;
}

/**
 * The people to tell, each once, in the order given, and never the person who caused it:
 * nobody is told of what they did themselves. Only a person can be that cause; an
 * automation or an API key with the same id as nobody is not.
 */
export function recipientsOf(
  candidates: readonly (string | null | undefined)[],
  cause: Cause,
): string[] {
  const people = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (cause.kind === 'user' && cause.id === candidate) continue;
    people.add(candidate);
  }
  return [...people];
}

/** A person's membership where a notification is, with the role it gives them. */
export interface MemberRole {
  readonly userId: string;
  readonly scope: PermissionScope;
  readonly key: string;
  readonly isBuiltin: boolean;
  readonly permissions: readonly string[];
}

/**
 * The people whose role allows any of these, where the notification is: in a business,
 * a business role's permissions and an agency role's business permissions; at the agency,
 * only an agency role's. Each person once, whichever membership allows it.
 */
export function holdersOf(
  members: readonly MemberRole[],
  anyOf: readonly Permission[],
  at: PermissionScope,
): string[] {
  const holders = new Set<string>();
  for (const member of members) {
    const granted = permissionsOf(member, at);
    if (anyOf.some((permission) => granted.has(permission))) holders.add(member.userId);
  }
  return [...holders];
}

/** Every kind, on or off: what was stored for a kind, and the default for the rest. */
export function preferencesOf(
  stored: readonly {
    readonly kind: string;
    readonly in_app: boolean;
    readonly remind_minutes?: number | null;
  }[],
): NotificationPreferences {
  const chosen = new Map(stored.map((row) => [row.kind, row]));
  return {
    items: notificationKinds.map((kind) => ({
      kind,
      inApp: chosen.get(kind)?.in_app ?? NOTIFICATION_DEFAULT_IN_APP,
      // How long before a task is due its reminder comes: none until the person chooses.
      ...(kind === 'task.reminder'
        ? { remindMinutes: chosen.get(kind)?.remind_minutes ?? null }
        : {}),
    })),
  };
}

/** The kind a stored row names, when the catalog still has it. */
export function kindOf(value: string): NotificationKind | undefined {
  return notificationKinds.find((kind) => kind === value);
}

/**
 * An id an event's payload carries under a key. Payloads are written by our own commands,
 * but a job reads whatever is stored: anything that is not one of our ids is no id.
 */
export function idIn(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value: unknown = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'string' && isUuidV7(value) ? value : undefined;
}

/**
 * Text cut to what a notification holds: trimmed, at most `max` characters with an
 * ellipsis in the last place when it was longer, and null when nothing is left.
 */
export function shortened(text: string | null | undefined, max: number): string | null {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return null;
  // By code point, as PostgreSQL's length() counts: a character outside the basic plane is one.
  const characters = Array.from(trimmed);
  return characters.length <= max ? trimmed : `${characters.slice(0, max - 1).join('')}…`;
}

/** What an event's notification is made once from. */
export const eventSource = (eventId: string): string => `event:${eventId}`;

/** What a task's reminder is made once from: the task and the due time it is before. */
export const reminderSource = (taskId: string, dueAt: Date): string =>
  `task.reminder:${taskId}:${dueAt.toISOString()}`;

/** What a task's due notification is made once from: the task and that due time. */
export const dueSource = (taskId: string, dueAt: Date): string =>
  `task.due:${taskId}:${dueAt.toISOString()}`;

/**
 * Who a form says to tell of a submission, read from its published definition as the forms
 * module stores it. A form that names nothing, one written before forms could say, and a
 * definition that cannot be read all tell the people who manage forms.
 */
export function formNotifyOf(definition: unknown): FormNotify {
  const named: unknown =
    typeof definition === 'object' && definition !== null && !Array.isArray(definition)
      ? (definition as Readonly<Record<string, unknown>>)['notify']
      : undefined;
  const parsed = formNotify.safeParse(named);
  return parsed.success ? parsed.data : { mode: 'managers' };
}
