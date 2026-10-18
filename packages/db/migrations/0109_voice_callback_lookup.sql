-- Voice callbacks need synchronous TwiML (ADR-109), so the opening-vault worker must
-- identify the tenant before entering RLS. A capability is routing, never proof of a
-- provider request. This function exposes identifiers only; credentials are opened
-- under tenant context and the full canonical URL/body signature verified afterwards.
create function private.resolve_voice_callback(p_digest text)
returns table (agency_id uuid, business_id uuid, connection_id uuid)
language sql stable security definer set search_path = ''
as $$
  select c.agency_id, c.business_id, c.id
  from messaging.provider_connections c
  join tenancy.businesses b on b.id = c.business_id and b.agency_id = c.agency_id
  where p_digest ~ '^[0-9a-f]{64}$'
    and c.webhook_digest = p_digest
    and c.provider = 'twilio'
    and c.status = 'connected'
    and b.status = 'active'
$$;
revoke execute on function private.resolve_voice_callback(text) from public;
grant execute on function private.resolve_voice_callback(text) to crm_app;
