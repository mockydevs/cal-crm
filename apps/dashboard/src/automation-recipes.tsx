// "Start from a recipe" on the workflows list (docs/AUTOMATIONS.md section 9): a ready-made
// workflow, made as a new draft from a few choices. The draft is an ordinary workflow: it
// opens in the builder, is checked like any other, and never starts running by itself.
// The dialog lists the recipes; choosing one shows what it does and asks its few choices.
// "Tag and route leads by source" adds the tags forms add for lead sources, so it asks the
// server for those (by the lead source's key, never by name) and names each by id: one tag
// a source, whoever made it, also after a rename. "Appointment reminders" asks which
// calendars, and whether a text goes too; a calendar's settings open it with that calendar
// chosen (the address names both).
//
// Its own chunk, fetched when the dialog is first asked for, with its words
// (lingui.config.ts, automation-words.ts).
import type { I18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createAutomation,
  ensureLeadSourceTags,
  getAutomationCatalog,
  type Automation,
  type AutomationDocumentInput,
  type AutomationSetup,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { AutomationDialog } from './automation-dialog';
import {
  recipeDocument,
  recipes,
  recipeSources,
  recipeTagNames,
  reminderDocument,
  reminderStarterChoices,
  stagesOf,
  starterChoices,
  tagIdsOf,
  withCalendar,
  withPipeline,
  type Recipe,
  type RecipeChoices,
  type RecipeKey,
  type ReminderChoices,
} from './automation-recipe-rules';
import { useBusiness } from './workspace';

const selectClassName =
  'min-h-11 w-full min-w-0 rounded-control border border-input bg-card px-2.5 text-md text-foreground disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9';

export interface RecipesDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (automation: Automation) => void;
  /** The recipe to open on, as the address names it, and the calendar it is for. */
  readonly initial?:
    { readonly recipe: RecipeKey; readonly calendar?: string | undefined } | undefined;
}

type Setup = Pick<AutomationSetup, 'pipelines' | 'users' | 'calendars' | 'channels'>;

/** Makes a draft from a document, and says in words why it could not. */
function useCreateDraft(
  onCreated: (automation: Automation) => void,
  forbidden: string,
): {
  readonly create: (document: () => Promise<AutomationDocumentInput>) => void;
  readonly pending: boolean;
  readonly problem: string | undefined;
} {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const cache = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const mutation = useMutation({
    mutationFn: async (document: () => Promise<AutomationDocumentInput>) => {
      const { automation } = await api.request(createAutomation, {
        body: { document: await document() },
      });
      return automation;
    },
    onSuccess: (automation) => {
      void cache.invalidateQueries({ queryKey: ['b', business.id, 'automation-catalog'] });
      onCreated(automation);
    },
    onError: (error) => {
      // Anything made before the failure (a tag) stays, and is found there on the next try.
      void cache.invalidateQueries({ queryKey: ['b', business.id, 'automation-catalog'] });
      setProblem(
        !(error instanceof ApiError)
          ? t`We couldn't reach the server. Check your connection and try again.`
          : error.status === 403
            ? forbidden
            : (error.problem.errors?.[0]?.message ??
              error.problem.detail ??
              t`We couldn't create the workflow. Try again.`),
      );
    },
  });
  return {
    create: (document) => {
      setProblem(undefined);
      mutation.mutate(document);
    },
    pending: mutation.isPending,
    problem,
  };
}

/** What a recipe is and does, as its card says it. */
function RecipeCard({ recipe, i18n }: { readonly recipe: Recipe; readonly i18n: I18n }) {
  const id = useId();
  return (
    <section
      aria-labelledby={`${id}-name`}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border p-4"
    >
      <h3 id={`${id}-name`} className="text-lg font-semibold wrap-break-word">
        {i18n._(recipe.name)}
      </h3>
      <p className="text-md text-muted-foreground">{i18n._(recipe.description)}</p>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-md">
        {recipe.does.map((step) => (
          <li key={step.id}>{i18n._(step)}</li>
        ))}
      </ol>
    </section>
  );
}

function Problem({ problem }: { readonly problem: string | undefined }) {
  return problem === undefined ? null : (
    <p role="alert" className="text-sm font-medium text-destructive wrap-anywhere">
      {problem}
    </p>
  );
}

function Actions({
  disabled,
  onCancel,
  onCreate,
}: {
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onCreate: () => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="quiet" onClick={onCancel}>
        <Trans>Cancel</Trans>
      </Button>
      <Button disabled={disabled} onClick={onCreate}>
        <Trans>Create the draft</Trans>
      </Button>
    </div>
  );
}

function LeadSourceChoices({
  recipe,
  setup,
  onCreated,
  onCancel,
}: {
  readonly recipe: Recipe;
  readonly setup: Setup;
  readonly onCreated: (automation: Automation) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [choices, setChoices] = useState<RecipeChoices | undefined>(() => starterChoices(setup));
  const focusOnMount = useCallback((list: HTMLSelectElement | null) => {
    list?.focus();
  }, []);
  const tagNames = recipeTagNames();
  const draft = useCreateDraft(
    onCreated,
    t`You don't have permission to create workflows or to add tags. Ask someone who manages workflows and tags to start this recipe.`,
  );
  return (
    <>
      <RecipeCard recipe={recipe} i18n={i18n} />
      {choices === undefined ? (
        <p role="alert" className="text-md font-medium text-destructive">
          <Trans>
            This recipe opens an opportunity, and this business has no pipeline with a stage yet.
            Add a pipeline in Opportunities first.
          </Trans>
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            <Trans>Pipeline for the new opportunities</Trans>
            <select
              // The choices arrive after the dialog opened: the keyboard comes to the first.
              ref={focusOnMount}
              className={selectClassName}
              value={choices.pipeline}
              onChange={(event) => {
                setChoices(withPipeline(choices, event.target.value, setup));
              }}
            >
              {setup.pipelines.map((pipeline) => (
                <option
                  key={pipeline.id}
                  value={pipeline.id}
                  disabled={pipeline.stages.length === 0}
                >
                  {pipeline.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            <Trans>Stage they start in</Trans>
            <select
              className={selectClassName}
              value={choices.stage}
              onChange={(event) => {
                setChoices({ ...choices, stage: event.target.value });
              }}
            >
              {stagesOf(setup, choices.pipeline).map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium sm:col-span-2">
            <Trans>Who new leads go to</Trans>
            <select
              className={selectClassName}
              value={choices.owners}
              onChange={(event) => {
                setChoices({ ...choices, owners: event.target.value });
              }}
            >
              <option value="none">{t`Nobody yet (leave the owner step out)`}</option>
              {setup.users.length > 1 ? (
                <option value="everyone">{t`Everyone on the team, in turn`}</option>
              ) : null}
              {setup.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
            <span className="font-normal text-muted-foreground">
              <Trans>A lead that already has an owner keeps that owner.</Trans>
            </span>
          </label>
        </div>
      )}
      <p className="text-sm text-muted-foreground wrap-anywhere">
        <Trans>
          It adds the tags your forms add for these sources ({tagNames}). One that isn't here yet is
          made first, in the “Lead source” tag group; no second copy is ever made.
        </Trans>
      </p>
      <Problem problem={draft.problem} />
      <Actions
        disabled={choices === undefined || draft.pending}
        onCancel={onCancel}
        onCreate={() => {
          if (choices === undefined) return;
          draft.create(async () => {
            // The tags first: the business's own tag of each lead source, as its forms add
            // them. The server finds each or makes it; the draft then names them by id.
            const tags = await api.request(ensureLeadSourceTags, {
              body: { sources: recipeSources() },
            });
            return recipeDocument(choices, setup, i18n._(recipe.name), tagIdsOf(tags));
          });
        }}
      />
    </>
  );
}

function ReminderChoicesForm({
  recipe,
  setup,
  calendar,
  onCreated,
  onCancel,
}: {
  readonly recipe: Recipe;
  readonly setup: Setup;
  readonly calendar: string | undefined;
  readonly onCreated: (automation: Automation) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const id = useId();
  const [choices, setChoices] = useState<ReminderChoices>(() =>
    reminderStarterChoices(setup, calendar),
  );
  const draft = useCreateDraft(
    onCreated,
    t`You don't have permission to create workflows. Ask someone who manages workflows to start this recipe.`,
  );
  // Shown after the dialog opened: the keyboard comes to the first choice.
  const focusOnMount = useCallback((box: HTMLInputElement | null) => {
    box?.focus();
  }, []);
  const firstIsText = setup.calendars.length === 0;
  return (
    <>
      <RecipeCard recipe={recipe} i18n={i18n} />
      <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={`${id}-calendars`}>
        <legend className="text-sm font-medium">
          <Trans>Calendars it reminds for</Trans>
        </legend>
        <p id={`${id}-calendars`} className="text-sm text-muted-foreground">
          {setup.calendars.length === 0 ? (
            <Trans>This business has no calendar yet: the workflow starts for any calendar.</Trans>
          ) : (
            <Trans>Leave them all unticked to remind for every calendar.</Trans>
          )}
        </p>
        {setup.calendars.map((each, index) => {
          const checked = choices.calendars.includes(each.id);
          return (
            <label key={each.id} className="flex min-h-9 min-w-0 items-center gap-2.5 text-md">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={checked}
                {...(index === 0 ? { ref: focusOnMount } : {})}
                onChange={() => {
                  setChoices(withCalendar(choices, each.id, !checked));
                }}
              />
              <span className="min-w-0 wrap-anywhere">{each.name}</span>
            </label>
          );
        })}
      </fieldset>
      <div className="flex min-w-0 flex-col gap-1">
        <label className="flex min-h-9 min-w-0 items-center gap-2.5 text-md">
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-primary"
            checked={choices.text && setup.channels.sms}
            disabled={!setup.channels.sms}
            {...(firstIsText ? { ref: focusOnMount } : {})}
            aria-describedby={`${id}-text`}
            onChange={(event) => {
              setChoices({ ...choices, text: event.target.checked });
            }}
          />
          <Trans>Also send a text an hour before</Trans>
        </label>
        <p id={`${id}-text`} className="text-sm text-muted-foreground">
          {setup.channels.sms ? (
            <Trans>
              Only to contacts with a phone number who agreed to texts about their bookings.
            </Trans>
          ) : (
            <Trans>
              Connect a phone number in Settings → Phone System to send texts. You can add the text
              step later.
            </Trans>
          )}
        </p>
      </div>
      {setup.channels.email ? null : (
        <p className="text-sm font-medium text-foreground">
          <Trans>
            This business has no mailbox connected, so the reminders can't be sent yet. The draft is
            made all the same: connect a mailbox in Settings → Email Services before you publish it.
          </Trans>
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        <Trans>
          Quiet hours hold reminders as they hold every message: one due during them goes out when
          they end.
        </Trans>
      </p>
      <Problem problem={draft.problem} />
      <Actions
        disabled={draft.pending}
        onCancel={onCancel}
        onCreate={() => {
          draft.create(() =>
            Promise.resolve(reminderDocument(choices, setup, i18n._(recipe.name))),
          );
        }}
      />
    </>
  );
}

/** The recipes to start from, each with what it is for. */
function RecipeList({ onPick }: { readonly onPick: (recipe: RecipeKey) => void }): ReactElement {
  const { i18n } = useLingui();
  const id = useId();
  // The list arrives after the dialog opened, or after "All recipes": the keyboard comes to
  // the first.
  const focusOnMount = useCallback((button: HTMLButtonElement | null) => {
    button?.focus();
  }, []);
  return (
    <ul className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      {recipes.map((recipe, index) => (
        <li key={recipe.key} className="min-w-0">
          <button
            type="button"
            className="flex h-full w-full min-w-0 flex-col items-start gap-1 rounded-xl border border-border p-4 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            {...(index === 0 ? { ref: focusOnMount } : {})}
            aria-labelledby={`${id}-${recipe.key}`}
            aria-describedby={`${id}-${recipe.key}-about`}
            onClick={() => {
              onPick(recipe.key);
            }}
          >
            <span id={`${id}-${recipe.key}`} className="text-md font-semibold wrap-break-word">
              {i18n._(recipe.name)}
            </span>
            <span id={`${id}-${recipe.key}-about`} className="text-sm text-muted-foreground">
              {i18n._(recipe.description)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Recipes({
  setup,
  initial,
  onCreated,
  onCancel,
}: {
  readonly setup: Setup;
  readonly initial: RecipesDialogProps['initial'];
  readonly onCreated: (automation: Automation) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [picked, setPicked] = useState<RecipeKey | undefined>(initial?.recipe);
  const recipe = recipes.find((each) => each.key === picked);
  if (recipe === undefined) return <RecipeList onPick={setPicked} />;
  return (
    <>
      <Button
        type="button"
        variant="quiet"
        size="small"
        className="self-start"
        onClick={() => {
          setPicked(undefined);
        }}
      >
        <Trans>← All recipes</Trans>
      </Button>
      {recipe.key === 'lead_source' ? (
        <LeadSourceChoices
          recipe={recipe}
          setup={setup}
          onCreated={onCreated}
          onCancel={onCancel}
        />
      ) : (
        <ReminderChoicesForm
          recipe={recipe}
          setup={setup}
          calendar={initial?.calendar}
          onCreated={onCreated}
          onCancel={onCancel}
        />
      )}
    </>
  );
}

export default function RecipesDialog({
  open,
  onOpenChange,
  onCreated,
  initial,
}: RecipesDialogProps): ReactElement {
  const business = useBusiness();
  const api = apiIn(business.id);
  // What the business has to choose from: its pipelines, team, calendars and channels.
  const catalog = useQuery({
    queryKey: ['b', business.id, 'automation-catalog'],
    queryFn: () => api.request(getAutomationCatalog, {}),
    enabled: open,
    staleTime: 60_000,
  });
  return (
    <AutomationDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={<Trans>Start from a recipe</Trans>}
      description={
        <Trans>
          A ready-made workflow, added as a new draft. You can change every step before you publish
          it; it never starts running by itself.
        </Trans>
      }
    >
      {catalog.isError ? (
        <div role="alert" className="flex min-w-0 flex-col items-start gap-2 text-md">
          <p className="font-medium text-destructive">
            <Trans>We couldn't load what this business has to choose from.</Trans>
          </p>
          <Button
            type="button"
            variant="secondary"
            size="small"
            data-initial-focus
            onClick={() => {
              void catalog.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : catalog.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : (
        <Recipes
          setup={catalog.data.setup}
          initial={initial}
          onCreated={(automation) => {
            onOpenChange(false);
            onCreated(automation);
          }}
          onCancel={() => {
            onOpenChange(false);
          }}
        />
      )}
    </AutomationDialog>
  );
}
