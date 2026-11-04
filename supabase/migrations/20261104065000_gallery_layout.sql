-- ============================================================
-- ResoFly — Galerij: de weergave van het album
-- Date: 2026-11-04
--
-- Aanleiding:
-- - Een galerij had wel zestien openingen, maar daaronder stond elk album er
--   hetzelfde bij: rijen die de breedte vullen, 6 px ertussen, afgeronde hoeken.
--   Een bruiloft vraagt om lucht en rust, een modeshoot om een strak raster, een
--   moodboard om iets speels. De beeldmaker bepaalt nu zelf de indeling, de
--   witruimte, het aantal kolommen en hoe speels het album oogt — los van de
--   opening (hero + cover), die blijft wat hij was.
-- - Speelsheid kiest zelf een ritme. Met "groot tonen" wijst de beeldmaker ook
--   zelf de beelden aan die een grote plek verdienen.
--
-- Scope:
-- 1. galleries.layout (jsonb): de weergave. '{}' = de standaard, en die geeft
--    exact de weergave van vóór deze migratie. Bestaande galerijen veranderen
--    dus niet.
-- 2. Trigger galleries_layout_guard: alleen bekende instellingen met geldige
--    waarden komen erin, met een leesbare melding als dat niet zo is. Dezelfde
--    regels staan in src/lib/galleryLayout.ts en de kopie in
--    supabase/functions/_shared/galleryLayout.ts; src/lib/galleryLayout.test.ts
--    vergelijkt de lijsten hieronder met die bestanden.
-- 3. gallery_items.featured: "groot tonen" — de foto krijgt in elke indeling een
--    grote plek.
--
-- Beveiliging:
-- - Geen nieuwe rechten: beide kolommen vallen onder de bestaande RLS van
--   galleries en gallery_items (can_read_org / can_write_org + de modulegate).
-- - De edge functions die een galerij naar buiten geven (client-portal,
--   gallery-public) sturen de weergave alleen gesaneerd mee, uit een vaste lijst
--   sleutels; de trigger is de harde grens daarachter, ook voor de service-role.
-- - De triggerfunctie is geen security definer en wordt niet los aangeroepen.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. De weergave
-- ------------------------------------------------------------
alter table public.galleries
  add column if not exists layout jsonb not null default '{}'::jsonb;

alter table public.galleries drop constraint if exists galleries_layout_object_check;
alter table public.galleries
  add constraint galleries_layout_object_check
  check (jsonb_typeof(layout) = 'object');

comment on column public.galleries.layout is
  'Weergave van het album, los van de opening: style (rows/masonry/grid/story/prints), columns, phone_columns, gap (px), width, section_spacing, playfulness (0-3), tile_shape, corners, frame, hover, reveal, headings, video_layout, video_size. Leeg object = de standaardweergave. Bewaakt door trigger galleries_layout_guard.';

-- ------------------------------------------------------------
-- 2. Alleen bekende instellingen, met geldige waarden
-- ------------------------------------------------------------
create or replace function public.enforce_gallery_layout_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  -- Keuzelijsten per instelling. Gelijk aan de constanten in
  -- src/lib/galleryLayout.ts (de test leest dit blok tussen de twee markeringen).
  -- layout-keuzes:begin
  v_choices constant jsonb := '{
    "style": ["rows", "masonry", "grid", "story", "prints"],
    "width": ["full", "wide", "medium", "narrow"],
    "section_spacing": ["tight", "normal", "airy", "grand"],
    "tile_shape": ["square", "portrait", "landscape"],
    "corners": ["square", "subtle", "soft", "round"],
    "frame": ["none", "mat", "line", "shadow"],
    "hover": ["zoom", "lift", "none"],
    "headings": ["label", "title", "numbered"],
    "video_layout": ["auto", "rows", "grid"],
    "video_size": ["small", "medium", "large"]
  }'::jsonb;
  -- Hele getallen: [minimum, maximum, leeg toegestaan (= automatisch)].
  v_numbers constant jsonb := '{
    "columns": [1, 8, true],
    "phone_columns": [1, 3, true],
    "gap": [0, 64, false],
    "playfulness": [0, 3, false]
  }'::jsonb;
  -- layout-keuzes:eind
  v_key text;
  v_value jsonb;
  v_number numeric;
begin
  new.layout := coalesce(new.layout, '{}'::jsonb);

  if jsonb_typeof(new.layout) <> 'object' then
    raise exception 'De weergave van de galerij moet een object zijn.' using errcode = '23514';
  end if;
  -- Ruim boven wat de app schrijft (zo'n 300 bytes); dit is een vangnet tegen
  -- een veld dat als opslag voor iets anders wordt misbruikt.
  if pg_column_size(new.layout) > 4096 then
    raise exception 'De weergave van de galerij is te groot.' using errcode = '23514';
  end if;

  for v_key, v_value in select e.key, e.value from jsonb_each(new.layout) as e loop
    if v_choices ? v_key then
      if jsonb_typeof(v_value) <> 'string' or not ((v_choices -> v_key) ? (v_value #>> '{}')) then
        raise exception 'De weergave van de galerij heeft een ongeldige waarde voor "%".', v_key
          using errcode = '23514';
      end if;
    elsif v_numbers ? v_key then
      if jsonb_typeof(v_value) = 'null' and (v_numbers -> v_key ->> 2)::boolean then
        continue;
      end if;
      if jsonb_typeof(v_value) <> 'number' then
        raise exception 'De weergave van de galerij verwacht een getal voor "%".', v_key
          using errcode = '23514';
      end if;
      v_number := (v_value #>> '{}')::numeric;
      if v_number <> trunc(v_number)
         or v_number < (v_numbers -> v_key ->> 0)::numeric
         or v_number > (v_numbers -> v_key ->> 1)::numeric then
        raise exception 'De weergave van de galerij verwacht voor "%" een heel getal van % tot en met %.',
          v_key, v_numbers -> v_key ->> 0, v_numbers -> v_key ->> 1
          using errcode = '23514';
      end if;
    elsif v_key = 'reveal' then
      if jsonb_typeof(v_value) <> 'boolean' then
        raise exception 'De weergave van de galerij verwacht aan of uit voor "reveal".' using errcode = '23514';
      end if;
    else
      raise exception 'De weergave van de galerij kent de instelling "%" niet.', v_key
        using errcode = '23514';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists galleries_layout_guard on public.galleries;
create trigger galleries_layout_guard
  before insert or update of layout
  on public.galleries
  for each row execute function public.enforce_gallery_layout_guard();

-- ------------------------------------------------------------
-- 3. Groot tonen
-- ------------------------------------------------------------
alter table public.gallery_items
  add column if not exists featured boolean not null default false;

comment on column public.gallery_items.featured is
  'Groot tonen: de beeldmaker heeft deze foto uitgelicht. Elke indeling geeft hem een grote plek (een eigen rij, een tegel van 2×2, twee kolommen breed).';

commit;
