-- ============================================================
-- ResoFly — purge_inbound_messages() ook vanuit pg_cron kunnen draaien
-- Date: 2026-08-15
--
-- WAAROM
-- De opruimfunctie eiste `auth.role() = 'service_role'`. pg_cron draait zonder
-- JWT, dus `auth.role()` is daar NULL en de nachtelijke taak zou élke nacht
-- stuklopen op een permissiefout — zonder dat iemand het merkt, want een
-- gefaalde cron-run is stil.
--
-- Dit volgt het patroon dat elders in deze repo al geldt (zie
-- enforce_module_write_access in 20260730100000_module_permissions.sql):
-- "service_role, pg_cron en de workers draaien zonder JWT; die paden hebben hun
-- eigen autorisatie". We blokkeren dus alleen een INGELOGDE gebruiker die geen
-- service_role is — niet het ontbreken van een sessie.
-- ============================================================

begin;

create or replace function public.purge_inbound_messages()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  -- Wél blokkeren: een ingelogde gebruiker zonder service_role.
  -- Niet blokkeren: geen sessie (pg_cron, service role, workers).
  if auth.uid() is not null and auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de service-role mag de opvangbak opschonen.' using errcode = '42501';
  end if;

  delete from public.inbound_messages
   where purge_after is not null and purge_after < now();
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

revoke execute on function public.purge_inbound_messages() from public, anon, authenticated;
grant  execute on function public.purge_inbound_messages() to service_role;

commit;
