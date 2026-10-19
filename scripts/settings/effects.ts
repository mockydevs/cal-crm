// What each setting does, and the test that proves it: the test changes the setting and sees
// the CRM behave differently. A setting that is saved and shown but changes nothing is a gap,
// listed with its reason, until code acts on it and a test proves that. `pnpm run
// settings:check` holds every column of every settings table to this list.
import type { Effects } from './audit.ts';

const proof = (file: string, test: string) => ({ proof: { file, test } });

const AI = 'packages/modules/ai/src/gateway.int.test.ts';
const DOCUMENTS = 'packages/modules/commerce/src/documents.int.test.ts';
const OWNERS = 'packages/modules/crm/src/pipelines/settings.int.test.ts';
const OUTBOUND = 'packages/modules/messaging/src/outbound.int.test.ts';
const TRACKING = 'packages/modules/forms/src/tracking/tracking.int.test.ts';

const INBOUND_CALL = 'packages/modules/messaging/src/voice/inbound-call.int.test.ts';
const INBOUND_ADVANCE = 'packages/modules/messaging/src/voice/inbound-advance.int.test.ts';
const MISSED_CALL = 'packages/modules/messaging/src/voice/missed-call.int.test.ts';
const RECORDING_RETENTION = 'packages/modules/messaging/src/voice/recording-retention.int.test.ts';
const CALL_HANDLING =
  'Nothing reads it yet: call connect, whisper and the outbound caller ID are not built yet.';
const RECORDING =
  'Nothing reads it yet: call recording, voicemail and transcripts are not built yet.';

export const effects: Effects = {
  'ai.settings': {
    enabled: proof(AI, 'calls nobody for a business that turned AI off'),
    key_source: proof(AI, 'uses the agency’s key or the business’s own, as the business chose'),
    monthly_limit: proof(
      AI,
      'pauses AI work once the month’s spend reaches it, without calling anyone',
    ),
    at_limit: proof(
      AI,
      'keeps going past the limit when the business chose that, and still tells the owner',
    ),
    mask_contact_details: proof(
      AI,
      'hides phone numbers and email addresses from the provider when the business asks',
    ),
    request_log_days: proof(
      AI,
      'keeps no log when the business keeps none, and keeps one for as long as it says',
    ),
    backup_provider: proof(
      AI,
      'takes over when the main model fails, and both calls are on record',
    ),
    backup_model: proof(AI, 'takes over when the main model fails, and both calls are on record'),
    limit_reached_at: {
      notASetting:
        'When the month’s spend reached the limit: the gateway writes it, nobody chooses it.',
    },
  },
  'commerce.settings': {
    payment_terms_days: proof(
      DOCUMENTS,
      'issues a draft: its number, its dates, who it is from and for, and nothing sent',
    ),
    quote_validity_days: proof(
      'packages/modules/commerce/src/rules.test.ts',
      'are today and the quote validity after it for a quote that names none',
    ),
    default_notes: proof(
      DOCUMENTS,
      'starts a draft with its totals worked out, the contact as they are and the default wording',
    ),
    default_terms: proof(
      DOCUMENTS,
      'starts a draft with its totals worked out, the contact as they are and the default wording',
    ),
    payment_instructions: proof(
      DOCUMENTS,
      'issues a draft: its number, its dates, who it is from and for, and nothing sent',
    ),
    tax_number: proof(
      DOCUMENTS,
      'issues a draft: its number, its dates, who it is from and for, and nothing sent',
    ),
    default_tax_rate: proof(
      'apps/dashboard/src/payments-rules.test.ts',
      'takes a line from a product, with the default tax rate when it has none',
    ),
  },
  'crm.settings': {
    tag_creation: proof(
      'packages/modules/crm/src/tags/configuration.int.test.ts',
      'enforces the default admin creation policy for empty and populated businesses',
    ),
    suggest_similar_tags: proof(
      'apps/dashboard/e2e/tag-management.spec.ts',
      'groups, describes and edits tags and rules at ${String(width)}px',
    ),
    trash_retention_days: proof(
      'packages/modules/crm/src/trash/trash.int.test.ts',
      "purges only what has been in the trash past its business's retention days",
    ),
    deal_owner_follows_contact: proof(
      OWNERS,
      "make a deal's new owner a follower of its primary contact only while that rule is on",
    ),
    contact_owner_follows_deal: proof(
      OWNERS,
      "make a contact's new owner a follower of the open deals it is the primary contact of only while that rule is on",
    ),
    deal_owner_differs: {
      gap: 'Saved and shown in the opportunity settings, but no code acts on it: a deal’s owner may differ from its contact’s whether it is on or off.',
    },
    duplicate_primary: proof(
      'packages/modules/crm/src/contacts/duplicate-settings.int.test.ts',
      'starts with the phone number when it is the primary field',
    ),
    duplicate_secondary: proof(
      'packages/modules/crm/src/contacts/duplicate-settings.int.test.ts',
      'tries the phone number after the email address when phone is the secondary field',
    ),
  },
  // Settings → External Tracking.
  'forms.tracking_settings': {
    tracking_id: proof(
      TRACKING,
      'gives a new tracking id on request, and the old one stops at once',
    ),
    page_views: proof(
      TRACKING,
      'is not kept when page views are off, and still proves the page was shown',
    ),
    form_capture: proof(TRACKING, 'is not taken when form capture is off'),
    allowed_domains: proof(
      TRACKING,
      'answers any secure website until the business lists some, then those and their subdomains',
    ),
    visitor_ids: proof(
      TRACKING,
      'keeps no visitor id for a browser that asks not to be tracked, unless told to',
    ),
  },
  'messaging.settings': {
    email_verification_enabled: proof(
      'packages/modules/messaging/src/email-verification-task.int.test.ts',
      'turning verification off allows unchecked addresses without a provider call',
    ),
    email_reverify_after_90_days: proof(
      'packages/modules/messaging/src/email-verification-task.int.test.ts',
      'turning re-verification off keeps a result older than ninety days usable',
    ),
    email_verification_daily_limit: proof(
      'packages/modules/messaging/src/email-verification-task.int.test.ts',
      'over the daily limit runs free domain checks and schedules the next business day',
    ),
    quiet_hours_enabled: proof(
      'packages/modules/messaging/src/quiet-hours-settings.int.test.ts',
      'counts what quiet hours hold now, and lets them go at the next check once turned off',
    ),
    quiet_hours_start: proof(
      OUTBOUND,
      'uses the contact local time for an interval %s the current hour',
    ),
    quiet_hours_end: proof(
      OUTBOUND,
      'uses the contact local time for an interval %s the current hour',
    ),
    contact_daily_limit: proof(
      OUTBOUND,
      'counts reservations atomically so two distinct queued messages cannot exceed the contact cap',
    ),
    campaign_daily_limit: proof(
      'packages/modules/messaging/src/campaigns.int.test.ts',
      'says when the limits spread a send over days',
    ),
  },
  'messaging.phone_system_settings': {
    default_phone_number_id: proof(
      'packages/modules/messaging/src/call-lifecycle.int.test.ts',
      'stores a requested call from the default number, queues the worker once, and answers a retry with the same call',
    ),
    inbound_prefer_assigned_user: proof(
      INBOUND_CALL,
      'rings the assigned number owner first when inbound_prefer_assigned_user is on, and skips them when off',
    ),
    inbound_allow_anonymous: proof(
      INBOUND_CALL,
      'allows anonymous callers when inbound_allow_anonymous is on, and hangs up when off',
    ),
    inbound_fallback_e164: proof(
      INBOUND_CALL,
      'adds the business fallback number to the route when set, and not when cleared',
    ),
    outbound_caller_id: { gap: CALL_HANDLING },
    outbound_quiet_hours_warning: {
      gap: 'Nothing reads it yet: placing a call does not warn about the contact’s quiet hours.',
    },
    outbound_connect_agent: { gap: RECORDING },
    recording_retention_days: proof(
      RECORDING_RETENTION,
      'deletes a recording older than the business keeps them, from the provider and its files',
    ),
    transcription_enabled: { gap: RECORDING },
    missed_call_text_enabled: proof(
      MISSED_CALL,
      'sends nothing when the missed-call text is off, or its message is empty',
    ),
    missed_call_text: proof(MISSED_CALL, 'texts a contact back once after their call rang out'),
  },
  'messaging.phone_number_settings': {
    phone_number_id: { notASetting: 'The number these settings belong to: part of the key.' },
    owner_user_id: proof(
      INBOUND_CALL,
      'rings the number owner when owner_user_id is set, and skips them when null',
    ),
    primary_user_id: proof(
      INBOUND_CALL,
      'rings the primary user set on the number, and changes when primary_user_id changes',
    ),
    ring_also_user_ids: proof(
      INBOUND_CALL,
      'rings additional team members in parallel when ring_also_user_ids is set, and not when empty',
    ),
    forward_to_e164: proof(
      INBOUND_CALL,
      'rings the outside number set to forward to, and not when it is cleared',
    ),
    use_business_fallback: proof(
      INBOUND_CALL,
      'falls back to the business number when use_business_fallback is on, and not when off',
    ),
    ring_timeout_seconds: proof(
      INBOUND_CALL,
      'changes the dial timeout when ring_timeout_seconds changes',
    ),
    voicemail_backup: proof(
      INBOUND_ADVANCE,
      'takes a voicemail after the last step when voicemail backup is on',
    ),
    forwarded_caller_id: proof(
      INBOUND_CALL,
      'uses caller or business number as callerId when forwarded_caller_id changes',
    ),
    prefer_contact_owner: proof(
      INBOUND_CALL,
      'rings the contact owner first when prefer_contact_owner is on, and not when off',
    ),
    call_connect_confirmation: { gap: CALL_HANDLING },
    whisper_enabled: { gap: CALL_HANDLING },
    whisper_message: { gap: CALL_HANDLING },
    recording_enabled: proof(
      INBOUND_CALL,
      'records the call and announces it when the number records',
    ),
    recording_announcement_enabled: proof(
      INBOUND_CALL,
      'neither records nor announces when recording is off',
    ),
    recording_announcement: proof(
      INBOUND_CALL,
      'records the call and announces it when the number records',
    ),
  },
};
