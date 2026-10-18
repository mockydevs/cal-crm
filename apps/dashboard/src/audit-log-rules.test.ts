import { describe, expect, it } from 'vitest';
import { auditQueryOf, auditRangeBackwards, noAuditFilters, recordPlace } from './audit-log-rules';

describe('what the audit log filters ask for', () => {
  it('asks for everything that changed something when nothing is chosen', () => {
    expect(auditQueryOf(noAuditFilters, undefined)).toEqual({});
    expect(auditQueryOf(noAuditFilters, 'aud_1')).toEqual({ after: 'aud_1' });
  });

  it('names the person, the module, the action, one record and the outcome', () => {
    expect(
      auditQueryOf(
        {
          ...noAuditFilters,
          member: 'me',
          module: 'tasks',
          action: 'deleted',
          subject: '  con_01m4bd188ff82s0add91b7pz63 ',
          outcome: 'denied',
        },
        undefined,
      ),
    ).toEqual({
      member: 'me',
      module: 'tasks',
      action: 'deleted',
      subject: 'con_01m4bd188ff82s0add91b7pz63',
      outcome: 'denied',
    });
    expect(
      auditQueryOf({ ...noAuditFilters, subject: 'x'.repeat(150) }, undefined).subject,
    ).toHaveLength(100);
  });

  it('asks for a range of days up to the end of its last day, where the reader is', () => {
    const query = auditQueryOf(
      { ...noAuditFilters, from: '2026-10-01', to: '2026-10-31' },
      undefined,
    );
    expect(query).toEqual({
      from: new Date(2026, 9, 1).toISOString(),
      before: new Date(2026, 10, 1).toISOString(),
    });
    expect(auditQueryOf({ ...noAuditFilters, to: 'soon' }, undefined)).toEqual({});
    expect(auditRangeBackwards({ ...noAuditFilters, from: '2026-10-02', to: '2026-10-01' })).toBe(
      true,
    );
    expect(auditRangeBackwards({ ...noAuditFilters, from: '2026-10-01', to: '2026-10-01' })).toBe(
      false,
    );
    expect(auditRangeBackwards({ ...noAuditFilters, to: '2026-10-01' })).toBe(false);
  });
});

describe('the record an entry links to', () => {
  it('is a contact, company, opportunity or task that is still there', () => {
    expect(
      recordPlace({ kind: 'contact', id: 'con_1', name: 'Maya Thompson', exists: true }),
    ).toEqual({
      kind: 'contact',
      id: 'con_1',
      name: 'Maya Thompson',
    });
    expect(recordPlace({ kind: 'task', id: 'task_1', name: null, exists: true })?.kind).toBe(
      'task',
    );
    expect(recordPlace({ kind: 'deal', id: 'deal_1', name: 'Wedding', exists: true })?.kind).toBe(
      'deal',
    );
    expect(recordPlace({ kind: 'company', id: 'com_1', name: 'Harbor', exists: true })?.kind).toBe(
      'company',
    );
  });

  it('is nothing for a record that is gone, of another kind, or not one record', () => {
    expect(recordPlace(null)).toBeUndefined();
    expect(
      recordPlace({ kind: 'contact', id: 'con_1', name: null, exists: false }),
    ).toBeUndefined();
    expect(
      recordPlace({ kind: 'pipeline', id: 'pipe_1', name: null, exists: null }),
    ).toBeUndefined();
    expect(recordPlace({ kind: 'contact', id: null, name: null, exists: true })).toBeUndefined();
  });
});
