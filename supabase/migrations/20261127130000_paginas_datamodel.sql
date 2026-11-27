-- ============================================================
-- ResoFly — Pagina's: het datamodel (stap 1A-1)
-- Date: 2026-11-27
--
-- Een pagina is een webpagina in ResoFly: blokken, subpagina's, gewone
-- tabellen (docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md, §3 tot §6 en §18).
-- Deze migratie legt alleen het fundament; de app gebruikt het vanaf 1A-2.
--
--   1. documents krijgt de kolommen van een pagina. Een pagina is een rij met
--      format = 'page' en de inhoud als ProseMirror-JSON in body. Waarom geen
--      nieuwe tabel: delen, het portaal, het logboek, het opslagquotum, de
--      opruimwachtrij en de handelingen van Gerrie werken al op documents.
--   2. De database houdt content (platte tekst) en excerpt (de korte tekst
--      voor tegels) bij, zodat die ook kloppen als Gerrie, de API of de
--      Word-editor schrijft.
--   3. body wordt gecontroleerd bij elke schrijfweg: alleen bekende blokken
--      en opmaak, links naar https:, http:, mailto: of tel:, en afbeeldingen
--      alleen als bestand in ResoFly (geen plaatje van buiten: in een
--      klantpagina zou dat een volgpixel zijn).
--   4. De boom: parent_id naar een andere pagina, in dezelfde organisatie,
--      zonder kring en hoogstens 20 diep. Klant en project gelden voor de hele
--      boom; alleen de bovenste pagina staat in een map.
--   5. Wie een pagina bewerkt, staat in document_edit_claims, niet op de rij
--      zelf: een trigger zet updated_at bij elke wijziging, en een hartslag
--      elke 30 seconden zou "laatst gewijzigd" anders steeds verzetten.
--   6. Versies in document_versions, alleen via save_page_version en
--      restore_page_version.
--   7. Zoeken in titel en tekst met search_documents, op een expressie-index
--      (geen extra kolom: die zou tot 1A-2 bij elke start meeladen).
--   8. Het logboek kent de nieuwe velden. body en content komen erin als
--      "gewijzigd", zonder de tekst.
--   9. Bij een pagina loopt edit_version op als de inhoud of de titel
--      verandert, zodat de app ziet dat iemand anders intussen schreef. Een
--      wijziging van alleen content wordt geweigerd: die tekst komt uit body,
--      en zou anders stil verdwijnen (zoals bij "tekst aanvullen" van Gerrie).
--  10. Een pagina delen kan pas vanaf stap 1C, met de vrijgegeven versie. Tot
--      dan neemt een gedeelde map geen pagina's mee, en weigert de database
--      een deling van een pagina. Anders zag een klant de live tekst.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. De kolommen van een pagina ───────────────────────────────────────────

alter table public.documents add column if not exists format text not null default 'html';
alter table public.documents add column if not exists body jsonb;
alter table public.documents add column if not exists parent_id uuid references public.documents(id) on delete cascade;
alter table public.documents add column if not exists position integer not null default 0;
alter table public.documents add column if not exists icon text;
alter table public.documents add column if not exists cover jsonb;
alter table public.documents add column if not exists full_width boolean not null default false;
alter table public.documents add column if not exists excerpt text not null default '';
alter table public.documents add column if not exists archived_at timestamptz;
alter table public.documents add column if not exists archived_by uuid references auth.users(id) on delete set null;

alter table public.documents drop constraint if exists documents_format_check;
alter table public.documents add constraint documents_format_check
  check (format in ('html', 'page', 'office'));
-- Een pagina heeft altijd een body, de andere soorten nooit.
alter table public.documents drop constraint if exists documents_page_body_check;
alter table public.documents add constraint documents_page_body_check
  check ((format = 'page') = (body is not null));
alter table public.documents drop constraint if exists documents_parent_page_check;
alter table public.documents add constraint documents_parent_page_check
  check (parent_id is null or format = 'page');
alter table public.documents drop constraint if exists documents_icon_length_check;
alter table public.documents add constraint documents_icon_length_check
  check (icon is null or char_length(icon) <= 64);
alter table public.documents drop constraint if exists documents_cover_shape_check;
alter table public.documents add constraint documents_cover_shape_check
  check (cover is null or jsonb_typeof(cover) = 'object');

create index if not exists idx_documents_parent
  on public.documents (organization_id, parent_id, position) where parent_id is not null;

-- ── 2. Welke bouwstenen een pagina mag hebben ──────────────────────────────
-- Eén plek. De spiegel staat in src/lib/pageSchema.ts; pageSchema.test.ts
-- houdt de twee gelijk. De namen zijn die van Tiptap, de editor van 1A-3; een
-- nieuw bloktype (zoals vermeldingen in fase 2) vraagt een nieuwe migratie.

create or replace function public.page_body_allowed()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'nodes', jsonb_build_array(
      'doc', 'paragraph', 'text', 'hardBreak', 'heading',
      'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
      'blockquote', 'codeBlock', 'horizontalRule',
      'table', 'tableRow', 'tableHeader', 'tableCell',
      'image', 'fileBlock', 'callout', 'details', 'detailsSummary', 'detailsContent',
      'columns', 'column', 'tableOfContents', 'subpage'
    ),
    'marks', jsonb_build_array('bold', 'italic', 'underline', 'strike', 'code', 'link', 'highlight'),
    'link_pattern', '^(https?:|mailto:|tel:|/|#)'
  );
$$;

-- Deze hulpjes draaien in de triggers hieronder, onder wie schrijft: dicht voor
-- anon, open voor ingelogde gebruikers.
revoke all on function public.page_body_allowed() from public, anon;

-- De reden waarom body niet mag, of null als hij goed is. Per laag tegelijk
-- (set-gebaseerd), want dit draait bij elke keer automatisch opslaan.
create or replace function public.page_body_problem(p_body jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_allowed jsonb := public.page_body_allowed();
  v_level jsonb;
  v_depth integer := 0;
  v_count integer := 0;
  v_bad text;
begin
  if p_body is null then
    return null;
  end if;
  if pg_column_size(p_body) > 2000000 then
    return 'De pagina is te groot (hoogstens 2 MB).';
  end if;
  if jsonb_typeof(p_body) <> 'object' or p_body->>'type' is distinct from 'doc' then
    return 'Een pagina begint met een document.';
  end if;

  v_level := jsonb_build_array(p_body);
  loop
    exit when jsonb_array_length(v_level) = 0;
    v_depth := v_depth + 1;
    if v_depth > 40 then
      return 'De pagina is te diep genest.';
    end if;
    v_count := v_count + jsonb_array_length(v_level);
    if v_count > 50000 then
      return 'De pagina heeft te veel blokken.';
    end if;

    -- Elk blok: een object met een bekend type; content en marks zijn lijsten.
    select coalesce(n->>'type', '(geen type)') into v_bad
    from jsonb_array_elements(v_level) n
    where jsonb_typeof(n) <> 'object'
       or not ((v_allowed->'nodes') ? coalesce(n->>'type', ''))
       or (n ? 'content' and jsonb_typeof(n->'content') <> 'array')
       or (n ? 'marks' and jsonb_typeof(n->'marks') <> 'array')
    limit 1;
    if v_bad is not null then
      return format('Onbekend of kapot blok: %s.', v_bad);
    end if;

    -- Tekst is tekst.
    if exists (
      select 1 from jsonb_array_elements(v_level) n
      where n->>'type' = 'text' and jsonb_typeof(n->'text') is distinct from 'string'
    ) then
      return 'Een tekstblok zonder tekst.';
    end if;

    -- Opmaak: alleen bekende, en een link alleen naar een veilig adres.
    select coalesce(m->>'type', '(geen type)') into v_bad
    from jsonb_array_elements(v_level) n,
         jsonb_array_elements(case when jsonb_typeof(n->'marks') = 'array' then n->'marks' else '[]'::jsonb end) m
    where not ((v_allowed->'marks') ? coalesce(m->>'type', ''))
    limit 1;
    if v_bad is not null then
      return format('Onbekende opmaak: %s.', v_bad);
    end if;
    if exists (
      select 1
      from jsonb_array_elements(v_level) n,
           jsonb_array_elements(case when jsonb_typeof(n->'marks') = 'array' then n->'marks' else '[]'::jsonb end) m
      where m->>'type' = 'link'
        and coalesce(m->'attrs'->>'href', '') !~* (v_allowed->>'link_pattern')
    ) then
      return 'Een link mag alleen naar https:, http:, mailto: of tel:.';
    end if;

    -- Afbeeldingen en bestanden alleen als bestand in ResoFly; een subpagina wijst naar een pagina.
    if exists (
      select 1 from jsonb_array_elements(v_level) n
      where n->>'type' = 'image' and nullif(n->'attrs'->>'src', '') is not null
    ) then
      return 'Een afbeelding van buiten kan niet in een pagina; zet hem als bestand in ResoFly.';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_level) n
      where (n->>'type' in ('image', 'fileBlock') and coalesce(n->'attrs'->>'attachmentId', '') !~ '^[0-9a-fA-F-]{36}$')
         or (n->>'type' = 'subpage' and coalesce(n->'attrs'->>'pageId', '') !~ '^[0-9a-fA-F-]{36}$')
    ) then
      return 'Een afbeelding, bestand of subpagina zonder geldige verwijzing.';
    end if;

    -- De volgende laag.
    select coalesce(jsonb_agg(c), '[]'::jsonb) into v_level
    from jsonb_array_elements(v_level) n,
         jsonb_array_elements(case when jsonb_typeof(n->'content') = 'array' then n->'content' else '[]'::jsonb end) c;
  end loop;
  return null;
end;
$$;

revoke all on function public.page_body_problem(jsonb) from public, anon;

-- De platte tekst van een pagina, in leesvolgorde: per tekstblok de tekst
-- aaneen, de blokken met een spatie ertussen. Voor zoeken en de korte tekst.
create or replace function public.page_body_text(p_body jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select left(coalesce(string_agg(blok, ' ' order by volgorde), ''), 300000)
  from (
    select y.volgorde,
           (select string_agg(case when c->>'type' = 'text' then c->>'text' else ' ' end, '' order by x.i)
              from jsonb_array_elements(b->'content') with ordinality as x(c, i)
             where c->>'type' in ('text', 'hardBreak')) as blok
    from jsonb_path_query(p_body, 'strict $.** ? (@.type != "text" && @.content.type() == "array")') with ordinality as y(b, volgorde)
  ) s
  where blok is not null and btrim(blok) <> '';
$$;

revoke all on function public.page_body_text(jsonb) from public, anon;

-- De korte tekst voor tegels en het klantscherm: zonder HTML, zonder dubbele spaties.
create or replace function public.document_excerpt(p_text text)
returns text
language sql
immutable
as $$
  select left(btrim(regexp_replace(
    replace(replace(replace(replace(replace(replace(
      regexp_replace(coalesce(p_text, ''), '<[^>]*>', ' ', 'g'),
      '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#039;', ''''),
    '\s+', ' ', 'g')), 200);
$$;

revoke all on function public.document_excerpt(text) from public, anon;

-- ── 3. De database houdt de soort, de tekst en de controle bij ─────────────

create or replace function public.documents_format_sync()
returns trigger
language plpgsql
as $$
begin
  -- Een Word-, Excel- of PowerPoint-bestand is altijd office.
  if new.storage_key is not null then
    new.format := 'office';
  elsif new.format = 'office' then
    new.format := 'html';
  end if;
  return new;
end;
$$;

revoke all on function public.documents_format_sync() from public, anon, authenticated;

drop trigger if exists documents_format_sync on public.documents;
create trigger documents_format_sync
  before insert or update of storage_key, format on public.documents
  for each row execute function public.documents_format_sync();

create or replace function public.documents_page_text()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_problem text;
begin
  if new.format = 'page' then
    v_problem := public.page_body_problem(new.body);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '22023';
    end if;
    new.content := public.page_body_text(new.body);
  end if;
  new.excerpt := public.document_excerpt(new.content);
  return new;
end;
$$;

revoke all on function public.documents_page_text() from public, anon, authenticated;

-- Na documents_format_sync (alfabetisch), zodat de soort al klopt.
drop trigger if exists documents_page_text on public.documents;
create trigger documents_page_text
  before insert or update of body, content, format, storage_key on public.documents
  for each row execute function public.documents_page_text();

-- ── 4. De boom ──────────────────────────────────────────────────────────────

create or replace function public.documents_page_tree()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent public.documents;
  v_cursor uuid;
  v_depth integer := 1;
  v_height integer := 0;
begin
  if new.parent_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.parent_id is not distinct from old.parent_id
     and new.client_id is not distinct from old.client_id
     and new.project_id is not distinct from old.project_id
     and new.folder_id is not distinct from old.folder_id then
    return new;
  end if;

  -- Eén verplaatsing tegelijk per organisatie. Anders konden twee gelijktijdige
  -- verplaatsingen (A onder B, B onder A) allebei langs de controle komen en
  -- samen een kring maken.
  perform pg_advisory_xact_lock(hashtextextended('documents_page_tree:' || new.organization_id::text, 0));

  select * into v_parent from public.documents d where d.id = new.parent_id;
  if not found or v_parent.organization_id <> new.organization_id then
    raise exception 'De bovenliggende pagina bestaat niet in deze organisatie.' using errcode = '23503';
  end if;
  if v_parent.format <> 'page' then
    raise exception 'Een subpagina hoort onder een pagina.' using errcode = '22023';
  end if;

  -- Geen kring, en hoogstens 20 diep: de voorouders, plus wat er onder deze pagina hangt.
  v_cursor := new.parent_id;
  while v_cursor is not null loop
    if v_cursor = new.id then
      raise exception 'Een pagina kan niet onder zichzelf staan.' using errcode = '22023';
    end if;
    v_depth := v_depth + 1;
    if v_depth > 21 then
      raise exception 'Pagina''s gaan hoogstens 20 diep.' using errcode = '22023';
    end if;
    select d.parent_id into v_cursor from public.documents d where d.id = v_cursor;
  end loop;
  if tg_op = 'UPDATE' then
    with recursive onder as (
      select d.id, 1 as niveau from public.documents d where d.parent_id = new.id
      union all
      select d.id, o.niveau + 1 from public.documents d join onder o on d.parent_id = o.id where o.niveau < 25
    )
    select coalesce(max(niveau), 0) into v_height from onder;
  end if;
  if v_depth + v_height > 21 then
    raise exception 'Pagina''s gaan hoogstens 20 diep.' using errcode = '22023';
  end if;

  -- Erven: klant en project van de bovenliggende pagina. De map hoort alleen
  -- bij de bovenste pagina; anders kon een subpagina van klant A in een map van
  -- klant B staan, en daar via een deling meeliften.
  new.client_id := v_parent.client_id;
  new.project_id := v_parent.project_id;
  new.folder_id := null;
  return new;
end;
$$;

revoke all on function public.documents_page_tree() from public, anon, authenticated;

drop trigger if exists documents_page_tree on public.documents;
create trigger documents_page_tree
  before insert or update of parent_id, client_id, project_id, folder_id on public.documents
  for each row execute function public.documents_page_tree();

-- Verandert de klant of het project van een pagina, dan gaan de subpagina's mee
-- (elk zet het weer door naar de eigen subpagina's).
create or replace function public.documents_page_tree_down()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.format = 'page'
     and (new.client_id is distinct from old.client_id or new.project_id is distinct from old.project_id) then
    update public.documents d
    set client_id = new.client_id, project_id = new.project_id
    where d.parent_id = new.id
      and (d.client_id is distinct from new.client_id or d.project_id is distinct from new.project_id);
  end if;
  return null;
end;
$$;

revoke all on function public.documents_page_tree_down() from public, anon, authenticated;

drop trigger if exists documents_page_tree_down on public.documents;
create trigger documents_page_tree_down
  after update of client_id, project_id on public.documents
  for each row execute function public.documents_page_tree_down();

-- ── 5. Wie bewerkt ──────────────────────────────────────────────────────────

create table if not exists public.document_edit_claims (
  document_id uuid primary key references public.documents(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);

create index if not exists idx_document_edit_claims_org on public.document_edit_claims (organization_id);

alter table public.document_edit_claims enable row level security;
drop policy if exists "document_edit_claims read" on public.document_edit_claims;
create policy "document_edit_claims read" on public.document_edit_claims
  for select to authenticated
  using (organization_id = any ((select public.my_organization_ids())::uuid[]));
select public.apply_module_gate('document_edit_claims', 'content');

-- Claimen of de hartslag geven: lukt als niemand bewerkt, als jij het al was,
-- of als de vorige twee minuten niets meer liet horen.
create or replace function public.claim_page_edit(p_document_id uuid)
returns table (claimed boolean, user_id uuid, seen_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  v_claim public.document_edit_claims;
begin
  select * into v_doc from public.documents d where d.id = p_document_id;
  if not found
     or not public.can_write_org(v_doc.organization_id)
     or not public.can_write_module(v_doc.organization_id, 'content') then
    raise exception 'Je mag deze pagina niet bewerken.' using errcode = '42501';
  end if;
  if v_doc.format <> 'page' or v_doc.archived_at is not null then
    raise exception 'Alleen een pagina die niet in de prullenbak ligt, kun je bewerken.' using errcode = '22023';
  end if;

  insert into public.document_edit_claims as c (document_id, organization_id, user_id, claimed_at, seen_at)
  values (v_doc.id, v_doc.organization_id, auth.uid(), now(), now())
  on conflict (document_id) do update
    set user_id = auth.uid(),
        claimed_at = case when c.user_id = auth.uid() then c.claimed_at else now() end,
        seen_at = now()
    where c.user_id = auth.uid() or c.seen_at < now() - interval '2 minutes';

  select * into v_claim from public.document_edit_claims c where c.document_id = v_doc.id;
  return query select v_claim.user_id = auth.uid(), v_claim.user_id, v_claim.seen_at;
end;
$$;

revoke all on function public.claim_page_edit(uuid) from public, anon;
grant execute on function public.claim_page_edit(uuid) to authenticated;

create or replace function public.release_page_edit(p_document_id uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.document_edit_claims c
  where c.document_id = p_document_id and c.user_id = auth.uid();
$$;

revoke all on function public.release_page_edit(uuid) from public, anon;
grant execute on function public.release_page_edit(uuid) to authenticated;

-- ── 6. Versies ──────────────────────────────────────────────────────────────

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  version integer not null check (version > 0),
  title text not null,
  body jsonb not null,
  reason text not null check (reason in ('sessie', 'vrijgave', 'vastgelegd', 'teruggezet', 'voor_gerrie')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (document_id, version)
);

create index if not exists idx_document_versions_doc
  on public.document_versions (organization_id, document_id, version desc);

alter table public.document_versions enable row level security;
drop policy if exists "document_versions read" on public.document_versions;
create policy "document_versions read" on public.document_versions
  for select to authenticated
  using (organization_id = any ((select public.my_organization_ids())::uuid[]));
select public.apply_module_gate('document_versions', 'content');

-- Een versie vastleggen van wat er nu staat. Bij een bewerksessie zonder
-- wijziging sinds de vorige versie komt er geen nieuwe bij.
create or replace function public.save_page_version(p_document_id uuid, p_reason text default 'sessie')
returns public.document_versions
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  v_last public.document_versions;
  v_new public.document_versions;
begin
  if p_reason is null or p_reason not in ('sessie', 'vrijgave', 'vastgelegd', 'voor_gerrie') then
    raise exception 'Onbekende reden voor een versie.' using errcode = '22023';
  end if;
  -- De rij vastzetten: twee gelijktijdige versies krijgen zo nooit hetzelfde nummer.
  select * into v_doc from public.documents d where d.id = p_document_id for update;
  if not found
     or not public.can_write_org(v_doc.organization_id)
     or not public.can_write_module(v_doc.organization_id, 'content') then
    raise exception 'Je mag deze pagina niet bewerken.' using errcode = '42501';
  end if;
  if v_doc.format <> 'page' then
    raise exception 'Alleen een pagina heeft versies.' using errcode = '22023';
  end if;

  select * into v_last from public.document_versions v
  where v.document_id = v_doc.id order by v.version desc limit 1;
  if found and p_reason = 'sessie' and v_last.body = v_doc.body and v_last.title = v_doc.title then
    return v_last;
  end if;

  insert into public.document_versions (organization_id, document_id, version, title, body, reason, created_by)
  values (v_doc.organization_id, v_doc.id, coalesce(v_last.version, 0) + 1, v_doc.title, v_doc.body, p_reason, auth.uid())
  returning * into v_new;
  return v_new;
end;
$$;

revoke all on function public.save_page_version(uuid, text) from public, anon;
grant execute on function public.save_page_version(uuid, text) to authenticated;

-- Een oude versie terugzetten: de pagina krijgt die inhoud, en dat is zelf weer
-- een nieuwe versie. Er gaat niets verloren.
create or replace function public.restore_page_version(p_version_id uuid)
returns public.document_versions
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_old public.document_versions;
  v_doc public.documents;
  v_new public.document_versions;
begin
  select * into v_old from public.document_versions v where v.id = p_version_id;
  if not found then
    raise exception 'Je mag deze pagina niet bewerken.' using errcode = '42501';
  end if;
  select * into v_doc from public.documents d where d.id = v_old.document_id for update;
  if not found
     or not public.can_write_org(v_doc.organization_id)
     or not public.can_write_module(v_doc.organization_id, 'content') then
    raise exception 'Je mag deze pagina niet bewerken.' using errcode = '42501';
  end if;

  update public.documents d set body = v_old.body, title = v_old.title where d.id = v_doc.id;
  insert into public.document_versions (organization_id, document_id, version, title, body, reason, created_by)
  values (v_doc.organization_id, v_doc.id,
          (select coalesce(max(v.version), 0) + 1 from public.document_versions v where v.document_id = v_doc.id),
          v_old.title, v_old.body, 'teruggezet', auth.uid())
  returning * into v_new;
  return v_new;
end;
$$;

revoke all on function public.restore_page_version(uuid) from public, anon;
grant execute on function public.restore_page_version(uuid) to authenticated;

-- ── 7. Zoeken ───────────────────────────────────────────────────────────────
-- Op een expressie-index; de functie gebruikt precies dezelfde expressie.
-- Elk woord telt als begin van een woord ("offer" vindt "offerte"). Het
-- resultaat geeft de korte tekst (excerpt) terug, nooit HTML.

create index if not exists idx_documents_search on public.documents
  using gin (to_tsvector('dutch'::regconfig, coalesce(title, '') || ' ' || coalesce(content, '')));

create or replace function public.document_search_query(p_query text)
returns tsquery
language sql
immutable
as $$
  select case
    when count(*) = 0 then null
    else to_tsquery('dutch'::regconfig, string_agg(quote_literal(woord) || ':*', ' & '))
  end
  from (
    select woord from regexp_split_to_table(lower(coalesce(p_query, '')), '[^[:alnum:]]+') as woord
    where woord <> '' limit 8
  ) w;
$$;

revoke all on function public.document_search_query(text) from public, anon;

create or replace function public.search_documents(p_organization_id uuid, p_query text, p_limit integer default 20)
returns table (
  id uuid, title text, excerpt text, format text, parent_id uuid,
  client_id uuid, project_id uuid, folder_id uuid, updated_at timestamptz, rank real
)
language sql
stable
security invoker
set search_path = public
as $$
  select d.id, d.title, d.excerpt, d.format, d.parent_id, d.client_id, d.project_id, d.folder_id, d.updated_at,
         ts_rank(to_tsvector('dutch'::regconfig, coalesce(d.title, '') || ' ' || coalesce(d.content, '')), q.q) as rank
  from (select public.document_search_query(p_query) as q) q
  join public.documents d on true
  where q.q is not null
    and d.organization_id = p_organization_id
    and d.archived_at is null
    and to_tsvector('dutch'::regconfig, coalesce(d.title, '') || ' ' || coalesce(d.content, '')) @@ q.q
  order by rank desc, d.updated_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke all on function public.search_documents(uuid, text, integer) from public, anon;
grant execute on function public.search_documents(uuid, text, integer) to authenticated, service_role;

-- ── 9. Bij een pagina: het versienummer, en alleen via body ────────────────

create or replace function public.documents_page_guard()
returns trigger
language plpgsql
as $$
begin
  if new.format = 'page' and old.format = 'page' then
    -- De tekst van een pagina komt uit body. Wie alleen content wijzigt, zou
    -- "gelukt" horen terwijl er niets verandert.
    if new.content is distinct from old.content and new.body is not distinct from old.body then
      raise exception 'Een pagina wijzig je via de blokken (body), niet via de tekst (content).' using errcode = '22023';
    end if;
    if new.body is distinct from old.body or new.title is distinct from old.title then
      new.edit_version := coalesce(old.edit_version, 0) + 1;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.documents_page_guard() from public, anon, authenticated;

-- Vóór documents_page_text (alfabetisch: guard < text), dat content opnieuw maakt.
drop trigger if exists documents_page_guard on public.documents;
create trigger documents_page_guard
  before update of body, content, title on public.documents
  for each row execute function public.documents_page_guard();

-- ── 10. Pagina's delen kan pas vanaf stap 1C ───────────────────────────────
-- Tot de vrijgave er is, deelt niets een pagina: een gedeelde map neemt ze
-- niet mee (zelfde functie als in 20261127120000, met één regel erbij), en een
-- deling van een pagina wordt geweigerd.

create or replace function public.drive_folder_tree_items(p_organization_id uuid, p_folder_id uuid)
returns table (
  item_type text,
  item_id uuid,
  folder_id uuid,
  name text,
  mime_type text,
  size_bytes bigint,
  storage_key text,
  modified timestamptz,
  path text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  select ctx.client_id into v_client
  from public.drive_item_client_safe(p_organization_id, 'folder', p_folder_id) ctx;

  return query
  with recursive tree as (
    select f.id, f.name, ''::text as path, 0 as depth
    from public.content_folders f
    where f.id = p_folder_id and f.organization_id = p_organization_id
    union all
    select c.id, c.name, case when t.path = '' then t.name else t.path || ' / ' || t.name end, t.depth + 1
    from public.content_folders c
    join tree t on c.parent_id = t.id
    where t.depth < 20
      and c.organization_id = p_organization_id
      and coalesce((select p.client_id from public.projects p where p.id = c.project_id), c.client_id)
          is not distinct from v_client
  )
  select 'attachment'::text, a.id, t.id, a.name, a.mime_type, a.size_bytes::bigint, a.storage_key,
         a.created_at,
         case when t.path = '' then t.name else t.path || ' / ' || t.name end
  from tree t
  join public.attachments a
    on a.entity_type = 'folder' and a.entity_id = t.id
   and a.organization_id = p_organization_id
  union all
  select 'note'::text, n.id, t.id, n.title, 'text/html'::text, 0::bigint, null::text,
         coalesce(n.updated_at, n.created_at),
         case when t.path = '' then t.name else t.path || ' / ' || t.name end
  from tree t
  join public.notes n on n.folder_id = t.id and n.organization_id = p_organization_id
   and coalesce((select p.client_id from public.projects p where p.id = n.project_id), n.client_id)
       is not distinct from v_client
  union all
  select 'document'::text, d.id, t.id, d.title,
         coalesce(d.mime_type, 'text/html'), coalesce(d.size_bytes, 0)::bigint, d.storage_key,
         coalesce(d.updated_at, d.created_at),
         case when t.path = '' then t.name else t.path || ' / ' || t.name end
  from tree t
  join public.documents d on d.folder_id = t.id and d.organization_id = p_organization_id
   and d.format <> 'page'
   and coalesce((select p.client_id from public.projects p where p.id = d.project_id), d.client_id)
       is not distinct from v_client;
end;
$$;

revoke all on function public.drive_folder_tree_items(uuid, uuid) from public, anon, authenticated;

create or replace function public.drive_shares_no_pages_yet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.item_type = 'document'
     and exists (select 1 from public.documents d where d.id = new.item_id and d.format = 'page') then
    raise exception 'Een pagina delen kan nog niet; dat komt met de vrijgave van een versie.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.drive_shares_no_pages_yet() from public, anon, authenticated;

drop trigger if exists drive_shares_no_pages_yet on public.drive_shares;
create trigger drive_shares_no_pages_yet
  before insert or update of item_type, item_id on public.drive_shares
  for each row execute function public.drive_shares_no_pages_yet();

-- ── 8. Het logboek ──────────────────────────────────────────────────────────
-- De definitie uit 20261111220000, met bij documents de nieuwe velden erbij.

create or replace function public.audit_field_spec(p_table text)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select (case p_table
    when 'tasks' then '{"title":"v","status":"v","priority":"v","tags":"v","start_date":"v","end_date":"v","planned_date":"v","planned_end_date":"v","planned_start_minute":"v","estimated_minutes":"v","project_id":"r","client_id":"r","ticket_id":"r","subtasks":"s","comments":"n","planned_order":"i"}'
    when 'projects' then '{"name":"v","client_id":"r","archived":"v","start_date":"v","end_date":"v","contract_id":"r","hourly_rate_cents":"v","billing_type":"v","budgeted_minutes":"v","color":"i"}'
    when 'clients' then '{"name":"v","client_code":"v","status":"v","client_kind":"v","follow_up":"v","value_eur":"v","tags":"v","country":"v","e_invoicing_enabled":"v","e_invoice_channel":"v","color":"i"}'
    when 'client_contacts' then '{"name":"v","role":"v","is_active":"v","gives_portal_access":"v","origin":"v","client_id":"r"}'
    when 'client_calls' then '{"subject":"v","direction":"v","outcome":"v","started_at":"v","duration_seconds":"v","client_id":"r","contact_id":"r","project_id":"r","ticket_id":"r","dedup_key":"i","provider_call_id":"i","metadata":"i"}'
    when 'tickets' then '{"title":"v","status":"v","priority":"v","client_id":"r","converted_to_project_id":"r","resolved_at":"v"}'
    when 'ticket_notes' then '{"is_internal":"v","author_type":"v","ticket_id":"r"}'
    when 'notes' then '{"title":"v","note_type":"v","tags":"v","client_id":"r","project_id":"r","folder_id":"r"}'
    when 'documents' then '{"title":"v","document_type":"v","client_id":"r","project_id":"r","folder_id":"r","mime_type":"v","size_bytes":"v","storage_key":"i","edit_version":"i","last_edited_by":"i","format":"v","body":"c","parent_id":"r","archived_at":"v","archived_by":"i","position":"i","icon":"i","cover":"i","full_width":"i","excerpt":"i"}'
    when 'attachments' then '{"name":"v","mime_type":"v","size_bytes":"v","parent_task_id":"r","storage_key":"i","public_url":"i","edit_version":"i","last_edited_by":"i","locked_by":"i","locked_at":"i"}'
    when 'content_folders' then '{"name":"v","parent_id":"r","client_id":"r","project_id":"r","position":"i"}'
    when 'note_handwriting' then '{"page_count":"v","stroke_count":"i","pages":"i"}'
    when 'drive_shares' then '{"item_type":"v","item_name":"v","recipient_kind":"v","can_download":"v","expires_at":"v","revoked_at":"v","notified_at":"v","client_id":"r","project_id":"r","member_user_id":"r","client_contact_id":"r","token_hash":"i","view_count":"i","last_viewed_at":"i"}'
    when 'file_transfers' then '{"subject":"v","status":"v","can_download":"v","expires_at":"v","sent_at":"v","revoked_at":"v","purged_at":"v","item_count":"v","total_bytes":"v","client_id":"r","project_id":"r","ticket_id":"r"}'
    when 'galleries' then '{"title":"v","status":"v","published_at":"v","allow_downloads":"v","download_quality":"v","share_enabled":"v","expires_at":"v","format":"v","hero_template":"v","project_id":"r","share_token":"i","share_pin_failed_count":"i","share_pin_locked_until":"i","cover_item_id":"i","cover_preview_key":"i","cover_thumb_key":"i","cover_bytes":"i","cover_focus_x":"i","cover_focus_y":"i"}'
    when 'time_entries' then '{"entry_date":"v","minutes":"v","billable":"v","entry_type":"v","indirect_category":"v","source":"v","started_at":"v","ended_at":"v","hourly_rate_cents":"v","user_id":"r","project_id":"r","client_id":"r","task_id":"r","calendar_event_link_id":"i"}'
    when 'project_members' then '{"user_id":"r","project_id":"r"}'
    when 'task_assignees' then '{"user_id":"r","task_id":"r"}'
    when 'project_templates' then '{"name":"v"}'
    when 'project_template_tasks' then '{"title":"v","status":"v","priority":"v","position":"i"}'
    when 'saved_reports' then '{"name":"v","is_pinned":"v","position":"i"}'
    when 'invoices' then '{"number":"v","status":"v","date":"v","due_date":"v","currency":"v","subtotal_amount":"v","vat_amount":"v","total_amount":"v","lines":"n","sent_at":"v","paid_at":"v","refunded_amount":"v","charged_back_amount":"v","reminder_level":"v","reminders_paused":"v","locked_at":"v","client_id":"r","project_id":"r","quote_id":"r","contract_id":"r","journal_entry_id":"r","last_email_delivery_status":"v","last_email_opened_at":"v","last_email_clicked_at":"v","last_email_failed_at":"v","public_token_hash":"i","public_token_created_at":"i","public_token_expires_at":"i","resend_last_email_id":"i","last_email_delivery_at":"i","latest_version_id":"i","sent_version_id":"i","paid_version_id":"i","source_quote_version_id":"i","last_pdf_file_name":"i","last_pdf_mime_type":"i","last_pdf_size_bytes":"i","last_pdf_sha256":"i"}'
    when 'quotes' then '{"number":"v","status":"v","date":"v","valid_until":"v","lines":"n","sent_at":"v","accepted_at":"v","internal_approval_status":"v","internal_approved_at":"v","internal_rejected_at":"v","client_decision_at":"v","client_id":"r","project_id":"r","internal_approval_requested_by":"r","internal_approved_by":"r","internal_rejected_by":"r","last_email_delivery_status":"v","last_email_opened_at":"v","last_email_clicked_at":"v","last_email_failed_at":"v","public_token_hash":"i","public_token_created_at":"i","public_token_expires_at":"i","resend_last_email_id":"i","last_email_delivery_at":"i","latest_version_id":"i","internal_approved_version_id":"i","sent_version_id":"i","accepted_version_id":"i","accepted_sent_version_id":"i","last_pdf_file_name":"i","last_pdf_mime_type":"i","last_pdf_size_bytes":"i","last_pdf_sha256":"i"}'
    when 'contracts' then '{"number":"v","title":"v","status":"v","date":"v","valid_until":"v","amount_cents":"v","currency":"v","sent_at":"v","signed_at":"v","voided_at":"v","internal_approval_status":"v","editor_mode":"v","client_id":"r","quote_id":"r","template_id":"r","supersedes_contract_id":"r","voided_by":"r","last_email_delivery_status":"v","public_token_hash":"i","public_token_created_at":"i","public_token_expires_at":"i","resend_last_email_id":"i","last_email_delivery_at":"i","signed_document_sha256":"i","signed_storage_provider":"i","signed_storage_key":"i","signed_pdf_file_name":"i","signed_pdf_size_bytes":"i","signed_pdf_data_base64":"i","body_storage_key":"i","body_mime_type":"i","body_size_bytes":"i","edit_version":"i","last_edited_by":"i"}'
    when 'contract_templates' then '{"name":"v","is_active":"v"}'
    when 'contract_projects' then '{"contract_id":"r","project_id":"r"}'
    when 'purchase_invoices' then '{"internal_number":"v","supplier_invoice_number":"v","date":"v","due_date":"v","subtotal_cents":"v","vat_cents":"v","total_cents":"v","currency":"v","status":"v","payment_status":"v","paid_at":"v","source":"v","lines":"n","supplier_id":"r","project_id":"r","journal_entry_id":"r","extraction_meta":"i"}'
    when 'suppliers' then '{"name":"v","supplier_code":"v","status":"v","default_vat_code":"v","inbox_unverified":"v","default_expense_account_id":"r"}'
    when 'journal_entries' then '{"entry_number":"v","date":"v","status":"v","source_type":"v","posted_at":"v","reverses_entry_id":"r","reversed_by_entry_id":"r"}'
    when 'ledger_accounts' then '{"code":"v","name":"v","type":"v","subtype":"v","default_vat_code":"v","is_active":"v","report_group":"v","is_restricted_reserve":"v"}'
    when 'bank_accounts' then '{"name":"v","currency":"v","is_active":"v","source":"v","provider":"v","ledger_account_id":"r","last_synced_at":"i","last_imported_at":"i","last_sync_attempt_at":"i","last_sync_error":"i","external_account_id":"i"}'
    when 'bank_rules' then '{"name":"v","priority":"v","is_active":"v","auto_book":"v","match_direction":"v","target_vat_code":"v","target_account_id":"r"}'
    when 'vat_returns' then '{"status":"v","period_type":"v","year":"v","period_index":"v","period_start":"v","period_end":"v","finalized_at":"v","filed_at":"v","journal_entry_id":"r","paid_bank_transaction_id":"r","supplements_return_id":"r"}'
    when 'fixed_assets' then '{"name":"v","asset_number":"v","category":"v","acquisition_date":"v","acquisition_cost_cents":"v","residual_value_cents":"v","useful_life_months":"v","method":"v","start_date":"v","status":"v","disposal_date":"v","disposal_proceeds_cents":"v"}'
    when 'prepaid_expenses' then '{"description":"c","amount_cents":"v","payment_date":"v","start_date":"v","months":"v","start_mode":"v","status":"v","end_date":"v","end_amount_cents":"v","end_refund_cents":"v","notes":"c","prepaid_account_id":"c","expense_account_id":"c","counter_account_id":"c","end_refund_account_id":"c","source_purchase_invoice_id":"c","start_journal_entry_id":"i","end_journal_entry_id":"i"}'
    when 'fiscal_years' then '{"label":"v","period_start":"v","period_end":"v","status":"v","result_cents":"v","closed_at":"v","reopened_at":"v"}'
    when 'corporate_tax_returns' then '{"year":"v","status":"v","taxable_amount_cents":"v","tax_cents":"v","balance_due_cents":"v","finalized_at":"v","computation":"i"}'
    when 'annual_accounts' then '{"status":"v","prepared_on":"v","prepare_deadline":"v","adoption_date":"v","adoption_method":"v","filing_date":"v","size_class":"v","size_class_override":"v","reversed_at":"v","snapshot":"i","snapshot_hash":"i","snapshot_version":"i","size_basis":"i"}'
    when 'organization_members' then '{"role":"v","status":"v","module_access":"v","joined_at":"v","user_id":"r","invited_by":"r"}'
    when 'organization_invitations' then '{"role":"v","status":"v","expires_at":"v","module_access":"v","consumes_license":"v","accepted_by":"r","accepted_at":"v","invited_by":"r"}'
    when 'organizations' then '{"name":"v","licensed_seats":"v","license_status":"v","onboarding_completed_at":"v","parent_organization_id":"r"}'
    when 'company_settings' then '{"legal_form":"v","kor_enabled":"v","vat_return_period":"v","bookkeeping_start_date":"v","fiscal_year_start_month":"v","invoice_send_method":"v","default_hourly_rate_cents":"v","invoice_template_kind":"v","brand_client_theme":"v","brand_hide_powered_by":"v"}'
    when 'calendar_events' then '{"etag":"i","sync_rev":"i","sequence":"i","icalendar_raw":"i","organizer_token":"i"}'
    when 'calendar_sources' then '{"change_seq":"i","feed_etag":"i","feed_content_hash":"i","feed_last_synced_at":"i","feed_last_error":"i","feed_url":"i","conference_types":"i"}'
    when 'calendar_connections' then '{"status":"v","last_error":"i"}'
    when 'email_campaigns' then '{"name":"v","subject":"v","status":"v","scheduled_at":"v","started_at":"v","sent_at":"v","accent_color":"i"}'
    when 'email_flows' then '{"name":"v","status":"v","stop_condition":"v"}'
    when 'email_templates' then '{"template_key":"v","enabled":"v"}'
    when 'client_field_definitions' then '{"label":"v","field_key":"v","field_type":"v","is_archived":"v","show_in_list":"v","position":"i"}'
    else '{}'
  end)::jsonb;
$$;

revoke all on function public.audit_field_spec(text) from public, anon, authenticated;
grant execute on function public.audit_field_spec(text) to service_role;

-- ── 9. Bestaande rijen ──────────────────────────────────────────────────────
-- De soort en de korte tekst, zonder "laatst gewijzigd" te verzetten en
-- zonder een regel in het logboek per document.

alter table public.documents disable trigger documents_updated;
alter table public.documents disable trigger documents_audit;

update public.documents d
set format = case when d.storage_key is not null then 'office' else d.format end,
    excerpt = public.document_excerpt(d.content)
where d.excerpt is distinct from public.document_excerpt(d.content)
   or (d.storage_key is not null and d.format <> 'office');

alter table public.documents enable trigger documents_updated;
alter table public.documents enable trigger documents_audit;

commit;
