import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parsePublicId, publicIdPrefixes, toPublicId, type PublicIdKind } from './index.js';

const kinds = Object.keys(publicIdPrefixes) as PublicIdKind[];
const uuidV7 = fc.uuid({ version: 7 });

describe('public ids', () => {
  it.each([
    ['form', 'form'],
    ['lost_reason', 'lrn'],
    ['appointment', 'appt'],
  ] as const)('gives %s a permanent id with tenant-record kind isolation', (kind, prefix) => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    const id = `${prefix}_01h455vb4pex5vsknk084sn02q`;
    expect(toPublicId(kind, uuid)).toBe(id);
    expect(parsePublicId(kind, id)).toBe(uuid);
    expect(parsePublicId(kind, 'con_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
    expect(parsePublicId('contact', id)).toBeUndefined();
  });
  it.each([
    ['automation', 'aut'],
    ['automation_version', 'aver'],
    ['automation_test_run', 'atest'],
    ['automation_enrolment', 'arun'],
    ['automation_folder', 'afol'],
    ['automation_step_run', 'astep'],
  ] as const)('keeps %s ids distinct from contact ids', (kind, prefix) => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    const id = `${prefix}_01h455vb4pex5vsknk084sn02q`;
    expect(toPublicId(kind, uuid)).toBe(id);
    expect(parsePublicId(kind, id)).toBe(uuid);
    expect(parsePublicId(kind, 'con_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
    expect(parsePublicId('contact', id)).toBeUndefined();
  });

  it.each([
    ['custom', 'rec'],
    ['object_type', 'obj'],
    ['link_type', 'asc'],
    ['record_link', 'rel'],
  ] as const)('gives custom objects, their records and associations %s ids', (kind, prefix) => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    const id = `${prefix}_01h455vb4pex5vsknk084sn02q`;
    expect(toPublicId(kind, uuid)).toBe(id);
    expect(parsePublicId(kind, id)).toBe(uuid);
    expect(parsePublicId('contact', id)).toBeUndefined();
  });

  it('turn back into the same UUIDv7, for every kind', () => {
    fc.assert(
      fc.property(fc.constantFrom(...kinds), uuidV7, (kind, uuid) => {
        expect(parsePublicId(kind, toPublicId(kind, uuid))).toBe(uuid);
      }),
    );
  });

  it('look like the documented con_… form', () => {
    expect(toPublicId('contact', '01890a5d-ac96-774b-bcce-b302099a8057')).toBe(
      'con_01h455vb4pex5vsknk084sn02q',
    );
  });

  it('gives notes and tasks distinct permanent public ids', () => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    expect(toPublicId('note', uuid)).toBe('note_01h455vb4pex5vsknk084sn02q');
    expect(toPublicId('task', uuid)).toBe('task_01h455vb4pex5vsknk084sn02q');
    expect(parsePublicId('note', 'task_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
  });

  it('gives saved views a distinct permanent public id', () => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    expect(toPublicId('saved_view', uuid)).toBe('view_01h455vb4pex5vsknk084sn02q');
    expect(parsePublicId('saved_view', 'view_01h455vb4pex5vsknk084sn02q')).toBe(uuid);
    expect(parsePublicId('saved_view', 'task_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
    expect(parsePublicId('task', 'view_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
  });

  it('gives calendars a permanent ID distinct from contacts', () => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    expect(toPublicId('calendar', uuid)).toBe('cal_01h455vb4pex5vsknk084sn02q');
    expect(parsePublicId('calendar', 'cal_01h455vb4pex5vsknk084sn02q')).toBe(uuid);
    expect(parsePublicId('calendar', 'con_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
  });

  it('gives message templates permanent ids distinct from contacts', () => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    expect(toPublicId('template', uuid)).toBe('tmpl_01h455vb4pex5vsknk084sn02q');
    expect(parsePublicId('template', 'tmpl_01h455vb4pex5vsknk084sn02q')).toBe(uuid);
    expect(parsePublicId('template', 'con_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
    expect(parsePublicId('contact', 'tmpl_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
  });

  it('sort in the same order as the UUIDv7s they hold, so by creation time', () => {
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    fc.assert(
      fc.property(uuidV7, uuidV7, (first, second) => {
        expect(compare(toPublicId('contact', first), toPublicId('contact', second))).toBe(
          compare(first, second),
        );
      }),
    );
  });

  it('gives notifications a permanent id distinct from notes and contacts', () => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    expect(toPublicId('notification', uuid)).toBe('ntf_01h455vb4pex5vsknk084sn02q');
    expect(parsePublicId('notification', 'ntf_01h455vb4pex5vsknk084sn02q')).toBe(uuid);
    expect(parsePublicId('notification', 'note_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
    expect(parsePublicId('contact', 'ntf_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
  });

  it('gives bulk actions a permanent id distinct from deals', () => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    expect(toPublicId('bulk_action', uuid)).toBe('bulk_01h455vb4pex5vsknk084sn02q');
    expect(parsePublicId('bulk_action', 'bulk_01h455vb4pex5vsknk084sn02q')).toBe(uuid);
    expect(parsePublicId('bulk_action', 'deal_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
    expect(parsePublicId('deal', 'bulk_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
  });

  it('gives audit log entries a permanent id distinct from automations and events', () => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    expect(toPublicId('audit_entry', uuid)).toBe('aud_01h455vb4pex5vsknk084sn02q');
    expect(parsePublicId('audit_entry', 'aud_01h455vb4pex5vsknk084sn02q')).toBe(uuid);
    expect(parsePublicId('audit_entry', 'aut_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
    expect(parsePublicId('event', 'aud_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
  });

  it('only parse as their own kind', () => {
    const deal = toPublicId('deal', '01890a5d-ac96-774b-bcce-b302099a8057');

    expect(parsePublicId('contact', deal)).toBeUndefined();
  });

  it.each([
    // The spec's valid-alphabet vector: a TypeID, but of a version 5 UUID.
    ['a UUID of another version', 'con_0123456789abcdefghjkmnpqrs'],
    ['a TypeID with no prefix', '01h455vb4pex5vsknk084sn02q'],
    ['something else', 'con_not-an-id'],
  ])('refuse %s', (_case, value) => {
    expect(parsePublicId('contact', value)).toBeUndefined();
  });

  it('are only made from UUIDv7s', () => {
    expect(() => toPublicId('contact', '5f0c9e3a-8b1d-4c2e-9f3a-1b2c3d4e5f60')).toThrow(TypeError);
  });
});
