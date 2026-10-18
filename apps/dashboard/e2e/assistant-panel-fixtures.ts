// What the API answers about the in-app assistant: a page's checks and chips,
// conversations, turns, messages and the card that publishes a form. For the panel's unit
// tests and its end-to-end tests. src/assistant/rules.test.ts checks every one of them
// against the contract, so a fixture can't drift from what the server really sends.
import type {
  AssistantContext,
  AssistantMessage,
  AssistantThread,
  AssistantTurn,
  Proposal,
} from '@repo/contracts';

// Ids the server made: the contract checks each wraps a UUIDv7.
const suffix = (last: string): string => `01k8e2wzr0e00800000000000${last}`;
export const threadId = (last: string): string => `athr_${suffix(last)}`;
export const turnId = (last: string): string => `aturn_${suffix(last)}`;
export const messageId = (last: string): string => `amsg_${suffix(last)}`;
export const formId = (last: string): string => `form_${suffix(last)}`;
export const publishId = (last: string): string => `prop_${suffix(last)}`;

export const at = '2026-10-12T09:00:00.000Z';
export const hostedUrl = 'https://crm.example.com/f/fk_wedding';
export const embedSnippet =
  '<script async src="https://crm.example.com/forms/embed.js" data-form-key="fk_wedding"></script>';

/** A business with a provider connected, on a page with nothing to say. */
export function contextOf(overrides: Partial<AssistantContext> = {}): AssistantContext {
  return {
    ai: 'ready',
    canUse: true,
    message: null,
    connect: null,
    subject: null,
    checks: [],
    chips: [],
    ...overrides,
  };
}

/** The list of forms: nothing to check, two things to ask. */
export const formsListContext = contextOf({
  chips: [
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
  ],
});

/** One form's page: a problem that stops it publishing, and two things usually wanted. */
export function formContext(id = formId('1')): AssistantContext {
  return contextOf({
    subject: { kind: 'form', id, name: 'Wedding enquiry' },
    checks: [
      {
        severity: 'blocker',
        code: 'field_label_required',
        message: 'The second question has no label.',
        target: { kind: 'form', id, section: 'questions', path: '/fields/1/label' },
      },
      {
        severity: 'suggestion',
        code: 'no_consent_box',
        message:
          'This form has no consent box, so nobody who sends it agrees to marketing messages.',
        target: { kind: 'form', id, section: 'consent', path: '/consents' },
      },
      {
        severity: 'suggestion',
        code: 'no_workflow',
        message:
          'No workflow starts when this form is sent, so nothing follows a submission by itself.',
        target: { kind: 'automations', id: null, section: null, path: null },
      },
    ],
    chips: [
      {
        code: 'form.whats_missing',
        label: 'What is missing on this form?',
        prompt: 'What is missing on this form? Go through what you found and what you would add.',
      },
      { code: 'form.publish', label: 'Publish this form', prompt: 'Publish this form.' },
    ],
  });
}

/** No provider is connected: the checks still answer, and there is nothing to type in. */
export const notConnected = contextOf({
  ai: 'not_connected',
  message: 'No AI provider is connected yet. Connect one in Settings → AI models.',
  connect: { kind: 'ai_settings', id: null, section: null, path: null },
});

/** This person's role does not include the assistant. */
export const noPermission = contextOf({
  canUse: false,
  message: 'Your role doesn’t include the assistant. Ask an administrator.',
});

export function turnOf(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    id: turnId('1'),
    threadId: threadId('1'),
    status: 'finished',
    outcome: 'answered',
    message: null,
    cancelRequested: false,
    steps: 3,
    costEstimate: '0.004200',
    createdAt: at,
    startedAt: at,
    finishedAt: at,
    ...overrides,
  };
}

/** A turn a worker has taken and not finished. */
export const runningTurn = turnOf({
  status: 'running',
  outcome: null,
  steps: 1,
  costEstimate: null,
  finishedAt: null,
});

export function threadOf(overrides: Partial<AssistantThread> = {}): AssistantThread {
  return {
    id: threadId('1'),
    title: 'A wedding enquiry form with a hidden campaign field',
    createdAt: at,
    lastActivityAt: at,
    expiresAt: '2026-11-11T09:00:00.000Z',
    turn: turnOf(),
    ...overrides,
  };
}

export function messageOf(
  seq: number,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    id: messageId(seq.toString(16)),
    seq,
    turnId: turnId('1'),
    kind: 'assistant',
    text: '',
    activity: null,
    proposal: null,
    code: null,
    createdAt: at,
    ...overrides,
  };
}

/** The card that publishes the draft form, waiting for a person. */
export function publishProposalOf(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: publishId('1'),
    agent: 'copilot',
    kind: 'form_publish',
    status: 'pending',
    autonomy: 'ask',
    summary: 'Publish the form “Wedding enquiry”',
    conversationId: null,
    recordId: null,
    formId: formId('1'),
    change: {
      kind: 'form_publish',
      formId: formId('1'),
      name: 'Wedding enquiry',
      questions: 5,
      consents: 1,
      republish: false,
    },
    basis: null,
    stale: false,
    edited: false,
    canDecide: true,
    result: null,
    undo: null,
    createdAt: at,
    expiresAt: '2026-10-19T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    undoneAt: null,
    undoneBy: null,
    ...overrides,
  };
}

/** The same card once the person pressed Publish. */
export function publishedProposalOf(overrides: Partial<Proposal> = {}): Proposal {
  return publishProposalOf({
    status: 'applied',
    result: { formId: formId('1'), hostedUrl, embedSnippet },
    undo: { available: true, reason: null, message: null },
    decidedAt: at,
    decidedBy: { kind: 'user', name: 'Dana Brooks', you: true },
    ...overrides,
  });
}

/** What the person asked for, in the story every test tells. */
export const asked =
  'A wedding enquiry form with a hidden campaign field. Ask for the date and the venue.';

/** The conversation after the assistant built the draft and asked to publish it. */
export function builtMessages(proposal: Proposal = publishProposalOf()): AssistantMessage[] {
  return [
    messageOf(1, { kind: 'user', text: asked }),
    messageOf(2, {
      kind: 'activity',
      text: 'Created the draft form “Wedding enquiry”',
      activity: {
        operationId: 'createForm',
        effect: 'draft',
        ok: true,
        target: { kind: 'form', id: formId('1'), section: null, path: null },
      },
    }),
    messageOf(3, {
      kind: 'activity',
      text: 'Saved 5 questions on “Wedding enquiry”',
      activity: {
        operationId: 'updateForm',
        effect: 'draft',
        ok: true,
        target: { kind: 'form', id: formId('1'), section: null, path: null },
      },
    }),
    messageOf(4, { kind: 'proposal', text: proposal.summary, proposal }),
    messageOf(5, {
      kind: 'assistant',
      text: 'The draft is ready with five questions and a hidden campaign field.\nA card is waiting above for you to publish it.',
    }),
  ];
}
