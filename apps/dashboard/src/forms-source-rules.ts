// What a form does to the contact it reaches, as the card "When someone sends the form"
// holds it (forms-source.tsx, forms-extras.tsx) and as the contract stores it
// (formContactActions): the Source it writes, the tags it adds, and whether it also adds
// the tag of the lead source. Everything here is plain values, so it is tested apart from
// the screen.
import {
  LEAD_SOURCE_LIMITS,
  leadSourceTagName,
  type FormContactActions,
  type FormDefinition,
} from '@repo/contracts';

/** The four things a form can write as a contact's Source, in the order the card offers them. */
export const sourceModes = ['arrived', 'text', 'form_name', 'none'] as const;
export type SourceMode = (typeof sourceModes)[number];

export const isSourceMode = (value: string): value is SourceMode =>
  (sourceModes as readonly string[]).includes(value);

/**
 * What the form does, whatever it was saved with. A form saved with no such part adds no
 * tag and writes no source, which is what the server does for it; one saved before the
 * lead source's tag was offered does not add it.
 */
export function actionsOf(definition: Pick<FormDefinition, 'contactActions'>): FormContactActions {
  const stored: Partial<FormContactActions> | undefined = definition.contactActions;
  return {
    tagIds: [...(stored?.tagIds ?? [])],
    source: stored?.source ?? { kind: 'none' },
    tagBySource: stored?.tagBySource === true,
  };
}

export const sourceModeOf = (actions: Pick<FormContactActions, 'source'>): SourceMode =>
  actions.source.kind;

/** The name the form writes when it writes one of its own; empty for every other choice. */
export const sourceTextOf = (actions: Pick<FormContactActions, 'source'>): string =>
  actions.source.kind === 'text' ? actions.source.text : '';

/**
 * The same form writing another kind of Source. Going to "a name I write" brings back the
 * name that was typed before, if there was one: choosing something else for a moment does
 * not lose it.
 */
export function withSourceMode(
  actions: FormContactActions,
  mode: SourceMode,
  rememberedText = '',
): FormContactActions {
  return {
    ...actions,
    source:
      mode === 'text'
        ? {
            kind: 'text',
            text: actions.source.kind === 'text' ? actions.source.text : rememberedText,
          }
        : { kind: mode },
  };
}

export const withSourceText = (actions: FormContactActions, text: string): FormContactActions => ({
  ...actions,
  source: { kind: 'text', text },
});

export const withTags = (
  actions: FormContactActions,
  tagIds: readonly string[],
): FormContactActions => ({ ...actions, tagIds: [...tagIds] });

export const withTagBySource = (actions: FormContactActions, on: boolean): FormContactActions => ({
  ...actions,
  tagBySource: on,
});

/**
 * Whether the lead source's tag still has room: a submission adds a set number of tags at
 * most, the form's own first, so a form that lists that many leaves none for it.
 */
export const sourceTagFits = (actions: Pick<FormContactActions, 'tagIds'>): boolean =>
  actions.tagIds.length < LEAD_SOURCE_LIMITS.tagsPerSubmission;

/** The tag a lead source gives, as an example for the card: "Source: Google Ads". */
export const sourceTagExample = (label: string): string => leadSourceTagName(label) ?? '';
