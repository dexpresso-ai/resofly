-- ============================================================
-- ResoFly — Sfeer van de klantgerichte pagina's
-- Date: 2026-08-21
--
-- Aanleiding:
-- - Alles wat de klant van de gebruiker ziet — het klantportaal, de galerij en
--   de publieke offerte-, factuur- en contractpagina's — stond in de
--   ResoFly-stijl: warm zwart met merkgoud. De huisstijl (merkkleur, logo,
--   lettertypen) bestond al, maar werd alleen op de galerij toegepast.
--
-- Ontwerp:
-- - Eén keuze erbij: donker of licht. De rest van het palet — vlakken, randen,
--   tekst, accenttekst, tekst óp de merkkleur — wordt in de frontend afgeleid
--   uit de merkkleur die hier al staat (`brand_accent_color`), met de
--   helderheids- en verzadigingstrap van het thema als maat. Zo blijft elk
--   contrast dat in globals.css is afgewogen staan en hoeft de gebruiker maar
--   één ding te kiezen. Zie `brandThemeVars()` in src/lib/branding.ts.
-- - Standaard 'dark': bestaande pagina's zien er daardoor precies uit als
--   voorheen, alleen dan in de merkkleur van de gebruiker in plaats van goud.
--
-- Meegenomen: `create_child_organization` kopieerde bij een nieuwe entiteit
-- alleen kleur, logo en lettertypen van de moeder. De afsluittekst, het
-- "powered by"-vinkje en de galerij-achtergrond bleven achter — en de nieuwe
-- sfeer zou dat ook doen. Het kopieerblok is nu compleet; de rest van de
-- functie staat er onveranderd bij, want CREATE OR REPLACE kent geen patch.
-- ============================================================

begin;

alter table public.company_settings
  add column if not exists brand_client_theme text not null default 'dark';

alter table public.company_settings drop constraint if exists company_settings_brand_client_theme_check;
alter table public.company_settings
  add constraint company_settings_brand_client_theme_check
  check (brand_client_theme in ('dark', 'light'));

comment on column public.company_settings.brand_client_theme is
  'Sfeer van de klantgerichte pagina''s (portaal, galerij, publieke offerte/factuur/contract): dark of light. De merkkleur bepaalt de tint, deze kolom de helderheid — zie brandThemeVars in src/lib/branding.ts.';

create or replace function public.create_child_organization(
  p_parent_organization_id uuid,
  p_name text,
  p_legal_form text default 'bv'
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email citext := public.current_user_email();
  v_parent uuid;
  v_base_slug text;
  v_slug text;
  v_counter int := 1;
  v_org public.organizations;
  v_allowance integer;
  v_legal_form text := coalesce(nullif(trim(p_legal_form), ''), 'bv');
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  if p_parent_organization_id is null then
    raise exception 'Organisatie ontbreekt' using errcode = '23514';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Naam van de administratie ontbreekt' using errcode = '23514';
  end if;
  if v_legal_form not in ('eenmanszaak','vof','maatschap','cv','bv','nv','cooperatie','stichting','vereniging') then
    raise exception 'Onbekende rechtsvorm: %', v_legal_form using errcode = '22023';
  end if;

  -- De moeder wordt EXPLICIET meegegeven (de app stuurt de actieve organisatie
  -- mee). Zelf de moeder opzoeken zou misgaan bij iemand die owner is van twee
  -- losse bedrijven: dan belandt de administratie onder de verkeerde.
  -- Wie vanuit een dochter aanmaakt, hangt hem onder dezelfde moeder — nooit
  -- onder de dochter, want de boom is maximaal één niveau diep.
  v_parent := public.billing_root_organization(p_parent_organization_id);

  if not public.user_has_org_role(v_parent, array['owner']) then
    raise exception 'Alleen een owner van de hoofdorganisatie kan een administratie toevoegen.' using errcode = '42501';
  end if;

  if not public.org_has_business(v_parent) then
    raise exception 'Meerdere administraties horen bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  v_allowance := public.org_entity_allowance(v_parent);
  if v_allowance is not null and public.org_entity_count(v_parent) >= v_allowance then
    -- Bijkopen gaat (nog) niet self-service: entity_addons wordt handmatig
    -- gezet. Verwijs dus niet naar een knop die er niet is.
    raise exception 'Je abonnement bevat % administraties. Neem contact op om er een bij te kopen.', v_allowance
      using errcode = '42501';
  end if;

  v_base_slug := public.slugify(p_name);
  v_slug := v_base_slug;
  while exists (select 1 from public.organizations where slug = v_slug) loop
    v_counter := v_counter + 1;
    v_slug := left(v_base_slug, 52) || '-' || v_counter::text;
  end loop;

  insert into public.organizations(name, slug, created_by, parent_organization_id)
  values (trim(p_name), v_slug, v_user_id, v_parent)
  returning * into v_org;

  -- Toegang is expliciet, niet geërfd. Alle owners van de moeder krijgen een
  -- echte membership-rij (zij zijn de rekeninghouders en owners zijn peers —
  -- zie de owner-peer-bescherming in 20260802000000). Gewone teamleden krijgen
  -- niets: die worden per administratie uitgenodigd, met eigen modulerechten.
  insert into public.organization_members(organization_id, user_id, email, role, status, invited_by)
  select v_org.id, om.user_id, om.email, 'owner', 'active', v_user_id
  from public.organization_members om
  where om.organization_id = v_parent
    and om.status = 'active'
    and om.role = 'owner'
  on conflict (organization_id, user_id) do nothing;

  -- De aanmaker hoort er hoe dan ook bij, ook als hij (nog) geen owner-rij op
  -- de moeder had staan maar wel via een andere weg owner is.
  insert into public.organization_members(organization_id, user_id, email, role, status, invited_by)
  values (v_org.id, v_user_id, v_email, 'owner', 'active', v_user_id)
  on conflict (organization_id, user_id) do nothing;

  -- Rechtsvorm meteen vastleggen; adres/KvK/btw blijven leeg want die
  -- verschillen per entiteit. Alleen de huisstijl nemen we over zodat
  -- documenten uit de nieuwe administratie er meteen goed uitzien.
  insert into public.company_settings(organization_id, company_name, legal_form)
  values (v_org.id, trim(p_name), v_legal_form)
  on conflict (organization_id) do update set legal_form = excluded.legal_form;

  update public.company_settings cs
  set brand_accent_color    = parent.brand_accent_color,
      brand_logo_data_url   = parent.brand_logo_data_url,
      brand_heading_font    = parent.brand_heading_font,
      brand_body_font       = parent.brand_body_font,
      brand_footer_text     = parent.brand_footer_text,
      brand_hide_powered_by = parent.brand_hide_powered_by,
      brand_gallery_bg      = parent.brand_gallery_bg,
      brand_client_theme    = parent.brand_client_theme
  from public.company_settings parent
  where cs.organization_id = v_org.id
    and parent.organization_id = v_parent;

  perform public.log_billing_audit(
    v_parent, 'entity_created', 'organization', v_org.id, null,
    jsonb_build_object(
      'source', 'create_child_organization',
      'child_organization_id', v_org.id,
      'name', trim(p_name),
      'legal_form', v_legal_form
    ),
    null
  );

  return v_org;
end;
$$;

commit;
