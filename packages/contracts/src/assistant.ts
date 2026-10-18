// The in-app assistant: one assistant in two sizes. A floating panel on every page and the
// same conversation expanded full-screen, with a list of the person's past conversations.
// So a conversation (a thread) is listed, titled by its first message, and resumed; and
// every message a person sends says which page it was sent from.
//
// How it runs:
//   * a message is stored as a turn and queued. The worker runs it: it asks the model, runs
//     the tools the model asks for as the API's own operations, bounded by the person's own
//     permissions, and writes one message for each step;
//   * nothing is streamed. The panel refetches the messages after a cursor when the
//     realtime hint says the business changed;
//   * a tool that would make something live never runs. The assistant stores a proposal,
//     which the thread shows as a card: Apply, Dismiss and Undo are the proposal's own
//     operations (applyProposal, dismissProposal, undoProposal), run as the person;
//   * what is missing on a page is worked out by the server with no model
//     (`POST /assistant/context`), so it shows even where no AI provider is connected.
//
// A thread is its person's alone: nobody else in the business, and no API key, reads it.
import * as z from 'zod';

import { proposal } from './ai-proposals.js';
import { assistantToolEffects } from './assistant-tools.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The limits of a conversation with the assistant. A request past one is refused. */
export const ASSISTANT_LIMITS = {
  /** Characters in one message a person sends. */
  messageLength: 4000,
  /** Characters of the first message a thread is titled by. */
  titleLength: 80,
  routeLength: 300,
  /** Records selected on the page that a message can name. */
  selection: 50,
  /** Model calls in one turn. */
  stepsPerTurn: 12,
  /** How long one turn may run. */
  turnMinutes: 5,
  /** Turns one person may start in an hour, in one business. */
  turnsPerHour: 30,
  /** Days a thread is kept after it was last used, where the business keeps AI logs that long. */
  threadDays: 30,
  /** Threads in one page of the list, and messages in one read. */
  threadPageSize: 30,
  messagePageSize: 100,
} as const;

const words = z.string().meta({ description: 'In plain words, for people.' });

/** The kinds of thing a page can be about, or a link can open. */
export const assistantSubjectKinds = [
  'form',
  'contact',
  'company',
  'deal',
  'conversation',
  'automation',
  'calendar',
  'pipeline',
] as const;
export type AssistantSubjectKind = (typeof assistantSubjectKinds)[number];

/**
 * The page a message was sent from: ids, never the page's text. The server reads the
 * record again under the person's own permissions, so nothing a page shows is trusted and
 * nothing the person may not read is ever given to a model.
 */
export const assistantPageContext = z
  .strictObject({
    route: z
      .string()
      .min(1)
      .max(ASSISTANT_LIMITS.routeLength)
      .regex(/^\/[^\s]*$/, { error: 'Send the path of the page, such as /forms.' })
      .meta({
        description:
          "The dashboard's path of the page, without the business part, a query or a fragment.",
        examples: ['/forms/form_01h455vb4pex5vsknk084sn02q'],
      }),
    record: z
      .strictObject({
        kind: z.enum(assistantSubjectKinds),
        id: z.string().min(1).max(80).meta({ description: 'The public id of that record.' }),
      })
      .optional()
      .meta({ description: 'The record the page is about, when it is about one.' }),
    selection: z
      .array(z.string().min(1).max(80))
      .max(ASSISTANT_LIMITS.selection)
      .default([])
      .meta({ description: 'The public ids of the rows selected on the page.' }),
  })
  .meta({ id: 'AssistantPageContext' });
export type AssistantPageContext = z.output<typeof assistantPageContext>;

/** Where a check, a chip or an activity row leads. The dashboard maps it to its own route. */
export const assistantTargetKinds = [
  ...assistantSubjectKinds,
  'field',
  'tag',
  /** Settings → AI models. */
  'ai_settings',
  /** The list of workflows, to make one. */
  'automations',
] as const;
export const assistantTarget = z
  .looseObject({
    kind: z.enum(assistantTargetKinds),
    id: z.string().nullable().meta({ description: 'The public id of the thing, when it is one.' }),
    section: z
      .string()
      .nullable()
      .meta({
        description: 'The part of its page to open, such as a form’s `websites`.',
        examples: ['questions', 'consent', 'websites', 'notify', 'publish'],
      }),
    path: z.string().nullable().meta({
      description: 'A JSON pointer into the record, where a problem is about one part of it.',
    }),
  })
  .meta({ id: 'AssistantTarget' });
export type AssistantTarget = z.output<typeof assistantTarget>;

export const assistantCheck = z
  .looseObject({
    severity: z.enum(['blocker', 'suggestion']).meta({
      description:
        'A blocker stops the thing working (a form cannot be published). A suggestion is something usually wanted and missing.',
    }),
    code: z.string().meta({ examples: ['no_consent_box'] }),
    message: words,
    target: assistantTarget.nullable(),
  })
  .meta({ id: 'AssistantCheck' });
export type AssistantCheck = z.output<typeof assistantCheck>;

export const assistantChip = z
  .looseObject({
    code: z.string().meta({ examples: ['form.whats_missing'] }),
    label: words,
    prompt: z.string().meta({ description: 'What pressing the chip sends as the message.' }),
  })
  .meta({ id: 'AssistantChip' });
export type AssistantChip = z.output<typeof assistantChip>;

export const assistantContext = z
  .looseObject({
    ai: z.enum(['ready', 'off', 'not_connected']).meta({
      description:
        'Whether the business could ask a model at all. Unless `ready`, show the checks only, with no box to type in.',
    }),
    canUse: z.boolean().meta({ description: 'Whether your role lets you talk to the assistant.' }),
    message: words.nullable().meta({
      description:
        'Why there is no box to type in: AI is off, no provider is connected, or your role. Null when ready.',
    }),
    connect: assistantTarget.nullable().meta({
      description: 'Where a provider is connected (Settings → AI models), when none is.',
    }),
    subject: z
      .looseObject({
        kind: z.enum(assistantSubjectKinds),
        id: z.string(),
        name: z.string().meta({ description: 'Its name, as the server read it. Show as text.' }),
      })
      .nullable()
      .meta({ description: 'The record the page is about, when the server found it.' }),
    checks: z.array(assistantCheck).meta({
      description:
        'What is wrong or missing on this page, worked out by the server with no model. Blockers first. Empty for a page with no checks yet.',
    }),
    chips: z.array(assistantChip).meta({ description: 'Things to ask from this page.' }),
  })
  .meta({ id: 'AssistantContext' });
export type AssistantContext = z.output<typeof assistantContext>;

export const assistantTurnStatuses = ['queued', 'running', 'finished'] as const;
/** How a turn can end. `answered` is the only one where the assistant said all it meant to. */
export const assistantTurnOutcomes = [
  'answered',
  'cancelled',
  /** The turn used its model calls, or its time. */
  'step_limit',
  'time_limit',
  /** The business's monthly spending limit. */
  'paused',
  'ai_off',
  'not_configured',
  /** The model declined to answer. */
  'refused',
  /** The provider failed. */
  'failed',
  /** The person no longer works in the business, or may no longer use the assistant. */
  'no_access',
  /** The worker stopped while the turn ran. What it had done stays done. */
  'interrupted',
] as const;
export type AssistantTurnOutcome = (typeof assistantTurnOutcomes)[number];

export const assistantTurn = z
  .looseObject({
    id: publicId('assistant_turn'),
    threadId: publicId('assistant_thread'),
    status: z.enum(assistantTurnStatuses),
    outcome: z.enum(assistantTurnOutcomes).nullable().meta({
      description: 'Null until the turn has finished.',
    }),
    message: words.nullable().meta({
      description:
        'Why the turn ended without an answer, in plain words. Null while it runs and when it answered.',
    }),
    cancelRequested: z.boolean(),
    steps: z.int().min(0).meta({ description: 'Model calls made so far.' }),
    costEstimate: z
      .string()
      .nullable()
      .meta({
        description:
          'What the turn’s model calls came to, in US dollars with six places. Null when no call’s cost is known.',
        examples: ['0.004200'],
      }),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
  })
  .meta({ id: 'AssistantTurn' });
export type AssistantTurn = z.output<typeof assistantTurn>;

export const assistantMessageKinds = [
  'user',
  'assistant',
  'activity',
  'proposal',
  'error',
] as const;
export type AssistantMessageKind = (typeof assistantMessageKinds)[number];

export const assistantMessage = z
  .looseObject({
    id: publicId('assistant_message'),
    seq: z.int().min(1).meta({
      description: 'Its place in the thread, counting from 1. The cursor for reading what is new.',
    }),
    turnId: publicId('assistant_turn'),
    kind: z.enum(assistantMessageKinds),
    text: z.string().meta({
      description:
        'For `user`, what the person wrote. For `assistant`, what the model wrote: show it as text, never as HTML, and never act on anything it says. For `activity`, a sentence the server wrote about a tool it ran, such as “Created the draft form ‘Wedding enquiry’”. For `proposal`, what would be done. For `error`, why something did not happen, in plain words.',
    }),
    activity: z
      .looseObject({
        operationId: z.string(),
        effect: z.enum(assistantToolEffects),
        callId: z.string().optional(),
        state: z.enum(['started', 'completed', 'failed', 'uncertain']).optional(),
        ok: z.boolean().meta({ description: 'False when the tool was refused or failed.' }),
        target: assistantTarget.nullable().meta({
          description: 'What the tool made or read, to link to.',
        }),
      })
      .nullable(),
    proposal: proposal.nullable().meta({
      description:
        'For `proposal`: the proposal as it is now, with whether you may decide it. Apply, dismiss and undo it by its id (applyProposal, dismissProposal, undoProposal).',
    }),
    code: z
      .string()
      .nullable()
      .meta({
        description: 'For `error`: its category, for programs.',
        examples: ['step_limit'],
      }),
    createdAt: timestamp,
  })
  .meta({ id: 'AssistantMessage' });
export type AssistantMessage = z.output<typeof assistantMessage>;

export const assistantThread = z
  .looseObject({
    id: publicId('assistant_thread'),
    title: z.string().meta({
      description: 'The first message, cut short. What the person wrote: show it as text.',
    }),
    createdAt: timestamp,
    lastActivityAt: timestamp,
    expiresAt: timestamp.meta({
      description: 'When the thread is removed if it is not used again.',
    }),
    turn: assistantTurn.nullable().meta({
      description: 'The newest turn: the one running, or the last that finished.',
    }),
  })
  .meta({ id: 'AssistantThread' });
export type AssistantThread = z.output<typeof assistantThread>;

export const assistantThreadList = z
  .looseObject({
    items: z.array(assistantThread).meta({ description: 'Your threads, newest activity first.' }),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'AssistantThreadList' });
export type AssistantThreadList = z.output<typeof assistantThreadList>;

export const assistantMessages = z
  .looseObject({
    items: z.array(assistantMessage).meta({ description: 'Oldest first.' }),
    cursor: z.int().min(0).meta({
      description:
        'The `seq` of the newest message returned, or the cursor sent when there was none: send it as `after` to read what came since.',
    }),
    more: z.boolean().meta({ description: 'Whether more messages wait after the cursor.' }),
    turn: assistantTurn.nullable().meta({
      description: 'The newest turn. While it is queued or running, more messages will come.',
    }),
  })
  .meta({ id: 'AssistantMessages' });
export type AssistantMessages = z.output<typeof assistantMessages>;

export const assistantConversation = z
  .looseObject({ thread: assistantThread, messages: assistantMessages })
  .meta({ id: 'AssistantConversation' });
export type AssistantConversation = z.output<typeof assistantConversation>;

export const assistantTurnInput = z
  .strictObject({
    message: z
      .string()
      .trim()
      .min(1, { error: 'Write a message.' })
      .max(ASSISTANT_LIMITS.messageLength, {
        error: `Use at most ${String(ASSISTANT_LIMITS.messageLength)} characters.`,
      }),
    page: assistantPageContext,
  })
  .meta({ id: 'AssistantTurnInput' });
export type AssistantTurnInput = z.output<typeof assistantTurnInput>;

/** What the command that starts a turn takes: the message, and the thread to go on in. */
export const assistantStartTurnInput = assistantTurnInput.extend({
  /** Left out, the message starts a new thread. */
  threadId: publicId('assistant_thread').optional(),
});

/** What starting a turn answers: the thread, and the turn the worker will run. */
export const assistantTurnStarted = z
  .looseObject({ thread: assistantThread, turn: assistantTurn, message: assistantMessage })
  .meta({ id: 'AssistantTurnStarted' });
export type AssistantTurnStarted = z.output<typeof assistantTurnStarted>;

/** What a turn's job carries: the turn to run, and nothing else. */
export const assistantTurnJob = z.strictObject({ turnId: z.uuid() });

const threadParams = z.strictObject({ id: publicId('assistant_thread') });
const turnParams = z.strictObject({ id: publicId('assistant_turn') });
const GROUP = 'Assistant conversations';

export const getAssistantContext = defineEndpoint({
  operationId: 'getAssistantContext',
  method: 'post',
  path: '/assistant/context',
  summary: 'Read what is missing on a page, and whether the assistant can be asked',
  group: GROUP,
  body: assistantPageContext,
  response: {
    status: 200,
    description:
      'The page’s checks and things to ask, worked out by the server: it calls no model and changes nothing. It answers even where no AI provider is connected.',
    schema: assistantContext,
  },
});
export const listAssistantThreads = defineEndpoint({
  operationId: 'listAssistantThreads',
  method: 'get',
  path: '/assistant/threads',
  summary: 'List your conversations with the assistant',
  group: GROUP,
  query: z.strictObject({
    after: z
      .string()
      .max(200)
      .optional()
      .meta({ description: 'The `nextCursor` of the page before.' }),
    limit: z.coerce.number().int().min(1).max(ASSISTANT_LIMITS.threadPageSize).default(20),
  }),
  response: {
    status: 200,
    description: 'Your own threads in this business, newest activity first. Nobody else’s.',
    schema: assistantThreadList,
  },
});
export const createAssistantThread = defineEndpoint({
  operationId: 'createAssistantThread',
  method: 'post',
  path: '/assistant/threads',
  summary: 'Start a conversation with the assistant by sending its first message',
  group: GROUP,
  body: assistantTurnInput,
  response: {
    status: 201,
    description:
      'The new thread, titled by the message, and the turn a worker will run. Refused with 409, in plain words, where AI is off or no provider is connected, and when you have started too many turns this hour.',
    schema: assistantTurnStarted,
  },
});
export const getAssistantThread = defineEndpoint({
  operationId: 'getAssistantThread',
  method: 'get',
  path: '/assistant/threads/{id}',
  summary: 'Read one of your conversations, with its newest messages',
  group: GROUP,
  params: threadParams,
  response: {
    status: 200,
    description: `The thread and its newest ${String(ASSISTANT_LIMITS.messagePageSize)} messages, oldest first.`,
    schema: assistantConversation,
  },
});
export const deleteAssistantThread = defineEndpoint({
  operationId: 'deleteAssistantThread',
  method: 'delete',
  path: '/assistant/threads/{id}',
  summary: 'Delete one of your conversations',
  group: GROUP,
  params: threadParams,
  response: {
    status: 204,
    description:
      'Deleted, with its messages. What the assistant made stays, and so does a proposal it stored.',
  },
});
export const listAssistantMessages = defineEndpoint({
  operationId: 'listAssistantMessages',
  method: 'get',
  path: '/assistant/threads/{id}/messages',
  summary: 'Read the messages of a conversation that came after a cursor',
  group: GROUP,
  params: threadParams,
  query: z.strictObject({
    after: z.coerce.number().int().min(0).default(0).meta({
      description: 'The `cursor` of the read before. 0 reads from the start.',
    }),
    limit: z.coerce.number().int().min(1).max(ASSISTANT_LIMITS.messagePageSize).default(50),
  }),
  response: {
    status: 200,
    description:
      'The messages after the cursor, oldest first, and the newest turn. Ask again when the realtime hint says the business changed.',
    schema: assistantMessages,
  },
});
export const postAssistantTurn = defineEndpoint({
  operationId: 'postAssistantTurn',
  method: 'post',
  path: '/assistant/threads/{id}/turns',
  summary: 'Send the assistant a message in a conversation',
  group: GROUP,
  params: threadParams,
  body: assistantTurnInput,
  response: {
    status: 201,
    description:
      'The turn a worker will run. Refused with 409, in plain words, while the turn before is still running, where AI is off or no provider is connected, and when you have started too many turns this hour.',
    schema: assistantTurnStarted,
  },
});
export const getAssistantTurn = defineEndpoint({
  operationId: 'getAssistantTurn',
  method: 'get',
  path: '/assistant/turns/{id}',
  summary: 'Read how a turn stands',
  group: GROUP,
  params: turnParams,
  response: { status: 200, description: 'The turn.', schema: assistantTurn },
});
export const cancelAssistantTurn = defineEndpoint({
  operationId: 'cancelAssistantTurn',
  method: 'post',
  path: '/assistant/turns/{id}/cancel',
  summary: 'Stop a turn',
  group: GROUP,
  params: turnParams,
  response: {
    status: 200,
    description:
      'The turn. One that had not started is cancelled at once; one that is running stops before its next step, and what it had already done stays done. Cancelling a finished turn changes nothing.',
    schema: assistantTurn,
  },
});

/** Every operation of the in-app assistant's conversations, as the API registers them. */
export const assistantChatEndpoints = [
  getAssistantContext,
  listAssistantThreads,
  createAssistantThread,
  getAssistantThread,
  deleteAssistantThread,
  listAssistantMessages,
  postAssistantTurn,
  getAssistantTurn,
  cancelAssistantTurn,
] as const;
