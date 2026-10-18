import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  apiKeyScopes,
  AUDIT_PAGE_SIZE,
  auditActionOf,
  auditActionVerbs,
  auditListEntry,
  auditLog,
  auditModuleNames,
  auditModuleOf,
  auditModules,
  auditPage,
  listAudit,
  listAuditQuery,
  MAX_AUDIT_PAGE_SIZE,
  auditOutcomes,
  endpoints,
  listRecordAudit,
  listRecordAuditQuery,
  parseInput,
  permissionCatalog,
} from './index.js';

const UUID = '01890a5d-ac96-774b-bcce-b302099a8057';

describe("a record's audit log", () => {
  it('is read for a contact, a company or a deal, a page after an entry', () => {
    expect(endpoints).toContain(listRecordAudit);
    expect(listRecordAudit).toMatchObject({ method: 'get', path: '/records/{id}/audit-log' });
    for (const kind of ['contact', 'company', 'deal'] as const)
      expect(parseInput(listRecordAudit.params, { id: toPublicId(kind, UUID) }).id).toMatch(/_/);
    expect(() => parseInput(listRecordAudit.params, { id: toPublicId('tag', UUID) })).toThrow();
    const after = toPublicId('audit_entry', UUID);
    expect(parseInput(listRecordAuditQuery, { after })).toEqual({ after });
    expect(parseInput(listRecordAuditQuery, {})).toEqual({});
    expect(() => parseInput(listRecordAuditQuery, { after: toPublicId('event', UUID) })).toThrow();
  });

  it('parses as the server answers it, with the outcomes the table allows', () => {
    expect(auditOutcomes).toEqual(['ok', 'denied', 'invalid', 'failed']);
    const entry = {
      id: toPublicId('audit_entry', UUID),
      at: '2026-10-07T09:30:00.000Z',
      command: 'contact.update',
      outcome: 'ok',
      errorCode: null,
      actor: { kind: 'user', name: 'Dana Brooks', you: true },
      proposed: false,
      events: [{ id: toPublicId('event', UUID), type: 'contact.updated' }],
      detail: { doNotContact: true, doNotContactReason: 'Asked by phone.' },
    };
    const log = { items: [entry], next: entry.id };
    expect(auditLog.parse(log)).toEqual(log);
    expect(() => auditLog.parse({ items: [{ ...entry, outcome: 'maybe' }], next: null })).toThrow();
  });

  it('is guarded by a permission of the business that no API key can hold', () => {
    expect(permissionCatalog['audit.read'].scope).toBe('business');
    expect(apiKeyScopes).not.toContain('audit.read');
  });
});

describe("the business's audit log", () => {
  it('is one endpoint, read a page at a time with the filters the screen has', () => {
    expect(endpoints).toContain(listAudit);
    expect(listAudit).toMatchObject({
      operationId: 'listAudit',
      method: 'get',
      path: '/audit-log',
      group: 'Audit log',
    });
    expect([AUDIT_PAGE_SIZE, MAX_AUDIT_PAGE_SIZE]).toEqual([50, 100]);
    expect(parseInput(listAuditQuery, {})).toEqual({ outcome: 'ok' });
    const after = toPublicId('audit_entry', UUID);
    const member = toPublicId('membership', UUID);
    const subject = toPublicId('task', UUID);
    expect(
      parseInput(listAuditQuery, {
        after,
        limit: '100',
        member,
        module: 'tasks',
        action: 'deleted',
        subject: ` ${subject} `,
        from: '2026-10-01T00:00:00+03:00',
        before: '2026-10-11T00:00:00+03:00',
        outcome: 'denied',
      }),
    ).toEqual({
      after,
      limit: 100,
      member,
      module: 'tasks',
      action: 'deleted',
      subject,
      from: '2026-10-01T00:00:00+03:00',
      before: '2026-10-11T00:00:00+03:00',
      outcome: 'denied',
    });
    expect(parseInput(listAuditQuery, { member: 'me' }).member).toBe('me');
    expect(parseInput(listAuditQuery, { actorKind: 'automation' }).actorKind).toBe('automation');
    for (const wrong of [
      { limit: '0' },
      { limit: '101' },
      { limit: '1.5' },
      { after: toPublicId('event', UUID) },
      { member: toPublicId('contact', UUID) },
      { member: 'me', actorKind: 'user' },
      { actorKind: 'robot' },
      { module: 'other' },
      { module: 'billing' },
      { action: 'viewed' },
      { subject: '' },
      { from: '2026-10-01' },
      { from: '2026-10-02T00:00:00Z', before: '2026-10-02T00:00:00Z' },
      { from: '2026-10-02T00:00:00Z', before: '2026-10-01T00:00:00Z' },
      { outcome: 'all' },
      { recordId: subject },
    ])
      expect(listAuditQuery.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    const issues = (query: object) =>
      listAuditQuery.safeParse(query).error?.issues.map((issue) => issue.path.join('/'));
    expect(issues({ member: 'me', actorKind: 'user' })).toEqual(['actorKind']);
    expect(issues({ from: '2026-10-02T00:00:00Z', before: '2026-10-01T00:00:00Z' })).toEqual([
      'before',
    ]);
  });

  it("reads a command's module from its first word and its action from its last", () => {
    for (const [command, module, action] of [
      ['contact.create', 'contacts', 'created'],
      ['contact.update', 'contacts', 'updated'],
      ['contact.set_dnd', 'contacts', 'updated'],
      ['contact.trash', 'contacts', 'deleted'],
      ['contact.restore', 'contacts', 'restored'],
      ['contact.bulk.apply_batch', 'contacts', 'updated'],
      ['contact_fact.remember', 'contacts', 'created'],
      ['company.create', 'companies', 'created'],
      ['deal.bulk', 'opportunities', 'updated'],
      ['pipelines.save', 'opportunities', 'updated'],
      ['pipeline.duplicate', 'opportunities', 'created'],
      ['task.complete', 'tasks', 'updated'],
      ['task.delete', 'tasks', 'deleted'],
      ['task.bulk', 'tasks', 'updated'],
      ['note.create', 'notes', 'created'],
      ['tag.assign', 'tags', 'updated'],
      ['tag_group.create', 'tags', 'created'],
      ['field.delete', 'custom_fields', 'deleted'],
      ['custom_value.delete_many', 'custom_values', 'deleted'],
      ['conversation.reply', 'conversations', 'updated'],
      ['template.archive', 'conversations', 'deleted'],
      ['calendar.public.book', 'calendars', 'created'],
      ['automation.publish', 'automations', 'updated'],
      ['automation.delete_folder', 'automations', 'deleted'],
      ['forms.create', 'forms', 'created'],
      ['import.start', 'imports', 'created'],
      ['team.invite', 'team', 'created'],
      ['team.remove_member', 'team', 'deleted'],
      ['api_key.revoke', 'team', 'deleted'],
      ['ai.set_autonomy', 'assistant', 'updated'],
      ['business.update_profile', 'settings', 'updated'],
      ['record.purge', 'trash', 'deleted'],
      ['billing.charge', 'other', 'updated'],
      ['nonsense', 'other', 'updated'],
      ['', 'other', 'updated'],
    ] as const) {
      expect(auditModuleOf(command), command).toBe(module);
      expect(auditActionOf(command), command).toBe(action);
    }
  });

  it('puts each first word in one module and each last word in one action', () => {
    const words = Object.values(auditModules).flat();
    expect(new Set(words).size).toBe(words.length);
    const verbs = Object.values(auditActionVerbs).flat();
    expect(new Set(verbs).size).toBe(verbs.length);
    expect(auditModuleNames).toEqual(Object.keys(auditModules));
    for (const word of [...words, ...verbs]) expect(word).toMatch(/^[a-z][a-z_]*$/);
  });

  it('answers each entry as the record log does, with what the command was about', () => {
    const entry = {
      id: toPublicId('audit_entry', UUID),
      at: '2026-10-07T09:30:00.000Z',
      command: 'task.complete',
      outcome: 'ok',
      errorCode: null,
      actor: { kind: 'user', name: 'Dana Brooks', you: true },
      proposed: false,
      events: [{ id: toPublicId('event', UUID), type: 'task.completed' }],
      detail: {},
      module: 'tasks',
      action: 'updated',
      record: { kind: 'task', id: toPublicId('task', UUID), name: 'Call Maya', exists: true },
      recordCount: 1,
    };
    const page = { items: [entry], next: null };
    expect(auditPage.parse(page)).toEqual(page);
    for (const record of [
      null,
      { kind: 'pipeline', id: toPublicId('pipeline', UUID), name: null, exists: null },
      { kind: 'webchat_session', id: null, name: null, exists: null },
      { kind: 'task', id: toPublicId('task', UUID), name: null, exists: false },
    ])
      expect(auditListEntry.parse({ ...entry, record }).record).toEqual(record);
    expect(auditListEntry.parse({ ...entry, module: 'other' }).module).toBe('other');
    for (const wrong of [
      { ...entry, module: 'billing' },
      { ...entry, action: 'viewed' },
      { ...entry, recordCount: -1 },
      { ...entry, record: { kind: 'task', id: null, name: null } },
      { ...entry, outcome: 'maybe' },
    ])
      expect(auditListEntry.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
  });
});
