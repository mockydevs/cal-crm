-- Saved views (task P1.22, ADR-035): a private view is its owner's alone.
--
-- tenant_isolation keeps businesses apart, but everyone in a business sees all of its rows.
-- These restrictive policies narrow saved views further. A view is visible and writable when
-- it's shared, or when it's the signed-in person's own and that person is acting themselves:
-- the command layer's rule for a signed-in person (actor kind user, and the actor is the
-- user). An API key, the system, and anything acting with a person's id on their behalf see
-- shared views only. A new view always belongs to the person writing it, so nobody can plant
-- a view on someone else, and someone else's shared view can't be made private.

create policy shared_or_own on crm.saved_views
  as restrictive
  for all
  using (
    visibility = 'shared'
    or (owner_user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id())))
  with check (
    visibility = 'shared'
    or (owner_user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id())));

create policy own_new_views on crm.saved_views
  as restrictive
  for insert
  with check (
    owner_user_id = (select app.user_id())
    and (select app.actor_kind()) = 'user'
    and (select app.actor_id()) = (select app.user_id()));
