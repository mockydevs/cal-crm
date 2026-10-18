import type { Invocation } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { ForbiddenError, type ActorKind } from '@repo/kernel';

/**
 * The actors that never design tags, whatever permissions their invocation carries: an
 * automation and an assistant, and the public's own actors, a form and a visitor (a
 * booking, a chat). Each applies the tags that exist. The one tag any of them causes to be
 * made is the system's own tag of a built-in lead source, which lead-source-tags.ts makes
 * from a closed list of keys and by no command.
 */
const NEVER_DESIGNERS: ReadonlySet<ActorKind> = new Set([
  'ai_agent',
  'automation',
  'form',
  'contact',
]);

/** Trusted actor identity decides whether definitions may be changed. */
export function canDesignTags(invocation: Invocation): boolean {
  return !NEVER_DESIGNERS.has(invocation.context.actorKind);
}

const PUBLIC_ACTORS: ReadonlySet<ActorKind> = new Set(['form', 'contact']);

export function canConfigureTags(invocation: Invocation): boolean {
  return (
    canDesignTags(invocation) &&
    (invocation.permissions === 'all' || invocation.permissions.has('tags.configure'))
  );
}

export function requireTagDesigner(invocation: Invocation, permission: Permission): void {
  if (!canDesignTags(invocation))
    throw new ForbiddenError(
      PUBLIC_ACTORS.has(invocation.context.actorKind)
        ? 'A form or a visitor can only apply existing tags.'
        : 'Automations and AI can only apply existing tags.',
      permission,
    );
}

/**
 * The in-app assistant, working for the person who asked it. It may create a tag where that
 * person could: it carries their permissions and nothing more, and the command layer holds
 * it to the business's rule for building drafts. It changes no existing tag, no group and
 * no rule.
 */
export function isPersonsAssistant(invocation: Invocation): boolean {
  return invocation.context.actorKind === 'ai_agent' && invocation.agent === 'copilot';
}
