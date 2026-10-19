import { decodeTypeId, encodeTypeId } from './typeid.js';

// Every id comes from Postgres 18's uuidv7(). In a UUIDv7 the first 48 bits are the Unix
// time in milliseconds (RFC 9562, section 5.7), so ids sort by creation time.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The prefix for each kind of id the API shows, as in con_01h455vb4pex5vsknk084sn02q.
 * Prefixes are part of the public API: once released, a prefix never changes.
 */
export const publicIdPrefixes = {
  ai_connection: 'aic',
  ai_connection_test: 'aict',
  ai_request: 'aireq',
  api_key: 'key',
  assistant_message: 'amsg',
  assistant_thread: 'athr',
  assistant_turn: 'aturn',
  appointment: 'appt',
  audit_entry: 'aud',
  automation: 'aut',
  bulk_action: 'bulk',
  automation_version: 'aver',
  automation_test_run: 'atest',
  automation_enrolment: 'arun',
  automation_folder: 'afol',
  automation_step_run: 'astep',
  blocked_slot: 'blk',
  business: 'biz',
  calendar: 'cal',
  calendar_group: 'calg',
  contact: 'con',
  contact_fact: 'fact',
  contact_identity: 'cid',
  conversation: 'cvn',
  channel_account: 'chan',
  company: 'com',
  // A record of a custom object, as crm.records.kind names it; its object, and the
  // associations (link types) and relations (record links) between records.
  custom: 'rec',
  object_type: 'obj',
  link_type: 'asc',
  record_link: 'rel',
  custom_value: 'cval',
  custom_value_folder: 'cvf',
  deal: 'deal',
  draft_request: 'drq',
  event: 'evt',
  file: 'file',
  field: 'fld',
  field_folder: 'ffld',
  form: 'form',
  form_submission: 'fsub',
  import: 'imp',
  integration_connection: 'int',
  tag: 'tag',
  tag_group: 'tgrp',
  invitation: 'inv',
  membership: 'mem',
  message: 'msg',
  mailbox: 'mbx',
  mailbox_attempt: 'mtry',
  lost_reason: 'lrn',
  lead_source_rule: 'lsr',
  score_rule: 'srul',
  note: 'note',
  notification: 'ntf',
  role: 'role',
  pipeline: 'pipe',
  proposal: 'prop',
  stage: 'stage',
  task: 'task',
  template: 'tmpl',
  template_folder: 'tfld',
  saved_view: 'view',
  sms_connection: 'smsc',
  sms_attempt: 'smst',
  phone_number: 'phn',
  call: 'call',
  call_leg: 'cleg',
  call_recording: 'crec',
  voice_grant: 'vgr',
  webchat_widget: 'wcw',
  snippet: 'snip',
  snippet_folder: 'snf',
  trigger_link: 'tlnk',
  manual_action: 'mact',
  marketplace_app: 'mapp',
  marketplace_install: 'mins',
  marketplace_delivery: 'mdlv',
  site: 'site',
  site_folder: 'sfld',
  site_step: 'sstp',
  site_page: 'spg',
  site_template: 'stpl',
  site_section: 'ssec',
  site_domain: 'sdom',
  site_redirect: 'srdr',
  product: 'prod',
  sales_document: 'sdoc',
  sales_document_line: 'sdl',
  payment: 'pay',
  media_folder: 'mfld',
  report: 'rpt',
  email_campaign: 'camp',
  email_campaign_folder: 'cfld',
} as const;

export type PublicIdKind = keyof typeof publicIdPrefixes;

/** The id the API shows for a record: its kind's prefix and its UUIDv7, as a TypeID. */
export function toPublicId(kind: PublicIdKind, uuid: string): string {
  if (!isUuidV7(uuid)) {
    throw new TypeError(`Not a UUIDv7: ${uuid}`);
  }
  return encodeTypeId(publicIdPrefixes[kind], uuid);
}

/** The UUIDv7 inside a public id of this kind, or undefined if the value isn't one. */
export function parsePublicId(kind: PublicIdKind, value: string): string | undefined {
  const decoded = decodeTypeId(value);
  return decoded?.prefix === publicIdPrefixes[kind] && isUuidV7(decoded.uuid)
    ? decoded.uuid
    : undefined;
}

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

/** The moment a UUIDv7 was generated, to the millisecond. */
export function uuidV7Timestamp(id: string): Date {
  if (!isUuidV7(id)) {
    throw new TypeError(`Not a UUIDv7: ${id}`);
  }
  const unixMilliseconds = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return new Date(unixMilliseconds);
}
