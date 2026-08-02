-- ============================================================
-- ResoFly — Galerijformaat: foto, video of hybride
-- Date: 2026-08-03
--
-- Aanleiding:
-- - Een galerij is bij het aanmaken al van een bepaald soort: een
--   fotogalerij (grid), een videogalerij (Netflix-achtige rijen) of een
--   hybride oplevering met beide. Het formaat bepaalt de weergave bij de
--   klant én welke bestanden er in mogen.
--
-- Scope:
-- - Kolom `format` op galleries (photo | video | hybrid), standaard 'hybrid'
--   zodat bestaande galerijen ongewijzigd blijven werken.
-- - Serverzijdige bewaking: een item van het verkeerde soort komt de galerij
--   niet in, en een formaatwijziging die bestaande media zou verstoten wordt
--   geweigerd. De frontend filtert al bij de bestandskiezer; deze triggers
--   zijn de harde grens (ook voor edge functions en de worker, die op de
--   service-role draaien en RLS omzeilen).
-- ============================================================

begin;

alter table public.galleries
  add column if not exists format text not null default 'hybrid';

alter table public.galleries drop constraint if exists galleries_format_check;
alter table public.galleries
  add constraint galleries_format_check
  check (format in ('photo', 'video', 'hybrid'));

comment on column public.galleries.format is
  'photo = alleen foto''s (grid), video = alleen video''s (Netflix-rijen), hybrid = beide.';

-- ------------------------------------------------------------
-- 1. Itemsoort moet bij het galerijformaat passen
-- ------------------------------------------------------------
create or replace function public.enforce_gallery_items_org_integrity()
returns trigger
language plpgsql
as $$
declare
  v_format text;
begin
  perform public.assert_same_org_reference('public.galleries', new.gallery_id, new.organization_id, 'gallery_items.gallery_id');

  -- Een item verhuizen naar een andere galerij is niet toegestaan: de R2-key
  -- bevat het oorspronkelijke galerij-id (kijk-tokens zijn per galerij), en
  -- favorieten + cover_item_id van de oude galerij zouden achterblijven met een
  -- verwijzing naar een item dat er niet meer in zit. De app biedt verplaatsen
  -- niet aan; wie wil verplaatsen, uploadt opnieuw.
  if tg_op = 'UPDATE' and new.gallery_id is distinct from old.gallery_id then
    raise exception 'Een galerij-item kan niet naar een andere galerij worden verplaatst.' using errcode = '23514';
  end if;

  select g.format into v_format from public.galleries g where g.id = new.gallery_id;
  if v_format = 'photo' and new.media_type <> 'photo' then
    raise exception 'Dit is een fotogalerij; video''s horen in een video- of hybride galerij.' using errcode = '23514';
  end if;
  if v_format = 'video' and new.media_type <> 'video' then
    raise exception 'Dit is een videogalerij; foto''s horen in een foto- of hybride galerij.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists gallery_items_org_integrity on public.gallery_items;
create trigger gallery_items_org_integrity
  before insert or update of organization_id, gallery_id, media_type
  on public.gallery_items
  for each row execute function public.enforce_gallery_items_org_integrity();

-- ------------------------------------------------------------
-- 2. Formaat wijzigen mag alleen als de bestaande media meegaan
-- ------------------------------------------------------------
create or replace function public.enforce_galleries_guard()
returns trigger
language plpgsql
as $$
declare
  v_conflicts integer;
begin
  new.title := btrim(coalesce(new.title, ''));
  if new.title = '' then
    raise exception 'Titel van de galerij is verplicht.' using errcode = '23514';
  end if;
  new.description := nullif(btrim(coalesce(new.description, '')), '');

  -- Publicatiemoment vastleggen bij de overgang naar published.
  -- (OLD niet aanraken op INSERT; kortsluiting is niet gegarandeerd.)
  if new.status = 'published' and new.published_at is null then
    if tg_op = 'INSERT' then
      new.published_at := now();
    elsif old.status is distinct from 'published' then
      new.published_at := now();
    end if;
  end if;

  -- Formaatwijziging: weiger zodra er media in zitten die er dan niet meer
  -- in horen. Zo kan een oplevering nooit stilletjes items verbergen.
  if tg_op = 'UPDATE' and new.format is distinct from old.format and new.format <> 'hybrid' then
    select count(*) into v_conflicts
    from public.gallery_items gi
    where gi.gallery_id = new.id
      and gi.media_type <> new.format;
    if v_conflicts > 0 then
      raise exception 'Deze galerij bevat % item(s) die niet in het gekozen formaat passen. Verwijder ze eerst of kies het hybride formaat.', v_conflicts
        using errcode = '23514';
    end if;
  end if;

  -- Cover moet een item van deze galerij zijn.
  if new.cover_item_id is not null then
    if not exists (
      select 1 from public.gallery_items gi
      where gi.id = new.cover_item_id and gi.gallery_id = new.id
    ) then
      raise exception 'Coverfoto hoort niet bij deze galerij.' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists galleries_guard on public.galleries;
create trigger galleries_guard
  before insert or update of title, description, status, format, cover_item_id
  on public.galleries
  for each row execute function public.enforce_galleries_guard();

commit;
