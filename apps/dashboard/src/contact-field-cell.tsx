// A custom field's value in a contact list's cell, as the contact page shows it. Fetched as a
// table with field columns first draws: not part of what the list's page loads first.
import type { FieldDefinition, RecordField } from '@repo/contracts';
import type { ReactElement } from 'react';
import { useValueLabel } from './field-value-label';

export default function ContactFieldCell({
  definition,
  value,
}: {
  readonly definition: FieldDefinition;
  readonly value: NonNullable<RecordField['value']>;
}): ReactElement {
  const label = useValueLabel();
  return <>{label({ definition, value })}</>;
}
