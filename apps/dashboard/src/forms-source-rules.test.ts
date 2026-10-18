import {
  DEFAULT_FORM_DEFINITION,
  FORM_LIMITS,
  formContactActions,
  formDefinition,
  type FormContactActions,
  type FormDefinition,
} from '@repo/contracts';
import { expect, it } from 'vitest';
import {
  actionsOf,
  isSourceMode,
  sourceModeOf,
  sourceModes,
  sourceTagExample,
  sourceTagFits,
  sourceTextOf,
  withSourceMode,
  withSourceText,
  withTagBySource,
  withTags,
} from './forms-source-rules';

const tag = (number: number): string =>
  `tag_01k8e2wzr0e0080000000000${String(number).padStart(2, '0')}`;
const base: FormContactActions = {
  tagIds: [tag(1)],
  source: { kind: 'arrived' },
  tagBySource: true,
};

it('reads a new form as writing how they arrived, with the tag of it', () => {
  expect(actionsOf(DEFAULT_FORM_DEFINITION)).toEqual({
    tagIds: [],
    source: { kind: 'arrived' },
    tagBySource: true,
  });
  expect(sourceModeOf(actionsOf(DEFAULT_FORM_DEFINITION))).toBe('arrived');
});

it('reads a form saved with no such part as adding no tag and writing no source', () => {
  const { contactActions: _left, ...old } = DEFAULT_FORM_DEFINITION;
  expect(actionsOf(old as FormDefinition)).toEqual({
    tagIds: [],
    source: { kind: 'none' },
    tagBySource: false,
  });
});

it('reads a form saved before the lead source tag was offered as not adding it', () => {
  // As it was stored: tags and a source, and no word of the tag by source.
  const stored = { tagIds: [tag(1)], source: { kind: 'form_name' } };
  const old = { ...DEFAULT_FORM_DEFINITION, contactActions: stored } as unknown as FormDefinition;
  expect(actionsOf(old)).toEqual({
    tagIds: [tag(1)],
    source: { kind: 'form_name' },
    tagBySource: false,
  });
  // The contract reads the same document the same way.
  expect(formContactActions.parse(stored)).toEqual(actionsOf(old));
  // And one that names no source at all is read by the contract as how they arrived.
  expect(formContactActions.parse({}).source).toEqual({ kind: 'arrived' });
});

it('hands back a copy: changing what the card holds never changes the saved form', () => {
  const held = actionsOf({ contactActions: base });
  held.tagIds.push(tag(2));
  expect(base.tagIds).toEqual([tag(1)]);
});

it('knows the four choices, in the order the card offers them', () => {
  expect(sourceModes).toEqual(['arrived', 'text', 'form_name', 'none']);
  for (const mode of sourceModes) expect(isSourceMode(mode)).toBe(true);
  expect(isSourceMode('fixed')).toBe(false);
});

it('changes the choice and keeps the tags and the tag by source', () => {
  for (const mode of ['arrived', 'form_name', 'none'] as const) {
    const next = withSourceMode({ ...base, source: { kind: 'text', text: 'Trade fair' } }, mode);
    expect(next).toEqual({ tagIds: [tag(1)], source: { kind: mode }, tagBySource: true });
    expect(sourceModeOf(next)).toBe(mode);
    expect(sourceTextOf(next)).toBe('');
  }
});

it('goes to a name of its own with the name typed before, the one it has, or none yet', () => {
  expect(withSourceMode(base, 'text').source).toEqual({ kind: 'text', text: '' });
  expect(withSourceMode(base, 'text', 'Trade fair').source).toEqual({
    kind: 'text',
    text: 'Trade fair',
  });
  const named = withSourceText(base, 'Open day');
  expect(sourceTextOf(named)).toBe('Open day');
  // Already a name of its own: it is kept, whatever was remembered.
  expect(withSourceMode(named, 'text', 'Trade fair').source).toEqual({
    kind: 'text',
    text: 'Open day',
  });
});

it('changes the tags and the switch, each leaving the rest alone', () => {
  expect(withTags(base, [tag(2), tag(3)])).toEqual({ ...base, tagIds: [tag(2), tag(3)] });
  expect(withTagBySource(base, false)).toEqual({ ...base, tagBySource: false });
  expect(withTagBySource({ ...base, tagBySource: false }, true)).toEqual(base);
});

it('makes what the contract takes, for every choice', () => {
  const definitionWith = (contactActions: FormContactActions): unknown => ({
    ...DEFAULT_FORM_DEFINITION,
    contactActions,
  });
  for (const mode of sourceModes) {
    const actions = withSourceMode(base, mode, 'Trade fair');
    expect(formDefinition.safeParse(definitionWith(actions)).success, mode).toBe(true);
  }
  // A name of its own that is still empty is the contract's to refuse, not the card's.
  expect(formDefinition.safeParse(definitionWith(withSourceMode(base, 'text'))).success).toBe(
    false,
  );
});

it('says when the lead source tag no longer fits beside the tags the form lists', () => {
  const full = Array.from({ length: FORM_LIMITS.tags }, (_, index) => tag(index));
  expect(sourceTagFits({ tagIds: full.slice(1) })).toBe(true);
  expect(sourceTagFits({ tagIds: full })).toBe(false);
});

it('names the tag a lead source gives as the server names it', () => {
  expect(sourceTagExample('Google Ads')).toBe('Source: Google Ads');
  expect(sourceTagExample('x'.repeat(80))).toBe('');
});
