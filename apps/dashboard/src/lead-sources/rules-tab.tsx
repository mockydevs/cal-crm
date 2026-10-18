// Settings → Lead Sources → Rules: the business's own rules for naming how a lead arrived,
// in the order they are tried, and under them the built-in rules, read-only, in theirs.
// Every lead gets a source from the built-in rules with no setup; a rule here runs first
// and can name the Source, add tags or fill a text custom field. The built-in list and
// every word of a condition come from the API's own vocabulary
// (packages/contracts/src/lead-sources.ts and lead-source-rules.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createLeadSourceRule,
  deleteLeadSourceRule,
  getFields,
  getTagConfiguration,
  LEAD_SOURCE_RULE_LIMITS,
  leadSourceKeys,
  leadSourceLabels,
  leadSourceRuleDescriptions,
  listLeadSourceRules,
  reorderLeadSourceRules,
  updateLeadSourceRule,
  type LeadSourceRule,
  type LeadSourceRuleList,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Copy, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { Switch } from '../automation-switch';
import { ConfirmDialog, ListProblem } from '../settings-list';
import { useBusiness } from '../workspace';
import {
  cardClassName,
  iconButtonClassName,
  labelClassName,
  LeadSourcesFrame,
  retryFaults,
} from './frame';
import { fillableFields, RuleSentenceLine, useSentenceText, useSentenceWords } from './rule-words';
import {
  canAddRule,
  copyName,
  droppedOrder,
  emptyRule,
  movedOrder,
  ruleBodyOf,
  ruleDraftOf,
  ruleSentence,
  type RuleDraft,
} from './rules';

// The editor, with the tag chips and the boxes of a condition: fetched when a rule is opened.
const RuleEditor = lazy(() => import('./rule-editor'));

const rulesKey = (businessId: string) => ['b', businessId, 'lead-sources', 'rules'] as const;

type Editing =
  | { readonly kind: 'new'; readonly initial: RuleDraft }
  | { readonly kind: 'edit'; readonly rule: LeadSourceRule };

/** What the server said, or the page's own words when no answer came. */
const saidBy = (error: unknown, fallback: string): string =>
  error instanceof ApiError
    ? (error.problem.errors?.[0]?.message ?? error.problem.detail ?? error.message)
    : fallback;

export default function RulesTab(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const [editing, setEditing] = useState<Editing>();
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const [removing, setRemoving] = useState<LeadSourceRule>();
  const [removeProblem, setRemoveProblem] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  // The button the keyboard goes back to once the list is drawn again.
  const [focusOn, setFocusOn] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const rules = useQuery({
    queryKey: rulesKey(business.id),
    queryFn: () => api.request(listLeadSourceRules, {}),
    retry: retryFaults,
  });
  const tags = useQuery({
    queryKey: ['b', business.id, 'tags'],
    queryFn: () => api.request(getTagConfiguration, {}),
    staleTime: 60_000,
    retry: retryFaults,
  });
  const fields = useQuery({
    queryKey: ['b', business.id, 'fields'],
    queryFn: () => api.request(getFields, {}),
    staleTime: 60_000,
    retry: retryFaults,
  });
  const tagItems = tags.data?.items ?? [];
  const fieldItems = fields.data?.items ?? [];
  const words = useSentenceWords(tagItems, fieldItems);
  const sentenceText = useSentenceText();

  useEffect(() => {
    if (focusOn === undefined) return;
    listRef.current?.querySelector<HTMLElement>(`[data-focus="${focusOn}"]`)?.focus();
  }, [focusOn, rules.data]);

  const keep = (list: LeadSourceRuleList): void => {
    cache.setQueryData(rulesKey(business.id), list);
  };
  const refresh = (): Promise<void> => cache.invalidateQueries({ queryKey: rulesKey(business.id) });
  const failed = (error: unknown, fallback: string): void => {
    setNotice('');
    setProblem(
      error instanceof ApiError && error.status === 409
        ? t`The rules changed since this page read them. They were read again: try once more.`
        : saidBy(error, fallback),
    );
    void refresh();
  };

  const reorder = useMutation({
    mutationFn: (input: { readonly ruleIds: string[]; readonly revision: string }) =>
      api.request(reorderLeadSourceRules, { body: input }),
    onError: (error) => {
      failed(error, t`The order wasn't saved. Check your connection and try again.`);
    },
  });
  const toggle = useMutation({
    mutationFn: (rule: LeadSourceRule) =>
      api.request(updateLeadSourceRule, {
        params: { ruleId: rule.id },
        body: {
          ...ruleBodyOf(ruleDraftOf(rule)),
          enabled: !rule.enabled,
          revision: rule.revision,
        },
      }),
    onSuccess: async (saved) => {
      await refresh();
      const name = saved.name;
      setProblem(undefined);
      setNotice(saved.enabled ? t`“${name}” is on.` : t`“${name}” is off.`);
    },
    onError: (error) => {
      failed(error, t`The rule wasn't changed. Check your connection and try again.`);
    },
  });
  const duplicate = useMutation({
    mutationFn: (rule: LeadSourceRule) =>
      api.request(createLeadSourceRule, {
        body: { ...ruleBodyOf(ruleDraftOf(rule)), name: copyName(rule.name, ` (${t`copy`})`) },
      }),
    onSuccess: async (made) => {
      await refresh();
      const name = made.name;
      setProblem(undefined);
      setNotice(t`“${name}” was added last.`);
      setFocusOn(`edit:${made.id}`);
    },
    onError: (error) => {
      failed(error, t`The copy wasn't made. Check your connection and try again.`);
    },
  });
  const remove = useMutation({
    mutationFn: (rule: LeadSourceRule) =>
      api.request(deleteLeadSourceRule, { params: { ruleId: rule.id } }),
    onSuccess: async (_gone, rule) => {
      await refresh();
      const name = rule.name;
      setRemoving(undefined);
      setProblem(undefined);
      setNotice(t`“${name}” was deleted.`);
    },
    onError: (error) => {
      setRemoveProblem(saidBy(error, t`It wasn't deleted. Check your connection and try again.`));
    },
  });

  const list = rules.data;
  const items = list?.items ?? [];
  const canManage = list?.canManage === true;
  const busy = reorder.isPending || toggle.isPending || duplicate.isPending;
  const limit = LEAD_SOURCE_RULE_LIMITS.rules;
  const count = items.length;
  const room = canAddRule(count);
  const removingName = removing?.name ?? '';

  const move = (ruleIds: string[] | undefined, rule: LeadSourceRule, focus: string): void => {
    if (ruleIds === undefined || list === undefined || busy) return;
    reorder.mutate(
      { ruleIds, revision: list.revision },
      {
        onSuccess: (next) => {
          keep(next);
          const name = rule.name;
          const place = next.items.findIndex((each) => each.id === rule.id) + 1;
          const total = next.items.length;
          setProblem(undefined);
          setNotice(t`“${name}” is now rule ${place} of ${total}.`);
          setFocusOn(focus);
        },
      },
    );
  };
  const open = (next: Editing, trigger: HTMLElement | null): void => {
    returnFocusRef.current = trigger;
    setEditing(next);
    setNotice('');
    setProblem(undefined);
  };
  const close = (message = ''): void => {
    setEditing(undefined);
    setNotice(message);
    // The editor is gone: the keyboard goes back to what opened it, when it is still there.
    requestAnimationFrame(() => {
      if (returnFocusRef.current?.isConnected === true) returnFocusRef.current.focus();
    });
  };

  const addButton = (
    <Button
      disabled={!room}
      onClick={(event) => {
        open({ kind: 'new', initial: emptyRule() }, event.currentTarget);
      }}
    >
      <Plus aria-hidden className="size-4" strokeWidth={2} />
      <Trans>Add rule</Trans>
    </Button>
  );

  return (
    <LeadSourcesFrame>
      <p className="max-w-[820px] text-md text-muted-foreground">
        <Trans>
          Every lead that arrives by a form, a booking page or a web chat is given a lead source by
          the built-in rules below, with nothing to set up. Rules of your own are tried first: they
          can give the lead another Source, add tags or fill a custom field.
        </Trans>
      </p>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}

      {editing === undefined ? null : (
        <Suspense fallback={null}>
          <RuleEditor
            key={editing.kind === 'edit' ? editing.rule.id : 'new'}
            rule={editing.kind === 'edit' ? editing.rule : undefined}
            initial={editing.kind === 'edit' ? ruleDraftOf(editing.rule) : editing.initial}
            client={api}
            businessId={business.id}
            fields={fillableFields(fieldItems)}
            tags={tagItems}
            onSaved={(saved) => {
              void refresh();
              const name = saved.name;
              close(t`“${name}” was saved.`);
            }}
            onCancel={() => {
              close();
            }}
          />
        </Suspense>
      )}

      <section className={cardClassName} aria-labelledby="lead-source-own-rules">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="lead-source-own-rules" className="text-base font-medium">
              <Trans>Your rules</Trans>
            </h2>
            {list === undefined || count === 0 ? null : (
              <p className={labelClassName}>
                {room
                  ? t`${count} of ${limit}. Tried from the top: the first that names a Source decides it, and every rule that matches adds its tags and fills its fields.`
                  : t`${count} of ${limit}, which is the most. Delete a rule to add another.`}
              </p>
            )}
          </div>
          {canManage && count > 0 && editing === undefined ? addButton : null}
        </div>
        {rules.isPending ? (
          <p role="status" className={labelClassName}>
            <Trans>Loading your rules…</Trans>
          </p>
        ) : rules.isError ? (
          <ListProblem
            onRetry={() => {
              void rules.refetch();
            }}
          >
            <Trans>Your rules couldn't be loaded.</Trans>
          </ListProblem>
        ) : count === 0 ? (
          <div className="flex min-w-0 flex-col items-start gap-3">
            <p className="max-w-[720px] text-sm">
              <Trans>
                You have no rules of your own, and most businesses need none: the built-in rules
                already tell Google Ads from Facebook Ads from a search. A rule is worth having when
                you want a name they cannot know, such as “Spring promo” for one campaign, a tag for
                every lead of one funnel, or a custom field filled from a link.
              </Trans>
            </p>
            {canManage ? (
              editing === undefined ? (
                addButton
              ) : null
            ) : (
              <p className={labelClassName}>
                <Trans>Adding a rule needs permission to manage forms.</Trans>
              </p>
            )}
          </div>
        ) : (
          <ol ref={listRef} className="flex min-w-0 list-none flex-col gap-2 p-0">
            {items.map((rule, index) => {
              const name = rule.name;
              const sentence = ruleSentence(ruleDraftOf(rule), words);
              const ids = items.map((each) => each.id);
              const place = index + 1;
              const said = sentenceText(sentence);
              return (
                // Dragging is a second way to reorder, for a mouse: the two arrow buttons of
                // each rule are the keyboard's and a screen reader's, and say where it went.
                // eslint-disable-next-line jsx-a11y-x/no-noninteractive-element-interactions
                <li
                  key={rule.id}
                  aria-label={t`Rule ${place}: ${name}. ${said}`}
                  draggable={canManage && !busy && editing === undefined}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    setDragging(rule.id);
                  }}
                  onDragEnd={() => {
                    setDragging(undefined);
                  }}
                  onDragOver={(event) => {
                    if (dragging !== undefined && dragging !== rule.id) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const moving = items.find((each) => each.id === dragging);
                    setDragging(undefined);
                    if (moving !== undefined)
                      move(droppedOrder(ids, moving.id, rule.id), moving, `edit:${moving.id}`);
                  }}
                  className={`flex min-w-0 flex-col gap-1.5 rounded-lg border border-border p-2.5 sm:flex-row sm:items-start sm:gap-3 ${
                    dragging === rule.id ? 'opacity-50' : ''
                  } ${rule.enabled ? '' : 'bg-muted'}`}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    {canManage ? (
                      <GripVertical
                        aria-hidden
                        className="mt-1 size-4 shrink-0 cursor-grab text-muted-foreground max-sm:hidden"
                        strokeWidth={1.8}
                      />
                    ) : null}
                    <span
                      aria-hidden
                      className="mt-0.5 w-5 shrink-0 text-sm text-muted-foreground tabular-nums"
                    >
                      {place}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="min-w-0 font-medium wrap-anywhere">
                        {name}
                        {rule.enabled ? null : (
                          <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-body">
                            <Trans>Off</Trans>
                          </span>
                        )}
                      </p>
                      <RuleSentenceLine sentence={sentence} />
                      {rule.problems.map((each) => (
                        <p key={`${each.code}:${each.id}`} className="text-sm text-destructive">
                          {each.message}
                        </p>
                      ))}
                    </div>
                  </div>
                  {canManage ? (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
                      <Switch
                        checked={rule.enabled}
                        disabled={busy}
                        aria-label={t`Use “${name}”`}
                        onChange={() => {
                          toggle.mutate(rule);
                        }}
                      />
                      <button
                        type="button"
                        data-focus={`up:${rule.id}`}
                        className={iconButtonClassName}
                        aria-label={t`Move “${name}” up`}
                        title={t`Move up`}
                        disabled={index === 0 || busy}
                        onClick={() => {
                          // At the top the button that moved it is off: the other one takes over.
                          move(
                            movedOrder(ids, index, -1),
                            rule,
                            index === 1 ? `down:${rule.id}` : `up:${rule.id}`,
                          );
                        }}
                      >
                        <ArrowUp aria-hidden className="size-4" strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        data-focus={`down:${rule.id}`}
                        className={iconButtonClassName}
                        aria-label={t`Move “${name}” down`}
                        title={t`Move down`}
                        disabled={index === count - 1 || busy}
                        onClick={() => {
                          move(
                            movedOrder(ids, index, 1),
                            rule,
                            index === count - 2 ? `up:${rule.id}` : `down:${rule.id}`,
                          );
                        }}
                      >
                        <ArrowDown aria-hidden className="size-4" strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        data-focus={`edit:${rule.id}`}
                        className={iconButtonClassName}
                        aria-label={t`Edit “${name}”`}
                        title={t`Edit`}
                        disabled={editing !== undefined}
                        onClick={(event) => {
                          open({ kind: 'edit', rule }, event.currentTarget);
                        }}
                      >
                        <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className={iconButtonClassName}
                        aria-label={t`Duplicate “${name}”`}
                        title={room ? t`Duplicate` : t`${limit} rules is the most`}
                        disabled={!room || busy}
                        onClick={() => {
                          duplicate.mutate(rule);
                        }}
                      >
                        <Copy aria-hidden className="size-4" strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className={iconButtonClassName}
                        aria-label={t`Delete “${name}”`}
                        title={t`Delete`}
                        disabled={busy}
                        onClick={(event) => {
                          returnFocusRef.current = event.currentTarget;
                          setRemoveProblem(undefined);
                          setRemoving(rule);
                        }}
                      >
                        <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {list !== undefined && !canManage && count > 0 ? (
          <p className={labelClassName}>
            <Trans>
              You can look at these rules. Changing them needs permission to manage forms.
            </Trans>
          </p>
        ) : null}
      </section>

      <section className={cardClassName} aria-labelledby="lead-source-built-in">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="lead-source-built-in" className="text-base font-medium">
            <Trans>Built-in rules</Trans>
          </h2>
          <p className={labelClassName}>
            <Trans>
              Tried from the top, after your rules: the first that fits names the lead source. They
              cannot be changed or reordered here.
            </Trans>
          </p>
        </div>
        <ol className="grid min-w-0 list-none gap-x-4 gap-y-1.5 p-0 text-sm sm:grid-cols-[1.5rem_minmax(0,11rem)_minmax(0,1fr)]">
          {leadSourceKeys.map((key, index) => (
            <li key={key} className="contents">
              <span aria-hidden className="text-muted-foreground tabular-nums max-sm:hidden">
                {index + 1}
              </span>
              <span className="min-w-0 font-medium wrap-anywhere">
                {key === 'source_param' ? t`The name in the link` : leadSourceLabels[key]}
              </span>
              <span className="min-w-0 pb-1 wrap-anywhere text-muted-foreground sm:pb-0">
                {leadSourceRuleDescriptions[key]}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <ConfirmDialog
        open={removing !== undefined}
        title={<Trans>Delete rule</Trans>}
        description={
          <Trans>
            “{removingName}” will no longer be tried. Leads it already named keep their Source and
            tags.
          </Trans>
        }
        confirmLabel={t`Delete rule`}
        destructive
        busy={remove.isPending}
        problem={removeProblem}
        returnFocus={returnFocusRef}
        onClose={() => {
          setRemoving(undefined);
        }}
        onConfirm={() => {
          if (removing === undefined) return;
          setRemoveProblem(undefined);
          remove.mutate(removing);
        }}
      />
    </LeadSourcesFrame>
  );
}
