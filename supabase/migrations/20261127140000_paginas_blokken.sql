-- ============================================================
-- Pagina's: de nieuwe blokken nakijken (stap 1A-4a)
--
-- Zie docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md (§3 en §18) en
-- docs/changelog/CHANGELOG_PAGINAS_BLOKKEN_2026-11-27.md.
--
-- De editor krijgt de gewone tabel, de callout, de uitklapper en de
-- inhoudsopgave. Die bloktypen nam de database al aan (20261127130000), maar
-- niet wat erin staat:
--
--   - de maten van een tabelcel (colspan, rowspan, colwidth) alleen als hele
--     getallen, en uitlijnen alleen links, midden of rechts. Tiptap zet
--     colwidth zonder controle in een style-attribuut; met tekst als breedte
--     kwam er een plaatje van buiten in de pagina, en de CSP laat plaatjes van
--     elk https-adres toe;
--   - de soort van een callout alleen uit de lijst.
--
-- De lijsten staan in page_body_allowed(), met de spiegel in
-- src/lib/pageSchema.ts; pageSchema.test.ts houdt ze gelijk.
--
-- Mag veilig opnieuw draaien: alleen create or replace. Bestaande pagina's
-- hebben nog geen tabellen of callouts, dus er is niets om na te kijken.
-- ============================================================

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
    'link_pattern', '^(https?:|mailto:|tel:|/|#)',
    'callout_variants', jsonb_build_array('info', 'tip', 'let-op', 'waarschuwing'),
    'cell_aligns', jsonb_build_array('left', 'center', 'right')
  );
$$;

revoke all on function public.page_body_allowed() from public, anon;

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

    -- De volgende laag.
    select coalesce(jsonb_agg(c), '[]'::jsonb) into v_level
    from jsonb_array_elements(v_level) n,
         jsonb_array_elements(case when jsonb_typeof(n->'content') = 'array' then n->'content' else '[]'::jsonb end) c;
  end loop;
  return null;
end;
$$;

revoke all on function public.page_body_problem(jsonb) from public, anon;
