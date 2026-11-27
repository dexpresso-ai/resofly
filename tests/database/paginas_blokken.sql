-- ============================================================
-- Databasetest: pagina's, de blokken van stap 1A-4a (20261127140000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: de editor maakt nu tabellen, callouts, uitklappers en een
-- inhoudsopgave. De database is de laatste grens voor alles wat erin komt
-- (app, Gerrie, MCP, API). Deze test:
--
--   1. bewaart een pagina met elk nieuw blok; de platte tekst neemt de tekst
--      uit de cellen, de callout en de uitklapper mee;
--   2. weigert een tabelcel met tekst of een stijl als maat: Tiptap zet colwidth
--      zonder controle in een style-attribuut, en de CSP laat plaatjes van elk
--      https-adres toe;
--   3. weigert uitlijnen anders dan links, midden of rechts, en een callout
--      met een onbekende soort.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar', 'eigenaar@blokken.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Blokken')).id as org \gset
reset role;
select pg_temp.beheer();

-- Schrijven zoals de app: ingelogd, onder RLS.
create function pg_temp.pagina(p_body jsonb) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.als(current_setting('test.eigenaar')::uuid);
  set local role authenticated;
  insert into public.documents (organization_id, created_by, title, format, body)
  values (current_setting('test.org')::uuid, current_setting('test.eigenaar')::uuid, 'Blokken', 'page', p_body) returning id into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;
select set_config('test.eigenaar', :'eigenaar', true), set_config('test.org', :'org', true);

create function pg_temp.probeer(p_body jsonb) returns text language sql as $$
  select format('select pg_temp.pagina(%L::jsonb)', p_body::text);
$$;

-- Een tabel met één cel, met deze attributen.
create function pg_temp.cel(p_attrs jsonb) returns jsonb language sql as $$
  select jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object(
    'type', 'table', 'content', jsonb_build_array(jsonb_build_object(
      'type', 'tableRow', 'content', jsonb_build_array(jsonb_build_object(
        'type', 'tableCell', 'attrs', p_attrs,
        'content', jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'cel')))))))))));
$$;

create function pg_temp.callout(p_attrs jsonb) returns jsonb language sql as $$
  select jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object(
    'type', 'callout', 'attrs', p_attrs,
    'content', jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'let op')))))));
$$;

-- ── 1. Elk nieuw blok ───────────────────────────────────────────────────────
select pg_temp.pagina($json${
  "type": "doc",
  "content": [
    {"type": "tableOfContents", "attrs": {"id": "5f0d7a52-62a4-4c64-9a3c-1f3d5c1f2b01"}},
    {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Prijzen"}]},
    {"type": "table", "content": [
      {"type": "tableRow", "content": [
        {"type": "tableHeader", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": [160], "align": null}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Naam"}]}]},
        {"type": "tableHeader", "attrs": {"colspan": 1, "rowspan": 1, "colwidth": null, "align": "right"}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Bedrag"}]}]}
      ]},
      {"type": "tableRow", "content": [
        {"type": "tableCell", "attrs": {"colspan": 2, "rowspan": 1, "colwidth": [0, 120]}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Koffie"}]}]}
      ]}
    ]},
    {"type": "callout", "attrs": {"variant": "let-op"}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Let hierop."}]}]},
    {"type": "details", "content": [
      {"type": "detailsSummary", "content": [{"type": "text", "text": "Meer weten?"}]},
      {"type": "detailsContent", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Hier staat meer."}]}]}
    ]}
  ]
}$json$::jsonb) as pagina \gset
select pg_temp.gelijk((select content from public.documents where id = :'pagina'),
  'Prijzen Naam Bedrag Koffie Let hierop. Meer weten? Hier staat meer.',
  'de platte tekst neemt de cellen, de callout en de uitklapper mee, in leesvolgorde');

select pg_temp.gelijk(pg_temp.pagina(pg_temp.callout('{}'::jsonb)) is not null, true, 'een callout zonder soort mag (de app kiest info)');
select pg_temp.gelijk(pg_temp.pagina(pg_temp.callout('{"variant": null}'::jsonb)) is not null, true, 'een callout met soort null mag');
select pg_temp.gelijk(pg_temp.pagina(pg_temp.cel('{"align": "center", "colwidth": null}'::jsonb)) is not null, true, 'een cel in het midden, zonder breedte, mag');

-- ── 2. De maten van een cel ─────────────────────────────────────────────────
select pg_temp.weigert(pg_temp.probeer(pg_temp.cel('{"colwidth": ["1px; background-image: url(https://volg.test/pixel.gif)"]}'::jsonb)),
  'Een tabelcel met een ongeldige maat', 'een breedte met een stijl erin');
select pg_temp.weigert(pg_temp.probeer(pg_temp.cel('{"colwidth": 120}'::jsonb)), 'Een tabelcel met een ongeldige maat', 'een breedte die geen lijst is');
select pg_temp.weigert(pg_temp.probeer(pg_temp.cel('{"colwidth": [12.5]}'::jsonb)), 'Een tabelcel met een ongeldige maat', 'een breedte met een komma');
select pg_temp.weigert(pg_temp.probeer(pg_temp.cel('{"colspan": "2"}'::jsonb)), 'Een tabelcel met een ongeldige maat', 'colspan als tekst');
select pg_temp.weigert(pg_temp.probeer(pg_temp.cel('{"colspan": 0}'::jsonb)), 'Een tabelcel met een ongeldige maat', 'colspan nul');
select pg_temp.weigert(pg_temp.probeer(pg_temp.cel('{"rowspan": 1.5}'::jsonb)), 'Een tabelcel met een ongeldige maat', 'een halve rij');

-- ── 3. Uitlijnen en de soort callout ────────────────────────────────────────
select pg_temp.weigert(pg_temp.probeer(pg_temp.cel('{"align": "justify"}'::jsonb)), 'Een tabelcel met een ongeldige maat of uitlijning', 'uitvullen kent de editor niet');
select pg_temp.weigert(pg_temp.probeer(pg_temp.cel('{"align": "left; color: red"}'::jsonb)), 'Een tabelcel met een ongeldige maat of uitlijning', 'een stijl als uitlijning');
select pg_temp.weigert(pg_temp.probeer(pg_temp.callout('{"variant": "rood"}'::jsonb)), 'Een callout met een onbekende soort', 'een onbekende soort');
select pg_temp.weigert(pg_temp.probeer(pg_temp.callout('{"variant": 3}'::jsonb)), 'Een callout met een onbekende soort', 'een getal als soort');

-- Wat er bij een weigering al stond, blijft staan.
select pg_temp.weigert(format('update public.documents set body = %L::jsonb where id = %L', pg_temp.cel('{"colwidth": ["x"]}'::jsonb)::text, :'pagina'),
  'Een tabelcel met een ongeldige maat', 'ook bij bijwerken');
select pg_temp.gelijk((select body->'content'->2->>'type' from public.documents where id = :'pagina'), 'table', 'de pagina is ongewijzigd');

\o
\echo Alle controles van paginas_blokken.sql geslaagd.
rollback;
