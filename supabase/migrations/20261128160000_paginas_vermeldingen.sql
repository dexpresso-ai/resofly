-- ============================================================
-- Pagina's: @-vermeldingen, de basis (stap 2-1a)
--
-- Zie docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md (§13 en §18, fase 2) en
-- docs/changelog/CHANGELOG_PAGINAS_VERMELDINGEN_2026-11-28.md.
--
-- Een pagina kan een klant, project, taak, factuur of collega noemen: een
-- inline knoop `mention` met alleen de soort (attrs.kind) en het id
-- (attrs.id). Geen naam. Wie Inhoud mag lezen maar Klanten of Financiën
-- niet, leest de body van een pagina wel. Een opgeslagen naam kwam dan via de
-- body, de versies, de platte tekst (content), het uittreksel, de zoekindex
-- en Gerrie bij die persoon terecht (CLAUDE.md, regel 3). De naam komt pas bij
-- het tonen, met de rechten van wie kijkt.
--
-- Deze migratie:
--   1. neemt `mention` aan in page_body_allowed() en page_body_problem(), met
--      alleen een bekende soort en een geldig uuid, en verder niets;
--   2. weigert een nieuwe vermelding van iets dat in een andere organisatie
--      bestaat (documents_page_vermeldingen), zoals bij afbeeldingen en
--      subpagina's (20261127150000). Wat niet (meer) bestaat, mag: anders kon
--      je geen oude versie terugzetten waarin een verwijderde klant stond;
--   3. houdt per pagina bij wat ze noemt (page_mentions), voor "Genoemd in"
--      bij een klant of project (stap 2-1c). Lezen gaat langs de regels van
--      documents: Inhoud mogen lezen, en niet in de prullenbak.
--
-- De platte tekst (page_body_text) neemt alleen tekst mee; een vermelding
-- staat er dus niet in, en ook niet in de zoekindex.
--
-- De editor kent `mention` in dezelfde stap (src/lib/pageEditorExtensions.ts).
-- Nam de database hem eerder aan, dan konden de API, de MCP en Gerrie
-- pagina's maken die de editor alleen om te lezen opent.
--
-- Mag veilig opnieuw draaien: create or replace, if not exists, drop ... if
-- exists, en on conflict do nothing.
-- ============================================================

-- ── 1. De knoop aannemen ────────────────────────────────────────────────────

-- De lijsten, met de spiegel in src/lib/pageSchema.ts (pageSchema.test.ts
-- houdt ze gelijk). mention_kinds staat vóór callout_variants: de test leest
-- elke lijst tot de volgende sleutel.
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
      'columns', 'column', 'tableOfContents', 'subpage', 'mention'
    ),
    'marks', jsonb_build_array('bold', 'italic', 'underline', 'strike', 'code', 'link', 'highlight'),
    'link_pattern', '^(https?:|mailto:|tel:|/|#)',
    'mention_kinds', jsonb_build_array('client', 'project', 'task', 'invoice', 'member'),
    'callout_variants', jsonb_build_array('info', 'tip', 'let-op', 'waarschuwing'),
    'cell_aligns', jsonb_build_array('left', 'center', 'right')
  );
$$;

revoke all on function public.page_body_allowed() from public, anon;

-- Zoals in 20261127140000, met de vermelding erbij (vóór "De volgende laag").
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

    -- Tabelcellen: spans en breedtes alleen als hele getallen, uitlijnen alleen
    -- links, midden of rechts. Tiptap zet colwidth zonder controle in een
    -- style-attribuut (createColGroup in @tiptap/extension-table 3.35.1), en de
    -- CSP laat plaatjes van elk https-adres toe: met tekst als breedte kwam er
    -- zo een volgpixel in de pagina. CASE, zodat de omzetting naar een getal
    -- alleen draait als het een getal is.
    if exists (
      select 1 from jsonb_array_elements(v_level) n
      where n->>'type' in ('tableCell', 'tableHeader')
        and jsonb_typeof(n->'attrs') = 'object'
        and (
          (coalesce(jsonb_typeof(n->'attrs'->'colspan'), 'null') <> 'null'
            and not case when jsonb_typeof(n->'attrs'->'colspan') = 'number'
                         then (n->'attrs'->>'colspan')::numeric between 1 and 1000
                              and (n->'attrs'->>'colspan')::numeric = trunc((n->'attrs'->>'colspan')::numeric)
                         else false end)
          or (coalesce(jsonb_typeof(n->'attrs'->'rowspan'), 'null') <> 'null'
            and not case when jsonb_typeof(n->'attrs'->'rowspan') = 'number'
                         then (n->'attrs'->>'rowspan')::numeric between 1 and 1000
                              and (n->'attrs'->>'rowspan')::numeric = trunc((n->'attrs'->>'rowspan')::numeric)
                         else false end)
          or (coalesce(jsonb_typeof(n->'attrs'->'colwidth'), 'null') <> 'null'
            and (jsonb_typeof(n->'attrs'->'colwidth') <> 'array'
              or exists (
                select 1 from jsonb_array_elements(case when jsonb_typeof(n->'attrs'->'colwidth') = 'array' then n->'attrs'->'colwidth' else '[]'::jsonb end) w
                where not case when jsonb_typeof(w) = 'number'
                               then (w #>> '{}')::numeric between 0 and 10000
                                    and (w #>> '{}')::numeric = trunc((w #>> '{}')::numeric)
                               else false end)))
          or (coalesce(jsonb_typeof(n->'attrs'->'align'), 'null') <> 'null'
            and not (jsonb_typeof(n->'attrs'->'align') = 'string'
                     and (v_allowed->'cell_aligns') ? (n->'attrs'->>'align')))
        )
    ) then
      return 'Een tabelcel met een ongeldige maat of uitlijning.';
    end if;

    -- Een callout heeft een soort uit de lijst; de app zet die als data-variant
    -- op de pagina, en de stijl hangt eraan.
    if exists (
      select 1 from jsonb_array_elements(v_level) n
      where n->>'type' = 'callout'
        and jsonb_typeof(n->'attrs') = 'object'
        and coalesce(jsonb_typeof(n->'attrs'->'variant'), 'null') <> 'null'
        and not (jsonb_typeof(n->'attrs'->'variant') = 'string'
                 and (v_allowed->'callout_variants') ? (n->'attrs'->>'variant'))
    ) then
      return 'Een callout met een onbekende soort.';
    end if;

    -- Een vermelding (stap 2-1a): alleen de soort en het id, geen naam, en
    -- geen inhoud. Wie Inhoud mag lezen maar Klanten of Financiën niet, leest
    -- de body wel; een opgeslagen naam kwam via de body, de versies, de
    -- platte tekst en de zoekindex bij hem terecht (regel 3). CASE, zodat de
    -- sleutels alleen geteld worden als attrs een object is.
    if exists (
      select 1 from jsonb_array_elements(v_level) n
      where n->>'type' = 'mention'
        and (case when jsonb_typeof(n->'attrs') = 'object'
                  then not ((v_allowed->'mention_kinds') ? coalesce(n->'attrs'->>'kind', ''))
                       or coalesce(n->'attrs'->>'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                       or exists (select 1 from jsonb_object_keys(n->'attrs') k where k not in ('kind', 'id'))
                  else true end
             or n ? 'content')
    ) then
      return 'Een vermelding bewaart alleen een bekende soort en een geldig id.';
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

-- ── 2. Niets uit een andere organisatie ─────────────────────────────────────

-- De vermeldingen in een body: soort en id, elk één keer.
create or replace function public.page_body_mentions(p_body jsonb)
returns table(kind text, entity_id uuid)
language sql
immutable
set search_path = public
as $$
  select distinct v->'attrs'->>'kind', (v->'attrs'->>'id')::uuid
  from jsonb_path_query(coalesce(p_body, '{}'::jsonb), 'strict $.** ? (@.type == "mention")') v
  where v->'attrs'->>'kind' in ('client', 'project', 'task', 'invoice', 'member')
    and coalesce(v->'attrs'->>'id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
$$;

revoke all on function public.page_body_mentions(jsonb) from public, anon;

-- Bestaat dit ding wél, maar in een andere organisatie? Security definer: wie
-- opslaat, mag die andere organisatie niet lezen, en zag het verschil dus niet.
-- Een collega is iemand die lid is (geweest) van deze organisatie; lid
-- alleen elders is "elders".
create or replace function public.page_mention_elsewhere(p_organization_id uuid, p_kind text, p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  case p_kind
    when 'client' then
      return exists (select 1 from public.clients c where c.id = p_id and c.organization_id <> p_organization_id);
    when 'project' then
      return exists (select 1 from public.projects p where p.id = p_id and p.organization_id <> p_organization_id);
    when 'task' then
      return exists (select 1 from public.tasks t where t.id = p_id and t.organization_id <> p_organization_id);
    when 'invoice' then
      return exists (select 1 from public.invoices i where i.id = p_id and i.organization_id <> p_organization_id);
    when 'member' then
      return exists (select 1 from public.organization_members m where m.user_id = p_id)
        and not exists (select 1 from public.organization_members m
                        where m.user_id = p_id and m.organization_id = p_organization_id);
    else
      return false;
  end case;
end;
$$;

revoke all on function public.page_mention_elsewhere(uuid, text, uuid) from public, anon, authenticated;

-- Alleen vermeldingen die er nieuw bij komen. Staat er al een die inmiddels
-- niet meer klopt, dan blijft opslaan werken (zoals bij de verwijzingen).
create or replace function public.documents_page_vermeldingen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.format is distinct from 'page' or new.body is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.body is not distinct from old.body then
    return new;
  end if;
  if exists (
    select 1
    from public.page_body_mentions(new.body) m
    where not exists (
            select 1 from public.page_body_mentions(case when tg_op = 'UPDATE' then old.body end) o
            where o.kind = m.kind and o.entity_id = m.entity_id)
      and public.page_mention_elsewhere(new.organization_id, m.kind, m.entity_id)
  ) then
    raise exception 'Een vermelding van iets uit een andere organisatie kan niet in deze pagina.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.documents_page_vermeldingen() from public, anon, authenticated;

-- Na documents_page_text (alfabetisch): de body is dan al nagekeken.
drop trigger if exists documents_page_vermeldingen on public.documents;
create trigger documents_page_vermeldingen
  before insert or update of body on public.documents
  for each row execute function public.documents_page_vermeldingen();

-- ── 3. "Genoemd in" ─────────────────────────────────────────────────────────

create table if not exists public.page_mentions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  kind text not null check (kind in ('client', 'project', 'task', 'invoice', 'member')),
  entity_id uuid not null,
  primary key (document_id, kind, entity_id)
);

create index if not exists page_mentions_entity on public.page_mentions (organization_id, kind, entity_id);

alter table public.page_mentions enable row level security;

-- Lezen alleen als je de pagina zelf mag lezen: de policies van documents
-- (organisatie, Inhoud, niet in de prullenbak) gelden in de subquery mee.
drop policy if exists "page_mentions met de pagina" on public.page_mentions;
create policy "page_mentions met de pagina" on public.page_mentions
  for select
  to authenticated
  using (exists (select 1 from public.documents d where d.id = page_mentions.document_id));

-- En de modulepoort, zoals elke organisatietabel sinds het hek (roles.test.ts).
select public.apply_module_gate('page_mentions', 'content');

-- Schrijven doet alleen de trigger hieronder.
revoke all on table public.page_mentions from public, anon, authenticated;
grant select on table public.page_mentions to authenticated;
grant all on table public.page_mentions to service_role;

-- Bij elke opslag van een pagina opnieuw: wat de body nu noemt.
create or replace function public.documents_page_mentions_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.body is not distinct from old.body and new.format is not distinct from old.format then
    return null;
  end if;
  delete from public.page_mentions pm where pm.document_id = new.id;
  if new.format = 'page' and new.body is not null then
    insert into public.page_mentions (organization_id, document_id, kind, entity_id)
    select new.organization_id, new.id, m.kind, m.entity_id
    from public.page_body_mentions(new.body) m
    on conflict do nothing;
  end if;
  return null;
end;
$$;

revoke all on function public.documents_page_mentions_sync() from public, anon, authenticated;

drop trigger if exists documents_page_mentions_sync on public.documents;
create trigger documents_page_mentions_sync
  after insert or update of body, format on public.documents
  for each row execute function public.documents_page_mentions_sync();

-- Wat er al stond. Tot deze migratie nam de database geen vermelding aan, dus
-- dit vindt niets; het staat er zodat opnieuw draaien de tabel gelijk trekt.
insert into public.page_mentions (organization_id, document_id, kind, entity_id)
select d.organization_id, d.id, m.kind, m.entity_id
from public.documents d
cross join lateral public.page_body_mentions(d.body) m
where d.format = 'page' and d.body is not null
on conflict do nothing;
