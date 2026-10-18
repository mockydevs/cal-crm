// Who a saved view is shared with, and what the reader may do with it, in a few words: for
// the row of views above a list and the panel that edits one.
import { Plural, Trans } from '@lingui/react/macro';
import type { SavedView } from '@repo/contracts';
import type { ReactElement } from 'react';

export function SharingSummary({ view }: { readonly view: SavedView }): ReactElement {
  const people = view.sharing.people.length;
  const shared =
    view.visibility === 'private' ? (
      <Trans>Private to you</Trans>
    ) : view.visibility === 'shared' ? (
      view.sharing.everyone === 'edit' ? (
        <Trans>Shared with everyone, who can edit</Trans>
      ) : (
        <Trans>Shared with everyone</Trans>
      )
    ) : (
      <Plural value={people} one="Shared with # person" other="Shared with # people" />
    );
  if (view.access === 'owner') return <span>{shared}</span>;
  return (
    <>
      <span>{shared}</span>
      <span aria-hidden>·</span>
      <span>
        {view.access === 'edit' ? <Trans>You can edit</Trans> : <Trans>You can view</Trans>}
      </span>
    </>
  );
}
