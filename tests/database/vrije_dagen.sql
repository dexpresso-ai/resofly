-- ============================================================
-- Databasetest: vrije dagen in de weekplanner (20261125090000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: een vrije dag is persoonlijk, net als je werktijd. Een collega, ook
-- een eigenaar, ziet hem niet en zet hem niet voor je. En de weekplanner hoort
-- bij Projecten: wie die module niet mag lezen, krijgt niets terug, en wie
-- hem alleen mag lezen, zet geen vrije dag. Deze test:
--
--   1. zet een organisatie op met een eigenaar, een lid met alles, een lid
--      zonder Projecten, een lid dat Projecten alleen mag lezen en een
--      boekhouder, plus een tweede organisatie;
--   2. laat ieder een vrije dag zetten: wie het niet mag, wordt geweigerd;
--   3. controleert per persoon welke vrije dagen hij ziet;
--   4. controleert de regels op de tabel: alleen voor een lid, één keer per
--      dag, en lezen één keer per vraag.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

-- ── 1. Leden en organisaties ────────────────────────────────────────────────

select gen_random_uuid() as eigenaar, gen_random_uuid() as lid, gen_random_uuid() as zonder_projecten,
       gen_random_uuid() as alleen_lezen, gen_random_uuid() as boekhouder, gen_random_uuid() as eigenaar_b \gset

insert into auth.users (id, email, aud, role) values
  (:'eigenaar',         'eigenaar@vrij.test',         'authenticated', 'authenticated'),
  (:'lid',              'lid@vrij.test',              'authenticated', 'authenticated'),
  (:'zonder_projecten', 'zonder-projecten@vrij.test', 'authenticated', 'authenticated'),
  (:'alleen_lezen',     'alleen-lezen@vrij.test',     'authenticated', 'authenticated'),
  (:'boekhouder',       'boekhouder@vrij.test',       'authenticated', 'authenticated'),
  (:'eigenaar_b',       'eigenaar-b@vrij.test',       'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Vrij')).id as org_a \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Bureau Elders')).id as org_b \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id in (:'org_a', :'org_b');

insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org_a', :'lid',              'lid@vrij.test',              'member',     'active', '{}'),
  (:'org_a', :'zonder_projecten', 'zonder-projecten@vrij.test', 'member',     'active', '{"projects":"none"}'),
  (:'org_a', :'alleen_lezen',     'alleen-lezen@vrij.test',     'member',     'active', '{"projects":"read"}'),
  (:'org_a', :'boekhouder',       'boekhouder@vrij.test',       'accountant', 'active', '{}');

-- Zet als `p_user` een vrije dag voor `p_voor`; geeft null als het lukt, anders de fout.
create function pg_temp.zet(p_user uuid, p_org uuid, p_voor uuid, p_dag date) returns text language plpgsql as $$
declare v_fout text;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  begin
    insert into public.planner_days_off (organization_id, user_id, day) values (p_org, p_voor, p_dag);
  exception when others then
    v_fout := sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  perform pg_temp.beheer();
  return v_fout;
end $$;

-- De vrije dagen die `p_user` ziet, als "e-mail:dag" op volgorde.
-- Eerst als die gebruiker de ids ophalen; de namen pas als beheerder, want
-- auth.users is niet leesbaar voor een ingelogde gebruiker.
create function pg_temp.ziet(p_user uuid) returns text language plpgsql as $$
declare v_ids uuid[]; v text;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select coalesce(array_agg(d.id), '{}') into v_ids from public.planner_days_off d;
  reset role;
  perform pg_temp.beheer();
  select coalesce(string_agg(split_part(u.email, '@', 1) || ':' || d.day::text, ',' order by u.email, d.day), '')
    into v
    from public.planner_days_off d
    join auth.users u on u.id = d.user_id
    where d.id = any (v_ids);
  return v;
end $$;

-- ── 2. Een vrije dag zetten ─────────────────────────────────────────────────

select pg_temp.gelijk(pg_temp.zet(:'eigenaar', :'org_a', :'eigenaar', '2026-11-27'), null::text, 'eigenaar: eigen vrije dag');
select pg_temp.gelijk(pg_temp.zet(:'lid', :'org_a', :'lid', '2026-11-25'), null::text, 'lid met alles: eigen vrije dag');

select pg_temp.gelijk(position('row-level security' in coalesce(pg_temp.zet(:'lid', :'org_a', :'eigenaar', '2026-11-26'), '')) > 0, true,
  'lid: geen vrije dag voor een ander, ook niet voor de eigenaar');
select pg_temp.gelijk(position('row-level security' in coalesce(pg_temp.zet(:'eigenaar', :'org_a', :'lid', '2026-11-26'), '')) > 0, true,
  'eigenaar: geen vrije dag voor een teamlid');
select pg_temp.gelijk(position('Geen toegang tot de module' in coalesce(pg_temp.zet(:'zonder_projecten', :'org_a', :'zonder_projecten', '2026-11-26'), '')) > 0, true,
  'zonder Projecten: geen vrije dag');
select pg_temp.gelijk(position('Geen toegang tot de module' in coalesce(pg_temp.zet(:'alleen_lezen', :'org_a', :'alleen_lezen', '2026-11-26'), '')) > 0, true,
  'Projecten alleen lezen: geen vrije dag');
select pg_temp.gelijk(pg_temp.zet(:'boekhouder', :'org_a', :'boekhouder', '2026-11-26') is not null, true,
  'boekhouder: geen vrije dag (geen Projecten)');
select pg_temp.gelijk(position('hoort bij een lid' in coalesce(pg_temp.zet(:'eigenaar_b', :'org_a', :'eigenaar_b', '2026-11-26'), '')) > 0, true,
  'andere organisatie: geen vrije dag in een organisatie waar je geen lid van bent');

-- De beheerder zet er een paar die de leden zelf niet mochten zetten, om te
-- zien of ze ze dan wel of niet lezen.
insert into public.planner_days_off (organization_id, user_id, day) values
  (:'org_a', :'zonder_projecten', '2026-11-24'),
  (:'org_a', :'alleen_lezen',     '2026-11-24'),
  (:'org_b', :'eigenaar_b',       '2026-11-23');

-- ── 3. Wie ziet wat ─────────────────────────────────────────────────────────

select pg_temp.gelijk(pg_temp.ziet(:'eigenaar'), 'eigenaar:2026-11-27', 'eigenaar: alleen de eigen dag, niet die van het lid');
select pg_temp.gelijk(pg_temp.ziet(:'lid'), 'lid:2026-11-25', 'lid: alleen de eigen dag');
select pg_temp.gelijk(pg_temp.ziet(:'zonder_projecten'), '', 'zonder Projecten: niets, ook de eigen dag niet');
select pg_temp.gelijk(pg_temp.ziet(:'alleen_lezen'), 'alleen-lezen:2026-11-24', 'Projecten alleen lezen: de eigen dag');
select pg_temp.gelijk(pg_temp.ziet(:'boekhouder'), '', 'boekhouder: niets');
select pg_temp.gelijk(pg_temp.ziet(:'eigenaar_b'), 'eigenaar-b:2026-11-23', 'andere organisatie: alleen de eigen dag daar');

-- Weer werkdag maken: alleen je eigen dag.
select pg_temp.als(:'lid');
set local role authenticated;
delete from public.planner_days_off where day = '2026-11-27';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select count(*) from public.planner_days_off where user_id = :'eigenaar'), 1::bigint,
  'lid: de vrije dag van de eigenaar weghalen gaat niet');
select pg_temp.als(:'lid');
set local role authenticated;
delete from public.planner_days_off where day = '2026-11-25';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select count(*) from public.planner_days_off where user_id = :'lid'), 0::bigint,
  'lid: de eigen vrije dag weghalen gaat wel');

-- ── 4. De regels op de tabel ────────────────────────────────────────────────

select pg_temp.weigert(format(
  'insert into public.planner_days_off (organization_id, user_id, day) values (%L, %L, ''2026-11-27'')',
  :'org_a', :'eigenaar'), 'planner_days_off_organization_id_user_id_day_key', 'dezelfde dag twee keer: geweigerd');
select pg_temp.weigert(format(
  'insert into public.planner_days_off (organization_id, user_id, day) values (%L, %L, ''2026-11-27'')',
  :'org_b', :'lid'), 'hoort bij een lid', 'een vrije dag voor iemand die geen lid is: geweigerd');

-- Lezen één keer per query: geen rechtenfunctie per rij in de leesregels.
select pg_temp.gelijk(
  (select bool_or(pg_get_expr(p.polqual, p.polrelid) ~ '\m(can_read_org|can_read_module|user_is_org_member|org_module_level)\(')
     from pg_policy p where p.polrelid = 'public.planner_days_off'::regclass and p.polcmd = 'r'),
  false, 'leesregels: geen rechtenfunctie per rij');

\o
\echo Alle controles van vrije_dagen.sql geslaagd.
rollback;
