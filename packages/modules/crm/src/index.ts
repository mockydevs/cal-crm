import type { AnyTask, ApiRoute } from '@repo/commands';
export { createPipelineProposables } from './pipelines/proposals.js';
export { readPipelines } from './pipelines/pipelines.js';

import { createContactRoutes } from './contacts/routes.js';
import { createCompanyRoutes } from './companies/routes.js';
import { companyLinkRoutes } from './companies/link-routes.js';
import { countTagsCreated } from './tags/counts.js';
import { createTagRoute, ensureLeadSourceTagsRoute, listTagsRoute } from './tags/routes.js';
import { tagGroupRoutes } from './tags/group-routes.js';
import { tagConfigurationRoutes } from './tags/configuration-routes.js';
import { recordTagRoutes } from './tags/assignment-routes.js';
import { pipelineRoutes } from './pipelines/routes.js';
import { fieldRoutes } from './fields/routes.js';
import { fieldFolderRoutes } from './fields/folder-routes.js';
import { customValueRoutes } from './custom-values/routes.js';
import { leadSourceRuleRoutes } from './attribution/lead-source-rule-commands.js';
import { recordFieldRoutes } from './fields/values.js';
import { createDealRoutes } from './deals/routes.js';
import type { DealPeopleOptions } from './deals/details.js';
import { trashRoutes } from './trash/routes.js';
import { noteRoutes } from './notes/routes.js';
import { searchRoutes } from './search/routes.js';
import { viewRoutes } from './views/routes.js';
import { associationRoutes } from './associations/routes.js';
import { purgeObjectTask } from './objects/objects.js';
import { scoreEventTask } from './scoring/scores.js';
import { fillMatchKeysTask } from './contacts/duplicates.js';
import type { ActorNames } from './activity/activity.js';

export type { ActorNames, NameLookup } from './activity/activity.js';
export { activityRoutes, type ActivityOptions } from './activity/routes.js';
export { taskRoutes } from './tasks/routes.js';
export type { TaskOptions } from './tasks/tasks.js';
// Recurring tasks: the worker makes each task of a series at its time.
export { createTaskSeriesTasks } from './tasks/series.js';
export { seedBusinessDefaults } from './defaults/defaults.js';
export { countTagsCreated, TAGS_CREATED } from './tags/counts.js';
export { createTagCommand, readTags } from './tags/tags.js';
export {
  createContact,
  createContactCommand,
  updateContactCommand,
  readContact,
} from './contacts/contacts.js';
// The contact page's own data. The commands are exported for whoever runs them outside
// HTTP, such as an automation step.
export { contactDetailRoutes } from './contacts/detail-routes.js';
// Bulk actions on contacts: the routes where the API runs, the job where the worker does.
export { contactBulkRoutes, createContactBulkTasks } from './contacts/bulk-routes.js';
export type {
  BulkEmailCheckBatch,
  BulkEmailCheckOutcome,
  BulkEmailChecks,
  BulkMessage,
  BulkMessages,
  BulkSendRefusal,
  BulkStarterGrants,
  ContactBulkOptions,
  ContactExportFiles,
} from './contacts/bulk-options.js';
// Contacts as an audience, for whoever sends to many at once.
export {
  contactAudienceTest,
  fixContactAudience,
  fixedContactAudience,
  type ContactAudience,
  type FixedContactAudience,
} from './contacts/audience.js';
export type { FilterPeople } from './contacts/filters.js';
export {
  readContactDetails,
  type AddressBlock,
  type BulkWorkflows,
  type ContactDetailOptions,
} from './contacts/details.js';
export {
  addContactFollowersCommand,
  assignContactOwnerCommand,
  removeContactFollowersCommand,
  removeAllContactFollowersCommand,
} from './contacts/people.js';
export { setContactDndCommand } from './contacts/dnd.js';
export { setBookingContactTimezone } from './contacts/booking-timezone.js';
export { assignOwnerFromBooking } from './contacts/booking-owner.js';
export { findTimeZone } from './contacts/contact-settings.js';
export { lockBookingContact } from './contacts/booking-contact.js';
export { readContactNames, type ContactName } from './contacts/names.js';
export {
  intakeContact,
  intakeVia,
  type ContactIntakeOptions,
  type ContactIntakeResult,
} from './contacts/intake.js';
export { writeIntakeReview, type IntakeVia } from './contacts/intake-review.js';
export {
  readContactAttribution,
  readLeadSourceDefault,
  recordTouch,
  type TouchInput,
} from './attribution/touches.js';
export { recordBookingTouch } from './attribution/booking-touch.js';
export {
  NO_VISIT,
  readVisit,
  sessionSourceOf,
  type VisitFacts,
} from './attribution/session-source.js';
// The lead source of a visit, and the one tag the system may make by itself.
export { leadSourceOf, leadSourceOfVisit, type LeadSource } from './attribution/lead-source.js';
export { readArrival, type Arrival, type SaidVisit } from './attribution/arrival.js';
// The business's own lead source rules, tried before the built-in ones.
export {
  decideLeadSource,
  decideLeadSourceFor,
  readActiveLeadSourceRules,
  taggedAs,
  type ActiveLeadSourceRule,
  type LeadDecision,
  type LeadFacts,
} from './attribution/lead-source-rules.js';
export { applyLeadSourceRules } from './attribution/lead-source-apply.js';
export {
  ensureLeadSourceTagsCommand,
  findLeadSourceTag,
  readTagNames,
  tagLeadSource,
} from './tags/lead-source-tags.js';
export { assignRecordTagCommand, removeRecordTagCommand } from './tags/assignments.js';
export { setRecordFieldCommand } from './fields/value-writes.js';
export { normalizeFieldValue } from './fields/value-validation.js';
export { normalizePhone } from './contacts/phones.js';
export { countryOf } from './contacts/country.js';
export {
  readFieldNormalizationContext,
  type FieldNormalizationContext,
} from './fields/normalization-context.js';
export { readRecordField } from './fields/value-read.js';
export { createFieldProposables } from './fields/value-proposals.js';
// A record's files: its documents and its file upload fields' files, with the files
// service and the messaging module's attachments handed over by the server.
export {
  recordFileRoutes,
  INSTANT_TEXT,
  type MessageAttachment,
  type MessageAttachments,
  type RecordFileOptions,
} from './record-files/routes.js';
export { createRecordFileCommands, type RecordFileStore } from './record-files/record-files.js';
export { readFields } from './fields/fields.js';
// Deleting a field for good asks what uses it, which the server hands over.
export {
  createFieldDeletionRoutes,
  type FieldDeletionOptions,
  type FieldUses,
  type FieldUsesReader,
} from './fields/deletion.js';
export { createTaskCommand } from './tasks/tasks.js';
export { createDealCommand, updateDealCommand, readDeal } from './deals/deals.js';
export { linkDealContactCommand, readContactDeals } from './deals/contact-links.js';
// The opportunity dialog's own data: who a deal is with and whose it is.
export { dealPeopleRoutes } from './deals/people-routes.js';
export { readDealDetails, type DealPeopleOptions } from './deals/details.js';
// A workflow's deal.update step gives a deal an owner through the same command.
export { assignDealOwnerCommand } from './deals/people.js';
export { requireRecord } from './records/access.js';
export { purgeExpiredTrash } from './trash/trash.js';
// Imports need the files service, which the server hands over: the routes where the API
// runs, the tasks and the sweep where the worker does.
export { createImportRoutes, type ImportRouteOptions } from './imports/routes.js';
export {
  createImportTasks,
  recoverStalledImports,
  type ImportFiles,
  type ImportProgress,
  type ImportTaskOptions,
} from './imports/run.js';
export { readImportNames } from './imports/store.js';
// The condition behind "view imported contacts", for whoever lists records.
export { writtenByImport } from './imports/imports.js';

/** The CRM module's API routes, for the server to register. */
export function createCrmRoutes(
  actorNames: ActorNames = {},
  /** Who is on the team and what people are called, for a deal list's owners. */
  people?: DealPeopleOptions,
): readonly ApiRoute[] {
  return [
    listTagsRoute,
    createTagRoute,
    ensureLeadSourceTagsRoute,
    ...tagGroupRoutes,
    ...tagConfigurationRoutes,
    ...recordTagRoutes,
    ...createContactRoutes(people),
    ...createCompanyRoutes(actorNames),
    ...companyLinkRoutes,
    ...pipelineRoutes,
    ...fieldRoutes,
    ...fieldFolderRoutes,
    ...customValueRoutes,
    ...leadSourceRuleRoutes,
    ...recordFieldRoutes(actorNames),
    ...createDealRoutes(people),
    ...trashRoutes,
    ...noteRoutes(actorNames),
    ...searchRoutes,
    // A list is shared with team members by name, who are whoever a task could be given to.
    ...viewRoutes(actorNames, people),
    ...associationRoutes,
  ];
}
export const crmRoutes: readonly ApiRoute[] = createCrmRoutes();

/** The CRM module's background tasks, for the worker to run. */
export const crmTasks: readonly AnyTask[] = [
  countTagsCreated,
  scoreEventTask,
  fillMatchKeysTask,
  purgeObjectTask,
];
// Custom objects: Settings → Objects with the reader of what uses an object, which the
// server hands over, and the job that empties a deleted one.
export { createObjectRoutes } from './objects/routes.js';
export {
  purgeObjectTask,
  type ObjectOptions,
  type ObjectUse,
  type ObjectUsesReader,
} from './objects/objects.js';
export { createNoteCommand } from './notes/notes.js';
// Engagement scoring: profile and rule commands, and a contact's score.
export { scoringRoutes } from './scoring/routes.js';
export {
  modifyContactScoreCommand,
  readContactScore,
  scoreEventCommand,
  scoreEventTask,
  setContactScoreCommand,
} from './scoring/scores.js';
export {
  createScoreRuleCommand,
  deleteScoreRuleCommand,
  publishScoreProfileCommand,
  readScoreProfile,
  updateScoreProfileCommand,
  updateScoreRuleCommand,
} from './scoring/profile.js';
// Duplicate contacts: the deduplication preferences, the finder and Manage Duplicates.
export { contactDuplicateRoutes } from './contacts/duplicate-routes.js';
export { contactMergeRoutes } from './contacts/merge-routes.js';
export type {
  ContactMergeOptions,
  ContactMergeParticipant,
  MergeCounts,
} from './contacts/merge.js';
export {
  fillMatchKeysTask,
  findDuplicateContact,
  readDuplicateGroups,
  readPossibleDuplicates,
  rejectDuplicateGroupCommand,
} from './contacts/duplicates.js';
export {
  readDuplicateSettings,
  readMatchSettings,
  updateDuplicateSettingsCommand,
} from './contacts/duplicate-settings.js';
