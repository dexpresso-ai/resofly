-- ============================================================
-- ResoFly — Handgeschreven notities (pen op tablet)
-- Date: 2026-09-16
--
-- Een notitie krijgt naast de getypte inhoud een handgeschreven laag: wat je
-- met een pen op een tablet schrijft, alsof je op een reMarkable werkt. De
-- lijnen worden als vectoren bewaard (geen bitmap), zodat ze op elk scherm
-- scherp blijven, later nog te gummen zijn en klein blijven in de database.
--
-- Ontwerp:
-- - Eén rij per notitie (`note_id` uniek). Verdwijnt de notitie, dan verdwijnt
--   het handschrift mee (`on delete cascade`).
-- - `pages` is het inktdocument: een lijst pagina's met lijnen (zie
--   src/lib/ink.ts, versie 1). De browser leest en schrijft dit als geheel.
-- - `page_count`/`stroke_count` zijn samenvattende tellers zodat lijsten en
--   agenda-kaarten "handschrift · 2 pagina's" kunnen tonen zonder de zware
--   `pages`-kolom mee te laden.
-- - Bewust een aparte tabel en geen kolom op `notes`: de werkruimte laadt
--   alle notities in één keer (select *), en de inkt kan honderden kilobytes
--   per notitie zijn.
--
-- Beveiliging: dezelfde regels als de notitie zelf — lezen bij leesrecht op de
-- organisatie, schrijven bij schrijfrecht, en de modulegate van Inhoud
-- (`content`) waar notities onder vallen.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create table if not exists public.note_handwriting (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  -- Inktdocument (versie 1): { version, width, height, pages: [{ id, paper, strokes: [...] }] }.
  pages jsonb not null default '{"version":1,"width":1000,"height":1414,"pages":[]}'::jsonb,
  page_count integer not null default 0 check (page_count >= 0),
  stroke_count integer not null default 0 check (stroke_count >= 0),
  paper text not null default 'lined' check (paper in ('blank', 'lined', 'dotted', 'grid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_id)
);

comment on table public.note_handwriting is
  'Handgeschreven laag (pen op tablet) per notitie: vectorlijnen per pagina, als jsonb. Eén rij per notitie.';
comment on column public.note_handwriting.pages is
  'Inktdocument versie 1 (src/lib/ink.ts): pagina''s met lijnen als platte [x,y,druk]-reeksen in paginacoördinaten.';
comment on column public.note_handwriting.page_count is
  'Aantal pagina''s met inhoud; samenvatting voor lijsten zodat `pages` niet mee hoeft te laden.';

create index if not exists idx_note_handwriting_org
  on public.note_handwriting (organization_id, updated_at desc);

-- ── Grens op de grootte ────────────────────────────────────────────────
-- Een pagina vol handschrift is enkele tienduizenden punten; tien pagina's
-- blijven ruim onder deze grens. De grens voorkomt dat één notitie de
-- werkruimte of de database dichtslibt.
create or replace function public.validate_note_handwriting()
returns trigger
language plpgsql
as $$
declare
  v_note_org uuid;
begin
  select organization_id into v_note_org from public.notes where id = new.note_id;
  if v_note_org is null then
    raise exception 'note_handwriting.note_id verwijst naar een niet-bestaande notitie' using errcode = '23514';
  end if;
  if v_note_org <> new.organization_id then
    raise exception 'note_handwriting.organization_id wijkt af van de gekoppelde notitie' using errcode = '23514';
  end if;

  if jsonb_typeof(new.pages) <> 'object' or jsonb_typeof(new.pages -> 'pages') <> 'array' then
    raise exception 'note_handwriting.pages moet een inktdocument met een pages-lijst zijn' using errcode = '23514';
  end if;
  if pg_column_size(new.pages) > 6 * 1024 * 1024 then
    raise exception 'Dit handschrift is te groot om op te slaan (maximaal 6 MB per notitie). Verdeel het over meerdere notities.' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists note_handwriting_validate on public.note_handwriting;
create trigger note_handwriting_validate
  before insert or update on public.note_handwriting
  for each row execute function public.validate_note_handwriting();

drop trigger if exists note_handwriting_prevent_org_change on public.note_handwriting;
create trigger note_handwriting_prevent_org_change
  before update of organization_id on public.note_handwriting
  for each row execute function public.prevent_organization_id_change();

-- Alleen aanmaken en verwijderen in de audit: het handschrift slaat tijdens het
-- schrijven om de paar seconden automatisch op, en elke pennenstreek als
-- "bijgewerkt" in de tijdlijn zou de activiteitenlijst dichtslibben.
drop trigger if exists note_handwriting_audit on public.note_handwriting;
create trigger note_handwriting_audit
  after insert or delete on public.note_handwriting
  for each row execute function public.audit_row_change('note_handwriting', 'note_id');

-- ── RLS ─────────────────────────────────────────────────────────────────
alter table public.note_handwriting enable row level security;

drop policy if exists "note handwriting read" on public.note_handwriting;
create policy "note handwriting read" on public.note_handwriting for select using (
  public.can_read_org(organization_id)
);
drop policy if exists "note handwriting insert" on public.note_handwriting;
create policy "note handwriting insert" on public.note_handwriting for insert with check (
  public.can_write_org(organization_id)
  and exists (
    select 1 from public.notes note
    where note.id = note_handwriting.note_id
      and note.organization_id = note_handwriting.organization_id
  )
);
drop policy if exists "note handwriting update" on public.note_handwriting;
create policy "note handwriting update" on public.note_handwriting for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);
drop policy if exists "note handwriting delete" on public.note_handwriting;
create policy "note handwriting delete" on public.note_handwriting for delete using (
  public.can_write_org(organization_id)
);

-- Modulegate: notities vallen onder Inhoud, het handschrift dus ook.
select public.apply_module_gate('note_handwriting', 'content');

commit;
