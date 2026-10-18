// The editor of one lead source rule (Settings → Lead Sources → Rules): a name, the
// conditions that must all hold (a fact of the visit from the API's own vocabulary, how it
// is compared, and with what), and what the rule does (name the Source, add tags, fill a
// text custom field). "Try a link" says whether the rule as it stands here, saved or not,
// would match a pasted address. The API's own schema checks the rule before it is sent,
// and what the server refuses is shown at the box it names.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ATTRIBUTION_LIMITS,
  createLeadSourceRule,
  getLeadSourceRule,
  LEAD_SOURCE_LIMITS,
  LEAD_SOURCE_RULE_LIMITS,
  leadSourceOperatorLabels,
  leadSourceOperatorsOf,
  previewLeadSource,
  updateLeadSourceRule,
  type FieldDefinition,
  type LeadSourceOperator,
  type LeadSourcePreview,
  type LeadSourceRule,
  type PreviewLeadSourceInput,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation } from '@tanstack/react-query';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { linkCheckRequest } from '../forms-link-check-rules';
import { TagPicker } from '../tag-picker';
import { cardClassName, fieldLabelClassName, iconButtonClassName, labelClassName } from './frame';
import { useSentenceWords } from './rule-words';
import {
  canAddCondition,
  canAddFieldWrite,
  checkRule,
  choiceName,
  conditionPhrase,
  emptyCondition,
  factChoices,
  factInfo,
  isClean,
  listOf,
  noRuleProblems,
  ruleDraftOf,
  ruleProblemsOf,
  tryRule,
  valueControl,
  withFact,
  withOperator,
  type ConditionDraft,
  type RuleDraft,
  type RuleProblems,
} from './rules';

const YES = 'yes';
const NO = 'no';
const CHOOSE = '';

function Problem({ id, children }: { readonly id?: string; readonly children: string }) {
  return (
    <p id={id} role="alert" className="text-sm font-medium text-destructive">
      {children}
    </p>
  );
}

/** A list of words typed freely, commas and all: the list is read from it as it changes. */
function ListInput({
  label,
  invalid,
  describedBy,
  values,
  onChange,
}: {
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy: string;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
}): ReactElement {
  const { t } = useLingui();
  const [typed, setTyped] = useState(() => values.join(', '));
  return (
    <Input
      aria-label={label}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      placeholder={t`spring, summer`}
      autoComplete="off"
      value={typed}
      onValueChange={(next) => {
        setTyped(next);
        onChange(listOf(next));
      }}
    />
  );
}

function ConditionRow({
  number,
  condition,
  problems,
  removable,
  words,
  onChange,
  onRemove,
}: {
  readonly number: number;
  readonly condition: ConditionDraft;
  readonly problems: Readonly<Record<string, string>> | undefined;
  readonly removable: boolean;
  readonly words: ReturnType<typeof useSentenceWords>;
  readonly onChange: (next: ConditionDraft) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const info = factInfo(condition.fact);
  const control = valueControl(condition);
  const presence = info.kind === 'presence';
  const said = Object.values(problems ?? {});
  const invalid = (box: string): boolean => problems?.[box] !== undefined;
  const described = [`${id}-what`, ...(said.length === 0 ? [] : [`${id}-problem`])].join(' ');
  const choices = info.choices ?? [];
  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border p-2.5">
      <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:flex lg:items-start">
        <div className="min-w-0 lg:w-56 lg:shrink-0">
          <Select
            aria-label={t`Condition ${number}: what to look at`}
            aria-invalid={invalid('fact')}
            aria-describedby={described}
            value={condition.fact}
            onValueChange={(next) => {
              const fact = factChoices.find((each) => each === next);
              if (fact !== undefined) onChange(withFact(condition, fact));
            }}
          >
            {factChoices.map((fact) => (
              <option key={fact} value={fact}>
                {factInfo(fact).label}
              </option>
            ))}
          </Select>
        </div>
        {info.kind === 'parameter' ? (
          <div className="min-w-0 lg:w-40 lg:shrink-0">
            <Input
              aria-label={t`Condition ${number}: parameter name`}
              aria-invalid={invalid('name')}
              aria-describedby={described}
              placeholder="promo"
              autoComplete="off"
              autoCapitalize="none"
              maxLength={60}
              value={condition.name}
              onValueChange={(name) => {
                onChange({ ...condition, name });
              }}
            />
          </div>
        ) : null}
        {presence ? (
          <div className="min-w-0 lg:w-40 lg:shrink-0">
            <Select
              aria-label={t`Condition ${number}: is it in the link`}
              aria-invalid={invalid('op')}
              aria-describedby={described}
              value={condition.op === 'is_empty' ? NO : YES}
              onValueChange={(next) => {
                onChange(withOperator(condition, next === NO ? 'is_empty' : 'is_not_empty'));
              }}
            >
              <option value={YES}>{t`Yes, it is there`}</option>
              <option value={NO}>{t`No, it is not`}</option>
            </Select>
          </div>
        ) : (
          <div className="min-w-0 lg:w-40 lg:shrink-0">
            <Select
              aria-label={t`Condition ${number}: how it is compared`}
              aria-invalid={invalid('op')}
              aria-describedby={described}
              value={condition.op}
              onValueChange={(next) => {
                const op = leadSourceOperatorsOf(condition.fact).find((each) => each === next);
                if (op !== undefined) onChange(withOperator(condition, op));
              }}
            >
              {leadSourceOperatorsOf(condition.fact).map((op: LeadSourceOperator) => (
                <option key={op} value={op}>
                  {leadSourceOperatorLabels[op]}
                </option>
              ))}
            </Select>
          </div>
        )}
        {presence || control === 'none' ? null : (
          <div className="min-w-0 sm:col-span-2 lg:flex-1">
            {control === 'choice' ? (
              <Select
                aria-label={t`Condition ${number}: value`}
                aria-invalid={invalid('value')}
                aria-describedby={described}
                value={choices.includes(condition.value) ? condition.value : CHOOSE}
                onValueChange={(value) => {
                  onChange({ ...condition, value });
                }}
              >
                <option value={CHOOSE}>{t`Choose one`}</option>
                {choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choiceName(condition.fact, choice, words)}
                  </option>
                ))}
              </Select>
            ) : control === 'choices' ? (
              <Select
                multiple
                aria-label={t`Condition ${number}: values`}
                aria-invalid={invalid('value')}
                aria-describedby={described}
                value={condition.values.filter((value) => choices.includes(value))}
                onValueChange={(values) => {
                  onChange({ ...condition, values });
                }}
              >
                {choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choiceName(condition.fact, choice, words)}
                  </option>
                ))}
              </Select>
            ) : control === 'texts' ? (
              <ListInput
                label={t`Condition ${number}: values, separated by commas`}
                invalid={invalid('value')}
                describedBy={described}
                values={condition.values}
                onChange={(values) => {
                  onChange({ ...condition, values });
                }}
              />
            ) : (
              <Input
                key="text"
                aria-label={t`Condition ${number}: value`}
                aria-invalid={invalid('value')}
                aria-describedby={described}
                autoComplete="off"
                maxLength={LEAD_SOURCE_RULE_LIMITS.valueLength}
                value={condition.value}
                onValueChange={(value) => {
                  onChange({ ...condition, value });
                }}
              />
            )}
          </div>
        )}
        {removable ? (
          <button
            type="button"
            className={`${iconButtonClassName} justify-self-end lg:ml-auto`}
            aria-label={t`Remove condition ${number}`}
            title={t`Remove condition ${number}`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
        ) : null}
      </div>
      <p id={`${id}-what`} className={labelClassName}>
        {info.description}
        {control === 'texts' ? <> {t`Separate the values with commas.`}</> : null}
      </p>
      {said.length === 0 ? null : <Problem id={`${id}-problem`}>{said.join(' ')}</Problem>}
    </li>
  );
}

export interface RuleEditorProps {
  /** The rule being changed; none for a new one. */
  readonly rule: LeadSourceRule | undefined;
  readonly initial: RuleDraft;
  readonly client: Client;
  readonly businessId: string;
  /** The contact's text custom fields a rule may fill. */
  readonly fields: readonly FieldDefinition[];
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  readonly onSaved: (rule: LeadSourceRule) => void;
  readonly onCancel: () => void;
}

export default function RuleEditor({
  rule,
  initial,
  client,
  businessId,
  fields,
  tags,
  onSaved,
  onCancel,
}: RuleEditorProps): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const words = useSentenceWords(tags, fields);
  const [draft, setDraft] = useState(initial);
  const [revision, setRevision] = useState(rule?.revision);
  const [problems, setProblems] = useState<RuleProblems>(noRuleProblems);
  const [stale, setStale] = useState(false);
  const [refusals, setRefusals] = useState(0);
  const [link, setLink] = useState('');
  const [linkProblem, setLinkProblem] = useState<string>();
  const [tried, setTried] = useState<{
    readonly url: string;
    readonly preview: LeadSourcePreview;
  }>();
  // The keyboard starts on the name, and goes to the first box a refusal names.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  useEffect(() => {
    if (refusals > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refusals]);

  const change = (next: RuleDraft): void => {
    setDraft(next);
    setProblems(noRuleProblems);
  };
  const refuse = (next: RuleProblems): void => {
    setProblems(next);
    setRefusals((count) => count + 1);
  };
  const save = useMutation({
    mutationFn: (body: ReturnType<typeof checkRule> & { readonly ok: true }) =>
      rule === undefined || revision === undefined
        ? client.request(createLeadSourceRule, { body: body.body })
        : client.request(updateLeadSourceRule, {
            params: { ruleId: rule.id },
            body: { ...body.body, revision },
          }),
    onSuccess: onSaved,
    onError: (error) => {
      setStale(error instanceof ApiError && error.status === 409);
      if (error instanceof ApiError && error.problem.errors !== undefined)
        refuse(ruleProblemsOf(error.problem.errors));
      else
        refuse({
          ...noRuleProblems,
          form:
            error instanceof ApiError
              ? (error.problem.detail ?? error.message)
              : t`The rule wasn't saved. Check your connection and try again.`,
        });
    },
  });
  const reload = useMutation({
    mutationFn: (ruleId: string) => client.request(getLeadSourceRule, { params: { ruleId } }),
    onSuccess: (fresh) => {
      setDraft(ruleDraftOf(fresh));
      setRevision(fresh.revision);
      setStale(false);
      setProblems(noRuleProblems);
    },
  });
  const trial = useMutation({
    mutationFn: (body: PreviewLeadSourceInput) => client.request(previewLeadSource, { body }),
    onSuccess: (preview, body) => {
      setTried({ url: body.url, preview });
    },
  });
  const tryLink = (): void => {
    const asked = linkCheckRequest(link, '', undefined);
    if (!asked.ok) {
      setLinkProblem(asked.problems.url);
      setTried(undefined);
      return;
    }
    setLinkProblem(undefined);
    trial.mutate(asked.body);
  };
  const submit = (): void => {
    if (save.isPending) return;
    const checked = checkRule(draft);
    if (!checked.ok) {
      refuse(ruleProblemsOf(checked.issues));
      return;
    }
    setProblems(noRuleProblems);
    setStale(false);
    save.mutate(checked);
  };

  const conditionLimit = LEAD_SOURCE_RULE_LIMITS.conditions;
  const fieldLimit = LEAD_SOURCE_RULE_LIMITS.fieldWrites;
  const result = tried === undefined ? undefined : tryRule(draft, tried.preview, tried.url);
  const ruleName = rule?.name ?? '';
  const unusedFields = (own: string): FieldDefinition[] =>
    fields.filter(
      (field) => field.id === own || !draft.fieldWrites.some((write) => write.fieldId === field.id),
    );
  const setCondition = (index: number, next: ConditionDraft): void => {
    change({
      ...draft,
      conditions: draft.conditions.map((each, at) => (at === index ? next : each)),
    });
  };
  return (
    <form
      ref={formRef}
      noValidate
      aria-label={rule === undefined ? t`New rule` : t`Edit rule ${ruleName}`}
      className={cardClassName}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h2 className="text-base font-medium">
        {rule === undefined ? <Trans>New rule</Trans> : <Trans>Edit rule</Trans>}
      </h2>
      <div className="flex max-w-xl min-w-0 flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className={fieldLabelClassName}>
          <Trans>Name</Trans>
        </label>
        <Input
          ref={nameRef}
          id={`${id}-name`}
          autoComplete="off"
          maxLength={LEAD_SOURCE_RULE_LIMITS.nameLength}
          placeholder={t`Such as Spring promo`}
          value={draft.name}
          aria-invalid={problems.name === undefined ? undefined : true}
          aria-describedby={problems.name === undefined ? undefined : `${id}-name-problem`}
          onValueChange={(name) => {
            change({ ...draft, name });
          }}
        />
        {problems.name === undefined ? null : (
          <Problem id={`${id}-name-problem`}>{problems.name}</Problem>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <h3 id={`${id}-when`} className={fieldLabelClassName}>
          <Trans>When all of these hold</Trans>
        </h3>
        <ol aria-labelledby={`${id}-when`} className="flex min-w-0 list-none flex-col gap-2 p-0">
          {draft.conditions.map((condition, index) => (
            <ConditionRow
              // A row is known by its place: rows are not reordered, only added and removed.
              // eslint-disable-next-line @eslint-react/no-array-index-key
              key={index}
              number={index + 1}
              condition={condition}
              problems={problems.conditions[index]}
              removable={draft.conditions.length > 1}
              words={words}
              onChange={(next) => {
                setCondition(index, next);
              }}
              onRemove={() => {
                change({
                  ...draft,
                  conditions: draft.conditions.filter((_, at) => at !== index),
                });
              }}
            />
          ))}
        </ol>
        {problems.conditionList === undefined ? null : <Problem>{problems.conditionList}</Problem>}
        {canAddCondition(draft) ? (
          <Button
            variant="secondary"
            size="small"
            className="self-start"
            onClick={() => {
              change({ ...draft, conditions: [...draft.conditions, emptyCondition()] });
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>Add condition</Trans>
          </Button>
        ) : (
          <p className={labelClassName}>{t`A rule holds at most ${conditionLimit} conditions.`}</p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <h3 className={fieldLabelClassName}>
          <Trans>Then</Trans>
        </h3>
        <div className="flex max-w-xl min-w-0 flex-col gap-1.5">
          <label htmlFor={`${id}-source`} className={labelClassName}>
            <Trans>Name the Source</Trans>
          </label>
          <Input
            id={`${id}-source`}
            autoComplete="off"
            maxLength={LEAD_SOURCE_LIMITS.labelLength}
            placeholder={t`Such as Spring promo`}
            value={draft.source}
            aria-invalid={problems.source === undefined ? undefined : true}
            aria-describedby={
              problems.source === undefined ? `${id}-source-hint` : `${id}-source-problem`
            }
            onValueChange={(source) => {
              change({ ...draft, source });
            }}
          />
          {problems.source === undefined ? (
            <p id={`${id}-source-hint`} className={labelClassName}>
              <Trans>
                Left empty, this rule names no Source: it only adds its tags and fills its fields,
                and the next rule or the built-in rules name the lead.
              </Trans>
            </p>
          ) : (
            <Problem id={`${id}-source-problem`}>{problems.source}</Problem>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <TagPicker
            label={t`Tags to add`}
            chosen={draft.tagIds}
            limit={LEAD_SOURCE_RULE_LIMITS.tags}
            client={client}
            cacheKey={['b', businessId, 'tags']}
            onChange={(tagIds) => {
              change({ ...draft, tagIds });
            }}
          />
          {problems.tagIds === undefined ? null : <Problem>{problems.tagIds}</Problem>}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p id={`${id}-fills`} className={fieldLabelClassName}>
            <Trans>Custom fields to fill</Trans>
          </p>
          {draft.fieldWrites.length === 0 ? null : (
            <ol
              aria-labelledby={`${id}-fills`}
              className="flex min-w-0 list-none flex-col gap-2 p-0"
            >
              {draft.fieldWrites.map((write, index) => {
                const number = index + 1;
                const said = Object.values(problems.fieldWrites[index] ?? {});
                const known = fields.some((field) => field.id === write.fieldId);
                const set = (next: Partial<typeof write>): void => {
                  change({
                    ...draft,
                    fieldWrites: draft.fieldWrites.map((each, at) =>
                      at === index ? { ...each, ...next } : each,
                    ),
                  });
                };
                return (
                  <li
                    // As with the conditions: a row is known by its place.
                    // eslint-disable-next-line @eslint-react/no-array-index-key
                    key={index}
                    className="flex min-w-0 flex-col gap-1.5"
                  >
                    <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-start">
                      <Select
                        aria-label={t`Field ${number}: which field`}
                        aria-invalid={problems.fieldWrites[index]?.['fieldId'] !== undefined}
                        value={write.fieldId}
                        onValueChange={(fieldId) => {
                          set({ fieldId });
                        }}
                      >
                        <option value={CHOOSE}>{t`Choose a field`}</option>
                        {known || write.fieldId === CHOOSE ? null : (
                          <option value={write.fieldId}>{t`A field that is gone`}</option>
                        )}
                        {unusedFields(write.fieldId).map((field) => (
                          <option key={field.id} value={field.id}>
                            {field.label}
                          </option>
                        ))}
                      </Select>
                      <Input
                        aria-label={t`Field ${number}: text to write`}
                        aria-invalid={
                          problems.fieldWrites[index]?.['value'] === undefined ? undefined : true
                        }
                        autoComplete="off"
                        maxLength={LEAD_SOURCE_RULE_LIMITS.valueLength}
                        value={write.value}
                        onValueChange={(value) => {
                          set({ value });
                        }}
                      />
                      <button
                        type="button"
                        className={`${iconButtonClassName} justify-self-end`}
                        aria-label={t`Remove field ${number}`}
                        title={t`Remove field ${number}`}
                        onClick={() => {
                          change({
                            ...draft,
                            fieldWrites: draft.fieldWrites.filter((_, at) => at !== index),
                          });
                        }}
                      >
                        <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                      </button>
                    </div>
                    {said.length === 0 ? null : <Problem>{said.join(' ')}</Problem>}
                  </li>
                );
              })}
            </ol>
          )}
          {problems.fieldWriteList === undefined ? null : (
            <Problem>{problems.fieldWriteList}</Problem>
          )}
          {fields.length === 0 ? (
            <p className={labelClassName}>
              <Trans>
                There are no text custom fields of contacts to fill yet. Make one in Settings, under
                Custom Fields.
              </Trans>
            </p>
          ) : canAddFieldWrite(draft) ? (
            <Button
              variant="secondary"
              size="small"
              className="self-start"
              onClick={() => {
                change({
                  ...draft,
                  fieldWrites: [...draft.fieldWrites, { fieldId: CHOOSE, value: '' }],
                });
              }}
            >
              <Plus aria-hidden className="size-4" strokeWidth={2} />
              <Trans>Add field</Trans>
            </Button>
          ) : (
            <p className={labelClassName}>{t`A rule fills at most ${fieldLimit} fields.`}</p>
          )}
        </div>
      </div>

      <div
        role="group"
        aria-labelledby={`${id}-try`}
        className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted p-3"
      >
        <h3 id={`${id}-try`} className={fieldLabelClassName}>
          <Trans>Try a link</Trans>
        </h3>
        <p id={`${id}-try-hint`} className={labelClassName}>
          <Trans>
            Paste an address a visitor would land on to see whether this rule, as it stands here,
            would match it. Nothing is stored.
          </Trans>
        </p>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1 basis-64">
            <Input
              aria-label={t`Link to try`}
              aria-describedby={[
                `${id}-try-hint`,
                ...(linkProblem === undefined ? [] : [`${id}-try-problem`]),
              ].join(' ')}
              // A problem with this box is not a problem with the rule: it never takes the
              // keyboard after a refused save.
              data-invalid={linkProblem === undefined ? undefined : true}
              type="text"
              inputMode="url"
              autoComplete="off"
              placeholder="https://www.example.com/offer?utm_campaign=spring"
              maxLength={ATTRIBUTION_LIMITS.urlLength}
              value={link}
              onValueChange={(next) => {
                setLink(next);
                setTried(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                // Enter here tries the link: it does not save the rule.
                event.preventDefault();
                tryLink();
              }}
            />
          </div>
          <Button variant="secondary" disabled={trial.isPending} onClick={tryLink}>
            {trial.isPending ? t`Trying…` : t`Try`}
          </Button>
        </div>
        {linkProblem === undefined ? null : (
          <Problem id={`${id}-try-problem`}>{linkProblem}</Problem>
        )}
        {trial.isError ? (
          <Problem>
            {trial.error instanceof ApiError
              ? trial.error.message
              : t`The link couldn't be tried. Check your connection and try again.`}
          </Problem>
        ) : null}
        <div aria-live="polite" className="flex min-w-0 flex-col gap-1.5 empty:hidden">
          {result === undefined ? null : (
            <>
              <p className="text-sm font-medium">
                {result.matches ? (
                  <Trans>This rule would match this link.</Trans>
                ) : (
                  <Trans>This rule would not match this link.</Trans>
                )}
              </p>
              <ul className="flex min-w-0 list-none flex-col gap-1 p-0 text-sm">
                {draft.conditions.map((condition, index) => {
                  const holds = result.holds[index] === true;
                  const Icon = holds ? Check : X;
                  return (
                    <li
                      // eslint-disable-next-line @eslint-react/no-array-index-key
                      key={index}
                      className="flex min-w-0 items-start gap-1.5"
                    >
                      <Icon
                        aria-hidden
                        className={`mt-0.5 size-4 shrink-0 ${holds ? 'text-success' : 'text-destructive'}`}
                        strokeWidth={2}
                      />
                      <span className="min-w-0 wrap-anywhere">
                        <span className="sr-only">
                          {holds ? <Trans>Holds:</Trans> : <Trans>Does not hold:</Trans>}{' '}
                        </span>
                        {conditionPhrase(condition, words)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className={labelClassName}>
                {result.matches ? (
                  <Trans>
                    Tried as a form on that page would take the lead. Saved, the rule would do what
                    is set under “Then”, in its place among your rules.
                  </Trans>
                ) : (
                  <Trans>
                    Tried as a form on that page would take the lead. Every condition must hold for
                    the rule to do anything.
                  </Trans>
                )}
              </p>
            </>
          )}
        </div>
      </div>

      {problems.form === undefined ? null : (
        <div className="flex flex-col items-start gap-2">
          <Problem>{problems.form}</Problem>
          {stale && rule !== undefined ? (
            <Button
              variant="secondary"
              size="small"
              disabled={reload.isPending}
              onClick={() => {
                reload.mutate(rule.id);
              }}
            >
              <Trans>Reload saved version</Trans>
            </Button>
          ) : null}
        </div>
      )}
      {isClean(problems) || problems.form !== undefined ? null : (
        <p role="status" className="text-sm text-destructive">
          <Trans>The rule wasn't saved: see what is marked above.</Trans>
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" disabled={save.isPending} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save rule</Trans>}
        </Button>
      </div>
    </form>
  );
}
