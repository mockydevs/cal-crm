// The Template Library: definitions in code, each with a key that never changes and a
// version that goes up when the definition does. A report made from one is a copy: a later
// version does not reach it.
import type { ReportDefinition, ReportTemplate } from '@repo/contracts';

import { pipelineAttributionDefinition } from './pipeline-attribution.js';

/** What a template is given of the business it is used in. */
export interface TemplateBinding {
  /** The business's first pipeline, by its public id, when it has one. */
  readonly pipelineId?: string | undefined;
}

interface TemplateSource {
  readonly key: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly build: (binding: TemplateBinding) => ReportDefinition;
}

const sources: readonly TemplateSource[] = [
  {
    key: 'pipeline_attribution',
    version: 1,
    name: 'Pipeline & Attribution Report',
    description:
      'Open, won and lost opportunities with their value, the pipeline as a funnel, leads and won value by session source, and appointments by status.',
    build: ({ pipelineId }) => pipelineAttributionDefinition(pipelineId),
  },
];

/** The library, as the API lists it: each template as it is before a business is known. */
export const reportTemplates: readonly ReportTemplate[] = sources.map(
  ({ key, version, name, description, build }) => ({
    key,
    version,
    name,
    description,
    definition: build({}),
  }),
);

/** A template's name and its definition for a business; undefined for a key not in the library. */
export function buildTemplate(
  key: string,
  binding: TemplateBinding,
): { readonly name: string; readonly definition: ReportDefinition } | undefined {
  const source = sources.find((each) => each.key === key);
  return source === undefined
    ? undefined
    : { name: source.name, definition: source.build(binding) };
}
