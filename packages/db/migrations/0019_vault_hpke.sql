-- The secrets vault, sealed for the worker with HPKE (task P1.27, ADR-019). A sealed
-- secret keeps HPKE's encapsulated key (enc: an X25519 public key, 32 bytes) instead of
-- the symmetric design's 12-byte nonce, which nothing had used yet.
alter table vault.secrets drop constraint secrets_nonce_length;
alter table vault.secrets rename column nonce to enc;
alter table vault.secrets
  add constraint secrets_enc_length check (length(enc) = 32);

-- Rotation (ADR-019): the secrets sealed under another key version than the current one,
-- in id order after p_after, a batch at a time. The worker re-seals each inside its own
-- tenant, and a secret it can't open is passed over rather than listed again. Like
-- private.due_enrolments, it returns ids only.
create function private.secrets_to_rotate(
  p_current_version smallint, p_after uuid, p_limit integer
)
returns table (agency_id uuid, business_id uuid, secret_id uuid)
language sql stable security definer set search_path = ''
as $$
  select s.agency_id, s.business_id, s.id
  from vault.secrets s
  where s.key_version <> p_current_version
    and (p_after is null or s.id > p_after)
  order by s.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.secrets_to_rotate(smallint, uuid, integer) from public;
grant execute on function private.secrets_to_rotate(smallint, uuid, integer) to crm_app;

-- How many secrets each key version seals, across every tenant: counts only. Rotation
-- checks it before it starts, refusing to re-seal anything under an older key than one
-- already in use, and after it ends, before saying the older keys can go.
create function private.secret_key_versions()
returns table (key_version smallint, secrets bigint)
language sql stable security definer set search_path = ''
as $$
  select s.key_version, count(*)
  from vault.secrets s
  group by s.key_version
$$;
revoke execute on function private.secret_key_versions() from public;
grant execute on function private.secret_key_versions() to crm_app;

-- crm_app rewrites a secret's sealed bytes (replacing or rotating it), never whose or what
-- it is: a sealed secret is bound to those, so changing them could only break it.
revoke update on vault.secrets from crm_app;
grant update (key_version, enc, ciphertext, rotated_at) on vault.secrets to crm_app;
