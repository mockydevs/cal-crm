-- A round-robin calendar carries on with whoever is still on the team.
--
-- 0040's resolver refused a calendar as soon as any one of its members had left the
-- business or been disabled. That is right for a personal calendar, which is one person.
-- For a round-robin calendar it took the whole booking page down because one of several
-- hosts left. Now a round-robin calendar resolves while at least one of its members is
-- still a current member of the business; the booking handlers offer and assign only
-- those. A personal calendar still needs its one member.
--
-- Nothing else changes: the same arguments, the same three ids, the same owner and
-- grants (a replaced function keeps its privileges; they are restated for the reader).
create or replace function private.resolve_calendar(p_agency_slug text, p_business_slug text, p_calendar_slug text)
returns table (agency_id uuid, business_id uuid, calendar_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, c.business_id, c.id
  from calendar.calendars c
  join tenancy.businesses b on b.id=c.business_id
  join tenancy.agencies g on g.id=b.agency_id
  join messaging.channel_accounts a on a.business_id=c.business_id and a.id=c.confirmation_account_id
  join messaging.mailboxes m on m.business_id=a.business_id and m.id=a.id
  cross join lateral (
    select count(*) as stored,
      count(*) filter (where exists (
        select from tenancy.memberships tm join auth.users u on u.id=tm.user_id
        where tm.agency_id=b.agency_id and tm.business_id=c.business_id
          and tm.user_id=cm.user_id and u.disabled_at is null
      )) as present
    from calendar.calendar_members cm
    where cm.business_id=c.business_id and cm.calendar_id=c.id
  ) members
  where g.slug=p_agency_slug and b.slug=p_business_slug and c.booking_slug=p_calendar_slug
    and p_agency_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    and p_business_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    and p_calendar_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    and b.status='active' and c.is_active and c.kind in ('personal','round_robin')
    and a.channel='email' and a.status='active' and m.use_for_conversations
    and case when c.kind='personal'
      then members.stored=1 and members.present=1
      else members.stored between 1 and 100 and members.present>=1 end
$$;
revoke execute on function private.resolve_calendar(text,text,text) from public;
grant execute on function private.resolve_calendar(text,text,text) to crm_app;
