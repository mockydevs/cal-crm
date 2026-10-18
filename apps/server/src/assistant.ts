// What the server composes for the assistant: the AI module keeps proposals and writes
// drafts, the messaging module owns the Inbox's commands and its conversations, and neither
// imports the other. Here the Inbox's proposable commands are handed to the routes and the
// draft job, and the draft job is told where to read a conversation and what the business
// has written down.
import type { ApiRoute, Proposable, Services } from '@repo/commands';
import {
  validateAutomation,
  type AssistantChip,
  type AssistantPageContext,
  type BusinessProfile,
} from '@repo/contracts';
import {
  createAssistantToolbox,
  createMemoryProposables,
  type AssistantConfirmation,
  type AssistantPage,
  type AssistantToolbox,
  type AssistantTurnOptions,
  type ExtractionSources,
  type ReplyDraftKnowledge,
  type ReplyDraftSources,
} from '@repo/module-ai';
import {
  createAutomationProposables,
  readAutomation,
  readAutomationSetup,
  readFormListeners,
} from '@repo/module-automation';
import {
  createCalendarProposables,
  readCalendar,
  type CalendarOptions,
} from '@repo/module-calendar';
import {
  createFieldProposables,
  createPipelineProposables,
  findTimeZone,
  readContact,
  readPipelines,
} from '@repo/module-crm';
import { parsePublicId } from '@repo/kernel';
import { formProposables, readFormChecks } from '@repo/module-forms';
import {
  createInboxProposables,
  findConversation,
  readReplyContext,
  type InboxOptions,
  readEligibleCalendarSenders,
  resolveCalendarSender,
  readCalendarSenderChoices,
} from '@repo/module-messaging';
import {
  readBusinessProfile,
  lockActiveBusiness,
  resolveCalendarMember,
  readCalendarMemberMemberships,
} from '@repo/module-tenancy';
import { readAutomationUsers } from './automation-users.js';

export const assistantCalendarOptions: CalendarOptions = {
  business: { lockActive: lockActiveBusiness },
  timeZones: { find: findTimeZone },
  members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
  senders: {
    resolve: resolveCalendarSender,
    choices: readCalendarSenderChoices,
    eligible: readEligibleCalendarSenders,
  },
};

/**
 * Every command an assistant may propose, from the modules that own them: the Inbox's reply
 * and status change, a value for a record's field (the CRM's own command), a fact to keep
 * about a contact, and publishing a form, where the install has a public address for a
 * published form to answer with.
 */
export function proposables(
  inbox: InboxOptions,
  publicUrl?: string,
  webhookDelivery = false,
): readonly Proposable[] {
  return [
    ...createInboxProposables(inbox),
    ...createFieldProposables(),
    ...createMemoryProposables(findConversation),
    ...createPipelineProposables(),
    ...createCalendarProposables(assistantCalendarOptions),
    ...createAutomationProposables({
      setup: (trx, context) =>
        readAutomationSetup(trx, context, readAutomationUsers, {
          webhookDelivery,
          smsDelivery: inbox.smsAvailable,
          teamNotifications: true,
        }),
    }),
    ...(publicUrl === undefined ? [] : formProposables(publicUrl)),
  ];
}

// The in-app assistant ------------------------------------------------------------
//
// The AI module runs the turn and keeps the conversation. What it cannot know is composed
// here: what each page shows, which tools make something live and what each then
// proposes, and the API's own routes, which are its tools.

/** What can be asked from the list of forms, and from one form. */
const FORM_LIST_CHIPS: readonly AssistantChip[] = [
  {
    code: 'forms.build',
    label: 'Build a form for me',
    prompt: 'Build a form for me. Ask me what it is for and what it should collect.',
  },
  {
    code: 'forms.review',
    label: 'Which forms need attention?',
    prompt: 'Look at my forms and tell me which ones are unfinished or have changes waiting.',
  },
];
const FORM_CHIPS: readonly AssistantChip[] = [
  {
    code: 'form.whats_missing',
    label: 'What is missing on this form?',
    prompt: 'What is missing on this form? Go through what you found and what you would add.',
  },
  {
    code: 'form.add_campaign_field',
    label: 'Add a hidden campaign field',
    prompt: 'Add a hidden field to this form that records the campaign from the page address.',
  },
  {
    code: 'form.publish',
    label: 'Publish this form',
    prompt: 'Publish this form.',
  },
];

/** The things to ask from a page with no record of its own, by where it is. */
export function assistantChips(page: Pick<AssistantPageContext, 'route'>): AssistantPage['chips'] {
  const route = page.route;
  if (route === '/forms' || route.startsWith('/forms/')) return FORM_LIST_CHIPS;
  if (route === '/pipelines' || route.startsWith('/pipelines/'))
    return [
      {
        code: 'pipelines.review',
        label: 'Check my pipelines',
        prompt: 'Read my pipelines and stages and explain what is missing.',
      },
      {
        code: 'pipelines.build',
        label: 'Set up a pipeline',
        prompt:
          'Help me set up a pipeline. Read the current configuration and propose the changes for me to confirm.',
      },
    ];
  if (route === '/calendars' || route.startsWith('/calendars/'))
    return [
      {
        code: 'calendars.review',
        label: 'Check booking readiness',
        prompt: 'Read this calendar and explain whether it can take bookings and what is missing.',
      },
      {
        code: 'calendars.build',
        label: 'Set up a calendar',
        prompt:
          'Help me set up a calendar and propose the settings, team and opening hours for me to confirm.',
      },
    ];
  if (route === '/automations' || route.startsWith('/automations/'))
    return [
      {
        code: 'workflows.build',
        label: 'Build a workflow',
        prompt:
          'Help me build a workflow as a draft. Read the schema and available capabilities, validate and test it, and ask me before publishing.',
      },
      {
        code: 'workflows.explain',
        label: 'Explain this workflow',
        prompt: 'Read this workflow and explain its triggers, conditions, actions and waits.',
      },
    ];
  if (route.startsWith('/contacts/'))
    return [
      {
        code: 'contact.journey',
        label: 'Follow this contact’s journey',
        prompt:
          'Read this contact’s recorded customer journey, follow the evidence and explain what happened. Disclose missing or incomplete evidence.',
      },
      {
        code: 'contact.why_not',
        label: 'Explain a workflow outcome',
        prompt:
          'Help me find why a workflow did not do what I expected for this contact. Ask which workflow, then read its recorded explanation, trigger evaluations and step evidence. Never infer a cause from missing records.',
      },
    ];
  if (route === '/reports' || route.startsWith('/reports/'))
    return [
      {
        code: 'reports.ask',
        label: 'Ask about these numbers',
        prompt:
          'Help me answer a question about the CRM numbers using the report catalogue and read-only queries. Show which records and time range support the answer.',
      },
    ];
  return undefined;
}

/**
 * What a page shows, read for whoever asks and with no model: the record it is about and
 * what is wrong or missing there. A form's checks are the forms module's, with the
 * automation module saying which workflows listen to it. A page with no checks yet answers
 * with none. Without a public address there are no forms to read as the API answers them.
 */
export function assistantPage(
  publicUrl: string | undefined,
  webhookDelivery = false,
  smsDelivery = false,
): AssistantTurnOptions['page'] {
  return async (trx, invocation, page): Promise<AssistantPage> => {
    const { record } = page;
    const chips = assistantChips(page);
    if (record?.kind === 'pipeline' && parsePublicId('pipeline', record.id) !== undefined) {
      const pipeline = (await readPipelines(trx, invocation)).items.find(
        (item) => item.id === record.id,
      );
      if (pipeline === undefined) return { subject: null, checks: [], chips };
      return {
        subject: { kind: 'pipeline', id: pipeline.id, name: pipeline.name },
        chips,
        checks: pipeline.stages.some((stage) => !stage.archived)
          ? []
          : [
              {
                severity: 'blocker',
                code: 'pipeline_no_active_stages',
                message: 'This pipeline has no active stages.',
                target: { kind: 'pipeline', id: pipeline.id, section: null, path: null },
              },
            ],
      };
    }
    if (record?.kind === 'calendar' && parsePublicId('calendar', record.id) !== undefined) {
      const { calendar } = await readCalendar(trx, invocation, record.id, assistantCalendarOptions);
      return {
        subject: { kind: 'calendar', id: calendar.id, name: calendar.name },
        chips,
        checks: calendar.bookable
          ? []
          : [
              {
                severity: 'blocker',
                code: 'calendar_not_bookable',
                message:
                  'This calendar is not ready to take bookings. Review its type, active status, confirmation sender and team availability.',
                target: { kind: 'calendar', id: calendar.id, section: null, path: null },
              },
            ],
      };
    }
    if (record?.kind === 'automation' && parsePublicId('automation', record.id) !== undefined) {
      const automation = await readAutomation(trx, record.id);
      const setup = await readAutomationSetup(trx, invocation.context, readAutomationUsers, {
        webhookDelivery,
        smsDelivery,
        teamNotifications: true,
      });
      const validation = validateAutomation(automation.draft, setup, {
        automationId: automation.id,
      });
      return {
        subject: { kind: 'automation', id: automation.id, name: automation.name },
        chips,
        checks: validation.errors.slice(0, 20).map((issue) => ({
          severity: 'blocker',
          code: issue.code,
          message: issue.message,
          target: {
            kind: 'automation',
            id: automation.id,
            section: null,
            path: `/draft${issue.path}`,
          },
        })),
      };
    }
    if (record?.kind === 'contact' && parsePublicId('contact', record.id) !== undefined) {
      const contact = await readContact(trx, invocation, record.id);
      return {
        subject: { kind: 'contact', id: contact.id, name: contact.name ?? 'Contact' },
        checks: [],
        chips,
      };
    }
    if (record?.kind !== 'form' || publicUrl === undefined)
      return { subject: null, checks: [], chips };
    const form = await readFormChecks(trx, invocation, record.id, {
      publicUrl,
      listeners: async (reading, formId) => (await readFormListeners(reading, formId)).length,
    });
    return {
      subject: { kind: 'form', id: form.id, name: form.name },
      checks: form.checks,
      chips: FORM_CHIPS,
    };
  };
}

/**
 * The tools that make something live, and the proposal each stores in place of running
 * (packages/contracts/src/assistant-tools.ts, effect `confirm`). The summary is written
 * here from what the proposal would do, never from a model's words.
 */
export const assistantConfirmations: Readonly<Record<string, AssistantConfirmation>> = {
  savePipelines: {
    kind: 'pipeline_save',
    input: ({ body }) => body,
    summary: () => 'Save the pipelines and stages',
  },
  createCalendar: {
    kind: 'calendar_create',
    input: ({ body }) => body,
    summary: (change) =>
      `Create calendar “${typeof change['name'] === 'string' ? change['name'] : 'Calendar'}”`,
  },
  updateCalendar: {
    kind: 'calendar_update',
    input: ({ params, body }) => ({ id: params['id'], settings: body }),
    summary: (change) =>
      `Save calendar “${typeof change['name'] === 'string' ? change['name'] : 'Calendar'}”`,
  },
  updateCalendarAvailability: {
    kind: 'calendar_availability',
    input: ({ params, body }) => ({ ...body, id: params['id'] }),
    summary: (change) =>
      `Save availability for “${typeof change['name'] === 'string' ? change['name'] : 'Calendar'}”`,
  },
  publishAutomation: {
    kind: 'automation_publish',
    input: ({ params, body }) => ({ ...body, id: params['id'] }),
    summary: (change) =>
      `Publish workflow “${typeof change['name'] === 'string' ? change['name'] : 'Workflow'}”`,
  },
  publishForm: {
    kind: 'form_publish',
    input: ({ params, body }) => ({ id: params['id'], revision: body['revision'] }),
    summary: (change) =>
      typeof change['name'] === 'string' && change['name'].trim() !== ''
        ? `Publish the form “${change['name'].trim()}”`
        : 'Publish this form',
  },
};

/**
 * The assistant's tools over routes that are only known once the server has composed
 * them: the worker is started before the routes are, and a turn's tools are the routes.
 * Asking for a tool before `ready` is called is a fault, and says so.
 */
export function deferredToolbox(
  services: Services,
  onFault: (operationId: string, error: unknown) => void,
): { readonly toolbox: AssistantToolbox; ready(routes: readonly ApiRoute[]): void } {
  let made: AssistantToolbox | undefined;
  const box = (): AssistantToolbox => {
    if (made === undefined) throw new Error('The assistant was asked for its tools too early.');
    return made;
  };
  return {
    toolbox: {
      get tools() {
        return box().tools;
      },
      run: (tool, input, invocation) => box().run(tool, input, invocation),
      check: (tool, input) => box().check(tool, input),
    },
    ready(routes) {
      made = createAssistantToolbox({ routes, services, onFault });
    },
  };
}

/**
 * Where the extraction job reads a conversation: from the Inbox, as the draft job does.
 * Without the team's internal notes, and for the one business the job runs in.
 */
export function extractionSources(inbox: InboxOptions): ExtractionSources {
  return {
    conversation: (trx, invocation, conversationId) =>
      readReplyContext(trx, invocation, conversationId, inbox),
  };
}

/**
 * What the business has written down about itself, for a draft to draw on. The knowledge
 * base arrives in phase 2; until then this is the business's own profile from Settings: its
 * name, where it is, and the time and money it works in. All of it is what the business
 * already tells its customers.
 */
export function businessKnowledge(
  profile: Pick<BusinessProfile, 'name' | 'timezone' | 'currency' | 'address'>,
): readonly ReplyDraftKnowledge[] {
  const { address } = profile;
  const where =
    address === null
      ? ''
      : [
          address.line1,
          address.line2,
          address.city,
          address.region,
          address.postalCode,
          address.country,
        ]
          .map((part) => part.trim())
          .filter((part) => part !== '')
          .join(', ');
  return [
    {
      title: 'About the business',
      text: [
        `Name: ${profile.name}.`,
        ...(where === '' ? [] : [`Address: ${where}.`]),
        `Time zone: ${profile.timezone}.`,
        `Currency: ${profile.currency}.`,
      ].join(' '),
    },
  ];
}

/** Where the draft job reads: one conversation from the Inbox, and the business's profile. */
export function draftSources(inbox: InboxOptions): ReplyDraftSources {
  return {
    conversation: (trx, invocation, conversationId) =>
      readReplyContext(trx, invocation, conversationId, inbox),
    // Read as someone with no permissions: the job needs the profile, not the right to
    // change it.
    knowledge: async (trx, context) =>
      businessKnowledge(await readBusinessProfile(trx, { context, permissions: new Set() })),
  };
}
