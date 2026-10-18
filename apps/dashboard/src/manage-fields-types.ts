// What "Manage fields" chooses among, shared by its panel (manage-fields.tsx) and its form
// (manage-fields-form.tsx) without either importing the other.

/** A column the table can show. Columns with a group are offered under its name. */
export interface FieldChoice<Key extends string> {
  readonly key: Key;
  readonly label: string;
  /** The folder it is in, such as a custom field's; left out, it comes first. */
  readonly group?: string;
}

/** At most `max` of the columns `applies` picks out may show at once. */
export interface FieldLimit<Key extends string> {
  readonly max: number;
  readonly applies: (key: Key) => boolean;
}
