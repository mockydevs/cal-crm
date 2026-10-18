// The automations a step can name: "Start another automation" starts one, and "Remove from
// automations" ends the contact's runs in some. The choices are the business's other
// automations, published first, each with its status, so a target that would start nothing
// (a draft, a paused one) is seen before the step is saved. A reference written by hand,
// by id or by name, is read as the validator reads it.
import { i18n } from '@lingui/core';
import { t } from '@lingui/core/macro';
import { MAX_REMOVE_AUTOMATIONS } from '@repo/contracts';

export interface Target {
  readonly id: string;
  readonly name: string;
  /** As the workflows list gives it; nothing until that list has been read. */
  readonly status: string | undefined;
}

// Published first: those are the ones a step can start now.
const ORDER: readonly (string | undefined)[] = ['active', 'paused', 'draft', undefined];

const rank = (status: string | undefined): number => {
  const place = ORDER.indexOf(status);
  return place === -1 ? ORDER.length : place;
};

/**
 * The automations a step can name: every one the business has but the one being edited,
 * which is kept only where a step already names it.
 */
export function targetsOf(
  automations: readonly { readonly id: string; readonly name: string }[],
  listed: readonly { readonly id: string; readonly status: string }[] | undefined,
  self: string | undefined,
  named: readonly string[],
): Target[] {
  const statuses = new Map(listed?.map((each) => [each.id, each.status]));
  return automations
    .filter((each) => each.id !== self || named.includes(each.id))
    .map((each) => ({ id: each.id, name: each.name, status: statuses.get(each.id) }))
    .sort(
      (one, other) =>
        rank(one.status) - rank(other.status) ||
        one.name.localeCompare(other.name, i18n.locale || undefined),
    );
}

/** The target a reference stands for: by id, or by a name only one of them has. */
function targetOf(targets: readonly Target[], reference: string): string | undefined {
  const byId = targets.find((each) => each.id === reference);
  if (byId !== undefined) return byId.id;
  const wanted = reference.trim().toLowerCase();
  const byName = targets.filter((each) => each.name.trim().toLowerCase() === wanted);
  return byName.length === 1 ? byName[0]?.id : undefined;
}

/** What a setting names: the targets it stands for, and the references nothing answers to. */
export function chosenTargets(
  targets: readonly Target[],
  given: unknown,
): { readonly ids: string[]; readonly unknown: string[] } {
  const references = (Array.isArray(given) ? (given as readonly unknown[]) : [given]).filter(
    (each): each is string => typeof each === 'string' && each !== '',
  );
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const reference of references) {
    const id = targetOf(targets, reference);
    if (id === undefined) unknown.push(reference);
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unknown };
}

/** A status as the workflows list names it; nothing for one this version doesn't know. */
export function statusWords(status: string | undefined): string | undefined {
  switch (status) {
    case 'active':
      return t`Published`;
    case 'paused':
      return t`Paused`;
    case 'draft':
      return t`Draft`;
    case 'archived':
      return t`Deleted`;
    case undefined:
    default:
      return undefined;
  }
}

/** A choice in a list: its name, with its status when that is known. */
export function targetLabel(target: Target): string {
  const { name } = target;
  const status = statusWords(target.status);
  return status === undefined ? name : t`${name} (${status})`;
}

/** What starting a target that isn't published does: nothing, and when that changes. */
export function inactiveNote(target: Target | undefined): string | undefined {
  if (target === undefined) return undefined;
  const { name } = target;
  switch (target.status) {
    case 'paused':
      return t`“${name}” is paused. This action starts nothing until it is published again.`;
    case 'draft':
      return t`“${name}” is a draft. This action starts nothing until it is published.`;
    case 'archived':
      return t`“${name}” is deleted. This action starts nothing.`;
    case undefined:
    default:
      return undefined;
  }
}

/** Whether a list holds as many automations as one step may name. */
export const atTheMost = (chosen: readonly unknown[]): boolean =>
  chosen.length >= MAX_REMOVE_AUTOMATIONS;
