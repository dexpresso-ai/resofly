-- ============================================================
-- ResoFly — Galerij: likes naast favorieten
-- Date: 2026-08-03
--
-- Aanleiding:
-- - Favorieten zijn de persoonlijke selectie van één kijker: "deze wil ik".
--   Ze komen bij de beeldmaker terug als keuzelijst.
-- - Daarnaast wil de klant kunnen laten zien wát mooi is. Een like is een
--   zichtbare waardering: iedere bezoeker van de galerij ziet de teller.
--
-- Scope:
-- - Kolom `reaction` op gallery_favorites (favorite | like). Bewust dezelfde
--   tabel: het actor-model (portaalcontact óf deellink-sessie), de RLS, de
--   org-integriteitstrigger en de realtime-publicatie gelden dan ongewijzigd
--   voor beide reacties.
-- - De unieke indexen krijgen `reaction` erbij, zodat één kijker een foto
--   zowel kan liken als als favoriet kan markeren — maar elk hooguit één keer.
-- ============================================================

begin;

alter table public.gallery_favorites
  add column if not exists reaction text not null default 'favorite';

alter table public.gallery_favorites drop constraint if exists gallery_favorites_reaction_check;
alter table public.gallery_favorites
  add constraint gallery_favorites_reaction_check
  check (reaction in ('favorite', 'like'));

comment on column public.gallery_favorites.reaction is
  'favorite = persoonlijke selectie van de kijker; like = zichtbare waardering (teller voor iedereen).';

-- Uniciteit per kijker én reactiesoort.
drop index if exists idx_gallery_favorites_contact_unique;
drop index if exists idx_gallery_favorites_session_unique;

create unique index if not exists idx_gallery_favorites_contact_unique
  on public.gallery_favorites (item_id, contact_id, reaction)
  where contact_id is not null;

create unique index if not exists idx_gallery_favorites_session_unique
  on public.gallery_favorites (item_id, session_key, reaction)
  where session_key is not null;

create index if not exists idx_gallery_favorites_item_reaction
  on public.gallery_favorites (item_id, reaction);

commit;
