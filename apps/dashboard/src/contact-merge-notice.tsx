// What a contact's page says as it opens after a merge: how many contacts were just merged
// into it, or that the contact asked for was merged into it. Said once: a reload says nothing.
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState, type ReactElement } from 'react';

import { clearMergeNotice, mergeNoticeFor } from './contact-merge/notice';

export function ContactMergeNotice({
  contactId,
}: {
  readonly contactId: string;
}): ReactElement | null {
  const { t } = useLingui();
  const [notice] = useState(() => mergeNoticeFor(contactId));
  useEffect(() => {
    if (notice !== undefined) clearMergeNotice();
  }, [notice]);
  if (notice === undefined) return null;
  return (
    <p role="status" className="text-sm">
      {notice.kind === 'merged'
        ? plural(notice.count, {
            one: '# contact was merged into this one.',
            other: '# contacts were merged into this one.',
          })
        : t`The contact you opened was merged into this one.`}
    </p>
  );
}
