// Proposals, approvals, undo and autonomy, and the inbox agent's reply drafts. "The AI
// works, people decide": what an assistant wants to do is stored as a proposal, which holds
// the command that would do it. A person applies it, changes it first, or dismisses it.
// Applying runs that command through the command layer as the person, with the person's
// permissions and every check the command has; nothing here is another way to change the
// data.
import { actorKinds } from '@repo/kernel';
import * as z from 'zod';

import { actor } from './activity.js';
import { factKinds, factQuote } from './contact-facts.js';
import { defineEndpoint } from './endpoints.js';
import { formPublicKey } from './forms.js';
import { publicId, recordId } from './ids.js';
import { conversationStatuses, MESSAGE_TEXT_MAX_LENGTH, replyChannels } from './inbox.js';
import { timestamp } from './timestamps.js';

/**
 * The assistants that can propose (ai.proposals.agent). `inbox` drafts replies;
 * `extraction` reads what a contact wrote and proposes field values and facts. The others
 * propose nothing yet.
 */
export const aiAgents = [
  'inbox',
  'copilot',
  'automation_author',
  'analyst',
  'cleanup',
  'extraction',
] as const;
export type AiAgent = (typeof aiAgents)[number];

/**
 * How much an assistant does on its own: `suggest` writes for a person to use, `ask` asks
 * before it acts, `act` acts and says so.
 */
export const autonomyLevels = ['suggest', 'ask', 'act'] as const;
export type AutonomyLevel = (typeof autonomyLevels)[number];

/** What every assistant starts at for every action. */
export const DEFAULT_AUTONOMY: AutonomyLevel = 'ask';

/**
 * The level an assistant has for an action until the business sets a rule. Asking first,
 * with one exception: the in-app assistant makes and edits drafts, fields and tags without
 * asking each time, since nothing a draft holds reaches anyone until it is published.
 */
export function defaultAutonomy(agent: string, action: string): AutonomyLevel {
  return agent === 'copilot' && action === 'build_draft' ? 'act' : DEFAULT_AUTONOMY;
}

/** The kinds of action a rule can be about: each names what some command does. */
export const autonomyActions = [
  'send_message',
  'update_conversation',
  /** Filling a field of a record from what a contact wrote. */
  'update_field',
  /** Keeping a fact about a contact. */
  'remember_fact',
  /** Making and editing what is not live yet: a draft form, a field, a tag. */
  'build_draft',
  /** Making a draft live. The in-app assistant never does: it proposes, a person confirms. */
  'publish',
] as const;
export type AutonomyAction = (typeof autonomyActions)[number];

/** The kinds of proposal there are a command for (ai.proposals.kind). */
export const proposalKinds = [
  'reply',
  'conversation_status',
  /** A value for one field of a record. */
  'field_value',
  /** A fact to keep about a contact. */
  'memory_fact',
  /** Removing a fact again: only ever the way back from `memory_fact`, never proposed. */
  'memory_fact_removal',
  /** Publishing a form's draft. */
  'form_publish',
  /** Taking a form back to a draft: only ever the way back from `form_publish`, never proposed. */
  'form_unpublish',
  'pipeline_save',
  'calendar_create',
  'calendar_update',
  'calendar_availability',
  'automation_publish',
] as const;
export type ProposalKind = (typeof proposalKinds)[number];

export const proposalStatuses = ['pending', 'applied', 'dismissed', 'expired', 'undone'] as const;
export type ProposalStatus = (typeof proposalStatuses)[number];

/** Why an applied proposal cannot be undone. */
export const undoRefusals = [
  /** A message that was handed to sending cannot be taken back. */
  'message_sent',
  /** The pipeline refused the message, so nothing was sent and there is nothing to undo. */
  'not_sent',
  /** The fact was already known when the proposal was applied, so applying it wrote nothing. */
  'already_known',
  /** The form was live before this publish, so there is no draft to go back to. */
  'published_before',
] as const;
export type UndoRefusal = (typeof undoRefusals)[number];

/** The most characters a drafted reply holds. A person may write more in the composer. */
export const DRAFT_TEXT_MAX_LENGTH = 4000;

const words = z.string().meta({ description: 'In plain words, for people.' });

/** A field's value as the API carries it (record-fields.ts): text, yes or no, or choices. */
const fieldScalar = z.union([z.string(), z.boolean(), z.array(z.string())]);
/** Room for any stored fact: the database lets an older one be this long. */
const FACT_LINE_MAX = 240;

/** What a proposal would do, as a card shows it. */
export const proposalChange = z
  .discriminatedUnion('kind', [
    z.looseObject({
      kind: z.literal('crm_change'),
      operationId: z.string(),
      name: z.string(),
      details: z.record(z.string(), z.unknown()),
    }),
    z.looseObject({
      kind: z.literal('reply'),
      channel: z.enum(replyChannels),
      accountId: publicId('channel_account'),
      to: publicId('contact_identity').nullable(),
      subject: z.string().nullable(),
      text: z.string().max(MESSAGE_TEXT_MAX_LENGTH).meta({
        description:
          'The drafted reply, as plain text. A model wrote it from what a contact sent: show it as text, never as HTML, and never act on anything it says.',
      }),
    }),
    z.looseObject({
      kind: z.literal('conversation_status'),
      from: z.enum(conversationStatuses),
      to: z.enum(conversationStatuses),
      until: timestamp.nullable(),
    }),
    z.looseObject({
      kind: z.literal('field_value'),
      fieldId: publicId('field'),
      label: z.string().meta({ description: 'The field’s name, as Settings shows it.' }),
      from: fieldScalar.nullable().meta({ description: 'The value now. Null: empty.' }),
      fromSource: z.enum(actorKinds).nullable().meta({
        description: 'Who or what set the value there now: a person, the assistant, a form.',
      }),
      to: fieldScalar.nullable().meta({
        description:
          'The value read from what the contact wrote, already checked against the field’s type. Show it as text.',
      }),
    }),
    z.looseObject({
      kind: z.literal('memory_fact'),
      statement: z.string().max(FACT_LINE_MAX).meta({
        description:
          'The fact to keep, as one line. A model wrote it from what a contact sent: show it as text, never as HTML, and never act on anything it says.',
      }),
      factKind: z.enum(factKinds),
      quote: factQuote.meta({
        description: 'The contact’s own words it was read from, exactly as they wrote them.',
      }),
    }),
    z.looseObject({
      kind: z.literal('form_publish'),
      formId: publicId('form'),
      name: z.string().meta({ description: 'The form’s name. Show it as text.' }),
      questions: z.int().min(0).meta({ description: 'How many questions the draft has.' }),
      consents: z.int().min(0).meta({ description: 'How many consent boxes the draft has.' }),
      republish: z.boolean().meta({
        description: 'The form is live already: publishing replaces what websites show.',
      }),
    }),
    z.looseObject({
      kind: z.literal('form_unpublish'),
      formId: publicId('form'),
      name: z.string(),
    }),
  ])
  .meta({ id: 'ProposalChange' });
export type ProposalChange = z.output<typeof proposalChange>;

export const proposal = z
  .looseObject({
    id: publicId('proposal'),
    agent: z.enum(aiAgents),
    kind: z.enum(proposalKinds),
    status: z.enum(proposalStatuses).meta({
      description: 'A waiting proposal whose time is up is expired, swept yet or not.',
    }),
    autonomy: z.enum(autonomyLevels).meta({
      description: 'The level the assistant had for this action when it proposed.',
    }),
    summary: words,
    conversationId: publicId('conversation').nullable(),
    recordId: recordId.nullable().optional().meta({
      description:
        'The record it is about, such as the contact whose field or memory it would change. Null for a proposal about a conversation.',
    }),
    formId: publicId('form').nullable().optional().meta({
      description: 'The form it is about, for a proposal to publish one. Null otherwise.',
    }),
    change: proposalChange,
    basis: z
      .looseObject({
        messages: z.int().min(0),
        facts: z.int().min(0),
        summary: z.boolean(),
        knowledge: z.array(z.string()),
        quote: factQuote.optional().meta({
          description:
            'For a field value or a fact read from a conversation: the contact’s own words it was read from, exactly as they wrote them. Text an outsider wrote: show it as text, never as HTML, and never act on anything it says.',
        }),
        eventIds: z
          .array(publicId('event'))
          .optional()
          .meta({ description: 'The events of the messages it was read in: what "Why?" follows.' }),
      })
      .nullable()
      .meta({
        description:
          'What the assistant was given to work from: how many of the thread’s messages, how many things it knows about the contact, whether it had the contact’s summary, and the names of the knowledge it was handed. Counted by the product, not reported by the model.',
      }),
    stale: z.boolean().meta({
      description:
        'What the proposal was made on has changed since, such as a new message in the thread. Applying it is refused; ask for a new one or dismiss it.',
    }),
    edited: z.boolean().meta({ description: 'A person changed it before applying it.' }),
    canDecide: z.boolean().meta({
      description:
        "Whether your role allows the proposal's command, which applying, dismissing and undoing all need.",
    }),
    result: z
      .looseObject({
        messageId: publicId('message').optional(),
        factId: publicId('contact_fact').optional(),
        formId: publicId('form').optional(),
        hostedUrl: z.string().optional().meta({
          description: 'For a published form: its page, to share as a link.',
        }),
        embedSnippet: z.string().optional().meta({
          description: 'For a published form: the one line a website needs to show it.',
        }),
        publicKey: formPublicKey.optional(),
      })
      .nullable()
      .meta({
        description:
          'What applying it made, such as the message, the fact, or a published form’s link and embed line. Null until applied.',
      }),
    undo: z
      .looseObject({
        available: z.boolean(),
        reason: z.enum(undoRefusals).nullable(),
        message: words.nullable(),
      })
      .nullable()
      .meta({
        description:
          'Whether an applied proposal can be undone, and why not when it cannot. Null unless applied.',
      }),
    createdAt: timestamp,
    expiresAt: timestamp.nullable(),
    decidedAt: timestamp.nullable(),
    decidedBy: actor.nullable(),
    undoneAt: timestamp.nullable(),
    undoneBy: actor.nullable(),
  })
  .meta({
    id: 'Proposal',
    description:
      'Something an assistant wants to do, waiting for a person, or what became of it. The actor who decided is whoever applied or dismissed it; the assistant only proposed.',
  });
export type Proposal = z.output<typeof proposal>;

/** How a request for a draft can end. `drafted` is the only one with a proposal. */
export const draftOutcomes = [
  'drafted',
  'refused',
  'failed',
  'paused',
  'ai_off',
  'not_configured',
  'nothing_to_answer',
  'cannot_reply',
  'superseded',
  'expired',
] as const;
export type DraftOutcome = (typeof draftOutcomes)[number];

export const draftRequest = z
  .looseObject({
    id: publicId('draft_request'),
    status: z.enum(['pending', 'finished']),
    outcome: z.enum(draftOutcomes).nullable().meta({
      description:
        'Null while the draft is being written. A request no worker took in three minutes is expired.',
    }),
    reason: z
      .string()
      .nullable()
      .meta({
        description:
          'The category behind the outcome, for programs: the provider’s failure, or which limit paused the call.',
        examples: ['limit_reached'],
      }),
    message: words.nullable().meta({
      description: 'Why there is no draft, in plain words. Null while pending and when drafted.',
    }),
    origin: z.enum(['person', 'message']).meta({
      description: 'Asked for by a person, or by a message that arrived.',
    }),
    createdAt: timestamp,
    finishedAt: timestamp.nullable(),
  })
  .meta({ id: 'DraftRequest' });
export type DraftRequest = z.output<typeof draftRequest>;

export const autonomySetting = z
  .looseObject({
    agent: z.enum(aiAgents),
    action: z.enum(autonomyActions),
    level: z.enum(autonomyLevels).meta({ description: 'The level that applies.' }),
    source: z.enum(['contact', 'business', 'default']).meta({
      description:
        'Where the level comes from: a rule for this contact, the business’s own rule, or the product’s starting level.',
    }),
    businessLevel: z.enum(autonomyLevels).meta({
      description: 'What applies to a contact with no rule of their own.',
    }),
  })
  .meta({ id: 'AutonomySetting' });
export type AutonomySetting = z.output<typeof autonomySetting>;

export const autonomySettings = z
  .looseObject({
    canChange: z.boolean().meta({ description: 'Whether your role may change a level.' }),
    items: z.array(autonomySetting),
  })
  .meta({ id: 'AutonomySettings' });
export type AutonomySettings = z.output<typeof autonomySettings>;

export const setAutonomyInput = z
  .strictObject({
    agent: z.enum(aiAgents),
    action: z.enum(autonomyActions),
    contactId: publicId('contact').nullable().default(null).meta({
      description: 'A rule for this contact alone. Null: the rule for the whole business.',
    }),
    level: z.enum(autonomyLevels).nullable().meta({
      description:
        'Null removes the rule: the contact follows the business again, or the business the starting level.',
    }),
  })
  .meta({ id: 'SetAutonomyInput' });
export type SetAutonomyInput = z.output<typeof setAutonomyInput>;

/** What the Inbox shows of the assistant for one conversation. */
export const conversationAssistant = z
  .looseObject({
    ai: z.enum(['ready', 'off', 'not_connected']).meta({
      description:
        'Whether the business could ask a model at all: AI is on and a provider is connected. `ready` does not promise the next call succeeds.',
    }),
    canDraft: z.boolean().meta({ description: 'Whether you may ask for a draft reply.' }),
    autonomy: autonomySetting.extend({
      canChange: z.boolean(),
    }),
    draft: draftRequest.nullable().meta({
      description:
        'The request for a draft that is being written, or the latest one that ended without a draft and still says something about the thread as it is. Null otherwise.',
    }),
    proposals: z.array(proposal).meta({
      description:
        'What is waiting for a decision about this conversation, then what was applied or undone in the last day, newest first.',
    }),
  })
  .meta({ id: 'ConversationAssistant' });
export type ConversationAssistant = z.output<typeof conversationAssistant>;

export const applyProposalInput = z
  .strictObject({
    changes: z.record(z.string(), z.unknown()).optional().meta({
      description:
        'What to run instead of what was proposed, where the kind allows a change. For a reply: the channel, accountId, to, subject and text of SendConversationReplyInput, without its idempotencyKey (the proposal is the key, so applying twice never sends twice). Checked like any input of the proposal’s command.',
    }),
  })
  .meta({ id: 'ApplyProposalInput' });
export type ApplyProposalInput = z.output<typeof applyProposalInput>;

/** A proposal's command, as its row keeps it: the command's name and its input. */
export const proposalCommand = z.object({
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

/**
 * How to reverse an applied proposal, as its row keeps it: the kind of proposal whose
 * command undoes it, with that command's input, or the reason nothing can.
 */
export const proposalUndoPlan = z.union([
  z.object({ kind: z.enum(proposalKinds), input: z.record(z.string(), z.unknown()) }),
  z.object({ impossible: z.string() }),
]);

/** What an extraction job carries: the conversation to read, and nothing else. */
export const extractContactJob = z.strictObject({ conversationId: z.uuid() });

/** What a draft job carries: the conversation to draft a reply for, and nothing else. */
export const draftReplyJob = z.strictObject({ conversationId: z.uuid() });

const conversationParams = z.strictObject({ id: publicId('conversation') });
/** One proposal, named by its id: what Dismiss takes, and every proposal path. */
export const proposalReference = z.strictObject({ id: publicId('proposal') });
const proposalParams = proposalReference;

export const getConversationAssistant = defineEndpoint({
  operationId: 'getConversationAssistant',
  method: 'get',
  path: '/conversations/{id}/assistant',
  summary: 'Read what the assistant proposes for a conversation',
  group: 'Assistant',
  params: conversationParams,
  response: {
    status: 200,
    description:
      'The draft being written, the proposals waiting and recently decided, and how much the assistant does on its own for this contact. Reading never calls a model.',
    schema: conversationAssistant,
  },
});
export const requestReplyDraft = defineEndpoint({
  operationId: 'requestReplyDraft',
  method: 'post',
  path: '/conversations/{id}/assistant/draft',
  summary: 'Ask the assistant to draft a reply',
  group: 'Assistant',
  params: conversationParams,
  response: {
    status: 201,
    description:
      'The request. A worker writes the draft, which then shows as a proposal; nothing is sent. Asking again while one is being written returns that one.',
    schema: draftRequest,
  },
});
export const getProposal = defineEndpoint({
  operationId: 'getProposal',
  method: 'get',
  path: '/proposals/{id}',
  summary: 'Read one proposal',
  group: 'Assistant',
  params: proposalParams,
  response: { status: 200, description: 'The proposal.', schema: proposal },
});
export const applyProposal = defineEndpoint({
  operationId: 'applyProposal',
  method: 'post',
  path: '/proposals/{id}/apply',
  summary: 'Apply a proposal',
  group: 'Assistant',
  params: proposalParams,
  body: applyProposalInput,
  response: {
    status: 200,
    description:
      'The proposal, applied. Its command ran as you: it needs the permission that command needs, and is refused as that command would be. A proposal that is stale, expired, dismissed or undone is refused with 409. Applying one that is already applied returns it and runs nothing again.',
    schema: proposal,
  },
});
export const dismissProposal = defineEndpoint({
  operationId: 'dismissProposal',
  method: 'post',
  path: '/proposals/{id}/dismiss',
  summary: 'Dismiss a proposal',
  group: 'Assistant',
  params: proposalParams,
  response: {
    status: 200,
    description:
      'The proposal, dismissed: nothing was run. It needs the permission the proposal’s command needs.',
    schema: proposal,
  },
});
export const undoProposal = defineEndpoint({
  operationId: 'undoProposal',
  method: 'post',
  path: '/proposals/{id}/undo',
  summary: 'Undo an applied proposal',
  group: 'Assistant',
  params: proposalParams,
  response: {
    status: 200,
    description:
      'The proposal, undone: the command that reverses it ran as you. Refused with 409, in plain words, where nothing can reverse it (a sent message cannot be unsent) or where the record changed again since.',
    schema: proposal,
  },
});
export const recordProposals = z
  .looseObject({
    items: z.array(proposal).meta({
      description:
        'What is waiting for a decision about this contact, then what was applied or undone in the last day, newest first.',
    }),
  })
  .meta({ id: 'RecordProposals' });
export type RecordProposals = z.output<typeof recordProposals>;

export const listContactProposals = defineEndpoint({
  operationId: 'listContactProposals',
  method: 'get',
  path: '/contacts/{id}/proposals',
  summary: 'List what the assistant proposes for a contact',
  group: 'Assistant',
  params: z.strictObject({ id: publicId('contact') }),
  response: {
    status: 200,
    description:
      'The field values and facts the assistant read from what the contact wrote and wants a person to decide on, then what was decided in the last day. Each is applied, dismissed and undone like any proposal. Reading never calls a model.',
    schema: recordProposals,
  },
});
export const getAutonomy = defineEndpoint({
  operationId: 'getAutonomy',
  method: 'get',
  path: '/ai/autonomy',
  summary: 'Read how much each assistant does on its own',
  group: 'Assistant',
  query: z.strictObject({ contactId: publicId('contact').optional() }),
  response: {
    status: 200,
    description: 'The level for each assistant and action, for the business or for one contact.',
    schema: autonomySettings,
  },
});
export const setAutonomy = defineEndpoint({
  operationId: 'setAutonomy',
  method: 'put',
  path: '/ai/autonomy',
  summary: 'Set how much an assistant does on its own',
  group: 'Assistant',
  body: setAutonomyInput,
  response: { status: 200, description: 'The level that now applies.', schema: autonomySetting },
});

/** Every operation of proposals and autonomy, as the API registers them. */
export const assistantEndpoints = [
  getConversationAssistant,
  requestReplyDraft,
  getProposal,
  applyProposal,
  dismissProposal,
  undoProposal,
  listContactProposals,
  getAutonomy,
  setAutonomy,
] as const;
