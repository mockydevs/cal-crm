// "Insert a field": the list of merge fields, searched by name, under their headings, each
// with its {{path}} beneath it. One list for the subject line, the address boxes and the
// message's toolbar (search-picker.tsx).
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import { Braces } from 'lucide-react';
import type { ReactElement } from 'react';
import { SearchPicker } from '../search-picker';
import { tokenOf } from './email-html';
import type { FieldGroupChoice } from './rules';

export function FieldPicker({
  label,
  fields,
  worded = false,
  onInsert,
}: {
  /** What it inserts into, such as "Insert a field into: Subject". */
  readonly label: string;
  readonly fields: readonly FieldGroupChoice[];
  /** With "Insert a field" beside its sign, where there is room: in the message's toolbar. */
  readonly worded?: boolean;
  /** Given the path of the field chosen. */
  readonly onInsert: (path: string) => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <SearchPicker
      label={label}
      placeholder={t`Insert a field`}
      searchLabel={t`Search fields`}
      items={fields.flatMap((group) =>
        group.fields.map((field) => ({
          id: field.path,
          name: field.label,
          detail: tokenOf(field.path),
          group: group.label,
        })),
      )}
      selected={[]}
      empty={t`No fields match.`}
      none={t`There are no fields to insert.`}
      tool={
        <>
          <Braces aria-hidden className="size-4" strokeWidth={2} />
          {worded ? (
            <span className="hidden sm:inline">
              <Trans>Insert a field</Trans>
            </span>
          ) : null}
        </>
      }
      onChange={([path]) => {
        if (path !== undefined) onInsert(path);
      }}
    />
  );
}
