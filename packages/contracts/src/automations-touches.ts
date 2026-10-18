// What a workflow listens for on a contact and what its steps change there, as keys one can
// compare across workflows: field:<path> for a field, tag_added:<tag> and tag_removed:<tag>
// for a tag. A step that changes what a trigger listens for can start that workflow, its
// own included. The engine starts no run from a change made in the chain that started it;
// the validator says where a document makes such a change, so its author knows.
import type { AutomationDocument, AutomationTrigger } from './automations.js';

/** A workflow's keys: what its triggers listen for, and what its steps write. */
export interface AutomationTouches {
  readonly listens: readonly string[];
  readonly writes: readonly string[];
}

/** The key a trigger listens for, if it listens for a change a step can make. */
export function triggerListens(trigger: AutomationTrigger): string | undefined {
  if (trigger.type === 'field.changed') return `field:${trigger.config.field}`;
  if (trigger.type === 'tag.added') return `tag_added:${trigger.config.tag}`;
  if (trigger.type === 'tag.removed') return `tag_removed:${trigger.config.tag}`;
  return undefined;
}

/** The keys of a document, each once, in the order first met. */
export function automationTouches(document: AutomationDocument): AutomationTouches {
  const listens = new Set<string>();
  for (const trigger of document.triggers) {
    const key = triggerListens(trigger);
    if (key !== undefined) listens.add(key);
  }
  const writes = new Set<string>();
  for (const step of Object.values(document.steps)) {
    if (step.type === 'contact.update')
      for (const path of Object.keys(step.config.fields)) writes.add(`field:${path}`);
    if (step.type === 'tag.add') writes.add(`tag_added:${step.config.tag}`);
    if (step.type === 'tag.remove') writes.add(`tag_removed:${step.config.tag}`);
  }
  return { listens: [...listens], writes: [...writes] };
}

/** A key in the words a person reads, with a tag named by `tagName` when it knows it. */
export function touchWords(key: string, tagName: (id: string) => string = (id) => id): string {
  const [kind = '', ...rest] = key.split(':');
  const what = rest.join(':');
  if (kind === 'tag_added') return `adds the tag ${tagName(what)}`;
  if (kind === 'tag_removed') return `removes the tag ${tagName(what)}`;
  return `changes ${what}`;
}
