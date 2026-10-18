-- Settings → Users (tasks/users-page-design.md). What an agency keeps about a person on its
-- team: the name in two parts, a phone, a picture and an email signature. It is the
-- agency's, not the sign-in account's: a person can belong to two agencies on one install,
-- and neither may rewrite what the other sees. auth.users stays as it is, written only by
-- crm_auth.

create table tenancy.user_profiles (
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  first_name text not null default '' constraint user_profiles_first_name_length
    check (length(first_name) <= 100),
  last_name text not null default '' constraint user_profiles_last_name_length
    check (length(last_name) <= 100),
  phone_e164 text constraint user_profiles_phone_e164 check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- An extension is dialled after the number answers; it means nothing without one.
  phone_extension text constraint user_profiles_extension_digits
    check (phone_extension ~ '^[0-9]{1,10}$'),
  avatar_file_id uuid,
  -- The signature as a note document (contracts note-text.ts): what the app edits and
  -- renders without trusting any markup.
  signature jsonb constraint user_profiles_signature_object
    check (signature is null or (jsonb_typeof(signature) = 'object' and pg_column_size(signature) <= 20000)),
  signature_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (agency_id, user_id),
  constraint user_profiles_extension_needs_phone check (phone_extension is null or phone_e164 is not null),
  constraint user_profiles_avatar_owner foreign key (agency_id, avatar_file_id)
    references files.files (agency_id, id) on delete set null (avatar_file_id)
);
create index user_profiles_user_idx on tenancy.user_profiles (user_id);
create index user_profiles_avatar_idx on tenancy.user_profiles (agency_id, avatar_file_id);
call util.add_updated_at_trigger('tenancy.user_profiles');
call util.enable_agency_rls('tenancy.user_profiles');
grant select, insert, update on tenancy.user_profiles to crm_app;

-- "Add user" sends an invitation that carries the person's details; they become the
-- profile when the invitation is accepted. Keys: firstName, lastName, phone, extension,
-- avatarFileId and calendarId (stored ids), signature, signatureEnabled.
alter table tenancy.invitations
  add column profile jsonb not null default '{}' constraint invitations_profile_object
    check (jsonb_typeof(profile) = 'object' and pg_column_size(profile) <= 24000);

-- The calendar a person works from in a business, such as the one a new appointment of
-- theirs starts on. Only a membership of a business can have one.
alter table tenancy.memberships
  add column default_calendar_id uuid,
  add constraint memberships_default_calendar_owner foreign key (business_id, default_calendar_id)
    references calendar.calendars (business_id, id) on delete set null (default_calendar_id);
create index memberships_default_calendar_idx
  on tenancy.memberships (business_id, default_calendar_id)
  where default_calendar_id is not null;

-- Accepting an invitation makes the invited person's profile from what the invitation
-- carries, in the transaction that makes their membership. A profile the agency already
-- keeps for the person stays as it is. A picture or a calendar that has gone since the
-- invitation was sent is left out rather than failing the acceptance.
create function private.apply_invitation_profile(p_invitation_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_invitation tenancy.invitations%rowtype;
  v_profile jsonb;
begin
  select * into v_invitation from tenancy.invitations where id = p_invitation_id;
  if not found or v_invitation.profile = '{}'::jsonb then
    return;
  end if;
  v_profile := v_invitation.profile;
  insert into tenancy.user_profiles
    (agency_id, user_id, first_name, last_name, phone_e164, phone_extension, avatar_file_id,
     signature, signature_enabled)
  values (
    v_invitation.agency_id, p_user_id,
    coalesce(v_profile ->> 'firstName', ''), coalesce(v_profile ->> 'lastName', ''),
    v_profile ->> 'phone',
    case when v_profile ->> 'phone' is not null then v_profile ->> 'extension' end,
    (select f.id from files.files f
      where f.agency_id = v_invitation.agency_id and f.deleted_at is null
        and f.id::text = v_profile ->> 'avatarFileId'),
    case when pg_catalog.jsonb_typeof(v_profile -> 'signature') = 'object'
      then v_profile -> 'signature' end,
    coalesce((v_profile ->> 'signatureEnabled')::boolean, false))
  on conflict (agency_id, user_id) do nothing;
  if v_invitation.business_id is not null then
    update tenancy.memberships m
    set default_calendar_id = c.id
    from calendar.calendars c
    where m.user_id = p_user_id and m.agency_id = v_invitation.agency_id
      and m.business_id = v_invitation.business_id
      and c.business_id = v_invitation.business_id and c.id::text = v_profile ->> 'calendarId';
  end if;
end
$$;
revoke execute on function private.apply_invitation_profile(uuid, uuid) from public;
-- crm_auth reaches this one function of the schema and no table behind it.
grant usage on schema private to crm_auth;
grant execute on function private.apply_invitation_profile(uuid, uuid) to crm_auth;
