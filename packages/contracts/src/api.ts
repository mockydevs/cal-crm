import { createApiKey, listApiKeys, revokeApiKey } from './api-keys.js';
import { integrationKeyEndpoints } from './integration-keys.js';
import { createNote, listRecordNotes, updateNote, deleteNote } from './notes.js';
import {
  createTask,
  listTasks,
  updateTask,
  completeTask,
  deleteTask,
  listTaskAssignees,
} from './tasks.js';
import { taskBulkEndpoints } from './task-bulk.js';
import { workflowEmailCopyEndpoints } from './workflow-email-copy.js';
import { workflowEmailSyncEndpoints } from './workflow-email-sync.js';
import {
  createView,
  deleteView,
  listViews,
  setViewSharing,
  shareView,
  unshareView,
  updateView,
} from './saved-views.js';
import { getContactMemory } from './contact-memory.js';
import { getContactJourney } from './contact-journey.js';
import { contactFactEndpoints } from './contact-facts.js';
import { listTimeZones } from './contact-preferences.js';
import { contactDetailEndpoints } from './contact-details.js';
import { emailVerificationEndpoints } from './email-verification.js';
import { contactBulkEndpoints } from './contact-bulk.js';
import { contactDuplicateEndpoints } from './contact-duplicates.js';
import { contactMergeEndpoints } from './contact-merge.js';
import { objectEndpoints } from './objects.js';
import { associationEndpoints, relationEndpoints } from './associations.js';
import { customRecordEndpoints } from './custom-records.js';
import { listAudit, listRecordAudit } from './audit.js';
import {
  getContactConsent,
  getMessagingSettings,
  recordContactConsent,
  updateMessagingSettings,
} from './consent.js';
import { getRecordFields, setRecordField, confirmRecordField } from './record-fields.js';
import { recordFileEndpoints } from './record-files.js';
import {
  listCompanies,
  createCompany,
  getCompany,
  updateCompany,
  trashCompany,
  restoreCompany,
  getContactCompanies,
  linkContactCompany,
  unlinkContactCompany,
} from './companies.js';
import { explainEvent, listRecordActivity } from './activity.js';
import { getTwoFactorRequirement, setTwoFactorRequirement } from './agency.js';
import { createBusiness } from './businesses.js';
import { createDeal, updateDeal, getDeal, getDeals, getDealStageSummary } from './deals.js';
import { dealBulkEndpoints } from './deal-bulk.js';
import { dealPeopleEndpoints } from './deal-people.js';
import {
  countContacts,
  createContact,
  getContact,
  getContactNeighbours,
  listContacts,
  restoreContact,
  trashContact,
  updateContact,
} from './contacts.js';
import { getBusinessProfile, updateBusinessProfile } from './business-profile.js';
import type { Endpoint } from './endpoints.js';
import { createFileLink, uploadFile } from './files.js';
import { getMe, getMyPermissions } from './me.js';
import { getFields, createField, updateField, getFieldDeletion, deleteField } from './fields.js';
import { fieldFolderEndpoints } from './field-folders.js';
import { customValueEndpoints } from './custom-values.js';
import { marketplaceOAuthEndpoints } from './marketplace-oauth.js';
import { marketplaceWebhookEndpoints } from './marketplace-webhooks.js';
import { marketplaceEndpoints } from './marketplace.js';
import { getPipelines, pipelineSettingEndpoints, savePipelines } from './pipelines.js';
import {
  createTag,
  listTags,
  getTagGroups,
  createTagGroup,
  updateTagGroup,
  getTagConfiguration,
  updateTagRules,
  updateTag,
  getRecordTags,
  assignRecordTag,
  removeRecordTag,
} from './tags.js';
import {
  listTeam,
  inviteMember,
  resendInvitation,
  revokeInvitation,
  removeTeamMember,
} from './team.js';
import { userEndpoints } from './users.js';
import { listTrash, purgeRecord, restoreDeal, trashDeal } from './trash.js';
import { searchRecords } from './search.js';
import {
  connectMailbox,
  discoverMailboxServers,
  getMailboxConnectionAttempt,
  listMailboxes,
} from './mailboxes.js';
import { requestMailboxCheck, getMailboxSetup, getMailboxSetupAlerts } from './mailbox-checks.js';
import { getMailboxSendingSettings, updateMailboxSendingSettings } from './mailbox-sending.js';
import {
  continueAutomationRun,
  createAutomation,
  createAutomationTestRun,
  diffAutomationVersions,
  exportAutomation,
  getAutomation,
  getAutomationCatalog,
  getAutomationRun,
  getAutomationSchema,
  getAutomationTestRun,
  getAutomationVersion,
  getAutomationWebhookSigning,
  importAutomation,
  listAutomationRuns,
  listAutomations,
  listAutomationVersions,
  listRecordAutomationRuns,
  patchAutomationDraft,
  pauseAutomation,
  publishAutomation,
  replaceAutomationDraft,
  resumeAutomation,
  retryAutomationRun,
  rotateAutomationWebhookSecret,
  validateAutomationDocument,
} from './automations-api.js';
import { automationManageEndpoints } from './automations-manage.js';
import { automationWebhookSecretEndpoints } from './automations-webhook-secrets-api.js';

/** Every operation of the public API, in the order the reference lists them. */
export const endpoints: readonly Endpoint[] = [
  connectMailbox,
  discoverMailboxServers,
  getMailboxConnectionAttempt,
  listMailboxes,
  getMailboxSendingSettings,
  updateMailboxSendingSettings,
  requestMailboxCheck,
  getMailboxSetup,
  getMailboxSetupAlerts,
  getMe,
  getMyPermissions,
  listCompanies,
  createCompany,
  getCompany,
  updateCompany,
  trashCompany,
  restoreCompany,
  getContactCompanies,
  linkContactCompany,
  unlinkContactCompany,
  createDeal,
  updateDeal,
  getDeal,
  getDeals,
  getDealStageSummary,
  ...dealPeopleEndpoints,
  ...dealBulkEndpoints,
  ...opportunityReportEndpoints,
  ...emailReportEndpoints,
  ...appointmentReportEndpoints,
  ...reportingEndpoints,
  ...contactAttributionEndpoints,
  ...leadSourceEndpoints,
  ...leadSourceRuleEndpoints,
  ...scoringEndpoints,
  ...externalTrackingEndpoints,
  ...integrationEndpoints,
  trashDeal,
  restoreDeal,
  getFields,
  getRecordFields,
  setRecordField,
  ...recordFileEndpoints,
  confirmRecordField,
  createField,
  updateField,
  getFieldDeletion,
  deleteField,
  ...fieldFolderEndpoints,
  ...customValueEndpoints,
  ...marketplaceEndpoints,
  ...marketplaceOAuthEndpoints,
  ...marketplaceWebhookEndpoints,
  getPipelines,
  savePipelines,
  ...pipelineSettingEndpoints,
  createBusiness,
  getBusinessProfile,
  updateBusinessProfile,
  listContacts,
  countContacts,
  createContact,
  getContact,
  getContactNeighbours,
  getContactMemory,
  getContactJourney,
  ...contactFactEndpoints,
  getContactConsent,
  recordContactConsent,
  updateContact,
  trashContact,
  restoreContact,
  ...contactDetailEndpoints,
  ...emailVerificationEndpoints,
  ...contactBulkEndpoints,
  ...contactDuplicateEndpoints,
  ...contactMergeEndpoints,
  ...objectEndpoints,
  ...associationEndpoints,
  ...customRecordEndpoints,
  ...relationEndpoints,
  listTimeZones,
  getMessagingSettings,
  updateMessagingSettings,
  listTags,
  createTag,
  getTagGroups,
  createTagGroup,
  updateTagGroup,
  getTagConfiguration,
  updateTagRules,
  updateTag,
  getRecordTags,
  assignRecordTag,
  removeRecordTag,
  listTrash,
  purgeRecord,
  searchRecords,
  createNote,
  listRecordNotes,
  updateNote,
  deleteNote,
  listTasks,
  createTask,
  updateTask,
  completeTask,
  deleteTask,
  listTaskAssignees,
  ...taskBulkEndpoints,
  ...workflowEmailCopyEndpoints,
  ...workflowEmailSyncEndpoints,
  uploadFile,
  createFileLink,
  listRecordActivity,
  explainEvent,
  listRecordAudit,
  listAudit,
  getTwoFactorRequirement,
  setTwoFactorRequirement,
  listTeam,
  inviteMember,
  resendInvitation,
  revokeInvitation,
  removeTeamMember,
  ...userEndpoints,
  listApiKeys,
  ...integrationKeyEndpoints,
  createApiKey,
  revokeApiKey,
  listViews,
  createView,
  updateView,
  deleteView,
  shareView,
  unshareView,
  setViewSharing,
  ...calendarEndpoints,
  ...calendarUserAvailabilityEndpoints,
  ...calendarEventEndpoints,
  ...blockedSlotEndpoints,
  ...googleCalendarEndpoints,
  ...appointmentEndpoints,
  connectSms,
  getSmsConnectionAttempt,
  listSmsConnections,
  listSmsProviderNumbers,
  refreshSmsProviderNumbers,
  registerPhoneNumber,
  listPhoneNumbers,
  ...phoneSystemEndpoints,
  ...voiceCallEndpoints,
  getAutomationSchema,
  getAutomationCatalog,
  listAutomations,
  getAutomation,
  createAutomation,
  replaceAutomationDraft,
  patchAutomationDraft,
  validateAutomationDocument,
  publishAutomation,
  pauseAutomation,
  resumeAutomation,
  listAutomationVersions,
  getAutomationVersion,
  diffAutomationVersions,
  createAutomationTestRun,
  getAutomationTestRun,
  listAutomationRuns,
  getAutomationRun,
  retryAutomationRun,
  continueAutomationRun,
  listRecordAutomationRuns,
  exportAutomation,
  importAutomation,
  getAutomationWebhookSigning,
  rotateAutomationWebhookSecret,
  ...automationWebhookSecretEndpoints,
  ...automationManageEndpoints,
  ...inboxEndpoints,
  ...messageTemplateEndpoints,
  ...messageTemplateFolderEndpoints,
  ...snippetEndpoints,
  ...emailCampaignEndpoints,
  ...triggerLinkEndpoints,
  ...manualActionEndpoints,
  ...webchatAdminEndpoints,
  ...formAdminEndpoints,
  ...aiSettingsEndpoints,
  ...assistantEndpoints,
  ...assistantChatEndpoints,
  ...importEndpoints,
  ...notificationEndpoints,
  ...siteEndpoints,
  ...siteStepEndpoints,
  ...siteTemplateEndpoints,
  ...siteDomainEndpoints,
  ...commerceEndpoints,
  ...mediaEndpoints,
  ...invoiceReminderEndpoints,
];
import { importEndpoints } from './imports.js';
import { notificationEndpoints } from './notifications.js';
import { calendarEndpoints } from './calendars.js';
import { calendarUserAvailabilityEndpoints } from './calendar-user-availability.js';
import { calendarEventEndpoints } from './calendar-events.js';
import { blockedSlotEndpoints } from './calendar-blocked-slots.js';
import { googleCalendarEndpoints } from './calendar-google.js';
import { appointmentEndpoints } from './appointments.js';
import { opportunityReportEndpoints } from './opportunity-report.js';
import { emailReportEndpoints } from './email-report.js';
import { appointmentReportEndpoints } from './appointment-report.js';
import { reportingEndpoints } from './reporting.js';
import { contactAttributionEndpoints } from './reporting-attribution.js';
import { leadSourceEndpoints } from './lead-sources.js';
import { leadSourceRuleEndpoints } from './lead-source-rules.js';
import { scoringEndpoints } from './scoring.js';
import { externalTrackingEndpoints } from './external-tracking.js';
import { integrationEndpoints } from './integrations.js';
import {
  connectSms,
  getSmsConnectionAttempt,
  listSmsConnections,
  listSmsProviderNumbers,
  refreshSmsProviderNumbers,
  registerPhoneNumber,
  listPhoneNumbers,
} from './sms.js';
import { phoneSystemEndpoints } from './phone-system.js';
import { voiceCallEndpoints } from './voice-calls.js';
import { inboxEndpoints } from './inbox.js';
import { messageTemplateEndpoints } from './message-templates.js';
import { messageTemplateFolderEndpoints } from './message-template-folders.js';
import { snippetEndpoints } from './snippets.js';
import { emailCampaignEndpoints } from './email-campaigns.js';
import { triggerLinkEndpoints } from './trigger-links.js';
import { manualActionEndpoints } from './manual-actions.js';
import { webchatAdminEndpoints } from './webchat.js';
import { formAdminEndpoints } from './forms.js';
import { siteEndpoints } from './sites.js';
import { siteStepEndpoints } from './sites-steps.js';
import { siteTemplateEndpoints } from './sites-templates.js';
import { siteDomainEndpoints } from './sites-domains.js';
import { commerceEndpoints } from './commerce.js';
import { invoiceReminderEndpoints } from './invoice-reminders.js';
import { mediaEndpoints } from './media.js';
import { aiSettingsEndpoints } from './ai.js';
import { assistantEndpoints } from './ai-proposals.js';
import { assistantChatEndpoints } from './assistant.js';
