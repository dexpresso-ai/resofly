-- ============================================================
-- ResoFly — Alle gegevens exporteren: een regel in het logboek
-- Date: 2026-11-11
--
-- Zie docs/plannen/GEGEVENS_MEENEMEN_BOUWPLAN_2026-11-11.md (fase 1).
--
-- De eigenaar kan onder Instellingen → Gegevens alles van de organisatie in
-- één zip downloaden. De export leest met zijn eigen rechten (RLS), dus hij
-- krijgt niets wat hij in ResoFly niet al kon zien. Wel is een export de
-- snelste manier om met één overgenomen account in één keer alles mee te
-- nemen. Daarom komt er een regel in het logboek, zichtbaar voor het hele
-- team (entity_type 'organization', zie audit_entity_module).
--
-- De app mag zelf niet in audit_logs schrijven; dat doen de triggers en de
-- server. Deze functie is de enige weg, en alleen voor een eigenaar: dezelfde
-- regel als de knop in het scherm (settingsTabRoleRule, tabblad 'gegevens').
--
-- Veilig opnieuw te draaien: create or replace, de lijst met acties wordt
-- alleen aangevuld, en de rechten opnieuw gezet.
-- ============================================================

-- audit_logs_action_check kent alleen vaste acties. Zonder 'data_export' liep
-- de eerste proef stuk op die controle, en kwam er dus geen regel. Zelfde
-- werkwijze als 20261106130000: de lijst uit de huidige definitie lezen en
-- alleen aanvullen, zodat acties van andere migraties blijven staan.
do $$
declare
  v_def text;
  v_actions text[];
  v_nieuw text[] := array['data_export'];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_action_check';
  if v_def is null then return; end if;
  select array_agg(distinct t[1] order by t[1]) into v_actions
    from regexp_matches(v_def, '([a-z][a-z0-9_]*)', 'g') as t
   where t[1] not in ('check', 'action', 'any', 'array', 'text');
  if v_actions is null or array_length(v_actions, 1) < 10 then
    raise exception 'audit_logs_action_check niet te lezen: %', left(v_def, 200);
  end if;
  if v_nieuw <@ v_actions then return; end if;
  select array_agg(distinct a order by a) into v_actions from unnest(v_actions || v_nieuw) as a;
  alter table public.audit_logs drop constraint audit_logs_action_check;
  execute format('alter table public.audit_logs add constraint audit_logs_action_check check (action = any (%L::text[]))', v_actions);
end $$;

create or replace function public.log_data_export(p_organization_id uuid, p_summary jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_summary jsonb := coalesce(p_summary, '{}'::jsonb);
begin
  if v_user is null then
    raise exception 'Log eerst in.' using errcode = '42501';
  end if;
  if not public.user_has_org_role(p_organization_id, array['owner']) then
    raise exception 'Alleen de eigenaar kan alle gegevens exporteren.' using errcode = '42501';
  end if;
  -- Alleen een object, en klein: dit is een samenvatting (aantallen), geen
  -- plek om gegevens op te slaan.
  if jsonb_typeof(v_summary) <> 'object' or length(v_summary::text) > 4000 then
    v_summary := '{}'::jsonb;
  end if;

  insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, v_user, 'data_export', 'organization', p_organization_id, 'Alle gegevens', v_summary);
end;
$$;

revoke all on function public.log_data_export(uuid, jsonb) from public, anon;
grant execute on function public.log_data_export(uuid, jsonb) to authenticated;
