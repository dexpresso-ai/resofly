-- ============================================================
-- ResoFly — Gerrie aanzetten: eerst akkoord, dan pas AI
-- Date: 2026-11-12
--
-- WAAROM
-- Tot nu toe stond Gerrie voor iedereen meteen aan zodra de module Gerrie
-- openstond. Niemand had gelezen of bevestigd wat dat betekent: dat een AI
-- je administratie leest, dat hij zich kan vergissen, en dat hij niets zelf
-- uitvoert. De vraag was: laat gebruikers de AI zelf aanzetten, en pas
-- daarna kunnen ze Gerrie gebruiken.
--
-- WAT
-- 1. ai_consents: per organisatie en per gebruiker of Gerrie aanstaat, sinds
--    wanneer, onder welke versie van de voorwaarden en welke punten iemand
--    aanvinkte. Per organisatie, omdat het akkoord over de gegevens van die
--    organisatie gaat (CLAUDE.md, regel 1): wie in twee organisaties werkt,
--    zet Gerrie in elk daarvan apart aan.
-- 2. ai_terms_version(): de versie van de tekst waarmee iemand akkoord ging.
--    Verandert de tekst wezenlijk, dan hoog je deze op; wie onder een oudere
--    versie akkoord ging, moet de nieuwe tekst dan eerst lezen. Spiegels:
--    AI_TERMS_VERSION in src/lib/aiConsent.ts en in
--    supabase/functions/_shared/aiConsent.ts (aiConsent.test.ts houdt ze gelijk).
-- 3. set_ai_consent(): de enige weg om Gerrie aan of uit te zetten, alleen
--    voor jezelf. Aanzetten kan alleen met de module Gerrie open, met de
--    huidige versie van de tekst en met alle drie de punten aangevinkt.
--    Uitzetten kan altijd, ook als een beheerder de module intussen dichtzette.
--    Uitzetten zet ook je eigen agents in deze organisatie op pauze: ze draaien
--    namens jou en lezen dan je gegevens zonder dat jij dat nog wilt.
-- 4. Een regel in het logboek ("zette Gerrie aan", "zette Gerrie uit"), zodat
--    de eigenaar en de beheerders zien wie akkoord ging.
--
-- LEZEN
-- Je eigen rij, en als owner of admin die van het hele team (Instellingen →
-- AI toont per teamlid of Gerrie aanstaat). Niemand schrijft zelf in de tabel:
-- dat doet set_ai_consent.
--
-- AFDWINGEN
-- De database bewaart het akkoord; de deuren naar de AI wegen het. Dat zijn
-- de edge functions gerrie-agent, gerrie-agent-runner (ook bij elke geplande
-- run), gerrie-signals (de kaarten die Gerrie zelf beoordeelt), mcp en
-- mcp-oauth. Die draaien met de service-role en lezen deze tabel daarmee
-- rechtstreeks (supabase/functions/_shared/aiConsent.ts).
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- ── 1. De versie van de voorwaarden ─────────────────────────────────────────
create or replace function public.ai_terms_version()
returns text
language sql
immutable
as $$
  select '2026-11-12'::text;
$$;

revoke all on function public.ai_terms_version() from public, anon;
grant execute on function public.ai_terms_version() to authenticated, service_role;

-- ── 2. Het akkoord per organisatie en gebruiker ─────────────────────────────
create table if not exists public.ai_consents (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  -- Onder welke tekst iemand akkoord ging, en wat hij aanvinkte.
  terms_version text not null,
  acknowledged text[] not null default '{}',
  accepted_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  constraint ai_consents_enabled_accepted check (not enabled or accepted_at is not null)
);

comment on table public.ai_consents is
  'Per organisatie en gebruiker: staat Gerrie (AI) aan, en onder welke voorwaarden ging iemand akkoord. Alleen te wijzigen via set_ai_consent (20261112160000).';

drop trigger if exists ai_consents_updated on public.ai_consents;
create trigger ai_consents_updated before update on public.ai_consents
  for each row execute function public.set_updated_at();

alter table public.ai_consents enable row level security;

drop policy if exists "ai consents read own or by admins" on public.ai_consents;
create policy "ai consents read own or by admins" on public.ai_consents for select using (
  user_id = auth.uid() or public.can_admin_org(organization_id)
);

-- Geen insert-, update- of deletepolicy: de app schrijft hier niet zelf.
-- De rechten op tabelniveau gaan voor de zekerheid ook dicht.
revoke all on public.ai_consents from anon;
revoke insert, update, delete, truncate on public.ai_consents from authenticated;
grant select on public.ai_consents to authenticated;
grant all on public.ai_consents to service_role;

-- De boekhouder heeft nooit Gerrie, en leest dus ook niet wie hem aanzette.
-- Bewust geen module gate: die zet ook een schrijftrigger op de tabel, en dan
-- kon wie de module Gerrie dicht kreeg, hem niet meer uitzetten.
select public.apply_accountant_fence('ai_consents');

-- ── 3. Het logboek kent de twee nieuwe handelingen ──────────────────────────
-- Zelfde werkwijze als 20261111120000: de lijst uit de huidige definitie
-- lezen en alleen aanvullen, zodat de acties van andere migraties blijven.
do $$
declare
  v_def text;
  v_actions text[];
  v_nieuw text[] := array['ai_enabled', 'ai_disabled'];
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

-- ── 4. Aan- en uitzetten ────────────────────────────────────────────────────
create or replace function public.set_ai_consent(
  p_organization_id uuid,
  p_enabled boolean,
  p_terms_version text default null,
  p_acknowledged text[] default '{}'
)
returns public.ai_consents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  -- De drie punten uit het scherm (AI_CONSENT_POINTS in src/lib/aiConsent.ts).
  v_required text[] := array['gegevens_lezen', 'kan_fouten_maken', 'geen_eigen_beslissingen'];
  v_row public.ai_consents;
  v_paused integer := 0;
begin
  if v_user is null then
    raise exception 'Log eerst in.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id and m.user_id = v_user and m.status = 'active'
  ) then
    raise exception 'Je bent geen lid van deze organisatie.' using errcode = '42501';
  end if;

  if coalesce(p_enabled, false) then
    -- Wie de module niet mag, zet Gerrie ook niet aan. Dat blijft de keuze van
    -- de eigenaar of een beheerder (Instellingen → Organisatie & team).
    if not public.can_read_module(p_organization_id, 'gerrie') then
      raise exception 'Je hebt in deze organisatie geen toegang tot Gerrie. Vraag de eigenaar of een beheerder om de module Gerrie voor je open te zetten.'
        using errcode = '42501';
    end if;
    if p_terms_version is distinct from public.ai_terms_version() then
      raise exception 'De uitleg over Gerrie is intussen veranderd. Ververs de pagina en lees hem opnieuw.'
        using errcode = '22023';
    end if;
    if not (v_required <@ coalesce(p_acknowledged, '{}'::text[])) then
      raise exception 'Vink alle drie de punten aan om Gerrie aan te zetten.' using errcode = '22023';
    end if;

    -- Stond hij al aan onder deze tekst, dan verandert er niets (ook geen
    -- tweede regel in het logboek bij een dubbele klik).
    select * into v_row from public.ai_consents
     where organization_id = p_organization_id and user_id = v_user;
    if found and v_row.enabled and v_row.terms_version = public.ai_terms_version() then
      return v_row;
    end if;

    insert into public.ai_consents as c
      (organization_id, user_id, enabled, terms_version, acknowledged, accepted_at, disabled_at)
    values
      (p_organization_id, v_user, true, p_terms_version, v_required, now(), null)
    on conflict (organization_id, user_id) do update
      set enabled = true,
          terms_version = excluded.terms_version,
          acknowledged = excluded.acknowledged,
          accepted_at = now(),
          disabled_at = null
    returning * into v_row;

    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (p_organization_id, v_user, 'ai_enabled', 'organization', p_organization_id, 'Gerrie (AI)',
            jsonb_build_object('voorwaarden', p_terms_version, 'akkoord', to_jsonb(v_required)));
    return v_row;
  end if;

  -- Uitzetten.
  update public.ai_consents
     set enabled = false, disabled_at = now()
   where organization_id = p_organization_id and user_id = v_user and enabled
  returning * into v_row;
  if not found then
    -- Stond al uit (of nooit aan): niets te doen.
    select * into v_row from public.ai_consents
     where organization_id = p_organization_id and user_id = v_user;
    return v_row;
  end if;

  -- Je agents draaien namens jou. Zonder dit bleven ze op hun schema je
  -- gegevens lezen terwijl jij de AI net had uitgezet. Ze gaan op pauze, niet
  -- weg: zet je Gerrie weer aan, dan zet je ze zelf weer aan.
  update public.ai_agents
     set status = 'paused', next_run_at = null, lease_until = null
   where organization_id = p_organization_id and run_as_user_id = v_user and status = 'active';
  get diagnostics v_paused = row_count;

  insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, v_user, 'ai_disabled', 'organization', p_organization_id, 'Gerrie (AI)',
          jsonb_build_object('agents_gepauzeerd', v_paused));
  return v_row;
end;
$$;

revoke all on function public.set_ai_consent(uuid, boolean, text, text[]) from public, anon;
grant execute on function public.set_ai_consent(uuid, boolean, text, text[]) to authenticated;

commit;
