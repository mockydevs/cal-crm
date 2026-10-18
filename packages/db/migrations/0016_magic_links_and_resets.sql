-- Magic links and password resets (task P1.02).

-- Better Auth keys some verification rows itself. To reserve a one-off clean-up lock, as
-- when a magic link first proves an address, it inserts an id that's a hash, not a uuid.
-- Nothing references these rows, so text ids cost nothing; new rows still get uuidv7()s.
alter table auth.verifications
  alter column id type text using id::text,
  alter column id set default uuidv7()::text;

-- A new password ends every link that could sign the person in without it:
-- password resets, whose value is the user's id, and magic links, whose value is JSON with
-- the email address. Better Auth stores their identifiers hashed (storeIdentifier), so they
-- are found by value. The database does this, so no way of changing a password skips it: a
-- reset, a change from the account page, or a first password.

create function auth.end_links_on_new_password() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_email text;
begin
  if new.password is null
     or (tg_op = 'UPDATE' and new.password is not distinct from old.password) then
    return null;
  end if;
  select email into v_email from auth.users where id = new.user_id;
  delete from auth.verifications v
  where v.value = new.user_id::text
     or case
          when pg_input_is_valid(v.value, 'jsonb') then lower(v.value::jsonb ->> 'email') = v_email
          else false
        end;
  return null;
end $$;
revoke execute on function auth.end_links_on_new_password() from public;

create trigger accounts_end_links_on_new_password
  after insert or update of password on auth.accounts
  for each row execute function auth.end_links_on_new_password();
