// A business's engagement scoring as the API holds it, for the component tests and the
// browser spec of Settings → Manage Scoring and the contact's score: every write is parsed
// by the contract's own schema and every answer is typed by the contract's own types. The
// draft is published as the server publishes it: only at the revision it was read at.
// Nothing here imports the dashboard's code, so a test never checks the page against itself.
import {
  publishScoreProfileInput,
  scoreRuleInput,
  setContactScoreInput,
  SCORING_LIMITS,
  updateScoreProfileInput,
  updateScoreRuleInput,
  type ContactScore,
  type ScoreProfile,
  type ScoreRule,
  type TagConfiguration,
} from '@repo/contracts';

export const at = '2026-10-17T09:00:00.000Z';
export const scoreRuleId = (number: number): string =>
  `srul_01k8e2wzr0e00800000000${String(number).padStart(4, '0')}`;
export const scoringTagId = (number: number): string =>
  `tag_01k8e2wzr0e00800000000${String(number).padStart(4, '0')}`;
export const scoringFormId = 'form_01k8e2wzr0e008000000000001';
export const scoredContactId = 'con_01k8e2wzr0e008000000000001';

const tagOf = (number: number, name: string): TagConfiguration['items'][number] => ({
  id: scoringTagId(number),
  name,
  description: '',
  createdAt: at,
  updatedAt: at,
  groupId: null,
  revision: 'a'.repeat(64),
});
export const scoringTags: TagConfiguration = {
  items: [tagOf(1, 'Hot lead'), tagOf(2, 'VIP')],
  groups: [],
  rules: { creation: 'everyone', suggestSimilar: true, revision: 'a'.repeat(64) },
  canManage: true,
  canCreate: true,
};

export const scoringForms = {
  items: [
    {
      id: scoringFormId,
      name: 'Wedding enquiry',
      status: 'published' as const,
      hasUnpublishedChanges: false,
      submissionCount: 3,
      lastSubmissionAt: at,
      updatedAt: at,
    },
  ],
  nextCursor: null,
  canManage: true,
};

export interface ScoringWorld {
  name: string;
  description: string;
  rules: ScoreRule[];
  revision: number;
  publishedRevision: number | null;
  publishedAt: string | null;
  liveRules: number;
  canManage: boolean;
  score: ContactScore;
  next: number;
}

const ruleOf = (
  number: number,
  rule: Pick<ScoreRule, 'when' | 'hasTagId' | 'calculation' | 'points'>,
): ScoreRule => ({
  ...rule,
  id: scoreRuleId(number),
  problems: [],
  revision: 1,
  createdAt: at,
  updatedAt: at,
});

/** GoHighLevel's three examples, published, and a contact scored 12. */
export function scoringWorldOf(overrides: Partial<ScoringWorld> = {}): ScoringWorld {
  return {
    name: 'Engagement Score',
    description: '',
    rules: [
      ruleOf(1, {
        when: { action: 'email_event', event: 'bounced' },
        hasTagId: null,
        calculation: 'subtract',
        points: 5,
      }),
      ruleOf(2, {
        when: { action: 'appointment_status', status: 'confirmed' },
        hasTagId: null,
        calculation: 'add',
        points: 1,
      }),
      ruleOf(3, {
        when: { action: 'contact_replied', channel: null },
        hasTagId: scoringTagId(1),
        calculation: 'add',
        points: 1,
      }),
    ],
    revision: 3,
    publishedRevision: 3,
    publishedAt: at,
    liveRules: 3,
    canManage: true,
    score: {
      score: 12,
      updatedAt: at,
      changes: [{ change: 1, source: 'rule', ruleId: scoreRuleId(3), at }],
      canEdit: true,
    },
    next: 4,
    ...overrides,
  };
}

export const profileOf = (world: ScoringWorld): ScoreProfile => ({
  name: world.name,
  description: world.description,
  rules: world.rules,
  revision: world.revision,
  publishedAt: world.publishedAt,
  unpublishedChanges:
    world.publishedRevision === null
      ? world.rules.length > 0
      : world.publishedRevision !== world.revision,
  liveRules: world.liveRules,
  limit: SCORING_LIMITS.rules,
  canManage: world.canManage,
});

/** A refusal as the server words it, for the stand-ins to throw or answer with. */
export interface Refusal {
  readonly status: number;
  readonly detail: string;
}
export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && 'status' in value && 'detail' in value;

export function createScoreRuleIn(world: ScoringWorld, body: unknown): ScoreRule {
  const input = scoreRuleInput.parse(body);
  const made = ruleOf(world.next, input);
  world.next += 1;
  world.rules = [...world.rules, made];
  world.revision += 1;
  return made;
}

export function updateScoreRuleIn(
  world: ScoringWorld,
  id: string,
  body: unknown,
): ScoreRule | Refusal {
  const input = updateScoreRuleInput.parse(body);
  const current = world.rules.find((rule) => rule.id === id);
  if (current === undefined) return { status: 404, detail: 'Scoring rule not found.' };
  if (current.revision !== input.revision)
    return {
      status: 409,
      detail: 'This rule changed. Reload the saved version before editing it again.',
    };
  const saved: ScoreRule = {
    ...current,
    when: input.when,
    hasTagId: input.hasTagId,
    calculation: input.calculation,
    points: input.points,
    revision: current.revision + 1,
  };
  world.rules = world.rules.map((rule) => (rule.id === id ? saved : rule));
  world.revision += 1;
  return saved;
}

export function deleteScoreRuleIn(world: ScoringWorld, id: string): void {
  world.rules = world.rules.filter((rule) => rule.id !== id);
  world.revision += 1;
}

export function publishIn(world: ScoringWorld, body: unknown): ScoreProfile | Refusal {
  const { revision } = publishScoreProfileInput.parse(body);
  if (revision !== world.revision)
    return {
      status: 409,
      detail: 'The rules changed since you read them. Reload them, then publish.',
    };
  world.publishedRevision = world.revision;
  world.publishedAt = at;
  world.liveRules = world.rules.length;
  return profileOf(world);
}

export function renameIn(world: ScoringWorld, body: unknown): ScoreProfile {
  const input = updateScoreProfileInput.parse(body);
  world.name = input.name;
  world.description = input.description;
  return profileOf(world);
}

export function setScoreIn(world: ScoringWorld, body: unknown): ContactScore {
  const { score } = setContactScoreInput.parse(body);
  const before = world.score.score ?? 0;
  world.score = {
    ...world.score,
    score,
    updatedAt: at,
    changes:
      score === world.score.score
        ? world.score.changes
        : [{ change: score - before, source: 'person', ruleId: null, at }, ...world.score.changes],
  };
  return world.score;
}
