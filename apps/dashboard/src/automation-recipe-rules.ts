// The ready-made workflows offered by "Start from a recipe" (docs/AUTOMATIONS.md section
// 9): what each is called and does, what a person chooses before one is made, and the
// document those choices give. A recipe is written by the contract's own function
// (automations-recipes.ts), so the server's tests publish the same document this makes.
// Nothing here talks to the server.
//
// Its words are in the builder's own catalog (lingui.config.ts, automation-words.ts).
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  appointmentRemindersRecipe,
  leadSourceRecipe,
  leadSourceRecipeBranches,
  leadSourceRecipeSources,
  leadSourceRecipeTags,
  MAX_ASSIGN_USERS,
  MAX_REMINDER_CALENDARS,
  type AutomationDocumentInput,
  type AutomationSetup,
  type LeadSourceRecipeBranch,
  type LeadSourceTags,
} from '@repo/contracts';

/** The recipes there are, by key; the address can name one (automation-search.ts). */
export const recipeKeys = ['lead_source', 'appointment_reminders'] as const;
export type RecipeKey = (typeof recipeKeys)[number];

export interface Recipe {
  readonly key: RecipeKey;
  readonly name: MessageDescriptor;
  readonly description: MessageDescriptor;
  /** What it does, step by step, as its card lists it. */
  readonly does: readonly MessageDescriptor[];
}

const branchNames = leadSourceRecipeBranches.map((branch) => branch.source).join(', ');

export const recipes: readonly Recipe[] = [
  {
    key: 'lead_source',
    name: msg`Tag and route leads by source`,
    description: msg`One form, several ads: tells the leads apart by how each arrived.`,
    does: [
      msg`Starts when any form is submitted.`,
      msg`Takes a branch for each of ${branchNames}, and one for everything else.`,
      msg`Adds the tag of that source, such as “Source: Google Ads”: the same tag your forms add. Everything else gets no tag here.`,
      msg`Gives the lead an owner, unless you leave that out.`,
      msg`Opens an opportunity whose source is how the lead arrived.`,
    ],
  },
  {
    key: 'appointment_reminders',
    name: msg`Appointment reminders`,
    description: msg`Fewer no-shows: reminds people of the appointment they booked, a day and an hour before.`,
    does: [
      msg`Starts when an appointment is booked on the calendars you choose. The booking's own confirmation is not sent again.`,
      msg`Waits until 24 hours before the appointment and emails a reminder. A booking made less than a day ahead skips this one.`,
      msg`Waits until 1 hour before and emails again, with a text too if you choose.`,
      msg`A reschedule moves both reminders; a cancellation or a no-show stops them.`,
      msg`The reminders are transactional: they go to people who agreed to booking notifications, without a marketing footer.`,
    ],
  },
];

/** What a person chooses for "Appointment reminders". */
export interface ReminderChoices {
  /** The calendars, by id; none: every calendar. */
  readonly calendars: readonly string[];
  /** Whether a text goes with the reminder an hour before. */
  readonly text: boolean;
}

/**
 * What "Appointment reminders" starts with: the calendar the address names, when the
 * business has it, else every calendar; and a text when a number can send one.
 */
export function reminderStarterChoices(
  setup: Pick<AutomationSetup, 'calendars' | 'channels'>,
  calendar?: string,
): ReminderChoices {
  return {
    calendars:
      calendar !== undefined && setup.calendars.some((each) => each.id === calendar)
        ? [calendar]
        : [],
    text: setup.channels.sms,
  };
}

/** The choices with a calendar ticked or unticked, never more than a recipe may list. */
export function withCalendar(
  choices: ReminderChoices,
  calendar: string,
  ticked: boolean,
): ReminderChoices {
  const others = choices.calendars.filter((each) => each !== calendar);
  return {
    ...choices,
    calendars: ticked ? [...others, calendar].slice(0, MAX_REMINDER_CALENDARS) : others,
  };
}

/** The reminders document the choices give. A text is never added without a number. */
export function reminderDocument(
  choices: ReminderChoices,
  setup: Pick<AutomationSetup, 'calendars' | 'channels'>,
  name: string,
): AutomationDocumentInput {
  return appointmentRemindersRecipe({
    name,
    calendars: choices.calendars.filter((id) => setup.calendars.some((each) => each.id === id)),
    text: choices.text && setup.channels.sms,
  });
}

/** Who new leads go to: nobody, everyone on the team in turn, or one person by id. */
export type RecipeOwners = 'none' | 'everyone' | (string & {});

export interface RecipeChoices {
  readonly pipeline: string;
  readonly stage: string;
  readonly owners: RecipeOwners;
}

type Setup = Pick<AutomationSetup, 'pipelines' | 'users'>;

/** The stages of the pipeline chosen; none for a pipeline the business does not have. */
export function stagesOf(
  setup: Pick<AutomationSetup, 'pipelines'>,
  pipeline: string,
): readonly { readonly id: string; readonly name: string }[] {
  return setup.pipelines.find((each) => each.id === pipeline)?.stages ?? [];
}

/**
 * What the dialog starts with: the first pipeline and its first stage, and the leads shared
 * between everyone when the team has more than one person. Nothing for a business with no
 * pipeline or no stage: an opportunity has nowhere to go.
 */
export function starterChoices(setup: Setup): RecipeChoices | undefined {
  const pipeline = setup.pipelines.find((each) => each.stages.length > 0);
  const stage = pipeline?.stages[0];
  if (pipeline === undefined || stage === undefined) return undefined;
  const [only] = setup.users;
  return {
    pipeline: pipeline.id,
    stage: stage.id,
    owners: only === undefined ? 'none' : setup.users.length === 1 ? only.id : 'everyone',
  };
}

/** The choices after another pipeline is chosen: its first stage. */
export function withPipeline(
  choices: RecipeChoices,
  pipeline: string,
  setup: Pick<AutomationSetup, 'pipelines'>,
): RecipeChoices {
  return { ...choices, pipeline, stage: stagesOf(setup, pipeline)[0]?.id ?? '' };
}

/** The team members the owner step names, by id: none, one, or everyone up to the limit. */
export function ownersOf(owners: RecipeOwners, setup: Pick<AutomationSetup, 'users'>): string[] {
  if (owners === 'none') return [];
  if (owners === 'everyone') return setup.users.slice(0, MAX_ASSIGN_USERS).map((user) => user.id);
  return setup.users.some((user) => user.id === owners) ? [owners] : [];
}

/**
 * The lead sources whose tags the recipe adds, by key: what the server is asked for. It
 * answers the business's own tag of each, the one a form adds for that source, making any
 * that is not there yet. The recipe never makes a tag by name, so it cannot make a second
 * "Source: Google Ads" beside the form's, or miss one a person renamed.
 */
export const recipeSources = (): LeadSourceRecipeBranch[] => leadSourceRecipeSources();

/** What those tags are called until someone renames them, for the dialog to say. */
export const recipeTagNames = (): string => leadSourceRecipeTags().join(', ');

/** The tag of each branch by id, from the server's answer. */
export function tagIdsOf(
  answer: Pick<LeadSourceTags, 'items'>,
): Partial<Record<LeadSourceRecipeBranch, string>> {
  const wanted = new Set<string>(recipeSources());
  return Object.fromEntries(
    answer.items
      .filter((item) => wanted.has(item.source))
      .map((item) => [item.source, item.tag.id]),
  );
}

/** The document the choices give, with everything of the business named by its id. */
export function recipeDocument(
  choices: RecipeChoices,
  setup: Setup,
  name: string,
  tags: Partial<Record<LeadSourceRecipeBranch, string>> = {},
): AutomationDocumentInput {
  return leadSourceRecipe({
    name,
    pipeline: choices.pipeline,
    stage: choices.stage,
    owners: ownersOf(choices.owners, setup),
    tags,
  });
}
