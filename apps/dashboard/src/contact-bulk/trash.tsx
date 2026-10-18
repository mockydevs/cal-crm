// Contacts → Delete on the contacts selected: each moves to the trash, where it can be
// restored, as deleting one contact does.
import { useLingui } from '@lingui/react/macro';
import type { ReactElement } from 'react';

import { BulkDialogShell, type BulkDialogProps } from './parts';

export default function TrashDialog(props: BulkDialogProps): ReactElement {
  const { t } = useLingui();
  return (
    <BulkDialogShell
      {...props}
      title={t`Delete contacts`}
      description={t`They move to the trash, where each can be restored.`}
      timing={false}
      missing={undefined}
      confirm="delete"
      bodyOf={({ delivery: _now, ...common }) => ({ action: 'trash', ...common })}
    >
      {() => null}
    </BulkDialogShell>
  );
}
