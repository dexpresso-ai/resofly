-- ============================================================
-- Pagina's: een regel in een takenlijst wordt een taak (stap 2-2a van
-- docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md, §18).
--
-- Een taak onthoudt uit welke pagina en welke regel ze komt:
--   page_id        de pagina (documents, format 'page');
--   page_block_id  het id van de regel. Elk blok heeft er een (UniqueID in
--                  de editor, een uuid).
--
-- De link staat bij de taak, niet in de pagina. Wie Projecten niet mag lezen,
-- ziet in de pagina een gewone takenlijst, en de klant en de export zien de
-- regel, niet de taak (regel 3). De body van een pagina verandert dus niet,
-- en page_body_problem ook niet.
--
-- Geen foreign key naar documents. Met "on delete set null" wijzigt het
-- definitief wissen van een pagina ook de taak, en dan houdt de schrijfpoort
-- van Projecten (zzz_module_write_gate op tasks) dat tegen voor wie alleen
-- Inhoud mag schrijven: het wissen zou mislukken. ticket_id heeft zo'n
-- foreign key wel, en daar zit hetzelfde.
-- De database controleert de link daarom bij het schrijven: een pagina van
-- dezelfde organisatie, die wie de taak opslaat mag lezen. Na definitief
-- wissen blijft er een id staan dat nergens meer heen wijst; de app toont dan
-- geen "Uit pagina".
--
-- Mag veilig opnieuw draaien: if not exists, create or replace en drop ...
-- if exists.
-- ============================================================

alter table public.tasks add column if not exists page_id uuid;
alter table public.tasks add column if not exists page_block_id uuid;

comment on column public.tasks.page_id is
  'De pagina waar deze taak uit kwam (stap 2-2a). Bewust zonder foreign key: zie 20261128170000_paginas_taken.sql.';
comment on column public.tasks.page_block_id is
  'Het id van de regel in die pagina (UniqueID).';

-- Een regel zonder pagina zegt niets.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_page_block_needs_page' and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_page_block_needs_page check (page_block_id is null or page_id is not null);
  end if;
end $$;

-- Eén taak per regel. Twee keer klikken, of twee collega's tegelijk, gaf
-- anders twee taken voor hetzelfde actiepunt.
create unique index if not exists tasks_page_block_unique
  on public.tasks (page_id, page_block_id)
  where page_block_id is not null;

-- De taken van een pagina, voor het label achter de regel.
create index if not exists tasks_page
  on public.tasks (organization_id, page_id)
  where page_id is not null;

-- De controle bij het schrijven. Met de rechten van wie opslaat (geen security
-- definer), zoals assert_same_org_reference bij de klant, het project en het
-- ticket van een taak: wie de pagina niet mag lezen (Inhoud, niet in de
-- prullenbak), kan er geen taak aan koppelen.
--
-- Alleen als de pagina verandert. Bij elke wijziging opnieuw controleren zou
-- wie Inhoud niet mag lezen een taak uit een pagina niet meer laten
-- verplaatsen, afvinken of hernoemen.
create or replace function public.tasks_page_link_check()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.page_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.page_id is not distinct from old.page_id then
    return new;
  end if;
  if not exists (
    select 1 from public.documents d
    where d.id = new.page_id
      and d.organization_id = new.organization_id
      and d.format = 'page'
  ) then
    raise exception 'tasks.page_id verwijst naar een pagina buiten de organisatie, een pagina die je niet mag lezen, of iets dat geen pagina is'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.tasks_page_link_check() from public, anon, authenticated;

drop trigger if exists tasks_page_link on public.tasks;
create trigger tasks_page_link
  before insert or update of page_id, page_block_id on public.tasks
  for each row execute function public.tasks_page_link_check();
