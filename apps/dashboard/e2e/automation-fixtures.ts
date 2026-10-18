// The automation from docs/AUTOMATIONS.md section 2 and the business it belongs to, for the
// builder's end-to-end tests and its unit tests. Plain data: nothing here needs a browser.
import {
  automationCatalog,
  type Automation,
  type AutomationFolder,
  type AutomationRunCounts,
  type AutomationSetup,
  type AutomationStats,
  type AutomationSummary,
} from '@repo/contracts';

export const automationId = 'aut_01k8e2wzr0e008000000000010';
export const versionId = 'aver_01k8e2wzr0e008000000000011';

const named = (id: string, name: string): { id: string; name: string } => ({ id, name });

/** Harbor Lights' setup: everything connected, so nothing is unavailable unless a test says. */
export const harborSetup: AutomationSetup = {
  fields: {
    contact: [
      {
        key: 'services',
        aliases: [],
        type: 'multi_choice',
        options: [
          { key: 'video', label: 'Video' },
          { key: 'photo', label: 'Photo' },
        ],
      },
    ],
    deal: [],
  },
  forms: [named('frm_quote', 'Request a quote')],
  emailTemplates: [named('tpl_guide', 'Pricing guide'), named('tpl_welcome', 'Welcome')],
  whatsappTemplates: [named('wat_hello', 'Hello')],
  mailboxes: [named('mbx_hello', 'hello@harborlights.example')],
  phoneNumbers: [named('pn_front', 'Front desk')],
  calendars: [named('cal_consult', 'Consultation')],
  pipelines: [
    {
      ...named('pip_sales', 'Sales'),
      stages: [named('stg_new', 'New lead'), named('stg_quoted', 'Quoted')],
    },
  ],
  lostReasons: [named('los_price', 'Too expensive')],
  tags: [named('tag_vip', 'VIP'), named('tag_cold', 'Cold')],
  users: [named('usr_dana', 'Dana Brooks')],
  automations: [named('aut_other', 'Win back')],
  triggerLinks: [{ ...named('tlnk_book', 'Booking page'), key: 'booking_page' }],
  values: ['sample_reel_url'],
  channels: { email: true, sms: true, whatsapp: true },
  ai: true,
  webhooks: true,
  unavailableSteps: [],
  unavailableTriggers: [],
};

/** "New lead follow-up", as the documentation writes it. */
export const followUp = {
  name: 'New lead follow-up',
  description: 'Pricing guide, then up to two texts until they reply or book.',
  triggers: [{ id: 'quote_form', type: 'form.submitted', config: { form: 'Request a quote' } }],
  stopWhen: [
    { event: 'message.received', from: 'contact' },
    { event: 'appointment.booked' },
    { event: 'deal.closed' },
  ],
  start: 'send_guide',
  steps: {
    send_guide: {
      type: 'email.send',
      config: { template: 'Pricing guide' },
      next: 'wait_2_days',
    },
    wait_2_days: { type: 'wait', config: { duration: 'P2D' }, next: 'asked_about_video' },
    asked_about_video: {
      type: 'condition',
      config: { if: { field: 'contact.services', operator: 'includes', value: 'video' } },
      next: { yes: 'send_reel', no: 'check_in' },
    },
    send_reel: {
      type: 'sms.send',
      config: { message: 'Here’s our video sample reel: {{values.sample_reel_url}}' },
    },
    check_in: {
      type: 'sms.send',
      config: {
        message: 'Hi {{contact.firstName}}, did the pricing guide come through?',
      },
      next: 'wait_3_days',
    },
    wait_3_days: { type: 'wait', config: { duration: 'P3D' }, next: 'last_check_in' },
    last_check_in: {
      type: 'sms.send',
      config: { message: 'Last check-in from Harbor Lights.' },
    },
  },
  settings: { reEnrollment: 'after_finished', timezone: 'contact' },
} as const;

export const stamp = '2026-10-09T09:00:00.000Z';

/** What the person may do, which the API says with each automation and with the list. */
export interface AutomationFlags {
  readonly canManage: boolean;
  readonly canPublish: boolean;
}

/** An automation as GET /automations/{id} answers: a draft, never published, all allowed. */
export function automationOf(
  over: Partial<Automation> & Partial<AutomationFlags> = {},
): Automation & AutomationFlags {
  return {
    id: automationId,
    name: followUp.name,
    description: followUp.description,
    status: 'draft',
    draftVersion: 3,
    liveVersion: null,
    lastRunAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    folderId: null,
    totalEnrolled: 0,
    activeEnrolled: 0,
    deletedAt: null,
    purgeAt: null,
    draft: followUp,
    live: null,
    canManage: true,
    canPublish: true,
    ...over,
  };
}

/** The automation's row in GET /automations. */
export function summaryOf(automation: Automation): AutomationSummary {
  const {
    draft: _draft,
    live: _live,
    canManage: _manage,
    canPublish: _publish,
    ...summary
  } = automation;
  return summary;
}

export const folderIds = {
  leads: 'afol_01k8e2wzr0e008000000000051',
  weddings: 'afol_01k8e2wzr0e008000000000052',
} as const;

/** A folder as GET /automation-folders lists it; a test says what differs. */
export function folderOf(
  id: string,
  name: string,
  over: Partial<AutomationFolder> = {},
): AutomationFolder {
  return {
    id,
    parentId: null,
    name,
    revision: 1,
    automationCount: 0,
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}

const runCounts = (enrolled: number, active: number, failed: number): AutomationRunCounts => ({
  enrolled,
  active,
  completed: enrolled - active - failed,
  exited: 0,
  failed,
  cancelled: 0,
});

/** GET /automations/{id}/stats for the follow-up: 12 runs in all, 5 of them on version 2. */
export const followUpStats: AutomationStats = {
  automationId,
  liveVersion: 2,
  runs: { allTime: runCounts(12, 3, 1), live: runCounts(5, 2, 0) },
  triggers: [
    {
      trigger: 'quote_form',
      type: 'form.submitted',
      inLiveVersion: true,
      allTime: { enrolled: 12 },
      live: { enrolled: 5 },
    },
  ],
  steps: [
    {
      step: 'send_guide',
      type: 'email.send',
      label: null,
      inLiveVersion: true,
      allTime: { entered: 12, completed: 11, failed: 1, waiting: 0, skipped: 0 },
      live: { entered: 5, completed: 5, failed: 0, waiting: 0, skipped: 0 },
    },
  ],
};

/** GET /automations/catalog: every trigger and step, and this business's setup. */
export const catalogOf = (setup: AutomationSetup = harborSetup): Record<string, unknown> => ({
  ...automationCatalog(),
  setup,
});

const custom = (
  key: string,
  type: AutomationSetup['fields']['contact'][number]['type'],
  options: readonly { key: string; label: string }[] = [],
): AutomationSetup['fields']['contact'][number] => ({ key, aliases: [], type, options });

/** The folder Settings keeps the wedding's own fields in. */
const weddingFolder = { id: 'ffld_wedding', name: 'Wedding details' };

/**
 * Harbor Lights with a team of three and custom fields of every kind a record step sets:
 * for the forms of Assign owner, Update contact, Find opportunity and Update opportunity.
 */
export const recordSetup: AutomationSetup = {
  ...harborSetup,
  fields: {
    contact: [
      ...harborSetup.fields.contact,
      custom('budget', 'number'),
      custom('visits', 'number'),
      custom('event_date', 'date'),
      custom('first_enquiry', 'datetime'),
      custom('utm_source', 'text'),
      custom('lead_source_raw', 'text'),
      custom('newsletter', 'boolean'),
      custom('notes', 'long_text'),
      custom('venue', 'single_choice', [
        { key: 'garden', label: 'Garden' },
        { key: 'hall', label: 'Hall' },
      ]),
      // Named and filed as Settings has them: listed by name, under their folder. Those
      // above carry neither, as an install from before the catalog named fields answers.
      { ...custom('diet', 'text'), label: 'Dietary requirements', folder: weddingFolder },
      { ...custom('guest_total', 'number'), label: 'Number of guests', folder: weddingFolder },
    ],
    deal: [
      custom('service', 'text'),
      custom('guests', 'number'),
      { ...custom('deposit', 'number'), label: 'Deposit paid', folder: null },
    ],
  },
  users: [
    named('usr_dana', 'Dana Brooks'),
    named('usr_chris', 'Chris Marino'),
    named('usr_sam', 'Sam Okoye'),
  ],
};

/** A one-step automation, the smallest a test can start from. */
export const welcome = {
  name: 'Welcome new contacts',
  triggers: [{ id: 'contact_created', type: 'contact.created', config: {} }],
  start: 'add_tag',
  steps: { add_tag: { type: 'tag.add', config: { tag: 'tag_vip' } } },
} as const;

export interface AutomationExample {
  readonly config: Record<string, unknown>;
  readonly summary: string;
}

// One real config for every step type the document can hold, and how the Steps view reads
// it. The unit tests go through the catalog: a step type added there without an example
// here, or without a summary, fails them.
export const stepExamples: Readonly<Record<string, AutomationExample>> = {
  'email.send': {
    config: { template: 'tpl_guide', mailbox: 'mbx_hello' },
    summary: 'Send the email “Pricing guide” from hello@harborlights.example',
  },
  'sms.send': {
    config: { message: 'Hi {{contact.firstName}}, did it come through?' },
    summary: 'Text them “Hi {{contact.firstName}}, did it come through?”',
  },
  'whatsapp.send': {
    config: { template: 'Hello' },
    summary: 'Send the WhatsApp template “Hello”',
  },
  'team.notify': {
    config: { message: 'New lead', to: 'everyone' },
    summary: 'Tell everyone on the team “New lead”',
  },
  'manual.call': {
    config: { notes: 'Ask about the date.', user: 'usr_dana' },
    summary: 'Ask Dana Brooks to call them',
  },
  'manual.sms': {
    config: { message: 'Thanks for coming by.' },
    summary: "Ask the contact's owner to text them “Thanks for coming by.”",
  },
  wait: { config: { duration: 'P2D' }, summary: 'Wait 2 days' },
  'wait.until': {
    config: { field: 'contact.eventDate', offset: 'P2D', direction: 'before', time: '09:00' },
    summary: 'Wait until 2 days before event date, at 09:00',
  },
  'wait.event': {
    config: { event: 'message.received', from: 'contact', timeout: 'P2D' },
    summary: 'Wait up to 2 days for a reply',
  },
  'wait.condition': {
    config: { if: { field: 'contact.email', operator: 'is_set' }, timeout: 'P2D' },
    summary: 'Wait up to 2 days for a condition to hold',
  },
  'wait.appointment': {
    config: { offset: 'P1D', direction: 'before' },
    summary: 'Wait until 1 day before their appointment starts',
  },
  condition: {
    config: { if: { field: 'contact.services', operator: 'includes', value: 'Video' } },
    summary: 'If services includes “Video”',
  },
  split: {
    config: {
      variants: [
        { name: 'a', percent: 60 },
        { name: 'b', percent: 40 },
      ],
    },
    summary: 'Split contacts: a 60% and b 40%',
  },
  'contact.update': {
    config: { fields: { 'contact.firstName': 'Sam', 'contact.custom.budget': null } },
    summary: 'On the contact: set first name to “Sam” and clear budget',
  },
  'deal.create': {
    config: { pipeline: 'pip_sales', stage: 'stg_new', name: 'Quote', amount: 500 },
    summary: 'Create an opportunity in Sales, at New lead. Source: from how they arrived',
  },
  'deal.find': {
    config: { which: 'oldest', stage: 'stg_quoted' },
    summary: 'Find their oldest opportunity: at Quoted',
  },
  'deal.update': {
    config: { name: 'Renewal', amount: 900 },
    summary: 'On the opportunity: set name and value',
  },
  'deal.move': { config: { stage: 'stg_quoted' }, summary: 'Move the opportunity to Quoted' },
  'deal.close': {
    config: { outcome: 'lost', lostReason: 'los_price' },
    summary: 'Close the opportunity as lost: Too expensive',
  },
  'task.create': {
    config: { title: 'Call them', dueIn: 'P1D' },
    summary: 'Create the task “Call them”, due in 1 day',
  },
  'owner.assign': {
    config: { user: 'usr_dana' },
    summary: 'Assign to Dana Brooks',
  },
  'owner.remove': { config: {}, summary: "Remove the contact's owner" },
  'dnd.set': {
    config: { channel: 'email', action: 'enable', reason: 'Requested by the contact.' },
    summary: 'Enable do not disturb for email',
  },
  'followers.add': {
    config: { users: ['usr_dana'] },
    summary: 'Add Dana Brooks as followers',
  },
  'followers.remove': { config: { all: true }, summary: 'Remove every follower' },
  'note.create': {
    config: { text: 'Welcome {{contact.firstName}}' },
    summary: 'Write the note “Welcome {{contact.firstName}}”',
  },
  'tag.add': { config: { tag: 'tag_vip' }, summary: 'Add the tag VIP' },
  'tag.remove': { config: { tag: 'Cold' }, summary: 'Remove the tag Cold' },
  'ai.ask': {
    config: { prompt: 'Is this lead a wedding?' },
    summary: 'Ask AI “Is this lead a wedding?”',
  },
  'ai.classify': {
    config: { categories: ['interested', 'not_now', 'stop'] },
    summary: 'Sort their last reply into interested, not_now, or stop',
  },
  'ai.draft_reply': {
    config: { instructions: 'Keep it short.' },
    summary: 'Draft a reply with AI, told “Keep it short.”',
  },
  'webhook.call': {
    config: { url: 'https://hooks.example.test/lead', method: 'PUT' },
    summary: 'Send a PUT request to https://hooks.example.test/lead',
  },
  'automation.run': {
    config: { automation: 'aut_other' },
    summary: 'Start the automation “Win back”',
  },
  goto: { config: { target: 'send_guide' }, summary: 'Go to the action send_guide' },
  goal: {
    config: {
      events: [
        { type: 'appointment.booked', config: {} },
        { type: 'message.received', config: {} },
      ],
      otherwise: 'wait',
    },
    summary: 'Come straight here on: Appointment booked or Message received',
  },
  'automation.remove': {
    config: { from: 'all_others', except: ['aut_other'] },
    summary: 'Remove them from every other automation, except “Win back”',
  },
  'score.modify': {
    config: { calculation: 'add', points: 10 },
    summary: 'Add 10 to their engagement score',
  },
  'email.verify': {
    config: { maxAgeDays: 30 },
    summary: 'Check the primary email (reuse results up to 30 days old)',
  },
};

export const triggerExamples: Readonly<Record<string, AutomationExample>> = {
  'form.submitted': { config: { form: 'frm_quote' }, summary: 'Someone submits “Request a quote”' },
  'message.received': { config: { channel: 'sms' }, summary: 'A contact sends a text' },
  'appointment.booked': {
    config: { calendar: 'cal_consult' },
    summary: 'Someone books an appointment on Consultation',
  },
  'appointment.status_changed': {
    config: { status: 'no_show' },
    summary: "An appointment's status changes to “no_show”",
  },
  'deal.stage_changed': {
    config: { pipeline: 'pip_sales', stage: 'stg_quoted' },
    summary: 'An opportunity moves to Quoted, in Sales',
  },
  'deal.closed': { config: { outcome: 'won' }, summary: 'An opportunity is won' },
  'contact.created': { config: {}, summary: 'A contact is created' },
  'contact.dnd_changed': {
    config: { flag: 'enabled', channel: 'sms' },
    summary: "A contact's do not disturb for text messages is turned on",
  },
  'contact.score_changed': {
    config: { operator: 'gte', score: 50 },
    summary: "A contact's engagement score is at least 50",
  },
  'field.changed': {
    config: { field: 'contact.firstName', to: 'Sam' },
    summary: "A contact's first name changes to “Sam”",
  },
  'tag.added': { config: { tag: 'tag_vip' }, summary: 'The tag VIP is added to a contact' },
  'tag.removed': { config: { tag: 'tag_vip' }, summary: 'The tag VIP is removed from a contact' },
  'task.created': { config: {}, summary: 'A task is created for a contact' },
  'task.completed': { config: {}, summary: "A contact's task is completed" },
  'task.reminder': { config: { before: 1, after: 2 }, summary: "A contact's task comes due" },
  'note.created': { config: {}, summary: 'A note is added to a contact' },
  'note.updated': { config: {}, summary: "A contact's note is changed" },
  'quote.sent': { config: {}, summary: 'A quote is sent' },
  'quote.accepted': { config: {}, summary: 'A quote is accepted' },
  'quote.declined': { config: {}, summary: 'A quote is declined' },
  'invoice.issued': { config: {}, summary: 'An invoice is issued' },
  'invoice.sent': { config: {}, summary: 'An invoice is sent' },
  'invoice.paid': { config: {}, summary: 'An invoice is paid in full' },
  'payment.recorded': { config: {}, summary: 'A payment is recorded' },
  'external_tracking.event': {
    config: { event: 'form_submission' },
    summary: 'A contact sends a form on your website',
  },
  'trigger_link.clicked': {
    config: { link: 'tlnk_book' },
    summary: 'A contact clicks the trigger link Booking page',
  },
  'automation.run_ended': {
    config: { automations: ['aut_other'], how: ['stopped'], stoppedBy: ['message.received'] },
    summary:
      "A contact's run of “Win back” is stopped by one of its stop conditions, when what stopped it was “A message arrives, from them or from the team”",
  },
  'date.reached': {
    config: { field: 'contact.birthday', offset: 'P1W', direction: 'before' },
    summary: 'It is 1 week before birthday',
  },
  'webhook.received': {
    config: {},
    summary: "An outside app calls this automation's webhook address",
  },
  schedule: {
    config: { every: 'week', at: '09:00', weekday: 'monday' },
    summary: 'Every Monday at 09:00',
  },
};

export const runIds = {
  maya: 'arun_01k8e2wzr0e008000000000021',
  jordan: 'arun_01k8e2wzr0e008000000000022',
  priya: 'arun_01k8e2wzr0e008000000000023',
} as const;
export const contactIds = {
  maya: 'con_01k8e2wzr0e008000000000031',
  jordan: 'con_01k8e2wzr0e008000000000032',
  priya: 'con_01k8e2wzr0e008000000000033',
} as const;

/** One run as the lists show it; a test says what differs. */
export function runSummaryOf(
  who: keyof typeof runIds,
  name: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: runIds[who],
    automationId,
    automationName: followUp.name,
    version: 2,
    status: 'completed',
    recordId: contactIds[who],
    record: { id: contactIds[who], name, trashed: false },
    currentStep: null,
    exitReason: null,
    wakeAt: null,
    startedAt: '2026-10-06T18:38:00.000Z',
    finishedAt: '2026-10-08T18:40:00.000Z',
    trigger: { id: 'quote_form', type: 'form.submitted' },
    currentAction: null,
    ...over,
  };
}

/** GET /automations/{id}/runs: one who finished, one waiting, one that failed. */
export const runList = {
  items: [
    runSummaryOf('priya', 'Priya Nair', {
      status: 'failed',
      exitReason: 'consent_required',
      startedAt: '2026-10-08T07:00:00.000Z',
      finishedAt: '2026-10-08T07:00:01.000Z',
    }),
    runSummaryOf('jordan', 'Jordan Lee', {
      status: 'waiting',
      currentStep: 'asked_about_video',
      currentAction: { step: 'asked_about_video', type: 'condition', label: null },
      wakeAt: '2026-10-09T12:15:00.000Z',
      startedAt: '2026-10-07T12:15:00.000Z',
      finishedAt: null,
    }),
    runSummaryOf('maya', 'Maya Thompson'),
  ],
  nextCursor: null,
} as const;

const stepRun = (
  step: string,
  type: string,
  config: Record<string, unknown>,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  step,
  type,
  status: 'succeeded',
  input: { config },
  output: {},
  branch: null,
  explanation: '',
  error: null,
  attempt: 1,
  startedAt: '2026-10-06T18:38:00.000Z',
  finishedAt: '2026-10-06T18:38:00.000Z',
  ...over,
});

/** GET /automation-runs/{id}: Maya's run, through the yes branch to the end. */
export const mayaRun = {
  ...runSummaryOf('maya', 'Maya Thompson'),
  steps: [
    stepRun(
      'send_guide',
      'email.send',
      { template: 'tpl_guide' },
      {
        output: { messageId: 'msg_01k8e2wzr0e008000000000041' },
        explanation: 'The email was queued to send.',
      },
    ),
    stepRun(
      'wait_2_days',
      'wait',
      { duration: 'P2D' },
      {
        status: 'waiting',
        output: { wakeAt: '2026-10-08T18:38:00.000Z' },
        explanation: 'Waiting 2 days, until 2026-10-08T18:38:00.000Z.',
      },
    ),
    stepRun(
      'asked_about_video',
      'condition',
      { if: { field: 'contact.custom.services', operator: 'includes', value: 'video' } },
      {
        input: {
          config: {
            if: { field: 'contact.custom.services', operator: 'includes', value: 'video' },
          },
          values: { 'contact.custom.services': ['video', 'photo'] },
        },
        branch: 'yes',
        explanation: 'The condition was true, so the yes branch was taken.',
        startedAt: '2026-10-08T18:38:00.000Z',
      },
    ),
    stepRun(
      'send_reel',
      'sms.send',
      { message: 'Here’s our video sample reel.' },
      {
        output: { messageId: 'msg_01k8e2wzr0e008000000000042' },
        explanation: 'The text message was queued to send.',
        startedAt: '2026-10-08T18:38:01.000Z',
      },
    ),
  ],
} as const;

/** Priya's run: it failed at its first step, and says why. */
export const priyaRun = {
  ...runList.items[0],
  steps: [
    stepRun(
      'send_guide',
      'email.send',
      { template: 'tpl_guide' },
      {
        status: 'failed',
        explanation: 'Messaging refused the email: consent_required.',
        error: { code: 'consent_required' },
        startedAt: '2026-10-08T07:00:00.000Z',
      },
    ),
  ],
} as const;

const logEntry = (
  number: number,
  who: keyof typeof runIds,
  name: string,
  step: Record<string, unknown>,
): Record<string, unknown> => ({
  ...step,
  id: `astep_01k8e2wzr0e0080000000000${String(60 + number)}`,
  runId: runIds[who],
  version: 2,
  label: null,
  record: { id: contactIds[who], name, trashed: false },
});

/** GET /automations/{id}/step-runs: the steps of Priya's and Maya's runs, newest first. */
export const stepRunList = {
  items: [
    logEntry(1, 'maya', 'Maya Thompson', {
      ...mayaRun.steps[3],
      startedAt: '2026-10-08T18:38:01.000Z',
    }),
    logEntry(2, 'maya', 'Maya Thompson', mayaRun.steps[2]),
    logEntry(3, 'priya', 'Priya Nair', priyaRun.steps[0]),
    logEntry(4, 'maya', 'Maya Thompson', { ...mayaRun.steps[1], status: 'succeeded' }),
    logEntry(5, 'maya', 'Maya Thompson', mayaRun.steps[0]),
  ],
  nextCursor: null,
} as const;

/** GET /automations/{id}/versions/2: the version the runs began on. */
export const versionTwo = {
  id: versionId,
  version: 2,
  changeSummary: 'Second',
  publishedAt: stamp,
  publishedByKind: 'user',
  document: followUp,
} as const;

const serviceIs = (value: string): Record<string, unknown> => ({
  field: 'contact.services',
  operator: 'includes',
  value,
});
const createDeal = (name: string, next: string): Record<string, unknown> => ({
  type: 'deal.create',
  config: { pipeline: 'pip_sales', stage: 'stg_new', name },
  next,
});

/** Three branches, a "Create opportunity" on each, all on to one email: branches that join again. */
export const threeDeals = {
  name: 'Deals by service',
  triggers: followUp.triggers,
  start: 'which_service',
  steps: {
    which_service: {
      type: 'condition',
      config: {
        branches: [
          { name: 'photo', if: serviceIs('photo') },
          { name: 'video', if: serviceIs('video') },
        ],
      },
      next: { photo: 'deal_photo', video: 'deal_video', none: 'deal_other' },
    },
    deal_photo: createDeal('Photo', 'thanks'),
    deal_video: createDeal('Video', 'thanks'),
    deal_other: createDeal('Other', 'thanks'),
    thanks: { type: 'email.send', config: { template: 'tpl_welcome' }, next: 'later' },
    later: { type: 'wait', config: { duration: 'P1D' } },
  },
  settings: followUp.settings,
} as const;

/**
 * A lead intake: two of three branches share a follow-up task, and then all three come
 * together again at one email. Two joins, one under the other.
 */
export const leadIntake = {
  name: 'Lead intake',
  triggers: followUp.triggers,
  start: 'which_service',
  steps: {
    which_service: {
      type: 'condition',
      config: {
        branches: [
          { name: 'photo', if: serviceIs('photo') },
          { name: 'video', if: serviceIs('video') },
        ],
      },
      next: { photo: 'deal_photo', video: 'deal_video', none: 'deal_other' },
    },
    deal_photo: createDeal('Photo', 'follow_up'),
    deal_video: createDeal('Video', 'follow_up'),
    deal_other: createDeal('Other', 'thanks'),
    follow_up: {
      type: 'task.create',
      config: { title: 'Follow up tomorrow', dueIn: 'P1D' },
      next: 'thanks',
    },
    thanks: { type: 'email.send', config: { template: 'tpl_welcome' } },
  },
  settings: followUp.settings,
} as const;
