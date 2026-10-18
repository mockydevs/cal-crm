// Contacts → Export on the contacts selected: a CSV file with the columns the list shows to
// start with, as GoHighLevel's export has them, written in the background and downloaded
// from Bulk Actions.
import { Trans, useLingui } from '@lingui/react/macro';
import { contactExportColumnKeys, type ContactExportColumnKey } from '@repo/contracts';
import { useState, type ReactElement } from 'react';

import { BulkDialogShell, checkClassName, type BulkDialogProps } from './parts';

export default function ExportDialog(
  props: BulkDialogProps & {
    /** The columns the list shows, built in or a field's id. */
    readonly columns: readonly string[];
    /** The business's contact fields, which can be added as columns. */
    readonly fields: readonly { readonly id: string; readonly label: string }[];
  },
): ReactElement {
  const { t } = useLingui();
  const { columns, fields, ...shell } = props;
  const [chosen, setChosen] = useState<string[]>(() => [...columns]);
  const words: Readonly<Record<ContactExportColumnKey, string>> = {
    name: t`Contact name`,
    phone: t`Phone`,
    email: t`Email`,
    company: t`Business name`,
    added: t`Created`,
    lastActivity: t`Last activity`,
    tags: t`Tags`,
  };
  return (
    <BulkDialogShell
      {...shell}
      title={t`Export contacts`}
      description={t`The file is written in the background; download it from Bulk Actions.`}
      timing={false}
      missing={chosen.length > 0 ? undefined : t`Choose at least one column.`}
      confirm="export"
      bodyOf={({ delivery: _now, ...common }) => ({ action: 'export', columns: chosen, ...common })}
    >
      {(pending) => (
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1.5 text-sm font-medium">
            <Trans>Columns in the file</Trans>
          </legend>
          {[
            ...contactExportColumnKeys.map((key) => ({ id: key, label: words[key] })),
            ...fields,
          ].map((column) => (
            <label key={column.id} className={checkClassName}>
              <input
                type="checkbox"
                className="size-5 accent-primary"
                checked={chosen.includes(column.id)}
                disabled={pending}
                onChange={(event) => {
                  setChosen(
                    event.target.checked
                      ? [...chosen.filter((each) => each !== column.id), column.id]
                      : chosen.filter((each) => each !== column.id),
                  );
                }}
              />
              {column.label}
            </label>
          ))}
        </fieldset>
      )}
    </BulkDialogShell>
  );
}
