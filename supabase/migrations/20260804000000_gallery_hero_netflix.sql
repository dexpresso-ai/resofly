-- ============================================================
-- ResoFly — Galerij: filmische kopvideo ("netflix"-opening)
-- Date: 2026-08-04
--
-- Aanleiding:
-- - Een videogalerij verdient de opening die kijkers van streamingdiensten
--   kennen: één grote kopvideo die stil meespeelt, met de titel eroverheen, en
--   daaronder de overige video's in horizontale rijen.
--
-- Ontwerp:
-- - Alleen een nieuwe waarde voor hero_template. De KOPVIDEO is bewust de
--   bestaande `cover_item_id` — hetzelfde veld waarmee je bij een fotogalerij
--   de coverfoto aanwijst. Eén begrip, één sterretje in de beheerweergave, en
--   dus geen tweede kolom die uit de pas kan gaan lopen.
-- - Geen extra kolommen nodig: het afspelen loopt via de Stream-kijkkopie
--   (stream_uid) en de download via de R2-master (storage_key), precies zoals
--   elke andere video in de galerij.
-- ============================================================

begin;

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
    'cinematic', 'mosaic', 'netflix'
  ));

comment on column public.galleries.hero_template is
  'Opening van de galerij. Basis: full/minimal. Modern: editorial/frame/split. Klassiek: classic/collage. Spectaculair: cinematic/mosaic/netflix. De hero-foto (of kopvideo bij netflix) is cover_item_id.';

commit;
