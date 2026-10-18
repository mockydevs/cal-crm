// Where a lead came from, as the lists a person chooses from: the fields a condition can
// compare and a message can insert, under "This lead's arrival", "Attribution (first)" and
// "Attribution (latest)", each with the comparisons its kind takes. The table of leaves is
// the contract's own (automations-attribution.ts), so a leaf added there is listed here.
// The built-in lead source names a value is chosen from are kept apart
// (automation-lead-sources.ts), fetched with the controls that offer them.
import { i18n } from '@lingui/core';
import {
  attributionLeaves,
  attributionPath,
  type AttributionLeafKey,
  type AttributionScope,
  type AutomationFieldType,
} from '@repo/contracts';
import { choiceName, leafLabel, scopeHeadings } from './automation-attribution-words';

/** The group each touch's fields are in, where fields are listed under headings. */
export const attributionGroups = {
  first: 'first',
  latest: 'latest',
  trigger: 'arrival',
} as const satisfies Readonly<Record<AttributionScope, string>>;

export type AttributionGroup = (typeof attributionGroups)[AttributionScope];

export interface AttributionField {
  readonly path: string;
  readonly label: string;
  readonly type: AutomationFieldType;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  readonly scope: AttributionScope;
  readonly heading: string;
}

// This lead's arrival comes first: it is the one a workflow branches on most, and typing
// "Lead source" in a list then lands on it, not on the contact's first or latest.
const listed: readonly AttributionScope[] = ['trigger', 'first', 'latest'];

/** Every attribution field, touch by touch, in the order the contract lists the leaves. */
export function attributionFields(): AttributionField[] {
  return listed.flatMap((scope) =>
    attributionLeaves.map((leaf): AttributionField => {
      const key: AttributionLeafKey = leaf.key;
      return {
        path: attributionPath(scope, key),
        label: leafLabel(scope, key),
        type: leaf.type,
        options: leaf.options.map((option) => ({
          key: option.key,
          label: choiceName(option.key),
        })),
        scope,
        heading: i18n._(scopeHeadings[scope]),
      };
    }),
  );
}
