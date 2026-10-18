// "Insert a field" under a message's text: the contact's fields, the business's custom
// values, and the fields of the opportunity the run has in hand, each put in as its merge
// field where the keyboard was. Fetched when a form with such text is first opened.
import { useLingui } from '@lingui/react/macro';
import type { AutomationSetup } from '@repo/contracts';
import { useLayoutEffect, useMemo, useRef, type ReactElement } from 'react';
import { insertedAt, MergeFieldSelect } from './automation-record-controls';
import { appointmentMergeFields } from './automation-appointment-fields';
import { sourceFields } from './automation-record-rules';

export default function MergeInsert({
  setup,
  label,
  targetId,
  value,
  onChange,
}: {
  readonly setup: AutomationSetup;
  /** What the text is called, such as "Message". */
  readonly label: string;
  /** The id of the box the text is typed into. */
  readonly targetId: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const fields = useMemo(
    () => [...sourceFields(setup, true), ...appointmentMergeFields()],
    [setup],
  );
  // Where the keyboard goes once the text with the new field in it is drawn.
  const caretRef = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const caret = caretRef.current;
    if (caret === undefined) return;
    caretRef.current = undefined;
    const box = document.getElementById(targetId);
    if (!(box instanceof HTMLInputElement) && !(box instanceof HTMLTextAreaElement)) return;
    box.focus();
    box.setSelectionRange(caret, caret);
  }, [value, targetId]);
  return (
    <MergeFieldSelect
      label={t`Insert a field into: ${label}`}
      fields={fields}
      onInsert={(token) => {
        const box = document.getElementById(targetId);
        const typed = box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement;
        const next = insertedAt(
          value,
          token,
          typed ? box.selectionStart : null,
          typed ? box.selectionEnd : null,
        );
        caretRef.current = next.caret;
        onChange(next.text);
      }}
    />
  );
}
