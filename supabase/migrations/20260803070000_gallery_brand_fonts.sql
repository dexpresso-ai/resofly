-- ============================================================
-- ResoFly — Huisstijl: eigen lettertypen
-- Date: 2026-08-03
--
-- Aanleiding:
-- - Kleur en logo maakten de galerij al eigen; typografie bepaalt minstens
--   zoveel van de uitstraling. Beeldmakers kiezen nu zelf een kop- en een
--   tekstlettertype.
--
-- Ontwerp:
-- - We bewaren een SLEUTEL uit een vaste lijst (bijv. 'playfair'), niet een
--   vrije font-family. De frontend vertaalt die sleutel naar een lettertype;
--   een onbekende sleutel valt terug op de standaard. Zo kan er nooit
--   willekeurige CSS via deze waarde de pagina in.
-- ============================================================

begin;

alter table public.company_settings
  add column if not exists brand_heading_font text not null default 'system',
  add column if not exists brand_body_font text not null default 'system';

-- Alleen een korte, eenvoudige sleutel; de betekenis zit in de frontend-lijst.
alter table public.company_settings drop constraint if exists company_settings_brand_fonts_check;
alter table public.company_settings
  add constraint company_settings_brand_fonts_check
  check (
    brand_heading_font ~ '^[a-z][a-z0-9-]{0,23}$'
    and brand_body_font ~ '^[a-z][a-z0-9-]{0,23}$'
  );

comment on column public.company_settings.brand_heading_font is
  'Sleutel uit de lettertypelijst in src/lib/branding.ts (koppen). Nooit rechtstreeks als CSS gebruiken.';
comment on column public.company_settings.brand_body_font is
  'Sleutel uit de lettertypelijst in src/lib/branding.ts (lopende tekst).';

commit;
