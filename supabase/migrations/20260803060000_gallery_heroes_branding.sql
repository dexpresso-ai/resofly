-- ============================================================
-- ResoFly — Meer hero-templates + eigen huisstijl op de galerij
-- Date: 2026-08-03
--
-- Aanleiding:
-- - De vier openingen waren te beperkt: er is behoefte aan moderne, klassieke
--   en uitgesproken spectaculaire varianten.
-- - Een oplevering hoort van de beeldmaker te zijn, niet van ResoFly. Daarom
--   een eigen logo, accentkleur en afsluiting op de galerij.
--
-- Scope:
-- 1. galleries.hero_template accepteert vijf extra varianten.
-- 2. company_settings krijgt huisstijlvelden. Het logo staat bewust als
--    data-URL in de database (zoals invoice_template_data_url): de PUBLIEKE
--    galerijpagina heeft geen sessie en dus geen media-token, dus een
--    R2-verwijzing zou daar niet te tonen zijn zonder een extra publiek pad.
--    De frontend schaalt het logo vóór opslag terug, zodat het klein blijft.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Extra hero-templates
-- ------------------------------------------------------------
alter table public.galleries drop constraint if exists galleries_hero_template_check;
alter table public.galleries
  add constraint galleries_hero_template_check
  check (hero_template in (
    -- Basis
    'full', 'minimal',
    -- Modern
    'editorial', 'frame', 'split',
    -- Klassiek
    'classic', 'collage',
    -- Spectaculair
    'cinematic', 'mosaic'
  ));

comment on column public.galleries.hero_template is
  'Opening van de galerij. Basis: full/minimal. Modern: editorial/frame/split. Klassiek: classic/collage. Spectaculair: cinematic/mosaic. De hero-foto is cover_item_id.';

-- ------------------------------------------------------------
-- 2. Huisstijl per organisatie
-- ------------------------------------------------------------
alter table public.company_settings
  add column if not exists brand_logo_data_url text,
  add column if not exists brand_accent_color text not null default '#FFD966',
  add column if not exists brand_footer_text text,
  add column if not exists brand_hide_powered_by boolean not null default false;

-- Alleen een hex-kleur; de waarde gaat rechtstreeks een CSS-variabele in.
alter table public.company_settings drop constraint if exists company_settings_brand_accent_color_check;
alter table public.company_settings
  add constraint company_settings_brand_accent_color_check
  check (brand_accent_color ~ '^#[0-9A-Fa-f]{6}$');

-- Alleen rasterformaten toestaan: een SVG-data-URL zou vreemde inhoud kunnen
-- bevatten, en we tonen het logo ook op de publieke pagina.
alter table public.company_settings drop constraint if exists company_settings_brand_logo_check;
alter table public.company_settings
  add constraint company_settings_brand_logo_check
  check (
    brand_logo_data_url is null
    or (
      brand_logo_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'
      and length(brand_logo_data_url) <= 400000
    )
  );

comment on column public.company_settings.brand_logo_data_url is
  'Logo als data-URL (png/jpeg/webp, max ~400 kB). Data-URL i.p.v. R2 omdat de publieke galerijpagina geen media-token heeft.';

commit;
