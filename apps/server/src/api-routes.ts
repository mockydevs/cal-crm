// Every API route the server registers. Each module exports its routes; the server only
// concatenates them. It hands business.create each module's seeder for a new business, the
// activity routes each module's way of naming who acted, the team routes a way to send an
// invitation, the API key routes a way to name who made a key, and the commerce routes the
// readers of the business's profile, a contact and an opportunity.
import type { ApiRoute } from '@repo/commands';
import {
  aiContactMerge,
  aiRoutes,
  createAssistantChatRoutes,
  createAssistantRoutes,
  createContactJourneyRoute,
  createMemoryRoutes,
} from '@repo/module-ai';
import {
  automationContactMerge,
  bulkWorkflows,
  createBulkMessages,
  contactValues,
  createAutomationRoutes,
  createManualActionRoutes,
  readFieldUses,
  readObjectUses,
  readTemplateFields,
  readTemplateUseCounts,
  readTemplateUses,
} from '@repo/module-automation';
import { readTeamPeople, readUserNames, type Authentication } from '@repo/module-auth';
import {
  calendarContactMerge,
  createAppointmentRoutes,
  createBlockedSlotRoutes,
  createCalendarEventRoutes,
  createCalendarRoutes,
  type AppointmentOptions,
} from '@repo/module-calendar';
import {
  activityRoutes,
  contactBulkRoutes,
  contactDetailRoutes,
  contactDuplicateRoutes,
  contactMergeRoutes,
  createCrmRoutes,
  createFieldDeletionRoutes,
  createObjectRoutes,
  dealPeopleRoutes,
  recordFileRoutes,
  findTimeZone,
  lockBookingContact,
  readContactNames,
  readImportNames,
  scoringRoutes,
  seedBusinessDefaults,
  taskRoutes,
} from '@repo/module-crm';
import {
  apiKeyRoutes,
  businessProfileRoutes,
  businessRoutes,
  lockActiveBusiness,
  marketplaceRoutes,
  readApiKeyNames,
  resolveCalendarMember,
  readCalendarMemberMemberships,
  readPersonGrants,
  tenancyRoutes,
  teamRoutes,
  userRoutes,
} from '@repo/module-tenancy';
import { commerceContactMerge, createCommerceRoutes } from '@repo/module-commerce';
import { checkBusinessLogo, checkUserAvatar } from '@repo/module-files';
import { externalTrackingRoutes, formsContactMerge, readFormNames } from '@repo/module-forms';
import { createNotificationRoutes } from '@repo/module-notifications';
import { createReportingRoutes } from '@repo/module-reporting';
import type { SealingVault } from '@repo/module-vault';
import {
  createConsentRoutes,
  createInboxRoutes,
  createCallRoutes,
  createPhoneSystemRoutes,
  readPhoneCalling,
  createCampaignRoutes,
  createSnippetRoutes,
  createTemplateRoutes,
  findConversation,
  queueCalendarConfirmation,
  readCalendarConfirmationRecipient,
  readContactAddressBlocks,
  readContactEmailVerifications,
  createEmailVerificationRoutes,
  bulkEmailChecks,
  contactAttachments,
  resolveCalendarSender,
  readCalendarSenderChoices,
  readEligibleCalendarSenders,
  smsDeliveryAvailable,
  messagingContactMerge,
  triggerLinkRoutes,
} from '@repo/module-messaging';
import { assistantPage, proposables } from './assistant.js';
import { campaignOptions, type CampaignInstall } from './campaign-options.js';
import { commerceOptions, type CommerceInstall } from './commerce-options.js';
import { readAutomationUsers } from './automation-users.js';
import { API_PREFIX } from './server.js';
import { taskOptions } from './task-options.js';

export const apiRoutes = (
  authentication?: Authentication,
  sealingVault?: SealingVault,
  webhookDelivery = false,
  /** PUBLIC_URL, as start() hands it over. Without one, nothing that needs it is offered. */
  publicUrl?: string,
  /**
   * What only a running install has for commerce: its files service, and what a document's
   * public address is made with. Without them a document is printed without a logo, has no
   * public address, and is emailed without its PDF.
   */
  commerce: CommerceInstall = {},
  /** The install's ceiling on one agency's campaign emails, when it sets one. */
  campaigns: CampaignInstall = {},
  /**
   * A fresh look at the hosts' Google Calendars before the team books or moves, where the
   * install connects Google. Without it the team's bookings read the busy store.
   */
  google?: AppointmentOptions['google'],
): readonly ApiRoute[] => {
  // Text messages are offered where a send can be made: with a vault, and a public address
  // the provider can report delivery to. Without that address every send would be refused
  // at dispatch, so the channel is not offered at all.
  const inbox = {
    actorNames: taskOptions.actorNames,
    assignees: taskOptions.assignees,
    smsAvailable: sealingVault !== undefined && smsDeliveryAvailable(publicUrl),
  };
  // Every command an assistant may propose: what a person applies, dismisses and undoes,
  // and what a conversation with the in-app assistant shows as a card.
  const proposed = proposables(inbox, publicUrl, webhookDelivery);
  const routes: readonly ApiRoute[] = [
    ...createEmailVerificationRoutes(sealingVault === undefined ? {} : { vault: sealingVault }),
    ...aiRoutes,
    // What the assistant knows about a contact: read by anyone who can open the contact,
    // rewritten or removed with contacts.manage. No route writes a new fact.
    ...createMemoryRoutes({ actorNames: taskOptions.actorNames, findConversation }),
    // What the assistant proposes, and what a person does with it. Applying a proposal runs
    // the Inbox's own command, as the person, so the same options go to both.
    ...createAssistantRoutes({
      proposables: proposed,
      actorNames: taskOptions.actorNames,
      findConversation,
    }),
    // The in-app assistant's conversations and its page checks. No route calls a model: a
    // message is queued for the worker, which runs it with these same routes as its tools
    // (start.ts).
    ...createAssistantChatRoutes({
      proposables: proposed,
      actorNames: taskOptions.actorNames,
      page: assistantPage(publicUrl, webhookDelivery, inbox.smsAvailable),
    }),
    ...createAutomationRoutes({
      users: readAutomationUsers,
      // A run's history names whoever continued it, as the timeline names people.
      actorNames: taskOptions.actorNames,
      teamNotifications: true,
      ...(sealingVault === undefined
        ? {}
        : {
            signing: { vault: sealingVault, lockBusiness: lockActiveBusiness },
            webhookSecrets: { vault: sealingVault, lockBusiness: lockActiveBusiness },
          }),
      webhookDelivery,
      // As for the Inbox below: a text message step is offered only where one can be sent.
      smsDelivery: sealingVault !== undefined && smsDeliveryAvailable(publicUrl),
    }),
    ...createCalendarRoutes({
      business: { lockActive: lockActiveBusiness },
      timeZones: { find: findTimeZone },
      members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
      senders: {
        resolve: resolveCalendarSender,
        choices: readCalendarSenderChoices,
        eligible: readEligibleCalendarSenders,
      },
    }),
    // What the Calendar view draws: tenancy says who is on the team, auth what they are
    // called, the CRM how a contact is shown.
    ...createCalendarEventRoutes({
      members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
      contacts: { names: readContactNames },
      people: { names: readUserNames },
    }),
    // Blocked slots, one at a time.
    ...createBlockedSlotRoutes({
      business: { lockActive: lockActiveBusiness },
      members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
      people: { names: readUserNames },
    }),
    // Appointments as the team works with them: the list, one appointment, and booking,
    // moving, cancelling and marking one. The booker's own confirmations go through
    // messaging's queue, as the booking page's do.
    ...createAppointmentRoutes({
      calendars: {
        business: { lockActive: lockActiveBusiness },
        timeZones: { find: findTimeZone },
        members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
        senders: {
          resolve: resolveCalendarSender,
          choices: readCalendarSenderChoices,
          eligible: readEligibleCalendarSenders,
        },
      },
      members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
      contacts: { names: readContactNames, lock: lockBookingContact },
      people: { names: readUserNames },
      notifications: {
        recipient: readCalendarConfirmationRecipient,
        queue: queueCalendarConfirmation,
      },
      publicOrigin: publicUrl,
      ...(google === undefined ? {} : { google }),
    }),
    // A form acts in its own name: what it set on a contact, and its place on the timeline,
    // show which form it was. An import does too, by the name of the file it read.
    ...createCrmRoutes(
      {
        user: readUserNames,
        api_key: readApiKeyNames,
        form: readFormNames,
        import: readImportNames,
      },
      // A deal list names each row's owner as the opportunity dialog does.
      { actorNames: taskOptions.actorNames, assignees: taskOptions.assignees },
    ),
    // Settings → Manage Scoring: profile and rule commands, and a contact's score.
    ...scoringRoutes,
    // Settings → External Tracking: the tracking id, its settings and Troubleshoot.
    ...externalTrackingRoutes,
    // Duplicate contacts: the deduplication preferences, the lookup, Manage Duplicates and
    // a contact's possible duplicates.
    ...contactDuplicateRoutes,
    // Merging contacts. Each module that keeps rows of a contact hands in its part of a
    // merge here, in the order they run and take their locks. Automation first: a workflow
    // step holds its run's row and may then queue a message, which holds the business; so
    // the runs are taken before messaging takes the business, and both before any contact.
    ...contactMergeRoutes({
      participants: [
        automationContactMerge,
        messagingContactMerge,
        formsContactMerge,
        calendarContactMerge,
        commerceContactMerge,
        aiContactMerge,
      ],
    }),
    // Deleting a field for good names the templates and automations that use it, which only
    // the automation module can read.
    ...createFieldDeletionRoutes({ uses: readFieldUses }),
    // Settings → Objects. Deleting a custom object is refused while a published workflow
    // uses it, which only the automation module can read.
    ...createObjectRoutes({ uses: readObjectUses }),
    // A record's documents and its file fields' files are kept by the files service; a
    // contact's Sent and Received are its conversation's attachments, which messaging reads.
    ...recordFileRoutes({
      store: commerce.files,
      messageAttachments: contactAttachments,
      actorNames: {
        user: readUserNames,
        api_key: readApiKeyNames,
        form: readFormNames,
        import: readImportNames,
      },
      apiUrl: publicUrl === undefined ? undefined : `${publicUrl}${API_PREFIX}`,
    }),
    // The opportunity dialog's own read and commands, and a contact's deals. An owner and a
    // follower of a deal are whoever a task could be assigned to, as a contact's are.
    ...dealPeopleRoutes({
      actorNames: {
        user: readUserNames,
        api_key: readApiKeyNames,
        form: readFormNames,
        import: readImportNames,
      },
      assignees: taskOptions.assignees,
    }),
    // The contact page's own read and commands. An owner and a follower are whoever a task
    // could be assigned to, and who made a contact is named as on its timeline.
    ...contactDetailRoutes({
      actorNames: {
        user: readUserNames,
        api_key: readApiKeyNames,
        form: readFormNames,
        import: readImportNames,
      },
      assignees: taskOptions.assignees,
      // Messaging knows which addresses are blocked: a hard bounce, an invalid number.
      blockedAddresses: readContactAddressBlocks,
      addressVerifications: readContactEmailVerifications,
    }),
    // Bulk actions on contacts: a new owner is whoever a task could be assigned to, and who
    // started an action is named as on a timeline.
    ...contactBulkRoutes({
      actorNames: { user: readUserNames, api_key: readApiKeyNames },
      assignees: taskOptions.assignees,
      // "Add to workflow" enrols through the automation module, as a trigger would.
      workflows: bulkWorkflows,
      // A bulk email or text is each contact's workflow send step, through messaging's
      // outbound path; a text only where one can be sent, as for the Inbox. Bulk email
      // counts against the agency's daily campaign ceiling.
      messages: createBulkMessages({
        smsAvailable: inbox.smsAvailable,
        publicUrl,
        agencyDailyLimit: campaigns.agencyDailyLimit,
      }),
      // An export is kept and linked by the files service, where this role has one.
      ...(commerce.files === undefined || publicUrl === undefined
        ? {}
        : { files: commerce.files, apiUrl: `${publicUrl}${API_PREFIX}` }),
      // "Verify emails" queues each contact's check through messaging's email verification.
      emailChecks: bulkEmailChecks,
      // Whoever started an action is asked again before each batch the worker runs.
      grants: readPersonGrants,
    }),
    ...createConsentRoutes({ user: readUserNames, api_key: readApiKeyNames }),
    // Settings → Phone System: calling defaults and each number's settings.
    ...createPhoneSystemRoutes(),
    // Calls are refused until Phone System says they can be made. A completed recording is
    // linked by the files service, where this role has one.
    ...createCallRoutes(
      readPhoneCalling,
      commerce.files === undefined || publicUrl === undefined
        ? {}
        : { files: commerce.files, apiUrl: `${publicUrl}${API_PREFIX}` },
    ),
    ...activityRoutes({
      actorNames: {
        user: readUserNames,
        api_key: readApiKeyNames,
        form: readFormNames,
        import: readImportNames,
      },
      members: taskOptions.assignees,
    }),
    ...taskRoutes(taskOptions),
    // The top bar's bell. A notification names who caused it as the timeline does: a
    // person, an API key, a form or an import.
    ...createNotificationRoutes({
      actorNames: {
        user: readUserNames,
        api_key: readApiKeyNames,
        form: readFormNames,
        import: readImportNames,
      },
    }),
    // A conversation is assigned to whoever a task could be, and names come from the same
    // readers.
    ...createInboxRoutes(inbox),
    // Automations send the templates, so they say which of them send one and which merge
    // fields a send can fill in. Messaging can't ask them itself.
    // A preview is filled in with a contact's own values, which automations own too.
    ...createTemplateRoutes({
      uses: readTemplateUses,
      useCounts: readTemplateUseCounts,
      fields: readTemplateFields,
      values: contactValues,
      publicUrl,
    }),
    // Snippets, trigger links and the manual actions queue. A snippet is filled in for a
    // contact with the values a send would read, which automations own; a manual action is
    // assigned to whoever a task could be.
    ...createSnippetRoutes({ values: contactValues, publicUrl }),
    // Email campaigns. The worker's campaign task is given the same options.
    ...createCampaignRoutes(campaignOptions({ publicUrl, ...campaigns })),
    ...triggerLinkRoutes,
    ...createManualActionRoutes({
      assignees: taskOptions.assignees,
      actorNames: taskOptions.actorNames,
    }),
    ...tenancyRoutes,
    ...businessRoutes({ seeders: [seedBusinessDefaults] }),
    ...businessProfileRoutes(checkBusinessLogo),
    ...teamRoutes({
      people: readTeamPeople,
      sendInvitation:
        authentication === undefined
          ? undefined
          : (email, token) => authentication.sendInvitation(email, token),
    }),
    ...userRoutes({
      people: readTeamPeople,
      checkAvatar: checkUserAvatar,
      sendInvitation:
        authentication === undefined
          ? undefined
          : (email, token) => authentication.sendInvitation(email, token),
    }),
    ...apiKeyRoutes({ people: readUserNames }),
    // The App Marketplace: the agency's apps, and each business's installs.
    ...marketplaceRoutes({
      people: readUserNames,
      ...(publicUrl === undefined ? {} : { issuer: publicUrl }),
      ...(sealingVault === undefined ? {} : { webhookVault: sealingVault }),
    }),
    // Products, quotes, invoices, payments and their settings, their PDFs, public addresses
    // and emails. What the module is handed is in commerce-options.ts.
    ...createCommerceRoutes(commerceOptions(commerce)),
    // Reporting: the catalogue, the query engine, saved reports and the fixed reports. A
    // team member in a report is whoever a task could be assigned to.
    ...createReportingRoutes({
      members: {
        resolve: taskOptions.assignees.resolve,
        memberships: taskOptions.assignees.memberships,
      },
      people: { names: readUserNames },
    }),
  ];
  return [...routes, createContactJourneyRoute(routes)];
};
