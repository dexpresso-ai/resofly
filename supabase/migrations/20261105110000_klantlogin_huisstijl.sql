-- ============================================================
-- ResoFly — De huisstijl op het inlogscherm van het klantportaal
-- Date: 2026-11-05
--
-- Aanleiding:
-- - Het klantportaal heeft één inlogadres voor iedereen: /portal. Welke
--   leverancier bij een bezoeker hoort, blijkt pas uit het e-mailadres
--   waarmee hij inlogt. Een klant die voor het eerst komt, zag daarom altijd
--   de standaardstijl van ResoFly, met "Klantportaal" als naam. Pas na het
--   inloggen (en daarna op hetzelfde apparaat) stond het portaal in het merk
--   van de leverancier.
-- - Leveranciers willen ook de kleuren van dat inlogscherm zelf kiezen.
--
-- Ontwerp:
-- - portal_login_addresses: per organisatie een eigen inlogadres,
--   /portal/<sleutel>. De sleutel is de merknaam plus tien willekeurige
--   tekens (zoals het doorstuuradres uit 20260815000000): leesbaar voor de
--   klant, maar niet te raden. Zo kan niemand met een bedrijfsnaam aftasten
--   of iemand ResoFly gebruikt, en verklapt het inlogscherm nog steeds van geen
--   enkel e-mailadres wie de leverancier is.
-- - Alleen de server schrijft in die tabel. De app leest het adres via
--   ensure_portal_login_key (maakt het aan als het er nog niet is); de
--   edge functions gebruiken de service-role. Er zijn bewust geen policies
--   voor authenticated: een sleutel die in mails staat, mag niet door een
--   teamlid worden omgezet, anders werken die links niet meer.
-- - company_settings krijgt de kleuren van het inlogscherm: achtergrond,
--   inlogkaart en knop, elk leeg = automatisch (kopkleur, werkvlak,
--   merkkleur), en een schakelaar voor een effen achtergrond zonder gloed en
--   ringen. Alleen hexkleuren: de waarden gaan rechtstreeks een
--   CSS-variabele in. Tekst op die vlakken rekent de frontend zelf uit, zodat
--   hij altijd leest (loginThemeVars in src/lib/branding.ts).
-- - create_child_organization neemt de kleuren over van de moeder, net als de
--   rest van de huisstijl. Een nieuwe administratie krijgt bij het eerste
--   gebruik een eigen inlogadres.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. De kleuren van het inlogscherm
-- ------------------------------------------------------------
alter table public.company_settings
  add column if not exists brand_login_bg_color text,
  add column if not exists brand_login_card_color text,
  add column if not exists brand_login_button_color text,
  add column if not exists brand_login_plain boolean not null default false;

alter table public.company_settings drop constraint if exists company_settings_brand_login_bg_color_check;
alter table public.company_settings
  add constraint company_settings_brand_login_bg_color_check
  check (brand_login_bg_color is null or brand_login_bg_color ~ '^#[0-9A-Fa-f]{6}$');

alter table public.company_settings drop constraint if exists company_settings_brand_login_card_color_check;
alter table public.company_settings
  add constraint company_settings_brand_login_card_color_check
  check (brand_login_card_color is null or brand_login_card_color ~ '^#[0-9A-Fa-f]{6}$');

alter table public.company_settings drop constraint if exists company_settings_brand_login_button_color_check;
alter table public.company_settings
  add constraint company_settings_brand_login_button_color_check
  check (brand_login_button_color is null or brand_login_button_color ~ '^#[0-9A-Fa-f]{6}$');

comment on column public.company_settings.brand_login_bg_color is
  'Achtergrond van het inlogscherm van het klantportaal. Leeg = de kopkleur (brand_header_color, of automatisch uit de merkkleur).';
comment on column public.company_settings.brand_login_card_color is
  'Kleur van de inlogkaart. Leeg = het werkvlak (brand_client_theme). De tekst erop rekent de frontend uit (loginThemeVars in src/lib/branding.ts).';
comment on column public.company_settings.brand_login_button_color is
  'Kleur van de knop, de focusrand en de regel boven de titel op het inlogscherm. Leeg = de merkkleur.';
comment on column public.company_settings.brand_login_plain is
  'Effen achtergrond op het inlogscherm: zonder het verloop, de gloed van de merkkleur en de ringen.';

-- ------------------------------------------------------------
-- 2. Een eigen inlogadres per organisatie
-- ------------------------------------------------------------
create table if not exists public.portal_login_addresses (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  key text not null unique,
  created_at timestamptz not null default now(),
  -- Merknaam (hoogstens 24 tekens) plus tien tekens uit het base32-alfabet.
  -- 'voorbeeld' (het voorbeeld bij Instellingen → Huisstijl) past hier nooit in.
  constraint portal_login_addresses_key_check
    check (key ~ '^[a-z0-9]+(-[a-z0-9]+)*-[a-z2-7]{10}$' and length(key) <= 48)
);

comment on table public.portal_login_addresses is
  'Het eigen inlogadres van het klantportaal per organisatie: /portal/<key>. Alleen de server schrijft hier; de app leest via ensure_portal_login_key.';

alter table public.portal_login_addresses enable row level security;
revoke all on table public.portal_login_addresses from public, anon, authenticated;
grant all on table public.portal_login_addresses to service_role;

-- Het boekhouder-hek (20261011000000): elke organisatietabel heeft een module
-- gate of dit hek, anders slaat de rooktest na de uitrol alarm
-- (accountant_fence_gaps). Een module gate past hier niet: die zet ook een
-- schrijfcontrole op de tabel, en dan kon een teamlid met alleen leesrecht op
-- Klanten het adres niet laten aanmaken. authenticated heeft hier sowieso geen
-- rechten; het hek legt vast dat dat zo blijft als er ooit een policy bij komt.
select public.apply_accountant_fence('portal_login_addresses');

-- ------------------------------------------------------------
-- 3. De sleutel maken
-- ------------------------------------------------------------
-- search_path met `extensions`: gen_random_bytes komt uit pgcrypto, en dat
-- staat bij Supabase in het schema extensions (zie 20260815000000).
create or replace function public.generate_portal_login_key(p_name text)
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  -- 32 tekens: 256 % 32 = 0, dus elk teken even waarschijnlijk.
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  v_slug text;
  v_rand text := '';
  v_bytes bytea;
  i integer;
begin
  -- Eerst de accenten eraf: slugify laat alleen a-z en 0-9 staan, en zonder
  -- dit werd "Café Élan" "caf-lan".
  v_slug := translate(lower(coalesce(nullif(btrim(p_name), ''), 'portaal')),
                      'àáâãäåāèéêëēìíîïīòóôõöøōùúûüūýÿñç',
                      'aaaaaaaeeeeeiiiiiooooooouuuuuyync');
  v_slug := btrim(left(public.slugify(v_slug), 24), '-');
  if v_slug is null or v_slug = '' then v_slug := 'portaal'; end if;

  v_bytes := gen_random_bytes(10);
  for i in 0..9 loop
    v_rand := v_rand || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;

  return v_slug || '-' || v_rand;
end;
$$;

revoke all on function public.generate_portal_login_key(text) from public, anon, authenticated;
grant execute on function public.generate_portal_login_key(text) to service_role;

-- Het adres van één organisatie; bestaat het nog niet, dan nu. Voor de app
-- (Instellingen → Huisstijl, het klantdossier) en de edge functions die een
-- link naar het portaal mailen.
create or replace function public.ensure_portal_login_key(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text;
  v_name text;
  v_attempt integer := 0;
begin
  if p_organization_id is null then
    return null;
  end if;
  -- Wie het portaal van deze organisatie niet mag zien, krijgt het adres ook
  -- niet. Het hoort bij Klanten: daar staat de link naar het portaal.
  if auth.role() is distinct from 'service_role'
     and not public.can_read_module(p_organization_id, 'clients') then
    raise exception 'Geen toegang tot het klantportaal van deze organisatie.' using errcode = '42501';
  end if;

  select a.key into v_key from public.portal_login_addresses a where a.organization_id = p_organization_id;
  if v_key is not null then
    return v_key;
  end if;

  select coalesce(nullif(btrim(cs.trade_name), ''), nullif(btrim(cs.company_name), ''), o.name)
    into v_name
    from public.organizations o
    left join public.company_settings cs on cs.organization_id = o.id
   where o.id = p_organization_id;
  if not found then
    return null;
  end if;

  -- Twee gelijktijdige aanroepen voor dezelfde organisatie: de tweede doet
  -- niets (on conflict). Een botsing op de sleutel zelf is met 50 willekeurige
  -- bits vrijwel onmogelijk; dan gewoon een nieuwe.
  loop
    v_attempt := v_attempt + 1;
    begin
      insert into public.portal_login_addresses (organization_id, key)
      values (p_organization_id, public.generate_portal_login_key(v_name))
      on conflict (organization_id) do nothing;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  select a.key into v_key from public.portal_login_addresses a where a.organization_id = p_organization_id;
  return v_key;
end;
$$;

-- Zie supabase/functions/_shared/migrationGrants.test.ts.
revoke all on function public.ensure_portal_login_key(uuid) from public, anon;
grant execute on function public.ensure_portal_login_key(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Elke bestaande organisatie meteen een adres
-- ------------------------------------------------------------
-- Zodat de eerste mail na de uitrol al het eigen adres heeft. Een botsing op
-- de sleutel (on conflict) slaat die ene over; die krijgt hem bij het eerste
-- gebruik via ensure_portal_login_key.
insert into public.portal_login_addresses (organization_id, key)
select o.id,
       public.generate_portal_login_key(coalesce(nullif(btrim(cs.trade_name), ''), nullif(btrim(cs.company_name), ''), o.name))
  from public.organizations o
  left join public.company_settings cs on cs.organization_id = o.id
 where not exists (select 1 from public.portal_login_addresses a where a.organization_id = o.id)
on conflict do nothing;

-- ------------------------------------------------------------
-- 5. Een nieuwe administratie neemt de kleuren over van de moeder
-- ------------------------------------------------------------
-- De functie staat er verder onveranderd bij (laatste versie: 20261015000000),
-- want CREATE OR REPLACE kent geen patch. Alleen de vier inlogkolommen zijn
-- erbij gekomen.
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
      brand_logo_dark_data_url = parent.brand_logo_dark_data_url,
      brand_login_bg_color     = parent.brand_login_bg_color,
      brand_login_card_color   = parent.brand_login_card_color,
      brand_login_button_color = parent.brand_login_button_color,
      brand_login_plain        = parent.brand_login_plain
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
