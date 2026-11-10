-- ============================================================
-- Beslislijst: een kaart volgt de rechten van ALLE modules waarvan hij gegevens toont.
--
-- Een kaart hing aan één module: die van het voorstel (20260914000000). Maar
-- een kaart over een klantmail (module Klanten) noemde ook de open offertes en
-- facturen van die klant, en Gerrie schreef de bedragen soms in zijn
-- samenvatting of conceptmail. Zo zag een teamlid zonder Financiën toch
-- financiële gegevens. Een kaart met actiepunten uit notulen (module
-- Projecten) liet de opname zien, en die hoort bij de Agenda. Dat botst met de
-- harde regel "modulerechten gelden overal": kan een teamlid een module niet
-- lezen, dan geeft de database niets terug.
--
-- Nu:
--   1. ai_decisions.required_modules: de modules boven de eigen module waarvan
--      de kaart gegevens toont. gerrie-signals vult ze bij het wegschrijven
--      (signalRules.ts, requiredModules); bestaande kaarten krijgen ze hieronder.
--   2. Lezen (RLS), afhandelen (ai_decision_resolve), dempen (ai_decision_mute)
--      en beslissen over het voorstel (ai_action_decide) vragen leesrecht op
--      elk van die modules. Owners en admins mogen alles en merken niets.
--
-- Veilig opnieuw te draaien: add column if not exists, create or replace, drop
-- policy if exists, en de aanvulling rekent steeds hetzelfde uit.
-- ============================================================

begin;

alter table public.ai_decisions
  add column if not exists required_modules text[] not null default '{}'::text[];

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_decisions_required_modules_known') then
    alter table public.ai_decisions add constraint ai_decisions_required_modules_known
      check (required_modules <@ array['clients','projects','time','calendar','tickets','content','stats','marketing','finance','chat','gerrie']::text[]);
  end if;
end $$;

comment on column public.ai_decisions.required_modules is
  'Modules boven de eigen module waarvan de kaart gegevens toont (open facturen, projectnamen, opnames). Lezen, afhandelen en beslissen vragen leesrecht op elk ervan (20261110110100).';

-- Leesrecht op een hele lijst modules; een lege lijst vraagt niets.
create or replace function public.can_read_modules(p_organization_id uuid, p_modules text[])
returns boolean
language sql
stable
as $$
  select coalesce(bool_and(public.can_read_module(p_organization_id, m)), true)
    from unnest(coalesce(p_modules, '{}'::text[])) as m;
$$;
revoke all on function public.can_read_modules(uuid, text[]) from public, anon;
grant execute on function public.can_read_modules(uuid, text[]) to authenticated, service_role;

drop policy if exists "ai_decisions read" on public.ai_decisions;
create policy "ai_decisions read" on public.ai_decisions
  for select to authenticated using (
    public.can_read_org(organization_id)
    and public.can_read_module(organization_id, module)
    and public.can_read_module(organization_id, 'gerrie')
    and public.can_read_modules(organization_id, required_modules)
  );

-- Bestaande kaarten. Dezelfde regels als requiredModules in signalRules.ts:
--   - klantmail met open offertes of facturen in de "waarom"-regels: Financiën;
--   - klantmail met een taak als voorstel, of waarbij Gerrie projecten opzocht: Projecten;
--   - actiepunten uit notulen: Agenda.
-- De eigen module van de kaart komt er niet in.
update public.ai_decisions d
   set required_modules = array(
         select distinct m from unnest(array[
           case when d.kind = 'inbound_mail'
                 and (d.evidence::text like '%Open offertes:%' or d.evidence::text like '%Open facturen:%')
                then 'finance' end,
           case when d.kind = 'inbound_mail'
                 and (coalesce(d.proposal ->> 'type', '') in ('task', 'create_tasks', 'edit_task', 'edit_project')
                      or coalesce(d.trace::text, '') like '%list_projects%')
                then 'projects' end,
           case when d.kind = 'meeting_notes_ready' then 'calendar' end
         ]) as m
          where m is not null and m <> d.module
          order by m
       )
 where d.kind in ('inbound_mail', 'meeting_notes_ready');

-- ── De drie wegen om iets met een kaart te doen ──────────────────────────────
-- Letterlijk de laatste versies (ai_decision_resolve en ai_decision_mute uit
-- 20261003050000, ai_action_decide uit 20261017000000), met alleen de controle
-- op required_modules erbij.

create or replace function public.ai_decision_resolve(
  p_id uuid, p_status text, p_snoozed_until timestamptz default null, p_resolution text default null
) returns public.ai_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.ai_decisions%rowtype;
  a public.ai_action_audit%rowtype;
  v_claimer uuid;
  v_until timestamptz;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd.' using errcode = '42501'; end if;
  select * into d from public.ai_decisions where id = p_id for update;
  if not found then raise exception 'Kaart niet gevonden.' using errcode = 'P0002'; end if;
  if not (public.can_read_org(d.organization_id) and public.can_read_module(d.organization_id, 'gerrie')
          and public.can_write_module(d.organization_id, d.module)
          -- 20261110110100: ook leesrecht op elke module waarvan de kaart gegevens toont.
          and public.can_read_modules(d.organization_id, d.required_modules)) then
    raise exception 'Je hebt geen schrijfrechten voor deze kaart.' using errcode = '42501';
  end if;
  if p_status not in ('open','snoozed','done','dismissed') then
    raise exception 'Onbekende status: %', p_status using errcode = '22023';
  end if;
  if p_status = 'snoozed' and p_snoozed_until is null then
    raise exception 'Geef een moment waarop de kaart terugkomt.' using errcode = '22023';
  end if;

  if d.audit_id is not null and p_status in ('done', 'dismissed') then
    select * into a from public.ai_action_audit where id = d.audit_id and organization_id = d.organization_id for update;
    if found and (a.status = 'proposed'
                  or (a.status = 'failed' and coalesce(a.result ->> 'decision', '') = 'failed')) then
      v_claimer := nullif(a.result ->> 'claimed_by', '')::uuid;
      v_until := nullif(a.result ->> 'claimed_until', '')::timestamptz;
      if v_claimer is not null and v_claimer <> auth.uid() and v_until > now() then
        raise exception 'Iemand anders voert dit voorstel op dit moment uit. Probeer het over een paar minuten opnieuw.'
          using errcode = 'RS409';
      end if;
      update public.ai_action_audit
         set status = case when p_status = 'done' then 'executed' else 'cancelled' end,
             result = (coalesce(result, '{}'::jsonb) - 'claimed_by' - 'claimed_until')
                   || jsonb_build_object('decision', case when p_status = 'done' then 'executed' else 'rejected' end,
                                         'decided_by', auth.uid(), 'decided_at', now())
       where id = a.id;
    end if;
  end if;

  update public.ai_decisions
     set status = p_status,
         snoozed_until = case when p_status = 'snoozed' then p_snoozed_until else null end,
         resolved_by = case when p_status in ('done','dismissed') then auth.uid() else null end,
         resolved_at = case when p_status in ('done','dismissed') then now() else null end,
         resolution = left(p_resolution, 200)
   where id = p_id
   returning * into d;
  return d;
end;
$$;
revoke execute on function public.ai_decision_resolve(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.ai_decision_resolve(uuid, text, timestamptz, text) to authenticated, service_role;

create or replace function public.ai_decision_mute(p_decision_id uuid, p_scope text, p_until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d public.ai_decisions%rowtype;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd.' using errcode = '42501'; end if;
  select * into d from public.ai_decisions where id = p_decision_id;
  if not found then raise exception 'Kaart niet gevonden.' using errcode = 'P0002'; end if;
  if not (public.can_read_org(d.organization_id) and public.can_read_module(d.organization_id, 'gerrie')
          and public.can_write_module(d.organization_id, d.module)
          -- 20261110110100: ook leesrecht op elke module waarvan de kaart gegevens toont.
          and public.can_read_modules(d.organization_id, d.required_modules)) then
    raise exception 'Je hebt geen schrijfrechten voor deze kaart.' using errcode = '42501';
  end if;
  if p_scope = 'kind' then
    insert into public.ai_decision_mutes (organization_id, scope, kind, until, created_by)
    values (d.organization_id, 'kind', d.kind, p_until, auth.uid())
    on conflict (organization_id, scope, coalesce(kind, ''), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set until = excluded.until, created_by = excluded.created_by, created_at = now();
    update public.ai_decisions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution = 'muted:kind'
     where organization_id = d.organization_id and kind = d.kind and status in ('open','snoozed');
  elsif p_scope = 'client' then
    if d.client_id is null then raise exception 'Deze kaart hoort niet bij een klant.' using errcode = '22023'; end if;
    insert into public.ai_decision_mutes (organization_id, scope, client_id, until, created_by)
    values (d.organization_id, 'client', d.client_id, p_until, auth.uid())
    on conflict (organization_id, scope, coalesce(kind, ''), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set until = excluded.until, created_by = excluded.created_by, created_at = now();
    update public.ai_decisions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution = 'muted:client'
     where organization_id = d.organization_id and client_id = d.client_id and status in ('open','snoozed');
  elsif p_scope = 'entity' then
    if d.entity_id is null then raise exception 'Deze kaart hoort niet bij een item.' using errcode = '22023'; end if;
    insert into public.ai_decision_mutes (organization_id, scope, entity_type, entity_id, until, created_by)
    values (d.organization_id, 'entity', d.entity_type, d.entity_id, p_until, auth.uid())
    on conflict (organization_id, scope, coalesce(kind, ''), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set until = excluded.until, created_by = excluded.created_by, created_at = now();
    update public.ai_decisions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution = 'muted:entity'
     where organization_id = d.organization_id and entity_id = d.entity_id and status in ('open','snoozed');
  else
    raise exception 'Onbekend bereik: %', p_scope using errcode = '22023';
  end if;
  -- De voorstellen achter de gedempte kaarten gaan dicht — behalve wat iemand
  -- op dit moment uitvoert; die meldt zelf zijn uitkomst.
  update public.ai_action_audit a
     set status = 'cancelled',
         result = (coalesce(a.result, '{}'::jsonb) - 'claimed_by' - 'claimed_until')
               || jsonb_build_object('decision', 'rejected', 'decided_by', auth.uid(), 'decided_at', now())
   where (a.status = 'proposed' or (a.status = 'failed' and coalesce(a.result ->> 'decision', '') = 'failed'))
     and coalesce(nullif(a.result ->> 'claimed_until', '')::timestamptz, '-infinity'::timestamptz) <= now()
     and a.id in (
       select x.audit_id from public.ai_decisions x
        where x.organization_id = d.organization_id and x.status = 'dismissed' and x.resolution like 'muted:%' and x.audit_id is not null
     );
end;
$$;
revoke execute on function public.ai_decision_mute(uuid, text, timestamptz) from public, anon;
grant execute on function public.ai_decision_mute(uuid, text, timestamptz) to authenticated, service_role;

create or replace function public.ai_action_decide(
  p_audit_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_outcome text,
  p_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row      public.ai_action_audit%rowtype;
  v_role     text;
  v_access   jsonb;
  v_module   text;
  v_required text[];
  v_outcome  text := p_outcome;
  v_claimer  uuid;
  v_until    timestamptz;
  v_detail   text;
  v_status   text;
  v_revoked  timestamptz;
  v_rejected constant text := 'Afgewezen door gebruiker.';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de server legt een beslissing vast.' using errcode = '42501';
  end if;
  if v_outcome is null or v_outcome not in ('claim', 'executed', 'failed', 'rejected') then
    raise exception 'Onbekende uitkomst: %.', coalesce(v_outcome, 'leeg') using errcode = '22023';
  end if;

  v_detail := nullif(btrim(left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 500)), '');
  -- Een oudere app meldt een afwijzing als "mislukt" met deze zin.
  if v_outcome = 'failed' and v_detail = v_rejected then v_outcome := 'rejected'; end if;

  select m.role, coalesce(m.module_access, '{}'::jsonb) into v_role, v_access
    from public.organization_members m
   where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active';
  if v_role is null or v_role not in ('owner', 'admin', 'member') then
    raise exception 'Je hebt geen schrijfrechten in deze organisatie.' using errcode = '42501';
  end if;

  select * into v_row
    from public.ai_action_audit
   where id = p_audit_id and organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'Dit voorstel bestaat niet in deze organisatie.' using errcode = 'P0002';
  end if;

  if v_role not in ('owner', 'admin') then
    if v_row.signal_id is not null and v_row.agent_id is null and v_row.agent_run_id is null
       and v_row.mcp_grant_id is null and v_row.api_key_id is null then
      -- Een kaart uit de Beslissingen-feed: dezelfde regel als de feed zelf.
      select d.module, d.required_modules into v_module, v_required
        from public.ai_decisions d
       where d.audit_id = v_row.id and d.organization_id = p_organization_id
       order by d.created_at desc
       limit 1;
      if v_module is null
         or coalesce(nullif(v_access ->> 'gerrie', ''), 'write') = 'none'
         or coalesce(nullif(v_access ->> v_module, ''), 'write') <> 'write'
         -- 20261110110100: ook leesrecht op elke module waarvan de kaart gegevens
         -- toont. Een teamlid (owners en admins komen hier niet): ontbrekende
         -- sleutel = volledig, net als org_module_level.
         or exists (select 1 from unnest(coalesce(v_required, '{}'::text[])) as m
                     where coalesce(nullif(v_access ->> m, ''), 'write') = 'none') then
        raise exception 'Over dit voorstel beslist wie de module van de kaart mag wijzigen, of een owner of admin.'
          using errcode = '42501';
      end if;
    elsif (v_row.agent_id is not null or v_row.agent_run_id is not null)
          and v_row.mcp_grant_id is null and v_row.api_key_id is null and v_row.signal_id is null then
      -- Een voorstel van een geplande agent: de eigenaar van die agent beslist.
      if v_row.user_id is distinct from p_user_id
         or coalesce(nullif(v_access ->> 'gerrie', ''), 'write') <> 'write'
         or not exists (
           select 1 from public.ai_agents a
            where a.id = v_row.agent_id and a.organization_id = p_organization_id and a.run_as_user_id = p_user_id
         ) then
        raise exception 'Over dit voorstel beslist de eigenaar van de agent, of een owner of admin.'
          using errcode = '42501';
      end if;
    elsif v_row.agent_id is not null or v_row.agent_run_id is not null or v_row.mcp_grant_id is not null
          or v_row.api_key_id is not null or v_row.signal_id is not null
          or v_row.user_id is distinct from p_user_id then
      raise exception 'Over dit voorstel beslist een owner of admin.' using errcode = '42501';
    end if;
  end if;

  if not (v_row.status = 'proposed'
          or (v_row.status = 'failed' and coalesce(v_row.result ->> 'decision', '') = 'failed')) then
    raise exception 'Dit voorstel is al afgehandeld.' using errcode = 'RS409';
  end if;

  v_claimer := nullif(v_row.result ->> 'claimed_by', '')::uuid;
  v_until := nullif(v_row.result ->> 'claimed_until', '')::timestamptz;
  if v_claimer is not null and v_claimer <> p_user_id and v_until > now() then
    raise exception 'Iemand anders voert dit voorstel op dit moment uit. Probeer het over een paar minuten opnieuw.'
      using errcode = 'RS409';
  end if;

  if v_outcome = 'claim' then
    -- Een voorstel van een ingetrokken sleutel voert niemand meer uit. Afwijzen
    -- mag wel, en wie het al uitvoerde, meldt zijn uitkomst gewoon.
    if v_row.api_key_id is not null then
      select k.revoked_at into v_revoked from public.api_keys k where k.id = v_row.api_key_id;
      if v_revoked is not null then
        raise exception 'De API-sleutel achter dit voorstel is ingetrokken; het wordt niet meer uitgevoerd.'
          using errcode = 'RS409';
      end if;
    end if;
    update public.ai_action_audit
       set result = coalesce(result, '{}'::jsonb)
                 || jsonb_build_object('claimed_by', p_user_id, 'claimed_until', now() + interval '10 minutes')
     where id = v_row.id;
    return jsonb_build_object('status', v_row.status, 'claimed_until', now() + interval '10 minutes')
      || case when v_claimer is not null and v_until <= now()
              then jsonb_build_object('stale_claim', jsonb_build_object('by', v_claimer, 'until', v_until))
              else '{}'::jsonb end;
  end if;

  v_status := case when v_outcome = 'executed' then 'executed' else 'failed' end;
  update public.ai_action_audit
     set status = v_status,
         result = (coalesce(result, '{}'::jsonb) - 'claimed_by' - 'claimed_until' - 'detail' - 'ok')
               || jsonb_build_object('ok', v_outcome = 'executed', 'decision', v_outcome,
                                     'decided_by', p_user_id, 'decided_at', now())
               || case
                    when v_outcome = 'rejected' then jsonb_build_object('detail', v_rejected)
                    when v_detail is not null then jsonb_build_object('detail', v_detail)
                    else '{}'::jsonb
                  end
   where id = v_row.id;
  return jsonb_build_object('status', v_status, 'decision', v_outcome);
end;
$$;
revoke all on function public.ai_action_decide(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.ai_action_decide(uuid, uuid, uuid, text, text) to service_role;

commit;
