-- Smart lists shared as GoHighLevel shares them: with everyone in the business or with
-- chosen team members, each able to view the list or also edit it, and the widths a
-- person dragged the list's columns to.
--
-- A view is 'private' (its owner's alone), 'shared' (everyone, at shared_access) or
-- 'selected' (the people in crm.saved_view_shares, each at their own access). Everyone and
-- chosen people are either-or. A shared list is the same list for all who see it: a change
-- by its owner or an editor is what everyone then opens.

alter table crm.saved_views
  drop constraint saved_views_visibility_valid,
  add constraint saved_views_visibility_valid
    check (visibility in ('private', 'shared', 'selected')),
  -- What everyone may do with a list shared with them all. Only such a list has a level of
  -- its own; any other keeps the default, so a view has one way of being written.
  add column shared_access text not null default 'view'
    constraint saved_views_shared_access_valid check (shared_access in ('view', 'edit')),
  add constraint saved_views_shared_access_for_everyone
    check (visibility = 'shared' or shared_access = 'view'),
  -- Column widths in pixels by column (a built-in key or a field id). The application
  -- checks keys and bounds; the table checks the shape. Null: no column was resized.
  add column column_widths jsonb
    constraint saved_views_column_widths_object
      check (column_widths is null or jsonb_typeof(column_widths) = 'object');

-- The people a 'selected' view is shared with, each once, at their access, since
-- created_at. A share goes with its view; a person is named by their user, as the view's
-- owner is.
create table crm.saved_view_shares (
  business_id uuid not null,
  view_id uuid not null,
  user_id uuid not null references auth.users (id),
  access text not null constraint saved_view_shares_access_valid check (access in ('view', 'edit')),
  created_at timestamptz not null default now(),
  primary key (business_id, view_id, user_id),
  foreign key (business_id, view_id) references crm.saved_views (business_id, id) on delete cascade
);
-- The views shared with a person, and the foreign key to the person.
create index saved_view_shares_user_idx on crm.saved_view_shares (user_id, business_id);
call util.enable_tenant_rls('crm.saved_view_shares');
grant select, insert, update, delete on crm.saved_view_shares to crm_app;

-- Whether a share still counts: the person is on the business's team (as its member or
-- its agency's) through a membership that already existed when the share was given.
-- Taken off the team, they lose the view at once; invited back, the old share stays
-- spent, and only sharing with them again gives it back. Answered only inside the
-- business acting.
create function private.saved_view_share_live(
  p_business_id uuid,
  p_user_id uuid,
  p_shared_at timestamptz
) returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_business_id = (select app.business_id()) and exists (
    select 1
    from tenancy.businesses b
    join tenancy.memberships m
      on m.agency_id = b.agency_id and (m.business_id = b.id or m.business_id is null)
    where b.id = p_business_id
      and m.user_id = p_user_id
      and m.created_at <= p_shared_at)
$$;

-- The access the signed-in person, acting themselves, has to a view by a share that still
-- counts, or null. It reads the shares past their own policy, which in turn asks whether
-- the view is visible: without this the two policies would ask each other.
create function private.saved_view_share_access(p_business_id uuid, p_view_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select s.access
  from crm.saved_view_shares s
  where s.business_id = p_business_id
    and s.business_id = (select app.business_id())
    and s.view_id = p_view_id
    and s.user_id = (select app.user_id())
    and (select app.actor_kind()) = 'user'
    and (select app.actor_id()) = (select app.user_id())
    and private.saved_view_share_live(s.business_id, s.user_id, s.created_at)
$$;

-- How many of an object's views the business shares, with everyone or by name, counted
-- past the views' own policy: the limit is the team's, whoever can see which of them.
create function private.shared_saved_view_count(p_object_type_id uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select count(*)
  from crm.saved_views v
  where v.business_id = (select app.business_id())
    and v.object_type_id = p_object_type_id
    and v.visibility <> 'private'
$$;
revoke execute on function private.saved_view_share_live(uuid, uuid, timestamptz) from public;
revoke execute on function private.saved_view_share_access(uuid, uuid) from public;
revoke execute on function private.shared_saved_view_count(uuid) from public;
grant execute on function private.saved_view_share_live(uuid, uuid, timestamptz) to crm_app;
grant execute on function private.saved_view_share_access(uuid, uuid) to crm_app;
grant execute on function private.shared_saved_view_count(uuid) to crm_app;

-- A view is seen when it is shared with everyone, when it is the signed-in person's own,
-- or when it is shared with them by name. It is changed or deleted by its owner, by
-- someone it is shared with by name to edit, or, shared with everyone, as before (the
-- application then holds who may). A new view is its writer's own (own_new_views).
drop policy shared_or_own on crm.saved_views;
create policy visible_views on crm.saved_views
  as restrictive
  for select
  using (
    visibility = 'shared'
    or (owner_user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id()))
    or (visibility = 'selected'
        and private.saved_view_share_access(business_id, id) is not null));
create policy changeable_views on crm.saved_views
  as restrictive
  for update
  using (
    visibility = 'shared'
    or (owner_user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id()))
    or (visibility = 'selected'
        and private.saved_view_share_access(business_id, id) = 'edit'))
  with check (
    visibility = 'shared'
    or (owner_user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id()))
    or (visibility = 'selected'
        and private.saved_view_share_access(business_id, id) = 'edit'));
create policy deletable_views on crm.saved_views
  as restrictive
  for delete
  using (
    visibility = 'shared'
    or (owner_user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id()))
    or (visibility = 'selected'
        and private.saved_view_share_access(business_id, id) = 'edit'));

-- Whether the signed-in person, acting themselves, may change who a view is shared with:
-- it is theirs, or they may edit it, by name or as everyone when it is shared with all to
-- edit. The application also asks for the permission to share views.
create function private.may_change_saved_view_shares(p_business_id uuid, p_view_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select app.actor_kind()) = 'user'
    and (select app.actor_id()) = (select app.user_id())
    and exists (
      select 1
      from crm.saved_views v
      where v.business_id = p_business_id
        and v.business_id = (select app.business_id())
        and v.id = p_view_id
        and (v.owner_user_id = (select app.user_id())
             or (v.visibility = 'shared' and v.shared_access = 'edit')
             or private.saved_view_share_access(v.business_id, v.id) = 'edit'))
$$;
revoke execute on function private.may_change_saved_view_shares(uuid, uuid) from public;
grant execute on function private.may_change_saved_view_shares(uuid, uuid) to crm_app;

-- A view's shares are seen by those who see the view, and written only by those who may
-- change who it is shared with.
create policy of_visible_views on crm.saved_view_shares
  as restrictive
  for select
  using (exists (
    select 1 from crm.saved_views v
    where v.business_id = saved_view_shares.business_id and v.id = saved_view_shares.view_id));
create policy added_by_view_editors on crm.saved_view_shares
  as restrictive
  for insert
  with check (private.may_change_saved_view_shares(business_id, view_id));
create policy changed_by_view_editors on crm.saved_view_shares
  as restrictive
  for update
  using (private.may_change_saved_view_shares(business_id, view_id))
  with check (private.may_change_saved_view_shares(business_id, view_id));
create policy removed_by_view_editors on crm.saved_view_shares
  as restrictive
  for delete
  using (private.may_change_saved_view_shares(business_id, view_id));
