// "Add new rule" and a rule's Edit: what the contact does (GoHighLevel's action, and which of
// it), whether only contacts with a tag are scored, and how many points are added or
// subtracted. A rule is saved in the draft; the page publishes it.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  appointmentStatuses,
  createScoreRule,
  SCORING_LIMITS,
  scoreCalculations,
  scoreEmailEvents,
  scoreReplyChannels,
  scoreRuleActions,
  scoreTagChanges,
  updateScoreRule,
  type ScoreRule,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { apiIn } from '../api';
import { SmallDialog } from '../settings-list';
import { useBusiness } from '../workspace';
import { bodyOf, draftOf, emptyDraft, missingOf, saidBy, type RuleDraft } from './rules';
import { useScoringWords } from './words';

interface Named {
  readonly id: string;
  readonly name: string;
}

const ANY = '';

/** What a box says is wrong with it, read out with the box. */
function Problem({
  id,
  children,
}: {
  readonly id: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p id={id} role="alert" className="text-sm font-medium text-destructive">
      {children}
    </p>
  );
}

/** One labelled choice of the dialog, and what is wrong with it, if anything. */
function Choice({
  label,
  value,
  onChange,
  problem,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly problem?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const id = useId();
  const problemId = useId();
  const wrong = problem !== undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      <Select
        aria-labelledby={id}
        aria-invalid={wrong}
        {...(wrong ? { 'aria-describedby': problemId } : {})}
        value={value}
        onValueChange={onChange}
      >
        {children}
      </Select>
      {wrong ? <Problem id={problemId}>{problem}</Problem> : null}
    </div>
  );
}

/** A value of a list the contract gives, or the one it was. */
const oneOf = <Value extends string>(list: readonly Value[], value: string, was: Value): Value =>
  list.find((each) => each === value) ?? was;

export default function RuleDialog({
  rule,
  tags,
  forms,
  returnFocus,
  onClose,
  onSaved,
}: {
  /** The rule to edit; none for a new one. */
  readonly rule: ScoreRule | undefined;
  readonly tags: readonly Named[];
  readonly forms: readonly Named[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSaved: (rule: ScoreRule, added: boolean) => Promise<void>;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const words = useScoringWords();
  const pointsId = useId();
  const pointsProblemId = useId();
  const [draft, setDraft] = useState<RuleDraft>(() =>
    rule === undefined ? emptyDraft : draftOf(rule),
  );
  const [tried, setTried] = useState(false);
  const change = (next: Partial<RuleDraft>): void => {
    setDraft((before) => ({ ...before, ...next }));
  };
  const save = useMutation({
    mutationFn: () => {
      const api = apiIn(business.id);
      const body = bodyOf(draft);
      return rule === undefined
        ? api.request(createScoreRule, { body })
        : api.request(updateScoreRule, {
            params: { ruleId: rule.id },
            body: { ...body, revision: rule.revision },
          });
    },
    onSuccess: (saved) => onSaved(saved, rule === undefined),
  });
  // The tags and forms the rule names that were deleted: shown as such, never chosen again.
  const deleted = new Set(rule?.problems.map((each) => each.id) ?? []);
  const missing = missingOf(draft, deleted);
  const tagChoices = (chosen: string): ReactElement[] => [
    ...(deleted.has(chosen)
      ? [
          <option key={chosen} value={chosen}>
            {t`(deleted)`}
          </option>,
        ]
      : []),
    ...tags
      .filter((tag) => !deleted.has(tag.id))
      .map((tag) => (
        <option key={tag.id} value={tag.id}>
          {tag.name}
        </option>
      )),
  ];

  return (
    <SmallDialog
      open
      onClose={onClose}
      title={rule === undefined ? t`Add new rule` : t`Edit rule`}
      description={t`Choose what the contact does, and how many points it adds or subtracts.`}
      returnFocus={returnFocus}
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (missing === undefined) save.mutate();
        }}
      >
        <Choice
          label={t`Action`}
          value={draft.action}
          onChange={(value) => {
            change({ action: oneOf(scoreRuleActions, value, draft.action) });
          }}
        >
          {scoreRuleActions.map((action) => (
            <option key={action} value={action}>
              {words.actions[action]}
            </option>
          ))}
        </Choice>
        {draft.action === 'email_event' ? (
          <Choice
            label={t`Email event`}
            value={draft.event}
            onChange={(value) => {
              change({ event: oneOf(scoreEmailEvents, value, draft.event) });
            }}
          >
            {scoreEmailEvents.map((event) => (
              <option key={event} value={event}>
                {words.events[event]}
              </option>
            ))}
          </Choice>
        ) : null}
        {draft.action === 'contact_replied' ? (
          <Choice
            label={t`Channel`}
            value={draft.channel}
            onChange={(value) => {
              change({ channel: value === ANY ? '' : oneOf(scoreReplyChannels, value, 'email') });
            }}
          >
            <option value={ANY}>{t`Any channel`}</option>
            {scoreReplyChannels.map((channel) => (
              <option key={channel} value={channel}>
                {words.channels[channel]}
              </option>
            ))}
          </Choice>
        ) : null}
        {draft.action === 'form_submitted' ? (
          <Choice
            label={t`Form`}
            value={draft.formId}
            onChange={(value) => {
              change({ formId: value });
            }}
            problem={
              deleted.has(draft.formId) ? (
                <Trans>That form was deleted. Choose another, or any form.</Trans>
              ) : undefined
            }
          >
            <option value={ANY}>{t`Any form`}</option>
            {deleted.has(draft.formId) ? (
              <option value={draft.formId}>{t`(deleted)`}</option>
            ) : null}
            {forms
              .filter((form) => !deleted.has(form.id))
              .map((form) => (
                <option key={form.id} value={form.id}>
                  {form.name}
                </option>
              ))}
          </Choice>
        ) : null}
        {draft.action === 'appointment_status' ? (
          <Choice
            label={t`Status`}
            value={draft.status}
            onChange={(value) => {
              change({ status: oneOf(appointmentStatuses, value, draft.status) });
            }}
          >
            {appointmentStatuses.map((status) => (
              <option key={status} value={status}>
                {words.statuses[status]}
              </option>
            ))}
          </Choice>
        ) : null}
        {draft.action === 'contact_tag' ? (
          <>
            <Choice
              label={t`Tag is`}
              value={draft.change}
              onChange={(value) => {
                change({ change: oneOf(scoreTagChanges, value, draft.change) });
              }}
            >
              <option value="added">{t`Added`}</option>
              <option value="removed">{t`Removed`}</option>
            </Choice>
            <Choice
              label={t`Tag`}
              value={draft.tagId}
              onChange={(value) => {
                change({ tagId: value });
              }}
              problem={
                deleted.has(draft.tagId) ? (
                  <Trans>That tag was deleted. Choose another.</Trans>
                ) : tried && missing === 'tag' ? (
                  <Trans>Choose the tag this rule scores.</Trans>
                ) : undefined
              }
            >
              <option value={ANY}>{t`Choose a tag`}</option>
              {tagChoices(draft.tagId)}
            </Choice>
          </>
        ) : null}
        <Choice
          label={t`Only contacts with the tag`}
          value={draft.hasTagId}
          onChange={(value) => {
            change({ hasTagId: value });
          }}
          problem={
            deleted.has(draft.hasTagId) ? (
              <Trans>That tag was deleted. Choose another, or any contact.</Trans>
            ) : undefined
          }
        >
          <option value={ANY}>{t`Any contact`}</option>
          {tagChoices(draft.hasTagId)}
        </Choice>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Choice
            label={t`Calculation`}
            value={draft.calculation}
            onChange={(value) => {
              change({ calculation: oneOf(scoreCalculations, value, draft.calculation) });
            }}
          >
            {scoreCalculations.map((calculation) => (
              <option key={calculation} value={calculation}>
                {words.calculations[calculation]}
              </option>
            ))}
          </Choice>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={pointsId} className="text-sm font-medium">
              <Trans>Points</Trans>
            </label>
            <Input
              id={pointsId}
              type="number"
              inputMode="numeric"
              min={1}
              max={SCORING_LIMITS.points}
              step={1}
              required
              aria-invalid={tried && missing === 'points'}
              {...(tried && missing === 'points' ? { 'aria-describedby': pointsProblemId } : {})}
              value={draft.points}
              onChange={(event) => {
                change({ points: event.target.value });
              }}
            />
          </div>
        </div>
        {tried && missing === 'points' ? (
          <Problem id={pointsProblemId}>
            <Trans>Enter whole points from 1 to 1,000.</Trans>
          </Problem>
        ) : null}
        {save.isError ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {saidBy(save.error, t`The rule wasn't saved. Check your connection and try again.`)}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={save.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={save.isPending}>
            <Trans>Save</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
