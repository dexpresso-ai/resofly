-- ============================================================
-- ResoFly — Eigen achtergrond voor de galerij
-- Date: 2026-08-03
--
-- Aanleiding:
-- - De galerij was altijd nachtzwart. Beeldmakers willen zelf bepalen waarop
--   hun werk ligt: donker voor filmisch werk, gebroken wit voor luchtige
--   reportages.
--
-- Ontwerp:
-- - Eén hexwaarde. De frontend leidt daar de rest van het palet uit af
--   (tekst, gedempte tekst, randen, tegelvlak) op basis van de helderheid,
--   zodat een lichte achtergrond automatisch donkere tekst krijgt. Zo hoeft
--   de gebruiker maar één ding te kiezen en blijft het altijd leesbaar.
-- ============================================================

begin;

alter table public.company_settings
  add column if not exists brand_gallery_bg text not null default '#0B0B0B';

alter table public.company_settings drop constraint if exists company_settings_brand_gallery_bg_check;
alter table public.company_settings
  add constraint company_settings_brand_gallery_bg_check
  check (brand_gallery_bg ~ '^#[0-9A-Fa-f]{6}$');

comment on column public.company_settings.brand_gallery_bg is
  'Achtergrondkleur van de galerij bij de klant. De frontend leidt het contrastpalet hieruit af (zie src/lib/branding.ts).';

commit;
