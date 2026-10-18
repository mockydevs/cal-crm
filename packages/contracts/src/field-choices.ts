// Reading a choice of a custom field from text, by its key or its label: what a hidden form
// question, a contact created through the API and the form builder each do with a choice
// named in words. On its own, so the screens that read fields do not carry it.
/** A choice of a field, as far as matching text to it needs. */
interface ChoiceOption {
  readonly key: string;
  readonly label: string;
  readonly archived: boolean;
}

/**
 * The choice a piece of text means among a field's choices that can still be chosen: by
 * its key, or by its label with capitals and spaces at either end ignored. Active labels
 * are unique in that sense, so a label names one choice. Undefined when it names none.
 */
export function choiceKeyOf(options: readonly ChoiceOption[], given: string): string | undefined {
  const live = options.filter((option) => !option.archived);
  const text = given.trim();
  const wanted = text.toLowerCase();
  return (
    live.find((option) => option.key === text) ??
    live.find((option) => option.label.trim().toLowerCase() === wanted)
  )?.key;
}

/**
 * Several choices, as a list or as one text separated by commas, each by key or label:
 * their keys, each once, in the order given. Undefined when one of them names no choice,
 * or none is given.
 */
export function choiceKeysOf(
  options: readonly ChoiceOption[],
  given: string | readonly string[],
): string[] | undefined {
  const parts = (typeof given === 'string' ? given.split(',') : [...given])
    .map((each) => each.trim())
    .filter((each) => each !== '');
  const keys = parts.map((each) => choiceKeyOf(options, each));
  if (keys.length === 0 || keys.some((key) => key === undefined)) return undefined;
  return [...new Set(keys.filter((key): key is string => key !== undefined))];
}
