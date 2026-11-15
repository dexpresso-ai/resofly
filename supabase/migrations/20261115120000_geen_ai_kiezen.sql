-- ============================================================
-- ResoFly — Kiezen voor geen AI: Gerrie dan overal weg
-- Date: 2026-11-15
--
-- WAAROM
-- Bij het inrichten van een nieuwe organisatie kiest de gebruiker nu meteen
-- of hij AI wil gebruiken. Kiest hij "nee", dan hoort Gerrie overal uit te
-- staan en nergens te zien te zijn, ook niet in het menu. Aanzetten kan
-- daarna alleen nog onder Instellingen → AI.
--
-- Daarvoor moet de app het verschil zien tussen "nog niet gekozen" en
-- "gekozen voor geen AI". Tot nu toe kon dat niet: set_ai_consent schreef bij
-- uitzetten alleen iets als Gerrie eerder aan had gestaan. Wie nooit akkoord
-- gaf en "nee" zei, had daarna nog steeds geen rij, en zag Gerrie dus nog in
-- het menu, met het scherm om hem aan te zetten.
--
-- WAT
-- set_ai_consent(…, false) legt de keuze nu altijd vast: bestaat er nog geen
-- rij, dan komt er een met enabled = false. Die rij betekent in de app: deze
-- gebruiker koos zelf voor geen AI (bij het inrichten, op de pagina Gerrie of
-- met "Gerrie uitzetten" in de instellingen). Geen rij blijft: nog niet
-- gekozen.
--
-- Het logboek zegt het verschil: "koos voor geen AI" als Gerrie nooit aan
-- stond, "zette Gerrie (AI) uit" als hij wel aan stond (metadata was_aan).
-- Nog eens "nee" zeggen geeft geen tweede regel.
--
-- Aanzetten verandert niet. De deuren naar de AI (supabase/functions/_shared/
-- aiConsent.ts) ook niet: die laten alleen enabled = true onder de huidige
-- tekst door, en een rij met enabled = false was daar al "nee".
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

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
  v_was_on boolean := false;
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

  -- Uitzetten. Ook als Gerrie nooit aan stond: dan is dit de keuze voor geen
  -- AI, en die moet blijven staan. Zonder rij zag de app "nog niet gekozen"
  -- en bleef Gerrie in het menu staan.
  select * into v_row from public.ai_consents
   where organization_id = p_organization_id and user_id = v_user
   for update;
  if found and not v_row.enabled then
    -- Stond al uit: niets te doen, en geen tweede regel in het logboek.
    return v_row;
  end if;
  v_was_on := found;

  insert into public.ai_consents as c
    (organization_id, user_id, enabled, terms_version, acknowledged, accepted_at, disabled_at)
  values
    (p_organization_id, v_user, false, public.ai_terms_version(), '{}', null, now())
  on conflict (organization_id, user_id) do update
    set enabled = false,
        disabled_at = now()
  returning * into v_row;

  -- Je agents draaien namens jou. Zonder dit bleven ze op hun schema je
  -- gegevens lezen terwijl jij de AI net had uitgezet. Ze gaan op pauze, niet
  -- weg: zet je Gerrie weer aan, dan zet je ze zelf weer aan. Ook bij "nooit
  -- aan": een agent van vóór het akkoord (20261112190000) kan nog actief staan.
  update public.ai_agents
     set status = 'paused', next_run_at = null, lease_until = null
   where organization_id = p_organization_id and run_as_user_id = v_user and status = 'active';
  get diagnostics v_paused = row_count;

  insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, v_user, 'ai_disabled', 'organization', p_organization_id, 'Gerrie (AI)',
          jsonb_build_object('agents_gepauzeerd', v_paused, 'was_aan', v_was_on));
  return v_row;
end;
$$;

revoke all on function public.set_ai_consent(uuid, boolean, text, text[]) from public, anon;
grant execute on function public.set_ai_consent(uuid, boolean, text, text[]) to authenticated;

commit;
