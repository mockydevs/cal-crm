// The merge fields a workflow email can insert, under their headings, and whether a path
// is one a send can fill in: the builder's own list (automation-record-rules.ts), with the
// business's trigger links. Fetched beside the panel, so the panel does not carry the
// builder's field rules.
import type { BuilderSetup } from '../automation-submission';
import { appointmentMergeFields } from '../automation-appointment-fields';
import { choiceAt, grouped, sourceFields } from '../automation-record-rules';
import { UNSUBSCRIBE_FIELD, type FieldGroupChoice } from '../email-editor/rules';

export interface EmailFields {
  readonly fields: readonly FieldGroupChoice[];
  readonly isKnown: (path: string) => boolean;
}

export function emailFields(setup: BuilderSetup, linksHeading: string): EmailFields {
  // The appointment's fields too, such as its reschedule-or-cancel link for a reminder.
  const choices = [...sourceFields(setup, true), ...appointmentMergeFields()];
  const groups: FieldGroupChoice[] = grouped(choices).map((group) => ({
    label: group.label,
    fields: group.fields.map((field) => ({ path: field.path, label: field.label })),
  }));
  const links = setup.triggerLinks ?? [];
  const fields =
    links.length === 0
      ? groups
      : [
          ...groups,
          {
            label: linksHeading,
            fields: links.map((link) => ({ path: `trigger_link.${link.key}`, label: link.name })),
          },
        ];
  const paths = new Set(fields.flatMap((group) => group.fields.map((field) => field.path)));
  return {
    fields,
    isKnown: (path) =>
      paths.has(path) || path === UNSUBSCRIBE_FIELD || choiceAt(choices, path, setup) !== undefined,
  };
}
