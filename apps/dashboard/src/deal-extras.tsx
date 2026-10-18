// What a card of the board and a row of the list show beside the opportunity itself, when
// the server was asked for it (GET /deals?include=contact,owner,tags): the primary contact,
// the owner and the opportunity's own tags; and a stage's name in the colour its pipeline
// draws it with.
import { useLingui } from '@lingui/react/macro';
import type { Deal } from '@repo/contracts';
import type { ReactElement, ReactNode } from 'react';
import { tintOf } from './avatar-tint';
import type { StageMark } from './deal-presentation';

type Owner = NonNullable<Deal['owner']>;

/** What to call an opportunity's owner: the reader as "You", someone who left by what is left. */
export function useOwnerName(): (owner: Owner) => string {
  const { t } = useLingui();
  return (owner) =>
    owner.you
      ? t`You`
      : (owner.name ?? (owner.membershipId === null ? t`Former team member` : t`Team member`));
}

/** The primary contact as a card or a row names it: by name, or else by how to reach it. */
export function contactNameOf(deal: Pick<Deal, 'primaryContact'>): string | undefined {
  const contact = deal.primaryContact;
  if (contact === undefined || contact === null) return undefined;
  return contact.name ?? contact.email ?? contact.phone?.display;
}

// A tag keeps the colour it has on a contact's page (record-tags.tsx).
const tagTints = {
  1: 'bg-avatar-1',
  2: 'bg-avatar-2',
  3: 'bg-avatar-3',
  4: 'bg-avatar-4',
} as const;

/** The opportunity's tags as small pills; nothing when it has none. */
export function DealTags({ tags }: { readonly tags: Deal['tags'] }): ReactElement | null {
  const { t } = useLingui();
  if (tags === undefined || tags.length === 0) return null;
  return (
    <ul aria-label={t`Tags`} className="flex min-w-0 flex-wrap gap-1">
      {tags.map((tag) => (
        <li
          key={tag.id}
          className={`max-w-full truncate rounded-full px-2 py-0.5 text-xs font-medium text-foreground ${tagTints[tintOf(tag.id)]}`}
        >
          {tag.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * A stage's name as its pipeline says to colour it: after a dot of the stage's colour, on a
 * tint of it, or plain. The colour is the stage's own, kept by the server.
 */
export function StageName({
  mark,
  children,
}: {
  readonly mark: StageMark;
  readonly children: ReactNode;
}): ReactElement {
  if (mark.tint !== undefined)
    return (
      <span
        data-stage-color="tint"
        className="inline-block max-w-full rounded px-1.5 py-0.5 text-foreground"
        style={{ backgroundColor: mark.tint }}
      >
        {children}
      </span>
    );
  if (mark.dot === undefined) return <>{children}</>;
  return (
    <span className="inline-flex max-w-full items-baseline gap-1.5">
      <span
        aria-hidden
        data-stage-color="dot"
        className="size-2 shrink-0 self-center rounded-full"
        style={{ backgroundColor: mark.dot }}
      />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
