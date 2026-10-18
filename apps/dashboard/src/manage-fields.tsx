// "Manage fields": which columns a list's table shows, and in what order, chosen in a panel
// at the right and applied together. The name column always shows, first. The order is what
// a saved view keeps, so it is changed here, with buttons that work the same by mouse,
// touch and keyboard.
import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Columns3 } from 'lucide-react';
import { lazy, useState, type ReactElement } from 'react';
import { PanelContent, SidePanel } from './list-toolbar';
import type { FieldChoice, FieldLimit } from './manage-fields-types';

const Form = lazy(() => import('./manage-fields-form'));

export function ManageFields<Key extends string>({
  choices,
  value,
  limit,
  onApply,
}: {
  /** Every column the table can show; the one keyed "name" always shows. */
  readonly choices: readonly FieldChoice<Key>[];
  readonly value: readonly Key[];
  readonly limit?: FieldLimit<Key>;
  readonly onApply: (columns: Key[]) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const shown = value.filter((key) => choices.some((choice) => choice.key === key)).length;
  const total = choices.length;
  return (
    <SidePanel
      open={open}
      onOpenChange={setOpen}
      title={<Trans>Manage fields</Trans>}
      trigger={
        <Button variant="quiet" className="px-2.5">
          <Columns3 aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>
            {shown}/{total} columns
          </Trans>
        </Button>
      }
    >
      <ManageFieldsForm
        choices={choices}
        value={value}
        {...(limit === undefined ? {} : { limit })}
        onCancel={() => {
          setOpen(false);
        }}
        onApply={(columns) => {
          setOpen(false);
          onApply(columns);
        }}
      />
    </SidePanel>
  );
}

/** The form loads when a fields panel opens, with its loading and failure contained. */
export function ManageFieldsForm<Key extends string>({
  choices,
  value,
  limit,
  onApply,
  onCancel,
}: {
  readonly choices: readonly FieldChoice<Key>[];
  readonly value: readonly Key[];
  readonly limit?: FieldLimit<Key>;
  readonly onApply: (columns: Key[]) => void;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <PanelContent>
      <Form
        choices={choices}
        value={value}
        // The lazy form takes any key: the limit applies to the keys of these choices.
        {...(limit === undefined
          ? {}
          : {
              limit: {
                max: limit.max,
                applies: (key: string) =>
                  choices.some((choice) => choice.key === key && limit.applies(choice.key)),
              },
            })}
        onCancel={onCancel}
        onApply={(columns) => {
          onApply(
            columns.filter((key): key is Key => choices.some((choice) => choice.key === key)),
          );
        }}
      />
    </PanelContent>
  );
}
