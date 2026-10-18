// A copy of a page keeps its content and renames what it points at: the steps its buttons
// go to and the saved sections it refers to are other rows in the copy. An action whose
// step did not come along does nothing; a reference to a saved section that did not come
// along is left out, since there is nothing for it to show.
import type { PageDocument, PageSection } from '@repo/contracts';

export interface Renames {
  /** A step's public id in the source, to its public id in the copy. */
  readonly steps: ReadonlyMap<string, string>;
  /** A saved section's public id in the source, to its public id in the copy. */
  readonly sections: ReadonlyMap<string, string>;
}

const DROP = Symbol('drop');

function renamed(value: unknown, renames: Renames): unknown {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => renamed(item, renames)).filter((item) => item !== DROP);
  }
  if (typeof value !== 'object' || value === null) return value;
  const node = value as Readonly<Record<string, unknown>>;
  if (node['type'] === 'step' && typeof node['stepId'] === 'string') {
    const stepId = renames.steps.get(node['stepId']);
    return stepId === undefined ? { type: 'none' } : { type: 'step', stepId };
  }
  if (node['type'] === 'saved_section' && typeof node['sectionId'] === 'string') {
    const sectionId = renames.sections.get(node['sectionId']);
    return sectionId === undefined ? DROP : { ...node, sectionId };
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, child]) => [key, renamed(child, renames)]),
  );
}

/** The document with its step and saved-section references renamed. A code page has none. */
export function remapDocument(document: PageDocument, renames: Renames): PageDocument {
  if (document.mode === 'code') return document;
  return renamed(document, renames) as PageDocument;
}

/** The section with the steps its actions go to renamed. */
export function remapSection(section: PageSection, renames: Renames): PageSection {
  return renamed(section, renames) as PageSection;
}

/** Keeps every reference as it is: a copy inside the same site. */
export const SAME: Renames = {
  steps: { get: (id: string) => id } as ReadonlyMap<string, string>,
  sections: { get: (id: string) => id } as ReadonlyMap<string, string>,
};
