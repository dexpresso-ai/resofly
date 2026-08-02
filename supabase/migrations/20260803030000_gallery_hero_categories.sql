-- ============================================================
-- ResoFly — Galerij: hero-templates + categorieën
-- Date: 2026-08-03
--
-- Aanleiding:
-- - Een fotogalerij opent met een hero: schermvullend beeld, split met tekst,
--   een collage van drie beelden, of alleen typografie. De hero-foto is de
--   bestaande `cover_item_id` — één begrip, geen tweede coverveld.
-- - Beeldmakers werken met terugkerende indelingen (Voorbereiding, Ceremonie,
--   Diner, Feest). Daarom een standaardlijst per organisatie die als startpunt
--   in elke nieuwe galerij landt, én per galerij aanpasbare categorieën.
--
-- Scope:
-- 1. galleries.hero_template (full | split | collage | minimal).
-- 2. gallery_category_presets: de standaardlijst per organisatie.
-- 3. gallery_categories: de categorieën ván één galerij (met volgorde).
-- 4. gallery_items.category_id + bewaking dat de categorie bij dezelfde
--    galerij hoort.
-- 5. Trigger die bij een nieuwe galerij de standaardlijst overneemt.
--
-- Beveiliging:
-- - Beide nieuwe tabellen krijgen de standaard org-policies plus de
--   restrictive module-gate op 'projects', net als de rest van de galerij.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Hero-template op de galerij
-- ------------------------------------------------------------
alter table public.galleries
  add column if not exists hero_template text not null default 'full';

alter table public.galleries drop constraint if exists galleries_hero_template_check;
alter table public.galleries
  add constraint galleries_hero_template_check
  check (hero_template in ('full', 'split', 'collage', 'minimal'));

comment on column public.galleries.hero_template is
  'Opening van de galerij: full = schermvullend beeld, split = beeld naast tekst, collage = drie beelden, minimal = alleen typografie. De hero-foto is cover_item_id.';

-- ------------------------------------------------------------
-- 2. Standaardlijst met categorieën per organisatie
-- ------------------------------------------------------------
create table if not exists public.gallery_category_presets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3. Categorieën binnen één galerij
-- ------------------------------------------------------------
create table if not exists public.gallery_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  gallery_id uuid not null references public.galleries(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 4. Koppeling item → categorie
-- ------------------------------------------------------------
alter table public.gallery_items
  add column if not exists category_id uuid references public.gallery_categories(id) on delete set null;

create index if not exists idx_gallery_items_category on public.gallery_items (category_id);
create index if not exists idx_gallery_categories_gallery on public.gallery_categories (gallery_id, position, created_at);
create index if not exists idx_gallery_category_presets_org on public.gallery_category_presets (organization_id, position, created_at);

-- Namen uniek binnen hun bereik (hoofdletterongevoelig).
create unique index if not exists idx_gallery_categories_unique_name
  on public.gallery_categories (gallery_id, lower(name));
create unique index if not exists idx_gallery_category_presets_unique_name
  on public.gallery_category_presets (organization_id, lower(name));

-- ------------------------------------------------------------
-- 5. Guards
-- ------------------------------------------------------------
create or replace function public.enforce_gallery_category_guard()
returns trigger
language plpgsql
as $$
begin
  new.name := btrim(coalesce(new.name, ''));
  if new.name = '' then
    raise exception 'Naam van de categorie is verplicht.' using errcode = '23514';
  end if;
  if length(new.name) > 60 then
    raise exception 'Naam van de categorie mag maximaal 60 tekens zijn.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists gallery_categories_guard on public.gallery_categories;
create trigger gallery_categories_guard
  before insert or update of name on public.gallery_categories
  for each row execute function public.enforce_gallery_category_guard();

drop trigger if exists gallery_category_presets_guard on public.gallery_category_presets;
create trigger gallery_category_presets_guard
  before insert or update of name on public.gallery_category_presets
  for each row execute function public.enforce_gallery_category_guard();

create or replace function public.enforce_gallery_categories_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.galleries', new.gallery_id, new.organization_id, 'gallery_categories.gallery_id');
  if tg_op = 'UPDATE' and new.gallery_id is distinct from old.gallery_id then
    raise exception 'Een categorie kan niet naar een andere galerij worden verplaatst.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists gallery_categories_org_integrity on public.gallery_categories;
create trigger gallery_categories_org_integrity
  before insert or update of organization_id, gallery_id
  on public.gallery_categories
  for each row execute function public.enforce_gallery_categories_org_integrity();

-- Itemsoort én categorie moeten bij de galerij passen.
create or replace function public.enforce_gallery_items_org_integrity()
returns trigger
language plpgsql
as $$
declare
  v_format text;
  v_category_gallery uuid;
begin
  perform public.assert_same_org_reference('public.galleries', new.gallery_id, new.organization_id, 'gallery_items.gallery_id');

  -- Een item verhuizen naar een andere galerij is niet toegestaan: de R2-key
  -- bevat het oorspronkelijke galerij-id (kijk-tokens zijn per galerij), en
  -- favorieten + cover_item_id van de oude galerij zouden achterblijven met een
  -- verwijzing naar een item dat er niet meer in zit.
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

  -- Een categorie uit een ándere galerij zou een item onzichtbaar maken.
  if new.category_id is not null then
    select gc.gallery_id into v_category_gallery
    from public.gallery_categories gc
    where gc.id = new.category_id and gc.organization_id = new.organization_id;
    if v_category_gallery is null then
      raise exception 'Onbekende categorie voor dit galerij-item.' using errcode = '23514';
    end if;
    if v_category_gallery <> new.gallery_id then
      raise exception 'De categorie hoort niet bij deze galerij.' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists gallery_items_org_integrity on public.gallery_items;
create trigger gallery_items_org_integrity
  before insert or update of organization_id, gallery_id, media_type, category_id
  on public.gallery_items
  for each row execute function public.enforce_gallery_items_org_integrity();

-- ------------------------------------------------------------
-- 6. Nieuwe galerij begint met de standaardlijst
-- ------------------------------------------------------------
create or replace function public.seed_gallery_categories_from_presets()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.gallery_categories (organization_id, gallery_id, created_by, name, position)
  select new.organization_id, new.id, new.created_by, p.name, p.position
  from public.gallery_category_presets p
  where p.organization_id = new.organization_id
  order by p.position, p.created_at;
  return new;
end;
$$;

drop trigger if exists galleries_seed_categories on public.galleries;
create trigger galleries_seed_categories
  after insert on public.galleries
  for each row execute function public.seed_gallery_categories_from_presets();

-- ------------------------------------------------------------
-- 7. Huisregels-triggers + RLS
-- ------------------------------------------------------------
drop trigger if exists gallery_categories_touch_updated_at on public.gallery_categories;
create trigger gallery_categories_touch_updated_at
  before update on public.gallery_categories
  for each row execute function public.set_updated_at();

drop trigger if exists gallery_category_presets_touch_updated_at on public.gallery_category_presets;
create trigger gallery_category_presets_touch_updated_at
  before update on public.gallery_category_presets
  for each row execute function public.set_updated_at();

drop trigger if exists gallery_categories_prevent_org_change on public.gallery_categories;
create trigger gallery_categories_prevent_org_change
  before update of organization_id on public.gallery_categories
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists gallery_category_presets_prevent_org_change on public.gallery_category_presets;
create trigger gallery_category_presets_prevent_org_change
  before update of organization_id on public.gallery_category_presets
  for each row execute function public.prevent_organization_id_change();

alter table public.gallery_categories enable row level security;
alter table public.gallery_category_presets enable row level security;

drop policy if exists "gallery_categories read" on public.gallery_categories;
create policy "gallery_categories read" on public.gallery_categories for select using (
  public.can_read_org(organization_id)
);
drop policy if exists "gallery_categories insert" on public.gallery_categories;
create policy "gallery_categories insert" on public.gallery_categories for insert with check (
  public.can_write_org(organization_id)
);
drop policy if exists "gallery_categories update" on public.gallery_categories;
create policy "gallery_categories update" on public.gallery_categories for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);
drop policy if exists "gallery_categories delete" on public.gallery_categories;
create policy "gallery_categories delete" on public.gallery_categories for delete using (
  public.can_write_org(organization_id)
);

drop policy if exists "gallery_category_presets read" on public.gallery_category_presets;
create policy "gallery_category_presets read" on public.gallery_category_presets for select using (
  public.can_read_org(organization_id)
);
drop policy if exists "gallery_category_presets insert" on public.gallery_category_presets;
create policy "gallery_category_presets insert" on public.gallery_category_presets for insert with check (
  public.can_write_org(organization_id)
);
drop policy if exists "gallery_category_presets update" on public.gallery_category_presets;
create policy "gallery_category_presets update" on public.gallery_category_presets for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);
drop policy if exists "gallery_category_presets delete" on public.gallery_category_presets;
create policy "gallery_category_presets delete" on public.gallery_category_presets for delete using (
  public.can_write_org(organization_id)
);

do $$
begin
  perform public.apply_module_gate('gallery_categories', 'projects');
  perform public.apply_module_gate('gallery_category_presets', 'projects');
end $$;

commit;
