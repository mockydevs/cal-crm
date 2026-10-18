// Ready-made workflows (AUTOMATIONS.md section 9): a document written from a few choices,
// for the builder's "Start from a recipe" and for anything else that wants the same
// starting point. A recipe is an ordinary document: it is validated, saved as a draft and
// edited like any other, and nothing here runs by itself.
import { attributionPath, DEAL_SOURCE_ARRIVAL } from './automations-attribution.js';
import type { AutomationDocumentInput } from './automations.js';
import { MAX_ASSIGN_USERS } from './automations-catalog.js';
import { leadSourceLabels, leadSourceTagName, type NamedLeadSourceKey } from './lead-sources.js';

/** A lead source the recipe gives a branch, by its key. */
export type LeadSourceRecipeBranch = (typeof leadSourceRecipeBranches)[number]['name'];

const branchOf = <Key extends NamedLeadSourceKey>(name: Key) => ({
  name,
  source: leadSourceLabels[name],
});

/**
 * The lead sources "Tag and route leads by source" gives a branch of their own, in the
 * order they are judged: each is a built-in lead source rule, named as the rule names a
 * touch (lead-sources.ts). Every other lead takes the branch kept for that, which adds no
 * tag: a step adds one fixed tag, and "everything else" is many sources (Direct, Referral,
 * Email…), so one tag for all of them would name most of them wrongly. A form that tags
 * by source has already given each of those leads the tag of its own source.
 */
export const leadSourceRecipeBranches = [
  branchOf('google_ads'),
  branchOf('facebook_ads'),
  branchOf('instagram_ads'),
  branchOf('organic_search'),
] as const;

// A built-in name always fits a tag; the name alone stands in if one ever did not.
const tagOf = (label: string): string => leadSourceTagName(label) ?? label;

export interface LeadSourceRecipeChoices {
  /** What the workflow is called; left out, the recipe's own name. */
  readonly name?: string | undefined;
  /** The pipeline and stage a new opportunity goes in, each by id or by name. */
  readonly pipeline: string;
  readonly stage: string;
  /**
   * Who new leads go to, by membership id or name: one person, or several who take turns.
   * None leaves the owner step out. A lead that already has an owner keeps that owner.
   */
  readonly owners?: readonly string[] | undefined;
  /**
   * The tag each branch adds, by id: the business's own tag of that lead source, as
   * `ensureLeadSourceTags` answers it. With an id the workflow keeps adding the same tag
   * after a person renames it. Left out, a branch names its tag ("Source: Google Ads").
   */
  readonly tags?: Readonly<Partial<Record<LeadSourceRecipeBranch, string>>> | undefined;
}

export const LEAD_SOURCE_RECIPE_NAME = 'Tag and route leads by source';

/**
 * The tags the recipe adds, by name: the business needs each before the draft is valid.
 * They are the tags a form that tags by source makes ("Source: Google Ads"), the system's
 * own, so a lead tagged by its form and by this workflow has one tag, not two. Whoever
 * builds the recipe asks for them by key (`leadSourceRecipeSources`, `ensureLeadSourceTags`)
 * and never creates one by name.
 */
export function leadSourceRecipeTags(): string[] {
  return leadSourceRecipeBranches.map((branch) => tagOf(branch.source));
}

/** The lead sources whose tags the recipe adds, by key: what `ensureLeadSourceTags` is asked. */
export function leadSourceRecipeSources(): LeadSourceRecipeBranch[] {
  return leadSourceRecipeBranches.map((branch) => branch.name);
}

/**
 * "Tag and route leads by source": when any form is submitted, the lead's arrival decides
 * a branch (Google Ads, Facebook Ads, Instagram Ads, Organic Search, or everything else);
 * each named branch adds its tag and everything else adds none, then every lead is given
 * an owner (when owners are chosen) and an opportunity whose source is how the lead
 * arrived, whichever branch it took ("Direct" for a direct lead, on the opportunity as on
 * the contact).
 */
export function leadSourceRecipe(choices: LeadSourceRecipeChoices): AutomationDocumentInput {
  const owners = [...new Set(choices.owners ?? [])].slice(0, MAX_ASSIGN_USERS);
  const [onlyOwner] = owners;
  const afterTag = owners.length === 0 ? 'create_opportunity' : 'assign_owner';
  const source = attributionPath('trigger', 'source');
  const tagStep = (label: string, tag: string) => ({
    type: 'tag.add' as const,
    label,
    config: { tag },
    next: afterTag,
  });
  return {
    name: choices.name ?? LEAD_SOURCE_RECIPE_NAME,
    description:
      'Tags each new lead by where it came from, gives it an owner and opens an opportunity that keeps the source.',
    triggers: [{ id: 'form_submitted', type: 'form.submitted', config: {} }],
    start: 'by_source',
    steps: {
      by_source: {
        type: 'condition',
        label: 'Where did the lead come from?',
        config: {
          branches: leadSourceRecipeBranches.map((branch) => ({
            name: branch.name,
            label: branch.source,
            if: { field: source, operator: 'equals' as const, value: branch.source },
          })),
        },
        next: {
          ...Object.fromEntries(
            leadSourceRecipeBranches.map((branch) => [branch.name, `tag_${branch.name}`]),
          ),
          // Everything else: no tag here (see leadSourceRecipeBranches).
          none: afterTag,
        },
      },
      ...Object.fromEntries(
        leadSourceRecipeBranches.map((branch) => [
          `tag_${branch.name}`,
          tagStep(`Tag: ${branch.source}`, choices.tags?.[branch.name] ?? tagOf(branch.source)),
        ]),
      ),
      ...(owners.length === 0 || onlyOwner === undefined
        ? {}
        : {
            assign_owner: {
              type: 'owner.assign' as const,
              label: 'Give the lead an owner',
              config:
                owners.length === 1
                  ? { user: onlyOwner, onlyIfUnassigned: true }
                  : { users: owners, onlyIfUnassigned: true },
              next: 'create_opportunity',
            },
          }),
      create_opportunity: {
        type: 'deal.create',
        label: 'Open an opportunity',
        config: {
          pipeline: choices.pipeline,
          stage: choices.stage,
          source: { from: DEAL_SOURCE_ARRIVAL },
        },
      },
    },
    settings: { reEnrollment: 'after_finished' },
  };
}

export const APPOINTMENT_REMINDERS_RECIPE_NAME = 'Appointment reminders';

/** The most calendars the recipe's trigger lists: one "Appointment booked" trigger each. */
export const MAX_REMINDER_CALENDARS = 20;

export interface AppointmentRemindersChoices {
  /** What the workflow is called; left out, the recipe's own name. */
  readonly name?: string | undefined;
  /** The calendars whose bookings are reminded, by id or name; none: every calendar. */
  readonly calendars?: readonly string[] | undefined;
  /** Whether a text goes with the reminder an hour before. Needs a number that can text. */
  readonly text?: boolean | undefined;
}

// What the two reminders say: the appointment in the contact's own zone, where it is, and
// how to change it. A field with no value takes its fallback instead of stopping the send.
const reminderBody = (opening: string): string =>
  [
    'Hi {{contact.firstName | default: "there"}},',
    '',
    opening,
    '',
    '{{appointment.title}}',
    'When: {{appointment.startTime}}',
    'Where: {{appointment.location | default: "as in your booking confirmation"}}',
    '',
    'Reschedule or cancel: {{appointment.manageUrl | default: "reply to this email"}}',
  ].join('\n');

/**
 * "Appointment reminders": when an appointment is booked on one of the calendars chosen (or
 * any), an email 24 hours before it starts and another an hour before, with a text then too
 * when chosen. The booking's own confirmation is not repeated. Each wait follows the
 * appointment when it is rescheduled; a cancelled appointment, or one marked no-show or
 * invalid, ends the run with nothing more sent (wait.appointment, version 2). A booking
 * less than 24 hours away skips the first reminder; one less than an hour away gets none.
 * The messages are transactional: they go to a contact the booking's consent allows (an
 * email to who ticked the booking's email box, a text to who ticked "Text me reminders"),
 * without the marketing footer. Quiet hours do not hold them while the appointment is
 * ahead. Each carries the appointment's own reschedule-or-cancel link, or says to reply
 * where the install serves no public pages. A message messaging refuses (no consent, no
 * phone number, no number to text from) is noted on the run, which goes on.
 */
export function appointmentRemindersRecipe(
  choices: AppointmentRemindersChoices = {},
): AutomationDocumentInput {
  const calendars = [...new Set(choices.calendars ?? [])].slice(0, MAX_REMINDER_CALENDARS);
  const triggers =
    calendars.length === 0
      ? [{ id: 'booked', type: 'appointment.booked' as const, config: {} }]
      : calendars.map((calendar, index) => ({
          id: index === 0 ? 'booked' : `booked_${String(index + 1)}`,
          type: 'appointment.booked' as const,
          config: { calendar },
        }));
  const text = choices.text === true;
  return {
    name: choices.name ?? APPOINTMENT_REMINDERS_RECIPE_NAME,
    description:
      'Reminds the contact of the appointment they booked, 24 hours and 1 hour before it starts. A reschedule moves the reminders; a cancellation or a no-show stops them.',
    triggers,
    start: 'wait_day_before',
    steps: {
      wait_day_before: {
        type: 'wait.appointment',
        label: 'Wait until 24 hours before',
        config: { offset: 'PT24H', direction: 'before' },
        // Booked less than a day ahead: straight on to the hour before.
        next: { reached: 'email_day_before', passed: 'wait_hour_before' },
      },
      email_day_before: {
        type: 'email.send',
        label: 'Email: reminder a day before',
        config: {
          purpose: 'transactional',
          subject: 'Reminder: {{appointment.title}} on {{appointment.startTime}}',
          body: reminderBody('This is a reminder of your appointment with us.'),
        },
        onFailure: 'continue',
        next: 'wait_hour_before',
      },
      wait_hour_before: {
        type: 'wait.appointment',
        label: 'Wait until 1 hour before',
        config: { offset: 'PT1H', direction: 'before' },
        next: { reached: 'email_hour_before' },
      },
      email_hour_before: {
        type: 'email.send',
        label: 'Email: reminder an hour before',
        config: {
          purpose: 'transactional',
          subject: 'Starting in 1 hour: {{appointment.title}}',
          body: reminderBody('Your appointment with us starts in about an hour.'),
        },
        onFailure: 'continue',
        ...(text ? { next: 'has_phone' } : {}),
      },
      ...(text
        ? {
            has_phone: {
              type: 'condition' as const,
              label: 'Has a phone number?',
              config: { if: { field: 'contact.phone', operator: 'is_set' as const } },
              next: { yes: 'text_hour_before' },
            },
            text_hour_before: {
              type: 'sms.send' as const,
              label: 'Text: reminder an hour before',
              config: {
                purpose: 'transactional' as const,
                message:
                  'Reminder: {{appointment.title}}, {{appointment.startTime}}. Reschedule or cancel: {{appointment.manageUrl | default: "reply to this text"}}. Reply STOP to opt out.',
              },
              onFailure: 'continue' as const,
            },
          }
        : {}),
    },
    // A contact who books again while a run waits is reminded of the newest booking once
    // that run ends.
    settings: { reEnrollment: 'after_finished' },
  };
}
