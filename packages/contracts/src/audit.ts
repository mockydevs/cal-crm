// The audit log, read. Every command writes one row to audit.commands, with who ran it and
// what came of it. A record's audit log is the commands that changed it: the ones whose
// events are on its timeline. Reading it needs `audit.read`.
//
// An entry never carries the command's whole input, the address it came from or the
// browser it came with. It shows the few fields the reader's list names for that command
// (`detail`), such as the reason given for turning do not contact on.
//
// The business's audit log is the same entries across every record: the commands that
// changed something, newest first, by who, module, action, thing and time. The table names
// no record, module or action. The thing a command changed is what its events are about;
// its module and action are read from its name by the lists below.
import { actorKinds } from '@repo/kernel';
import * as z from 'zod';

import { actor } from './activity.js';
import { defineEndpoint } from './endpoints.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';

/** How many entries a page of an audit log holds. */
export const AUDIT_PAGE_SIZE = 50;

/** As audit.commands allows them (commands_outcome_valid). */
export const auditOutcomes = ['ok', 'denied', 'invalid', 'failed'] as const;
export type AuditOutcome = (typeof auditOutcomes)[number];

export const auditEntry = z
  .looseObject({
    id: publicId('audit_entry'),
    at: timestamp.meta({ description: 'When the command ran.' }),
    command: z.string().meta({
      description: 'The command, as the audit log names it.',
      examples: ['contact.update'],
    }),
    outcome: z.enum(auditOutcomes).meta({
      description:
        "What came of it. A record's log holds only commands that changed it, so each is ok.",
    }),
    errorCode: z.string().nullable(),
    actor,
    proposed: z.boolean().meta({
      description:
        'Whether an assistant proposed the change and the actor approved it (a proposal applied or undone).',
    }),
    events: z
      .array(
        z.looseObject({
          id: publicId('event'),
          type: z.string().meta({ examples: ['contact.updated'] }),
        }),
      )
      .meta({ description: 'What the command reported, oldest first. Each can be explained.' }),
    detail: z.record(z.string(), z.unknown()).meta({
      description:
        "The parts of the command's input this log shows for that command, such as the reason for a do-not-contact change. Empty for most commands.",
    }),
  })
  .meta({ id: 'AuditEntry', description: 'One command: who ran it, when, and what came of it.' });
export type AuditEntry = z.infer<typeof auditEntry>;

export const auditLog = z
  .looseObject({
    items: z.array(auditEntry).meta({ description: 'Newest first.' }),
    next: publicId('audit_entry').nullable().meta({
      description: 'Pass it as after to read the next page. Null on the last page.',
    }),
  })
  .meta({ id: 'AuditLog', description: 'A page of an audit log.' });
export type AuditLog = z.infer<typeof auditLog>;

export const listRecordAuditQuery = z.strictObject({
  after: publicId('audit_entry')
    .optional()
    .meta({ description: "Start after this entry: the previous page's next." }),
});

export const listRecordAudit = defineEndpoint({
  operationId: 'listRecordAudit',
  method: 'get',
  path: '/records/{id}/audit-log',
  summary: 'Read the commands that changed a record: who did what, and when',
  group: 'Audit log',
  params: z.strictObject({ id: recordId }),
  query: listRecordAuditQuery,
  response: {
    status: 200,
    description: `A page of the record's audit log, ${String(AUDIT_PAGE_SIZE)} entries at most.`,
    schema: auditLog,
  },
});

/** The most entries a page of the business's audit log holds. Unasked, AUDIT_PAGE_SIZE. */
export const MAX_AUDIT_PAGE_SIZE = 100;

/**
 * The modules of the audit log, each the commands whose name starts with one of its words:
 * `contact.update` is of contacts. A command of none of them is of `other`.
 */
export const auditModules = {
  contacts: ['contact', 'contacts', 'contact_fact', 'consents'],
  companies: ['company'],
  opportunities: ['deal', 'pipeline', 'pipelines', 'opportunity_settings'],
  tasks: ['task'],
  notes: ['note'],
  tags: ['tag', 'tag_group', 'tag_rules'],
  custom_fields: ['field', 'field_folder'],
  custom_values: ['custom_value', 'custom_value_folder'],
  conversations: [
    'conversation',
    'manual_action',
    'snippet',
    'snippet_folder',
    'trigger_link',
    'template',
    'messaging',
    'mailbox',
    'mailboxes',
    'sms',
    'webchat',
  ],
  calendars: ['calendar', 'appointment'],
  automations: ['automation', 'automations'],
  forms: ['forms'],
  imports: ['import', 'imports'],
  team: ['team', 'api_key'],
  assistant: ['ai', 'proposal'],
  settings: ['business', 'view', 'file', 'integration'],
  trash: ['record', 'trash'],
} as const satisfies Record<string, readonly string[]>;
export type AuditModule = keyof typeof auditModules;
export const auditModuleNames = Object.keys(auditModules) as [AuditModule, ...AuditModule[]];

/**
 * What a command did, by the last word of its name. A word in none of the lists is an
 * update, which is what most commands are; so is a bulk command, whatever it was asked.
 */
export const auditActionVerbs = {
  created: [
    'create',
    'create_folder',
    'create_widget',
    'duplicate',
    'invite',
    'book',
    'remember',
    'connect',
    'connect_provider',
    'register_number',
    'start',
  ],
  deleted: [
    'delete',
    'delete_folder',
    'delete_many',
    'trash',
    'purge',
    'purge_deleted',
    'purge_expired',
    'remove_member',
    'remove_connection',
    'remove_model_price',
    'revoke',
    'revoke_invitation',
    'archive',
    'discard_submission',
  ],
  restored: ['restore'],
} as const satisfies Record<string, readonly string[]>;
export const auditActions = ['created', 'updated', 'deleted', 'restored'] as const;
export type AuditAction = (typeof auditActions)[number];

/** The module a command is of, by the first word of its name. */
export function auditModuleOf(command: string): AuditModule | 'other' {
  const word = command.split('.')[0] ?? '';
  for (const name of auditModuleNames)
    if ((auditModules[name] as readonly string[]).includes(word)) return name;
  return 'other';
}

/** What a command did, by the last word of its name. */
export function auditActionOf(command: string): AuditAction {
  const word = command.split('.').at(-1) ?? '';
  for (const action of ['created', 'deleted', 'restored'] as const)
    if ((auditActionVerbs[action] as readonly string[]).includes(word)) return action;
  return 'updated';
}

export const auditListEntry = auditEntry
  .extend({
    module: z.enum([...auditModuleNames, 'other']).meta({
      description: "The part of the product the command belongs to, by its name's first word.",
    }),
    action: z.enum(auditActions).meta({
      description:
        "What it did, by its name's last word. A bulk command is an update whatever it was asked.",
    }),
    record: z
      .looseObject({
        kind: z.string().meta({ examples: ['contact', 'task', 'pipeline'] }),
        id: z.string().nullable().meta({
          description: "The thing's id as the API gives it. Null for a kind without one.",
        }),
        name: z.string().nullable().meta({
          description:
            'Its name now, for a contact, a company, a deal and a task (its title). Null for any other kind, and when it no longer exists or has no name.',
        }),
        exists: z.boolean().nullable().meta({
          description:
            'Whether it is still there, for a contact, a company, a deal and a task. Null for any other kind: this list does not look those up.',
        }),
      })
      .nullable()
      .meta({
        description:
          "The one thing the command's events are about. Null when it wrote no event, as a refused one does, or wrote about several things, as a bulk action does.",
      }),
    recordCount: z.int().min(0).meta({
      description: "How many different things the command's events are about.",
    }),
  })
  .meta({
    id: 'AuditListEntry',
    description: 'One command in the audit log of the business, with what it was about.',
  });
export type AuditListEntry = z.infer<typeof auditListEntry>;

export const auditPage = z
  .looseObject({
    items: z.array(auditListEntry).meta({ description: 'Newest first.' }),
    next: publicId('audit_entry').nullable().meta({
      description:
        'Pass it as after, with the same filters, to read the next page. Null on the last page.',
    }),
  })
  .meta({ id: 'AuditPage', description: "A page of the business's audit log." });
export type AuditPage = z.infer<typeof auditPage>;

const bound = z.iso.datetime({ offset: true }).refine((value) => !value.startsWith('0000-'));

export const listAuditQuery = z
  .strictObject({
    after: publicId('audit_entry')
      .optional()
      .meta({ description: "Start after this entry: the previous page's next." }),
    limit: z.coerce
      .number()
      .int()
      .min(1, { error: 'Ask for at least 1 entry.' })
      .max(MAX_AUDIT_PAGE_SIZE, {
        error: `Ask for at most ${String(MAX_AUDIT_PAGE_SIZE)} entries.`,
      })
      .optional()
      .meta({
        description: `How many entries a page holds. Left out, ${String(AUDIT_PAGE_SIZE)}.`,
      }),
    member: z
      .union([z.literal('me'), publicId('membership')])
      .optional()
      .meta({
        description:
          'Only what this person did: me, or a member by the id listTaskAssignees and the team list give.',
      }),
    actorKind: z.enum(actorKinds).optional().meta({
      description:
        'Only what this kind of actor did, such as automation or api_key. Not together with member.',
    }),
    module: z.enum(auditModuleNames).optional(),
    action: z.enum(auditActions).optional(),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(100, { error: 'Use at most 100 characters.' })
      .optional()
      .meta({
        description:
          'Only the commands that wrote about this one thing, by its id as the API gives it: a contact, a task, a pipeline. An id that names nothing finds nothing.',
      }),
    from: bound.optional().meta({
      description: 'Only commands run at or after this time. A time with its offset.',
    }),
    before: bound.optional().meta({
      description: 'Only commands run before this time. A time with its offset, after from.',
    }),
    outcome: z.enum(auditOutcomes).default('ok').meta({
      description:
        'ok, which a request without it gets: the commands that changed something. denied, invalid or failed: the attempts that were refused or failed, which changed nothing and name no record. Commands that only read are in neither.',
    }),
  })
  .superRefine((query, context) => {
    if (query.member !== undefined && query.actorKind !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['actorKind'],
        message: 'Name one member, or a kind of actor: not both.',
        params: { code: 'member_with_actor_kind' },
      });
    if (
      query.from !== undefined &&
      query.before !== undefined &&
      Date.parse(query.before) <= Date.parse(query.from)
    )
      context.addIssue({
        code: 'custom',
        path: ['before'],
        message: 'End the range after it starts.',
        params: { code: 'empty_range' },
      });
  });
export type ListAuditQuery = z.output<typeof listAuditQuery>;

export const listAudit = defineEndpoint({
  operationId: 'listAudit',
  method: 'get',
  path: '/audit-log',
  summary: 'Read who changed what across the business, newest first',
  group: 'Audit log',
  query: listAuditQuery,
  response: {
    status: 200,
    description: `A page of the business's audit log, ${String(AUDIT_PAGE_SIZE)} entries unless limit says otherwise.`,
    schema: auditPage,
  },
});
