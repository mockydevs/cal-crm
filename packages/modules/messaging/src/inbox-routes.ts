// The Inbox API. Any member of the business reads; each change needs its command's
// permission.
import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  addConversationNote,
  addConversationNoteInput,
  assignConversation,
  assignConversationInput,
  bulkUpdateConversations,
  getConversation,
  getConversationComposer,
  getEmailReport,
  getInboxSummary,
  listConversationAssignees,
  listConversationMessages,
  listConversations,
  markConversationRead,
  markConversationReadInput,
  parseInput,
  sendConversationReply,
  sendConversationReplyInput,
  setConversationStatus,
  setConversationStatusInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import { readEmailReport } from './email-report.js';
import { bulkConversationsCommand } from './inbox-bulk.js';
import {
  assignConversationCommand,
  markConversationReadCommand,
  setConversationStatusCommand,
} from './inbox-commands.js';
import {
  allows,
  readConversation,
  readConversationAssignees,
  readConversations,
  readInboxSummary,
  requireConversation,
  type InboxOptions,
} from './inbox-list.js';
import { addConversationNoteCommand } from './inbox-notes.js';
import { sendConversationReplyCommand } from './inbox-reply.js';
import { readComposer, readThread } from './inbox-thread.js';

export function createInboxRoutes(options: InboxOptions): readonly ApiRoute[] {
  const assign = assignConversationCommand(options);
  const setStatus = setConversationStatusCommand(options);
  const markRead = markConversationReadCommand(options);
  const markReadAsReplier = markConversationReadCommand(options, 'conversations.reply');
  const bulk = bulkConversationsCommand();
  const bulkAsReplier = bulkConversationsCommand('conversations.reply');
  const addNote = addConversationNoteCommand(options);
  const reply = sendConversationReplyCommand(options);
  return [
    {
      endpoint: getInboxSummary,
      run({ invocation }, { db }) {
        requireBusiness(invocation.context);
        return withTenant(db, invocation.context, (trx) => readInboxSummary(trx, invocation));
      },
    } satisfies Route<typeof getInboxSummary>,
    {
      endpoint: listConversationAssignees,
      run({ invocation, query }, { db }) {
        requireBusiness(invocation.context);
        const parsed = parseInput(listConversationAssignees.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readConversationAssignees(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof listConversationAssignees>,
    {
      endpoint: listConversations,
      run({ invocation, query }, { db }) {
        requireBusiness(invocation.context);
        const parsed = parseInput(listConversations.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readConversations(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof listConversations>,
    {
      endpoint: getConversation,
      run({ invocation, params }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(getConversation.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readConversation(trx, invocation, id, options),
        );
      },
    } satisfies Route<typeof getConversation>,
    {
      endpoint: listConversationMessages,
      run({ invocation, params, query }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(listConversationMessages.params, params);
        const parsed = parseInput(listConversationMessages.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readThread(trx, invocation, id, parsed, options),
        );
      },
    } satisfies Route<typeof listConversationMessages>,
    {
      endpoint: getConversationComposer,
      run({ invocation, params }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(getConversationComposer.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readComposer(trx, invocation, id, options),
        );
      },
    } satisfies Route<typeof getConversationComposer>,
    {
      endpoint: assignConversation,
      command: assign,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(assignConversation.params, params);
        // Not found comes before anything is said about the body.
        await withTenant(services.db, invocation.context, (trx) =>
          requireConversation(trx, parsed.id),
        );
        return runCommand(
          services,
          assign,
          { ...parseInput(assignConversationInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof assignConversation>,
    {
      endpoint: setConversationStatus,
      command: setStatus,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(setConversationStatus.params, params);
        await withTenant(services.db, invocation.context, (trx) =>
          requireConversation(trx, parsed.id),
        );
        return runCommand(
          services,
          setStatus,
          { ...parsed, change: parseInput(setConversationStatusInput, body) },
          invocation,
        );
      },
    } satisfies Route<typeof setConversationStatus>,
    {
      endpoint: markConversationRead,
      command: markRead,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(markConversationRead.params, params);
        await withTenant(services.db, invocation.context, (trx) =>
          requireConversation(trx, parsed.id),
        );
        // Someone who replies but doesn't manage may still mark read; anyone else is
        // held to, and told about, the right to manage.
        const replierOnly =
          !allows(invocation, 'conversations.manage') && allows(invocation, 'conversations.reply');
        return runCommand(
          services,
          replierOnly ? markReadAsReplier : markRead,
          { ...parseInput(markConversationReadInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof markConversationRead>,
    {
      endpoint: bulkUpdateConversations,
      command: bulk,
      run({ invocation, body }, services) {
        requireBusiness(invocation.context);
        // As for marking one conversation read: someone who replies but doesn't manage may,
        // and anyone else is held to, and told about, the right to manage.
        const replierOnly =
          !allows(invocation, 'conversations.manage') && allows(invocation, 'conversations.reply');
        return runCommand(services, replierOnly ? bulkAsReplier : bulk, body, invocation);
      },
    } satisfies Route<typeof bulkUpdateConversations>,
    {
      endpoint: addConversationNote,
      command: addNote,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(addConversationNote.params, params);
        await withTenant(services.db, invocation.context, (trx) =>
          requireConversation(trx, parsed.id),
        );
        return runCommand(
          services,
          addNote,
          { ...parseInput(addConversationNoteInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof addConversationNote>,
    {
      endpoint: sendConversationReply,
      command: reply,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(sendConversationReply.params, params);
        await withTenant(services.db, invocation.context, (trx) =>
          requireConversation(trx, parsed.id),
        );
        return runCommand(
          services,
          reply,
          { ...parsed, reply: parseInput(sendConversationReplyInput, body) },
          invocation,
        );
      },
    } satisfies Route<typeof sendConversationReply>,
    // The numbers behind the Dashboard's email widgets.
    {
      endpoint: getEmailReport,
      run({ invocation, query }, { db }) {
        requireBusiness(invocation.context);
        const parsed = parseInput(getEmailReport.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readEmailReport(trx, invocation, parsed),
        );
      },
    } satisfies Route<typeof getEmailReport>,
  ];
}
