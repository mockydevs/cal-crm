// Who a saved view is shared with, as the Sharing & permissions step edits it: nobody else,
// everyone in the business at one level, or chosen team members each at theirs, as
// GoHighLevel shares a smart list. Apart from the step, so the rules are tested alone.
import type { SavedView, ViewAccessLevel, ViewSharingInput } from '@repo/contracts';

export type SharingMode = 'private' | 'everyone' | 'selected';

export interface SharingDraft {
  readonly mode: SharingMode;
  /** The level for everyone, kept while another mode is chosen. */
  readonly everyone: ViewAccessLevel;
  /** The people chosen, by membership, each at a level, in the order chosen. */
  readonly people: ReadonlyMap<string, ViewAccessLevel>;
}

/** How a view is shared now, as a draft to change. */
export function sharingDraftOf(view: SavedView): SharingDraft {
  const people = new Map<string, ViewAccessLevel>();
  for (const person of view.sharing.people)
    if (person.membershipId !== null) people.set(person.membershipId, person.access);
  return {
    mode:
      view.visibility === 'shared'
        ? 'everyone'
        : view.visibility === 'selected'
          ? 'selected'
          : 'private',
    everyone: view.sharing.everyone ?? 'view',
    people,
  };
}

/**
 * How many people the view is shared with who are no longer on the team: they can't be
 * named again, so saving a change of sharing leaves them out.
 */
export function departedCount(view: SavedView): number {
  return view.sharing.people.filter((person) => person.membershipId === null).length;
}

/** What the server is asked for: everyone at a level, or the people chosen, or nobody. */
export function sharingInputOf(draft: SharingDraft, revision: string): ViewSharingInput {
  return {
    everyone: draft.mode === 'everyone' ? draft.everyone : null,
    people:
      draft.mode === 'selected'
        ? [...draft.people].map(([membershipId, access]) => ({ membershipId, access }))
        : [],
    revision,
  };
}

/** Whether saving the draft would change how the view is shared. */
export function sharingChanged(draft: SharingDraft, view: SavedView): boolean {
  const before = sharingInputOf(sharingDraftOf(view), view.revision);
  const after = sharingInputOf(draft, view.revision);
  const sorted = (input: ViewSharingInput) =>
    JSON.stringify([
      input.everyone,
      input.people.toSorted((left, right) => left.membershipId.localeCompare(right.membershipId)),
    ]);
  return sorted(before) !== sorted(after) || (departedCount(view) > 0 && draft.mode !== 'private');
}

/**
 * Whether the draft can be saved by this reader: someone it is shared with to edit never
 * makes it private, and keeps their own editing whichever way it is shared, everyone's
 * level or their own.
 */
export function sharingAllowed(
  draft: SharingDraft,
  view: SavedView,
  myMembership: string | undefined,
): boolean {
  if (draft.mode === 'selected' && draft.people.size === 0) return false;
  if (view.access === 'owner') return true;
  if (draft.mode === 'private') return false;
  return draft.mode === 'everyone'
    ? draft.everyone === 'edit'
    : myMembership !== undefined && draft.people.get(myMembership) === 'edit';
}

/** Whether someone of the team can be chosen: anyone but the view's owner, who always has it. */
export function choosable(
  view: SavedView,
  member: { readonly id: string; readonly you: boolean },
): boolean {
  return member.id !== view.owner.membershipId && !(view.access === 'owner' && member.you);
}
