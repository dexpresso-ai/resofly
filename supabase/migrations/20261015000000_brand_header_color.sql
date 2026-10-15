-- ============================================================
-- ResoFly — Kopkleur en lichte logoversie voor de klantpagina's
-- Date: 2026-10-15
--
-- Aanleiding:
-- - Het klantportaal en de publieke offerte-, factuur- en contractpagina
--   krijgen de opbouw van de werkruimte: een kop met groet en kerncijfers en
--   het werkvlak eronder. Die kop heeft een eigen kleur. Veel merken hebben
--   een donkere hoofdkleur en een felle accentkleur (navy met koraal); met
--   alleen de merkkleur is dat niet neer te zetten.
-- - De meeste logo's zijn donker op transparant en vallen weg op een donkere
--   kop. Zonder lichte versie zet de frontend het logo op een licht plaatje.
--
-- Ontwerp:
-- - `brand_header_color`: leeg = automatisch. De frontend leidt de kop dan af
--   uit de merkkleur (het grafiet van de cockpit in de tint van het merk); zie
--   brandThemeVars() in src/lib/branding.ts. Alleen een hexkleur: de waarde
--   gaat rechtstreeks een CSS-variabele in.
-- - `brand_logo_dark_data_url`: de lichte versie van het logo, met dezelfde
--   eisen als het gewone logo (alleen png/jpeg/webp als data-URL, geen svg).
-- - create_child_organization neemt beide over van de moeder, net als de rest
--   van de huisstijl. De functie staat er verder onveranderd bij, want CREATE
--   OR REPLACE kent geen patch.
-- ============================================================

begin;

alter table public.company_settings
  add column if not exists brand_header_color text,
  add column if not exists brand_logo_dark_data_url text;

alter table public.company_settings drop constraint if exists company_settings_brand_header_color_check;
alter table public.company_settings
  add constraint company_settings_brand_header_color_check
  check (brand_header_color is null or brand_header_color ~ '^#[0-9A-Fa-f]{6}$');

alter table public.company_settings drop constraint if exists company_settings_brand_logo_dark_check;
alter table public.company_settings
  add constraint company_settings_brand_logo_dark_check
  check (
    brand_logo_dark_data_url is null
    or (
      brand_logo_dark_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'
      and length(brand_logo_dark_data_url) <= 400000
    )
  );

comment on column public.company_settings.brand_header_color is
  'Kleur van de kop van de klantpagina''s (portaal en publieke offerte/factuur/contract). Leeg = automatisch, afgeleid uit brand_accent_color — zie brandThemeVars in src/lib/branding.ts.';
comment on column public.company_settings.brand_logo_dark_data_url is
  'Lichte versie van het logo voor op een donkere kop (png/jpeg/webp als data-URL, max ~400 kB). Leeg = het gewone logo, op een licht plaatje als het wegvalt.';

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
      brand_client_theme    = parent.brand_client_theme,
      brand_header_color    = parent.brand_header_color,
      brand_logo_dark_data_url = parent.brand_logo_dark_data_url
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

-- Zie supabase/functions/_shared/migrationGrants.test.ts: elke security-definer-
-- functie uit een migratie ná 20260926000000 wordt hier expliciet dichtgezet.
revoke all on function public.create_child_organization(uuid, text, text) from public, anon;
grant execute on function public.create_child_organization(uuid, text, text) to authenticated;

commit;
