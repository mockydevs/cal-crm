// The API of proposals, reply drafts and autonomy. Any member of the business reads what
// the assistant proposes. Deciding needs more:
//
//   * Apply, Dismiss and Undo have no permission of their own. Each needs the permission
//     of the command the proposal holds, checked by the command layer when that command
//     runs, so a proposal can never be a way around a role;
//   * asking for a draft needs the right to reply;
//   * changing how much an assistant does on its own needs `ai.manage`.
//
// No route here calls a model: a draft is queued for the worker (reply-drafts.ts).
import {
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Proposable,
  type Route,
} from '@repo/commands';
import {
  applyProposal as applyProposalEndpoint,
  applyProposalInput,
  dismissProposal as dismissProposalEndpoint,
  getAutonomy,
  getConversationAssistant,
  getProposal,
  listContactProposals,
  parseInput,
  requestReplyDraft,
  setAutonomy,
  undoProposal as undoProposalEndpoint,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { NotFoundError } from '@repo/kernel';
import { requireRecord, type ActorNames } from '@repo/module-crm';

import { readAutonomySettings, setAutonomyCommand } from './autonomy-settings.js';
import {
  applyProposal,
  dismissProposal,
  readProposal,
  readRecordProposals,
  undoProposal,
  type ProposalOptions,
} from './proposals.js';
import {
  createRequestDraftCommand,
  readConversationAssistant,
  type FindConversation,
} from './reply-drafts.js';

export interface AssistantOptions {
  /** Every command that can be proposed, from the modules that own them. */
  readonly proposables: readonly Proposable[];
  /** Who decided a proposal, by name. */
  readonly actorNames: ActorNames;
  /** A conversation of the request's business, from the module that owns conversations. */
  readonly findConversation: FindConversation;
  readonly now?: () => Date;
}

export function createAssistantRoutes(options: AssistantOptions): readonly ApiRoute[] {
  const now = options.now ?? (() => new Date());
  const proposals: ProposalOptions = {
    registry: options.proposables,
    actorNames: options.actorNames,
    now,
  };
  const requestDraft = createRequestDraftCommand(now, options.findConversation);
  const changeAutonomy = setAutonomyCommand();

  return [
    {
      endpoint: getConversationAssistant,
      run({ invocation, params }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(getConversationAssistant.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readConversationAssistant(trx, invocation, proposals, options.findConversation, id),
        );
      },
    } satisfies Route<typeof getConversationAssistant>,
    {
      endpoint: requestReplyDraft,
      command: requestDraft,
      run({ invocation, params }, services) {
        requireBusiness(invocation.context);
        return runCommand(
          services,
          requestDraft,
          parseInput(requestReplyDraft.params, params),
          invocation,
        );
      },
    } satisfies Route<typeof requestReplyDraft>,
    {
      endpoint: getProposal,
      run({ invocation, params }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(getProposal.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readProposal(trx, invocation, proposals, id),
        );
      },
    } satisfies Route<typeof getProposal>,
    {
      endpoint: applyProposalEndpoint,
      run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const { id } = parseInput(applyProposalEndpoint.params, params);
        const { changes } = parseInput(applyProposalInput, body);
        return applyProposal(services, proposals, invocation, id, changes);
      },
    } satisfies Route<typeof applyProposalEndpoint>,
    {
      endpoint: dismissProposalEndpoint,
      run({ invocation, params }, services) {
        requireBusiness(invocation.context);
        const { id } = parseInput(dismissProposalEndpoint.params, params);
        return dismissProposal(services, proposals, invocation, id);
      },
    } satisfies Route<typeof dismissProposalEndpoint>,
    {
      endpoint: undoProposalEndpoint,
      run({ invocation, params }, services) {
        requireBusiness(invocation.context);
        const { id } = parseInput(undoProposalEndpoint.params, params);
        return undoProposal(services, proposals, invocation, id);
      },
    } satisfies Route<typeof undoProposalEndpoint>,
    {
      endpoint: listContactProposals,
      run({ invocation, params }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(listContactProposals.params, params);
        return withTenant(db, invocation.context, async (trx) => {
          // CRM's reader applies its own visibility rules: a contact of another business,
          // or one that was purged, is not found.
          const record = await requireRecord(trx, id);
          if (record.kind !== 'contact') throw new NotFoundError('Contact', id);
          return { items: await readRecordProposals(trx, invocation, proposals, record.id) };
        });
      },
    } satisfies Route<typeof listContactProposals>,
    {
      endpoint: getAutonomy,
      run({ invocation, query }, { db }) {
        requireBusiness(invocation.context);
        const { contactId } = parseInput(getAutonomy.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readAutonomySettings(trx, invocation, contactId),
        );
      },
    } satisfies Route<typeof getAutonomy>,
    {
      endpoint: setAutonomy,
      command: changeAutonomy,
      run({ invocation, body }, services) {
        requireBusiness(invocation.context);
        return runCommand(services, changeAutonomy, body, invocation);
      },
    } satisfies Route<typeof setAutonomy>,
  ];
}
