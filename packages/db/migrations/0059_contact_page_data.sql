-- The data the contact detail page reads and changes (tasks B2.01 to B2.04, ADR-068): who
-- follows a contact, a label on each of its phone numbers, do not
-- disturb for one channel at a time, and how the contact came to be. One new table; the
-- rest belongs to rows that already exist.

-- B2.01 Owner and followers -----------------------------------------------------------------
-- The owner is crm.contacts.owner_user_id (0005), which a command now sets. Followers are
-- the other people who want to hear about the contact: any number of team members, each
-- at most once. A follower is a person, not a membership, as an owner and a task's assignee
-- are: whether they are still on the team is asked of the tenancy module when it matters.
create table crm.contact_followers (
  business_id uuid not null,
  contact_id uuid not null,
  -- Users are never deleted (DATABASE.md section 2).
  user_id uuid not null references auth.users (id),
  added_by_kind text not null constraint contact_followers_added_by_kind_valid
    check (added_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  added_by_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, contact_id, user_id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade
);
comment on table crm.contact_followers is
  'The team members who follow a contact. The contact''s owner is crm.contacts.owner_user_id.';
-- "The contacts I follow", and the key to auth.users.
create index contact_followers_user_idx on crm.contact_followers (user_id, business_id);

call util.enable_tenant_rls('crm.contact_followers');
grant select, insert, delete on crm.contact_followers to crm_app;

-- B2.02 Labels on phone numbers ------------------------------------------------------------
-- What a number is for: one of the labels the application offers (the contract's
-- contactPhoneLabels: home, work, mobile, landline). Null: no label. The database holds the
-- form of a label and its two rules, not the list, so offering another label needs no
-- migration: only a phone number has one, and a contact uses each label once. Whether an
-- address can be delivered to is not stored here: messaging.suppressions says so (a hard
-- bounce, an invalid number), and verified_at stays null until something can honestly set it.
alter table crm.contact_identities
  add column label text
    constraint contact_identities_label_format
      check (label is null or label ~ '^[a-z][a-z_]{0,29}$'),
  add constraint contact_identities_label_phone_only
    check (label is null or kind = 'phone');
create unique index contact_identities_one_label_idx
  on crm.contact_identities (business_id, contact_id, label) where label is not null;

-- B2.03 Do not disturb, one channel at a time -----------------------------------------------
-- do_not_contact (0032) stops every channel. dnd_channels stops the channels it names and
-- leaves the others to consent, suppressions and quiet hours. The names are the outbound
-- pipeline's own (messaging.messages.channel and messaging.consents.channel), so a channel
-- that is not built yet can be switched off before it exists. The application stores the
-- list sorted and without repeats; a repeat would change nothing the send check reads.
alter table crm.contacts
  add column dnd_channels text[] not null default '{}'
    constraint contacts_dnd_channels_valid
      check (dnd_channels <@ array['call', 'email', 'sms', 'webchat', 'whatsapp']::text[]
             and cardinality(dnd_channels) <= 5);

-- B2.04 Where a contact came from -----------------------------------------------------------
-- created_by_kind says who or what acted; for mail, a text message, a web chat and a
-- booking that is the system or the contact, which does not say which of them it was. This
-- says how the contact came to be, set once by the command that makes it.
alter table crm.contacts
  add column created_source text not null default 'unknown'
    constraint contacts_created_source_valid
      check (created_source in ('user', 'api', 'form', 'booking', 'import', 'email', 'sms',
                                'webchat', 'automation', 'assistant', 'unknown'));

-- Existing contacts: the actor kind settles it for six of the eight kinds. For the other
-- two the command that made the contact is read from the audit log, which names the events
-- each command wrote, where that month of the log is still kept. A contact with neither is
-- left as unknown: nothing is guessed. This is not an edit of the contact.
alter table crm.contacts disable trigger touch_updated_at;

update crm.contacts c
set created_source = case c.created_by_kind
  when 'user' then 'user'
  when 'api_key' then 'api'
  when 'form' then 'form'
  when 'import' then 'import'
  when 'automation' then 'automation'
  when 'ai_agent' then 'assistant'
  else 'unknown'
end;

-- An audit row and the events of its command are written in one transaction, so they carry
-- the same recorded_at: the join reads one index range of each for every contact.
update crm.contacts c
set created_source = made.source
from (
  select e.business_id, e.subject_id as contact_id,
    case a.command
      when 'mailbox.ingest_inbound' then 'email'
      when 'sms.receive' then 'sms'
      when 'webchat.send_message' then 'webchat'
      when 'calendar.public.book' then 'booking'
    end as source
  from events.events e
  join audit.commands a
    on a.agency_id = e.agency_id and a.business_id = e.business_id
   and a.recorded_at = e.recorded_at and e.id = any (a.event_ids)
  where e.type = 'contact.created' and e.subject_kind = 'contact'
) made
where c.created_by_kind in ('system', 'contact')
  and made.business_id = c.business_id and made.contact_id = c.id
  and made.source is not null;

alter table crm.contacts enable trigger touch_updated_at;
