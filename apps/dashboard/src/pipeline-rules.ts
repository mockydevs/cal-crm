// What the Pipelines page works out before it draws: the pipeline being edited in its
// dialog, whether it is ready to save, and the whole configuration the server takes. The
// server keeps every pipeline and stage, in order, under one revision, and is sent all of
// them each time (packages/contracts/src/pipelines.ts): nothing is deleted, only archived.
import type { Pipeline, PipelineColorStyle, SavePipelinesInput } from '@repo/contracts';

/** A stage in the dialog. `key` stays with its row; `id` is missing until it is saved. */
export interface StageDraft {
  readonly key: string;
  readonly id: string | undefined;
  readonly name: string;
  readonly description: string;
  readonly archived: boolean;
  /** As typed: digits, or nothing for a stage with no probability. */
  readonly probability: string;
  /** `#rrggbb` in lower case, or null for no color. */
  readonly color: string | null;
  readonly showInFunnel: boolean;
  readonly showInPie: boolean;
}

/** A pipeline in the dialog; `id` is missing for one being created. */
export interface PipelineDraft {
  readonly id: string | undefined;
  readonly name: string;
  readonly description: string;
  readonly archived: boolean;
  /** Whether each opportunity carries its own probability instead of its stage's. */
  readonly dealProbability: boolean;
  readonly colorStyle: PipelineColorStyle;
  /** Whether the dashboard's funnel chart shows the pipeline. */
  readonly showInFunnel: boolean;
  /** Whether the dashboard's stage distribution chart shows it. */
  readonly showInPie: boolean;
  readonly stages: readonly StageDraft[];
}

/** A stage to add: no probability and no color, shown in both charts, as the server starts one. */
export function newStage(name = '', probability = ''): StageDraft {
  return {
    key: crypto.randomUUID(),
    id: undefined,
    name,
    description: '',
    archived: false,
    probability,
    color: null,
    showInFunnel: true,
    showInPie: true,
  };
}

/**
 * A pipeline to create, starting with the stages named (the dialog names GoHighLevel's
 * four). Their probabilities climb in equal steps and stop short of certain, as
 * GoHighLevel's do: 20, 40, 60 and 80 for four.
 */
export function newDraft(stageNames: readonly string[]): PipelineDraft {
  return {
    id: undefined,
    name: '',
    description: '',
    archived: false,
    dealProbability: false,
    colorStyle: 'none',
    showInFunnel: true,
    showInPie: true,
    stages: stageNames.map((name, index) =>
      newStage(name, String(Math.round(((index + 1) * 100) / (stageNames.length + 1)))),
    ),
  };
}

export function draftOf(pipeline: Pipeline): PipelineDraft {
  return {
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    archived: pipeline.archived,
    dealProbability: pipeline.dealProbability ?? false,
    colorStyle: pipeline.colorStyle ?? 'none',
    showInFunnel: pipeline.showInFunnel ?? true,
    showInPie: pipeline.showInPie ?? true,
    stages: pipeline.stages.map((stage) => ({
      key: stage.id,
      id: stage.id,
      name: stage.name,
      description: stage.description,
      archived: stage.archived,
      probability:
        stage.probability === undefined || stage.probability === null
          ? ''
          : String(stage.probability),
      color: stage.color ?? null,
      showInFunnel: stage.showInFunnel ?? true,
      showInPie: stage.showInPie ?? true,
    })),
  };
}

/** What a probability box keeps of what was typed: digits only, three at most. */
export function probabilityTyped(text: string): string {
  return text.replace(/\D/g, '').slice(0, 3);
}

/** Whether a typed probability is one the server takes: nothing, or a whole percent to 100. */
export function probabilityIsValid(text: string): boolean {
  return text === '' || (/^\d{1,3}$/.test(text) && Number(text) <= 100);
}

/**
 * Whether the server would take it: the pipeline and each of its stages has a name, and
 * each probability is a whole percent or left empty.
 */
export function isReady(draft: PipelineDraft): boolean {
  return (
    draft.name.trim() !== '' &&
    draft.stages.every((stage) => stage.name.trim() !== '' && probabilityIsValid(stage.probability))
  );
}

export function sameDraft(one: PipelineDraft, other: PipelineDraft): boolean {
  return JSON.stringify(one) === JSON.stringify(other);
}

/** The list with the entry at `from` put at `to`; unchanged when either is not a place in it. */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** What the server is sent for one pipeline: saved ids kept, unsaved ones left out. */
type PipelineInput = SavePipelinesInput['items'][number];

/**
 * A pipeline the dialog did not open, sent back as it is. Its settings are left out: the
 * server keeps what it has for anything a save does not name.
 */
function inputOf(pipeline: Pipeline): PipelineInput {
  return {
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    archived: pipeline.archived,
    stages: pipeline.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      description: stage.description,
      archived: stage.archived,
    })),
  };
}

/** The pipeline in the dialog, with every setting the dialog shows. */
function inputOfDraft(draft: PipelineDraft): PipelineInput {
  return {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    name: draft.name,
    description: draft.description,
    archived: draft.archived,
    dealProbability: draft.dealProbability,
    colorStyle: draft.colorStyle,
    showInFunnel: draft.showInFunnel,
    showInPie: draft.showInPie,
    stages: draft.stages.map((stage) => ({
      ...(stage.id === undefined ? {} : { id: stage.id }),
      name: stage.name,
      description: stage.description,
      archived: stage.archived,
      probability: stage.probability === '' ? null : Number(stage.probability),
      color: stage.color,
      showInFunnel: stage.showInFunnel,
      showInPie: stage.showInPie,
    })),
  };
}

/** Every pipeline, with the edited one in its place, or last when it is new. */
export function draftInput(
  configuration: { readonly items: readonly Pipeline[]; readonly revision: string },
  draft: PipelineDraft,
): SavePipelinesInput {
  const edited = inputOfDraft(draft);
  return {
    revision: configuration.revision,
    items:
      draft.id === undefined
        ? [...configuration.items.map(inputOf), edited]
        : configuration.items.map((item) => (item.id === draft.id ? edited : inputOf(item))),
  };
}

export function withMoved(items: readonly Pipeline[], id: string, offset: -1 | 1): Pipeline[] {
  const index = items.findIndex((item) => item.id === id);
  return moved(items, index, index + offset);
}

export function withArchived(
  items: readonly Pipeline[],
  id: string,
  archived: boolean,
): Pipeline[] {
  return items.map((item) => (item.id === id ? { ...item, archived } : item));
}

export function toInput(items: readonly Pipeline[], revision: string): SavePipelinesInput {
  return { revision, items: items.map(inputOf) };
}

export interface PipelineRow {
  readonly pipeline: Pipeline;
  /** Its place among all the pipelines, from 1, whatever the search hides. */
  readonly position: number;
}

/** The pipelines whose name holds what was typed, each with its place in the whole list. */
export function matching(items: readonly Pipeline[], search: string): PipelineRow[] {
  const wanted = search.trim().toLocaleLowerCase();
  return items
    .map((pipeline, index) => ({ pipeline, position: index + 1 }))
    .filter(({ pipeline }) => pipeline.name.toLocaleLowerCase().includes(wanted));
}

/** The pipeline a duplicate made: the one in the list after that was not in the list before. */
export function copyOf(
  before: readonly Pipeline[],
  after: readonly Pipeline[],
): Pipeline | undefined {
  const known = new Set(before.map((item) => item.id));
  return after.find((item) => !known.has(item.id));
}
