// Whether every setting does something. A setting is a column of a table whose name ends in
// "settings"; each one names the test that proves changing it changes what the CRM does, or is
// listed as a gap with its reason. Saving a value and reading it back proves nothing.

/** What a settings column is held to: a test that proves its effect, or a reason. */
export type Effect =
  | { readonly proof: { readonly file: string; readonly test: string } }
  | { readonly gap: string }
  | { readonly notASetting: string };

/** The entries, by table and then by column. */
export type Effects = Readonly<Record<string, Readonly<Record<string, Effect>>>>;

export interface Audit {
  readonly problems: readonly string[];
  readonly settings: number;
  readonly gaps: readonly { readonly setting: string; readonly reason: string }[];
}

// Every settings table has them, and none is a choice anyone makes.
const BOOKKEEPING = new Set(['business_id', 'created_at', 'updated_at', 'revision']);

/** The columns of each settings table, from the schema that kysely-codegen writes. */
export function settingsColumns(schema: string): ReadonlyMap<string, readonly string[]> {
  const text = schema.replaceAll('\r', '');
  const interfaces = new Map(
    [...text.matchAll(/^export interface (\w+) \{\n([\s\S]*?)\n\}/gm)].map((match) => [
      match[1],
      [...(match[2] ?? '').matchAll(/^ {2}(\w+)\??:/gm)].map((column) => column[1] ?? ''),
    ]),
  );
  const tables = new Map<string, readonly string[]>();
  for (const [, table, name] of text.matchAll(/^ {2}"([a-z_]+\.[a-z_]*settings)": (\w+);$/gm))
    if (table !== undefined && name !== undefined)
      tables.set(
        table,
        (interfaces.get(name) ?? []).filter((column) => !BOOKKEEPING.has(column)),
      );
  return tables;
}

const TEST_FILE = /\.(test|spec)\.tsx?$/;

function problemWith(effect: Effect, read: (file: string) => string | undefined): string | null {
  if ('gap' in effect) return effect.gap.trim() === '' ? 'give the reason.' : null;
  if ('notASetting' in effect) return effect.notASetting.trim() === '' ? 'give the reason.' : null;
  const { file, test } = effect.proof;
  if (!TEST_FILE.test(file)) return `${file} is not a test file.`;
  const source = read(file);
  if (source === undefined) return `${file} does not exist.`;
  // The name as the test declares it, between its own quotes.
  return ["'", '"', '`'].some((quote) => source.includes(`${quote}${test}${quote}`))
    ? null
    : `${file} has no test named "${test}".`;
}

export function auditSettings(input: {
  readonly schema: string;
  readonly effects: Effects;
  readonly read: (file: string) => string | undefined;
}): Audit {
  const tables = settingsColumns(input.schema);
  const problems: string[] = [];
  const gaps: { setting: string; reason: string }[] = [];
  let settings = 0;
  for (const [table, columns] of tables)
    for (const column of columns) {
      const setting = `${table}.${column}`;
      const effect = input.effects[table]?.[column];
      if (effect === undefined) {
        problems.push(
          `${setting}: name the test that proves what it changes, or list it as a gap with its reason.`,
        );
        continue;
      }
      const problem = problemWith(effect, input.read);
      if (problem !== null) problems.push(`${setting}: ${problem}`);
      if ('notASetting' in effect) continue;
      settings += 1;
      if ('gap' in effect) gaps.push({ setting, reason: effect.gap });
    }
  for (const [table, entries] of Object.entries(input.effects))
    for (const column of Object.keys(entries))
      if (!(tables.get(table) ?? []).includes(column))
        problems.push(`${table}.${column}: no such column; remove its entry.`);
  return { problems, settings, gaps };
}
