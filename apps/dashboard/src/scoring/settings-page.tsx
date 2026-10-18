// Settings → Manage Scoring, laid out as GoHighLevel's: one line on what scoring does, "Add
// new rule", the profile's tab ("Engagement Score"), a search, and the rules table (Action,
// Calculation, Points) with a menu on each row and paging. The rules are a draft: the page
// says whether it differs from what scores now, and "Publish" makes it live. GoHighLevel's
// actions this CRM records nothing for are named under the table, never offered.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  deleteScoreRule,
  getScoreProfile,
  getTagConfiguration,
  publishScoreProfile,
  unavailableScoreActions,
  updateScoreProfile,
  type ScoreProfile,
  type ScoreRule,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from '../api';
import { readFormChoices } from '../lead-sources/forms-read';
import { ListSearch } from '../list-toolbar';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  listCardClassName,
  ListFooter,
  ListProblem,
  retryFaults,
  RowMenu,
  SmallDialog,
  tableClassName,
  tableRegionClassName,
} from '../settings-list';
import { rangeOf, type PageSize } from '../settings-rules';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';
import { pageOf, saidBy, searched } from './rules';
import { useScoringWords } from './words';

// The rule's dialog, with its choices: fetched when a rule is opened.
const RuleDialog = lazy(() => import('./rule-dialog'));

const profileKey = (businessId: string) => ['b', businessId, 'scoring'] as const;

type Editing = { readonly rule: ScoreRule | undefined } | undefined;

export default function ManageScoringPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const cache = useQueryClient();
  const words = useScoringWords();
  const tabId = useId();
  const panelId = useId();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [editing, setEditing] = useState<Editing>();
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState<ScoreRule>();
  const [removeProblem, setRemoveProblem] = useState<string>();
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const profile = useQuery({
    queryKey: profileKey(business.id),
    queryFn: () => api.request(getScoreProfile, {}),
    retry: retryFaults,
  });
  const tags = useQuery({
    queryKey: ['b', business.id, 'tags'],
    queryFn: () => api.request(getTagConfiguration, {}),
    staleTime: 60_000,
    retry: retryFaults,
  });
  const forms = useQuery({
    // Not under the profile's key: a save reads the profile again, never the forms.
    queryKey: ['b', business.id, 'score-forms'],
    queryFn: () => readFormChoices(api),
    staleTime: 60_000,
    retry: retryFaults,
  });
  const tagItems = tags.data?.items ?? [];
  const formItems = forms.data ?? [];
  const tagName = (id: string): string =>
    tagItems.find((each) => each.id === id)?.name ?? t`a deleted tag`;
  const formName = (id: string): string =>
    formItems.find((each) => each.id === id)?.name ?? t`a deleted form`;
  const sentence = (rule: ScoreRule): string => words.sentence(rule, tagName, formName);

  const keep = (next: ScoreProfile): void => {
    cache.setQueryData(profileKey(business.id), next);
  };
  const refresh = (): Promise<void> =>
    cache.invalidateQueries({ queryKey: profileKey(business.id) });

  const publish = useMutation({
    mutationFn: (revision: number) => api.request(publishScoreProfile, { body: { revision } }),
    onSuccess: (next) => {
      keep(next);
      setProblem(undefined);
      setNotice(t`Published. The rules score what contacts do from now on.`);
    },
    onError: (error) => {
      setNotice('');
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t`The rules changed since this page read them. They were read again: check them and publish once more.`
          : saidBy(error, t`It wasn't published. Check your connection and try again.`),
      );
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (rule: ScoreRule) => api.request(deleteScoreRule, { params: { ruleId: rule.id } }),
    onSuccess: async () => {
      await refresh();
      setRemoving(undefined);
      setProblem(undefined);
      setNotice(t`The rule was deleted from the draft. Publish to stop it scoring.`);
    },
    onError: (error) => {
      setRemoveProblem(saidBy(error, t`It wasn't deleted. Check your connection and try again.`));
    },
  });

  const data = profile.data;
  const canManage = data?.canManage === true;
  const rules = data?.rules ?? [];
  const found = searched(rules, search, sentence);
  const shown = pageOf(found, page, pageSize);
  const range = rangeOf({
    index: shown.page,
    pageSize,
    shown: shown.items.length,
    total: found.length,
  });
  const full = rules.length >= (data?.limit ?? Infinity);
  const removingSaid = removing === undefined ? undefined : sentence(removing);
  const unavailable = unavailableScoreActions.map((key) => words.unavailable[key]).join(', ');

  return (
    <Page
      title={t`Manage Scoring`}
      actions={
        canManage ? (
          <Button
            disabled={full}
            onClick={(event) => {
              returnFocusRef.current = event.currentTarget;
              setEditing({ rule: undefined });
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>Add new rule</Trans>
          </Button>
        ) : undefined
      }
    >
      <p className="text-md text-muted-foreground">
        <Trans>
          Use the score builder to add or subtract points in a profile and publish it to make it
          live.
        </Trans>
      </p>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      {profile.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading the scoring rules…</Trans>
        </p>
      ) : null}
      {profile.isError ? (
        <ListProblem
          onRetry={() => {
            void profile.refetch();
          }}
        >
          <Trans>The scoring rules couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {data === undefined ? null : (
        <section className={listCardClassName} aria-label={t`Scoring profiles`}>
          <div
            role="tablist"
            aria-label={t`Scoring profiles`}
            className="flex border-b border-border"
          >
            <button
              type="button"
              role="tab"
              id={tabId}
              aria-selected
              aria-controls={panelId}
              className="-mb-px min-h-11 border-b-2 border-primary px-3 text-sm font-medium text-link lg:min-h-9"
            >
              {data.name}
            </button>
          </div>
          <div role="tabpanel" id={panelId} aria-labelledby={tabId} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                {data.description === '' ? null : (
                  <p className="text-md wrap-anywhere text-body">{data.description}</p>
                )}
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {data.publishedAt === null ? (
                    <Badge variant="attention">
                      <Trans>Draft</Trans>
                    </Badge>
                  ) : (
                    <Badge>
                      <Trans>Published</Trans>
                    </Badge>
                  )}
                  {data.unpublishedChanges ? (
                    <Trans>The draft has changes that score nothing until you publish them.</Trans>
                  ) : data.publishedAt === null ? (
                    <Trans>Add rules, then publish them to start scoring.</Trans>
                  ) : (
                    <Trans>Every rule here scores what contacts do.</Trans>
                  )}
                </p>
              </div>
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={(event) => {
                      returnFocusRef.current = event.currentTarget;
                      setRenaming(true);
                    }}
                  >
                    <Trans>Edit profile</Trans>
                  </Button>
                  <Button
                    disabled={!data.unpublishedChanges || publish.isPending}
                    onClick={() => {
                      publish.mutate(data.revision);
                    }}
                  >
                    <Trans>Publish</Trans>
                  </Button>
                </div>
              ) : null}
            </div>
            {canManage ? null : (
              <p className="text-md text-muted-foreground">
                <Trans>
                  You can read the scoring rules. Changing them needs permission to configure
                  fields.
                </Trans>
              </p>
            )}
            <ListSearch
              label={t`Search rules`}
              value={search}
              onChange={(next) => {
                setSearch(next);
                setPage(0);
              }}
            />
            {found.length === 0 ? (
              <p className="py-6 text-center text-md text-muted-foreground">
                {rules.length === 0 ? (
                  <Trans>No rules yet. Add one to start scoring what contacts do.</Trans>
                ) : (
                  <Trans>No rules match.</Trans>
                )}
              </p>
            ) : (
              <div
                role="region"
                aria-label={t`Scoring rules table`}
                className={tableRegionClassName}
              >
                <table className={`${tableClassName} min-w-[640px] table-fixed`}>
                  <caption className="sr-only">
                    <Trans>Scoring rules</Trans>
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className={headerCellClassName}>
                        <Trans>Action</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} w-44`}>
                        <Trans>Calculation</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} w-24`}>
                        <Trans>Points</Trans>
                      </th>
                      {canManage ? (
                        <th scope="col" className={`${headerCellClassName} w-16`}>
                          <span className="sr-only">
                            <Trans>Actions</Trans>
                          </span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.items.map((rule) => {
                      const said = sentence(rule);
                      return (
                        <tr key={rule.id} className="hover:bg-muted">
                          <th
                            scope="row"
                            className={`${cellClassName} text-left font-medium wrap-anywhere text-foreground`}
                          >
                            {said}
                            {rule.problems.map((each) => (
                              <span
                                key={each.code + each.id}
                                className="block text-xs font-normal text-destructive"
                              >
                                {each.code === 'tag_missing' ? (
                                  <Trans>A tag it names was deleted: it scores nobody.</Trans>
                                ) : (
                                  <Trans>The form it names was deleted: it scores nobody.</Trans>
                                )}
                              </span>
                            ))}
                          </th>
                          <td className={cellClassName}>{words.calculations[rule.calculation]}</td>
                          <td
                            className={`${cellClassName} font-medium ${rule.calculation === 'add' ? 'text-success' : 'text-destructive'}`}
                          >
                            {rule.calculation === 'add'
                              ? `+${String(rule.points)}`
                              : `-${String(rule.points)}`}
                          </td>
                          {canManage ? (
                            <td className={`${cellClassName} text-right`}>
                              <RowMenu
                                label={t`Actions for ${said}`}
                                onOpen={(trigger) => {
                                  returnFocusRef.current = trigger;
                                }}
                                actions={[
                                  {
                                    label: t`Edit`,
                                    onSelect: () => {
                                      setEditing({ rule });
                                    },
                                  },
                                  {
                                    label: t`Delete`,
                                    destructive: true,
                                    onSelect: () => {
                                      setRemoveProblem(undefined);
                                      setRemoving(rule);
                                    },
                                  },
                                ]}
                              />
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {found.length === 0 ? null : (
              <ListFooter
                perPageLabel={t`Rules per page`}
                pageSize={pageSize}
                onPageSize={(size) => {
                  setPageSize(size);
                  setPage(0);
                }}
                range={range}
                number={shown.page + 1}
                previous={shown.page > 0}
                next={(shown.page + 1) * pageSize < found.length}
                busy={false}
                onPrevious={() => {
                  setPage(shown.page - 1);
                }}
                onNext={() => {
                  setPage(shown.page + 1);
                }}
              />
            )}
          </div>
        </section>
      )}
      <p className="text-sm text-muted-foreground">
        <Trans>
          Not available yet, as this CRM doesn't record them: {unavailable}. A contact's score never
          drops by itself; a workflow can subtract points instead.
        </Trans>
      </p>
      {editing === undefined ? null : (
        <Suspense fallback={null}>
          <RuleDialog
            rule={editing.rule}
            tags={tagItems}
            forms={formItems}
            returnFocus={returnFocusRef}
            onClose={() => {
              setEditing(undefined);
            }}
            onSaved={async (saved, added) => {
              await refresh();
              setEditing(undefined);
              setProblem(undefined);
              const said = sentence(saved);
              setNotice(
                added
                  ? t`Rule added to the draft: ${said}. Publish to make it score.`
                  : t`Rule saved in the draft: ${said}. Publish to make it score.`,
              );
            }}
          />
        </Suspense>
      )}
      {data === undefined || !renaming ? null : (
        <ProfileDialog
          open
          profile={data}
          returnFocus={returnFocusRef}
          onClose={() => {
            setRenaming(false);
          }}
          onSaved={(next) => {
            keep(next);
            setRenaming(false);
            setNotice(t`The profile was saved.`);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== undefined}
        title={t`Delete this rule?`}
        description={
          removingSaid === undefined
            ? ''
            : t`"${removingSaid}" leaves the draft. It keeps scoring until you publish.`
        }
        confirmLabel={t`Delete`}
        destructive
        busy={remove.isPending}
        problem={removeProblem}
        returnFocus={returnFocusRef}
        onConfirm={() => {
          if (removing !== undefined) remove.mutate(removing);
        }}
        onClose={() => {
          setRemoving(undefined);
        }}
      />
    </Page>
  );
}

/** The profile's name and description, as GoHighLevel lets them be edited. */
function ProfileDialog({
  open,
  profile,
  returnFocus,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly profile: ScoreProfile;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSaved: (profile: ScoreProfile) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const save = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(updateScoreProfile, { body: { name, description } }),
    onSuccess: onSaved,
  });
  return (
    <SmallDialog open={open} onClose={onClose} title={t`Edit profile`} returnFocus={returnFocus}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-sm font-medium">
            <Trans>Name</Trans>
          </label>
          <Input
            id={nameId}
            required
            maxLength={100}
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={descriptionId} className="text-sm font-medium">
            <Trans>Description</Trans>
          </label>
          <Textarea
            id={descriptionId}
            rows={3}
            maxLength={500}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
        {save.isError ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {saidBy(save.error, t`It wasn't saved. Check your connection and try again.`)}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={save.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={save.isPending || name.trim() === ''}>
            <Trans>Save</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
