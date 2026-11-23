-- ============================================================
-- Databasetest: de leesrechten één keer per query (20261122200000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: 20261122200000 schreef 289 leespolicies om van een aanroep per rij
-- (can_read_org, can_read_module: elk een eigen query op organization_members)
-- naar een lijst die één keer per query wordt opgehaald (een InitPlan). Op
-- staging kostte de oude vorm zo'n 90 µs per rij. Dat mag alleen sneller
-- worden, niet anders: een rij te veel is een lek tussen organisaties of
-- modules, een rij te weinig een lege pagina. Deze test:
--
--   1. zet twee organisaties op met elke rol: owner, admin, lid met alles,
--      lid zonder Financiën, lid met alleen lezen, viewer, boekhouder, een
--      uitgeschakeld lid, iemand in beide organisaties, een buitenstaander,
--      en een sessie zonder JWT;
--   2. vult negen tabellen, met bijlagen aan vijf soorten records (ook een
--      chatbericht);
--   3. vergelijkt per gebruiker en per tabel de rijen die de RLS laat zien met
--      wat de oude functies (can_read_org, can_read_module,
--      attachment_module) zeggen;
--   4. controleert het plan: een InitPlan, geen rechtenfunctie per rij;
--   5. geen leespolicy rekent nog per rij met de oude vorm, op twee bewuste
--      uitzonderingen na;
--   6. attachment_module geeft alleen modules uit module_keys(), en de nieuwe
--      functies zijn dicht voor anon;
--   7. zet daarna de oude policies terug en vergelijkt opnieuw: oud en nieuw
--      laten precies dezelfde rijen zien.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

-- De hulpjes: als, beheer, gelijk, weigert.
\ir hulpjes.psql

-- ── 1. Gebruikers en organisaties ──────────────────────────────────────────

select gen_random_uuid() as eigenaar, gen_random_uuid() as beheerder, gen_random_uuid() as lid,
       gen_random_uuid() as zonder_fin, gen_random_uuid() as lezer, gen_random_uuid() as kijker,
       gen_random_uuid() as boekhouder, gen_random_uuid() as uit, gen_random_uuid() as beide,
       gen_random_uuid() as eigenaar_b, gen_random_uuid() as buiten \gset

insert into auth.users (id, email, aud, role) values
  (:'eigenaar',   'eigenaar@rls.test',   'authenticated', 'authenticated'),
  (:'beheerder',  'beheerder@rls.test',  'authenticated', 'authenticated'),
  (:'lid',        'lid@rls.test',        'authenticated', 'authenticated'),
  (:'zonder_fin', 'zonder-fin@rls.test', 'authenticated', 'authenticated'),
  (:'lezer',      'lezer@rls.test',      'authenticated', 'authenticated'),
  (:'kijker',     'kijker@rls.test',     'authenticated', 'authenticated'),
  (:'boekhouder', 'boekhouder@rls.test', 'authenticated', 'authenticated'),
  (:'uit',        'uit@rls.test',        'authenticated', 'authenticated'),
  (:'beide',      'beide@rls.test',      'authenticated', 'authenticated'),
  (:'eigenaar_b', 'eigenaar-b@rls.test', 'authenticated', 'authenticated'),
  (:'buiten',     'buiten@elders.test',  'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Alfa')).id as org_a \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Bureau Beta')).id as org_b \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 20 where id in (:'org_a', :'org_b');

-- module_access van owner, admin en boekhouder telt niet (member_module_level);
-- daarom staat er bij de admin en de boekhouder bewust iets in.
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org_a', :'beheerder',  'beheerder@rls.test',  'admin',      'active',   '{"finance":"none","projects":"none"}'),
  (:'org_a', :'lid',        'lid@rls.test',        'member',     'active',   '{}'),
  (:'org_a', :'zonder_fin', 'zonder-fin@rls.test', 'member',     'active',   '{"finance":"none"}'),
  (:'org_a', :'lezer',      'lezer@rls.test',      'member',     'active',   '{"finance":"read","projects":"read","time":"none","content":"none"}'),
  (:'org_a', :'kijker',     'kijker@rls.test',     'viewer',     'active',   '{"clients":"none","finance":"write"}'),
  (:'org_a', :'boekhouder', 'boekhouder@rls.test', 'accountant', 'active',   '{"projects":"write"}'),
  (:'org_a', :'uit',        'uit@rls.test',        'member',     'disabled', '{}'),
  (:'org_a', :'beide',      'beide@rls.test',      'member',     'active',   '{"projects":"none","chat":"none"}'),
  (:'org_b', :'beide',      'beide@rls.test',      'admin',      'active',   '{}');

-- ── 2. Gegevens in beide organisaties (als beheerder: zonder JWT) ──────────

create temp table orgs (naam text primary key, id uuid not null);
insert into orgs values ('a', :'org_a'), ('b', :'org_b');

insert into public.clients (organization_id, name)
select o.id, 'Klant ' || o.naam || g from orgs o, generate_series(1, 2) g;
insert into public.tasks (organization_id, title)
select o.id, 'Taak ' || o.naam || g from orgs o, generate_series(1, 3) g;
insert into public.notes (organization_id, title)
select o.id, 'Notitie ' || o.naam || g from orgs o, generate_series(1, 2) g;
insert into public.invoices (organization_id, number)
select o.id, 'RLS-' || o.naam || '-' || g from orgs o, generate_series(1, 2) g;
insert into public.time_entries (organization_id, user_id, minutes)
select o.id, case o.naam when 'a' then :'eigenaar'::uuid else :'eigenaar_b'::uuid end, 30 * g
from orgs o, generate_series(1, 2) g;

insert into public.ledger_accounts (organization_id, code, name, type)
select o.id, c.code, c.naam, c.soort from orgs o,
  (values ('9910', 'RLS bank', 'asset'), ('9920', 'RLS kosten', 'expense')) as c(code, naam, soort);
insert into public.journal_entries (organization_id, year, quarter, month)
select o.id, 2026, 4, 11 from orgs o;
insert into public.journal_lines (organization_id, entry_id, account_id, debit_cents, credit_cents)
select e.organization_id, e.id, la.id,
       case when la.code = '9920' then 1000 else 0 end, case when la.code = '9910' then 1000 else 0 end
from public.journal_entries e
join public.ledger_accounts la on la.organization_id = e.organization_id and la.code in ('9910', '9920')
where e.organization_id in (:'org_a', :'org_b');
insert into public.bank_accounts (organization_id, name, ledger_account_id)
select la.organization_id, 'RLS-rekening', la.id from public.ledger_accounts la
where la.organization_id in (:'org_a', :'org_b') and la.code = '9910';
insert into public.bank_transactions (organization_id, bank_account_id, dedup_key, booking_date, amount_cents)
select b.organization_id, b.id, 'rls-' || b.id || '-' || g, current_date - g, -1000 * g
from public.bank_accounts b, generate_series(1, 2) g
where b.organization_id in (:'org_a', :'org_b');

-- Teamchat: in A praten de eigenaar, het lid en "beide"; de lezer niet.
insert into public.chat_conversations (organization_id, kind, created_by)
select o.id, 'group', case o.naam when 'a' then :'eigenaar'::uuid else :'eigenaar_b'::uuid end from orgs o;
insert into public.chat_participants (conversation_id, organization_id, user_id)
select c.id, c.organization_id, u.id
from public.chat_conversations c
join (values (:'org_a'::uuid, :'eigenaar'::uuid), (:'org_a', :'lid'), (:'org_a', :'beide'), (:'org_b', :'eigenaar_b'))
  as u(org, id) on u.org = c.organization_id;
insert into public.chat_messages (organization_id, conversation_id, body)
select c.organization_id, c.id, 'Hallo' from public.chat_conversations c where c.organization_id in (:'org_a', :'org_b');

-- Bijlagen aan vijf soorten records: Klanten, Projecten, Inhoud, Financiën, Teamchat.
insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, storage_key)
select r.organization_id, r.soort, r.id, r.soort || '.pdf', 'application/pdf', r.organization_id::text || '/rls/' || r.id
from (
  select organization_id, 'client' as soort, id from public.clients
  union all select organization_id, 'task', id from public.tasks
  union all select organization_id, 'note', id from public.notes
  union all select organization_id, 'invoice', id from public.invoices
  union all select organization_id, 'chat_message', id from public.chat_messages
) r
where r.organization_id in (:'org_a', :'org_b');

-- ── 3. Wat de RLS laat zien, tegen de oude functies ────────────────────────

create temp table tabellen (naam text primary key, oud text not null);
insert into tabellen values
  ('tasks',             'public.can_read_org(t.organization_id) and public.can_read_module(t.organization_id, ''projects'')'),
  ('clients',           'public.can_read_org(t.organization_id) and public.can_read_module(t.organization_id, ''clients'')'),
  ('notes',             'public.can_read_org(t.organization_id) and public.can_read_module(t.organization_id, ''content'')'),
  ('invoices',          'public.can_read_org(t.organization_id) and public.can_read_module(t.organization_id, ''finance'')'),
  ('journal_lines',     'public.can_read_org(t.organization_id) and public.can_read_module(t.organization_id, ''finance'')'),
  ('bank_transactions', 'public.can_read_org(t.organization_id) and public.can_read_module(t.organization_id, ''finance'')'),
  ('time_entries',      'public.can_read_org(t.organization_id) and public.can_read_module(t.organization_id, ''time'')'),
  -- Plus het boekhouder-hek: van de teamlijst alleen de eigen rij.
  ('organization_members',
   'public.can_read_org(t.organization_id)
    and (not (t.organization_id = any (public.my_accountant_organization_ids())) or t.user_id = auth.uid())'),
  -- Plus het boekhouder-hek (alleen financiële bijlagen) en de chat: een
  -- bijlage aan een chatbericht alleen voor wie dat bericht mag lezen
  -- (de policies van chat_messages: deelnemer, en de module Teamchat).
  ('attachments',
   'public.can_read_org(t.organization_id)
    and (public.attachment_module(t.entity_type) is null
         or public.can_read_module(t.organization_id, public.attachment_module(t.entity_type)))
    and (not (t.organization_id = any (public.my_accountant_organization_ids()))
         or public.attachment_module(t.entity_type) = ''finance'')
    and (t.entity_type <> ''chat_message'' or exists (
          select 1 from public.chat_messages m
          where m.id = t.entity_id and public.chat_is_participant(m.conversation_id)
            and public.can_read_module(m.organization_id, ''chat'')))');

create temp table gebruikers (naam text primary key, id uuid);
insert into gebruikers values
  ('eigenaar', :'eigenaar'), ('beheerder', :'beheerder'), ('lid', :'lid'), ('zonder_fin', :'zonder_fin'),
  ('lezer', :'lezer'), ('kijker', :'kijker'), ('boekhouder', :'boekhouder'), ('uit', :'uit'),
  ('beide', :'beide'), ('eigenaar_b', :'eigenaar_b'), ('buiten', :'buiten'),
  ('zonder_jwt', null);

-- De id's die de RLS laat zien, als deze gebruiker (zoals PostgREST het doet).
create function pg_temp.via_rls(p_user uuid, p_tabel text) returns text language plpgsql as $$
declare
  v text;
  -- Vóór set role: authenticated mag de tijdelijke tabel niet lezen.
  v_orgs uuid[] := (select array_agg(id) from orgs);
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else
    json_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
  set local role authenticated;
  execute format(
    'select coalesce(string_agg(t.id::text, '','' order by t.id), '''') from public.%I t where t.organization_id = any ($1)',
    p_tabel) into v using v_orgs;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

-- Dezelfde vraag met de oude functies, zonder RLS (als beheerder), maar met
-- de JWT van de gebruiker, zodat auth.uid() hem is.
create function pg_temp.via_oud(p_user uuid, p_tabel text) returns text language plpgsql as $$
declare
  v text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else
    json_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
  execute format(
    'select coalesce(string_agg(t.id::text, '','' order by t.id), '''') from public.%I t where t.organization_id = any ($1) and (%s)',
    p_tabel, (select oud from tabellen where naam = p_tabel)) into v using (select array_agg(id) from orgs);
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create function pg_temp.aantal(p_ids text) returns int language sql as $$
  select case when p_ids = '' then 0 else cardinality(string_to_array(p_ids, ',')) end
$$;

create temp table uitkomst (gebruiker text, tabel text, rls text, oud text, primary key (gebruiker, tabel));
insert into uitkomst
select g.naam, t.naam, pg_temp.via_rls(g.id, t.naam), pg_temp.via_oud(g.id, t.naam)
from gebruikers g cross join tabellen t;

-- Per gebruiker het aantal zichtbare rijen, ter lezing in de uitvoer.
do $$
declare
  r record;
begin
  for r in
    select u.gebruiker, string_agg(u.tabel || ' ' || pg_temp.aantal(u.rls), ', ' order by u.tabel) as regel
    from uitkomst u group by u.gebruiker order by u.gebruiker
  loop
    raise notice 'zichtbaar voor %: %', r.gebruiker, r.regel;
  end loop;
end $$;

select pg_temp.gelijk(
  (select count(*) from uitkomst where rls is distinct from oud), 0::bigint,
  format('RLS gelijk aan de oude functies: %s gebruikers x %s tabellen',
         (select count(*) from gebruikers), (select count(*) from tabellen)));
-- Wat er verschilt, als het misgaat.
do $$
declare
  v text;
begin
  select string_agg(format('%s/%s: rls %s, oud %s', gebruiker, tabel, pg_temp.aantal(rls), pg_temp.aantal(oud)), '; ')
    into v from uitkomst where rls is distinct from oud;
  if v is not null then
    raise exception 'MISLUKT: verschil tussen RLS en de oude functies: %', v;
  end if;
end $$;

-- Een paar uitkomsten met de hand, zodat de test niet slaagt omdat alles leeg is.
create function pg_temp.n(p_gebruiker text, p_tabel text) returns int language sql as $$
  select pg_temp.aantal(rls) from uitkomst where gebruiker = p_gebruiker and tabel = p_tabel
$$;
select pg_temp.gelijk(pg_temp.n('eigenaar', 'tasks'), 3, 'owner A: de drie taken van A');
select pg_temp.gelijk(pg_temp.n('eigenaar', 'attachments'), 10, 'owner A: alle tien bijlagen van A (deelnemer in de chat)');
select pg_temp.gelijk(pg_temp.n('beheerder', 'invoices'), 2, 'admin: module_access telt niet, Financiën open');
select pg_temp.gelijk(pg_temp.n('beheerder', 'attachments'), 9, 'admin: geen deelnemer, dus de chatbijlage niet');
select pg_temp.gelijk(pg_temp.n('zonder_fin', 'invoices'), 0, 'lid zonder Financiën: geen facturen');
select pg_temp.gelijk(pg_temp.n('zonder_fin', 'bank_transactions'), 0, 'lid zonder Financiën: geen bank');
select pg_temp.gelijk(pg_temp.n('zonder_fin', 'tasks'), 3, 'lid zonder Financiën: wel taken');
select pg_temp.gelijk(pg_temp.n('zonder_fin', 'attachments'), 7, 'lid zonder Financiën: bijlagen behalve facturen en chat');
select pg_temp.gelijk(pg_temp.n('lezer', 'time_entries'), 0, 'lezer: Uren dicht');
select pg_temp.gelijk(pg_temp.n('lezer', 'journal_lines'), 2, 'lezer: Financiën lezen');
select pg_temp.gelijk(pg_temp.n('kijker', 'clients'), 0, 'viewer: Klanten dicht');
select pg_temp.gelijk(pg_temp.n('kijker', 'invoices'), 2, 'viewer: Financiën lezen (write wordt read)');
select pg_temp.gelijk(pg_temp.n('boekhouder', 'invoices'), 2, 'boekhouder: facturen');
select pg_temp.gelijk(pg_temp.n('boekhouder', 'tasks'), 0, 'boekhouder: geen taken, ook niet met projects=write');
select pg_temp.gelijk(pg_temp.n('boekhouder', 'attachments'), 2, 'boekhouder: alleen de bijlagen aan facturen');
select pg_temp.gelijk(pg_temp.n('boekhouder', 'organization_members'), 1, 'boekhouder: van de teamlijst alleen zichzelf');
select pg_temp.gelijk(pg_temp.n('uit', 'tasks') + pg_temp.n('uit', 'organization_members'), 0, 'uitgeschakeld lid: niets');
select pg_temp.gelijk(pg_temp.n('beide', 'tasks'), 3, 'in twee organisaties: alleen de taken van B (Projecten dicht in A)');
select pg_temp.gelijk(pg_temp.n('beide', 'invoices'), 4, 'in twee organisaties: de facturen van A en B');
select pg_temp.gelijk(pg_temp.n('beide', 'organization_members'), 11, 'in twee organisaties: beide teamlijsten (9 + 2)');
-- A: tien min drie taken en de chat (deelnemer, maar Teamchat dicht); B: alles
-- behalve de chat (geen deelnemer).
select pg_temp.gelijk(pg_temp.n('beide', 'attachments'), 15, 'in twee organisaties: bijlagen per organisatie met eigen rechten (6 + 9)');
select pg_temp.gelijk(pg_temp.n('eigenaar_b', 'tasks'), 3, 'owner B: alleen de taken van B');
select pg_temp.gelijk((select sum(pg_temp.aantal(rls))::int from uitkomst where gebruiker in ('buiten', 'zonder_jwt')), 0,
  'geen lid en geen JWT: niets');

-- anon heeft geen rechten op de tabellen; daar verandert niets aan.
set local role anon;
select pg_temp.weigert('select count(*) from public.tasks', 'permission denied', 'anon: geen toegang tot tasks');
select pg_temp.weigert('select public.my_organization_ids()', 'permission denied', 'anon: my_organization_ids dicht');
reset role;

-- null: organization_id is NOT NULL op elke herschreven tabel (de migratie
-- controleert dat); de lijst zelf bevat nooit null, ook zonder lidmaatschap.
select pg_temp.gelijk(
  (select count(*) from tabellen t join pg_attribute a
     on a.attrelid = ('public.' || t.naam)::regclass and a.attname = 'organization_id' and a.attnotnull),
  (select count(*) from tabellen), 'organization_id is NOT NULL op alle negen tabellen');
select pg_temp.als(:'lid');
select pg_temp.gelijk(public.my_organization_ids() @> array[:'org_a'::uuid] and array_position(public.my_organization_ids(), null) is null,
  true, 'my_organization_ids: de organisatie van het lid, zonder null');
select pg_temp.als(:'buiten');
select pg_temp.gelijk(public.my_organization_ids(), '{}'::uuid[], 'my_organization_ids: leeg voor een buitenstaander, niet null');
select pg_temp.beheer();

-- ── 4. Het plan: één keer per query ────────────────────────────────────────

create function pg_temp.plan(p_user uuid, p_sql text) returns text language plpgsql as $$
declare
  r record;
  v text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  for r in execute 'explain (costs off) ' || p_sql loop
    v := v || r."QUERY PLAN" || E'\n';
  end loop;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

select pg_temp.plan(:'lid', format('select * from public.tasks where organization_id = %L', :'org_a')) as plan_taken \gset
select pg_temp.gelijk(:'plan_taken' ~ 'InitPlan', true, 'plan tasks: de rechten in een InitPlan');
select pg_temp.gelijk(:'plan_taken' ~ '(user_is_org_member|org_module_level|can_read_org|can_read_module)', false,
  'plan tasks: geen rechtenfunctie per rij');
select pg_temp.plan(:'lid', format('select * from public.attachments where organization_id = %L', :'org_a')) as plan_bijlagen \gset
select pg_temp.gelijk(:'plan_bijlagen' ~ '(user_is_org_member|org_module_level|can_read_org|can_read_module)', false,
  'plan attachments: geen rechtenfunctie per rij');

-- ── 5. Geen leespolicy rekent nog per rij met de oude vorm ─────────────────
--
-- Schrijf een nieuwe leespolicy zo:
--   organization_id = any ((select public.my_organization_ids())::uuid[])
--   organization_id = any ((select public.my_module_organization_ids('<module>'))::uuid[])
-- (apply_module_gate doet het tweede zelf). Bewust per rij, en klein:
--   - organizations: can_read_org(id); een gebruiker leest er een handvol van;
--   - ai_decisions: can_read_module(organization_id, module), de module uit
--     een kolom.

select string_agg(format('%s op %s', p.polname, c.relname), '; ' order by c.relname, p.polname) as per_rij
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and p.polcmd in ('r', '*')
  and pg_get_expr(p.polqual, p.polrelid) ~ '\m(can_read_org|can_read_module|user_is_org_member|org_module_level)\(' \gset
select pg_temp.gelijk(:'per_rij', 'ai_decisions read op ai_decisions; organizations read by members op organizations',
  'leespolicies: alleen de twee bewuste uitzonderingen rekenen nog per rij');

-- ── 6. attachment_module en de rechten op de nieuwe functies ───────────────
--
-- my_readable_module_keys() kent alleen de modules uit module_keys(). Geeft
-- attachment_module ooit een andere terug, dan ziet niemand die bijlagen meer.

select coalesce(string_agg(distinct m[2], ', '), '') as buiten_keys
from regexp_matches(pg_get_functiondef('public.attachment_module(text)'::regprocedure),
                    '\m(then|else)\s+''([^'']*)''', 'gi') as m
where not (m[2] = any (public.module_keys())) \gset
select pg_temp.gelijk(:'buiten_keys', '', 'attachment_module: alleen modules uit module_keys()');
select pg_temp.gelijk(
  pg_get_functiondef('public.attachment_module(text)'::regprocedure) ~* '\m(then|else)\s+(?![\s'']|null\M)', false,
  'attachment_module: elke tak een vaste module of null');

select pg_temp.gelijk(
  (select count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('my_organization_ids', 'my_module_organization_ids', 'my_readable_module_keys')
      and p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=public']
      and not has_function_privilege('anon', p.oid, 'execute')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  3::bigint, 'de drie lijsten: stable, security definer, vaste search_path, dicht voor anon');

-- apply_module_gate geeft een nieuwe tabel meteen de snelle vorm, en die werkt.
create table public.rls_proef (id uuid primary key default gen_random_uuid(), organization_id uuid not null);
alter table public.rls_proef enable row level security;
grant select on public.rls_proef to authenticated;
create policy "rls_proef read" on public.rls_proef for select
  using (organization_id = any ((select public.my_organization_ids())::uuid[]));
-- Stil: de generator meldt anders vijf keer "does not exist, skipping".
set local client_min_messages = warning;
select public.apply_module_gate('rls_proef', 'finance');
set local client_min_messages = notice;
insert into public.rls_proef (organization_id) select id from orgs;
select pg_temp.gelijk(
  (select pg_get_expr(polqual, polrelid) ~ 'my_module_organization_ids\(''finance''::text\)'
          and pg_get_expr(polqual, polrelid) !~ 'can_read_module'
     from pg_policy where polrelid = 'public.rls_proef'::regclass and polname = 'module gate select'),
  true, 'apply_module_gate: de leespoort in de snelle vorm');
select pg_temp.gelijk(
  (select count(*) from pg_policy where polrelid = 'public.rls_proef'::regclass
     and polname in ('module gate insert', 'module gate update', 'module gate delete')
     and coalesce(pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)) ~ 'can_write_module\(organization_id, ''finance''::text\)'),
  3::bigint, 'apply_module_gate: schrijven blijft can_write_module');
select pg_temp.gelijk(pg_temp.aantal(pg_temp.via_rls(:'zonder_fin', 'rls_proef')), 0, 'apply_module_gate: zonder Financiën niets');
select pg_temp.gelijk(pg_temp.aantal(pg_temp.via_rls(:'lezer', 'rls_proef')), 1, 'apply_module_gate: een lezer ziet zijn organisatie');
select pg_temp.gelijk(pg_temp.aantal(pg_temp.via_rls(:'beide', 'rls_proef')), 2, 'apply_module_gate: in twee organisaties allebei');
drop table public.rls_proef;

-- ── 7. Oud tegen nieuw: de oude policies terug ─────────────────────────────
--
-- Draai de herschrijving terug (alleen in deze transactie) en vraag alles
-- opnieuw op. Dat toetst niet de omschrijving hierboven maar de policies zelf,
-- met alles wat erbij komt (het hek, de chat, de policies van chat_messages).

do $$
declare
  r      record;
  v_pad  text := current_setting('search_path');
  v_oud  text;
  v_n    int := 0;
begin
  perform set_config('search_path', '', true);
  for r in
    select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) as qual
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and p.polcmd = 'r'
      and pg_get_expr(p.polqual, p.polrelid) ~ 'my_(module_)?organization_ids|my_readable_module_keys'
  loop
    v_oud := regexp_replace(r.qual,
      '\(organization_id = ANY \(\(\s*SELECT public\.my_organization_ids\(\) AS my_organization_ids\)::uuid\[\]\)\)',
      'public.can_read_org(organization_id)', 'g');
    v_oud := regexp_replace(v_oud,
      '\(organization_id = ANY \(\(\s*SELECT public\.my_module_organization_ids\(''([a-z_]+)''::text\) AS my_module_organization_ids\)::uuid\[\]\)\)',
      'public.can_read_module(organization_id, ''\1''::text)', 'g');
    if r.relname = 'attachments' and r.polname = 'module gate select' then
      v_oud := '((public.attachment_module(entity_type) IS NULL) OR public.can_read_module(organization_id, public.attachment_module(entity_type)))';
    end if;
    if v_oud ~ 'my_(module_)?organization_ids|my_readable_module_keys' then
      raise exception 'MISLUKT: % op % laat zich niet terugzetten: %', r.polname, r.relname, v_oud;
    end if;
    execute format('alter policy %I on public.%I using (%s)', r.polname, r.relname, v_oud);
    v_n := v_n + 1;
  end loop;
  perform set_config('search_path', v_pad, true);
  raise notice 'ok: % leespolicies teruggezet naar de oude vorm', v_n;
  -- Minstens, niet precies: een nieuwe tabel krijgt volgens regel 5 van
  -- supabase/migrations/README.md zijn leespolicy meteen in de snelle vorm, en
  -- telt hier dan mee. Met "precies 290" faalde deze test op de eerste nieuwe
  -- tabellen daarna (time_entry_invoices en sent_e_invoices, 23 november).
  if v_n < 290 then
    raise exception 'MISLUKT: % leespolicies teruggezet, verwacht minstens 290 (289 uit 20261122200000, de poort op attachments, en die van latere tabellen)', v_n;
  end if;
end $$;

select pg_temp.plan(:'lid', format('select * from public.tasks where organization_id = %L', :'org_a')) as plan_oud \gset
select pg_temp.gelijk(:'plan_oud' ~ 'user_is_org_member', true, 'oud: het plan roept user_is_org_member per rij aan (de controle in stap 4 werkt)');

create temp table uitkomst_oud as
select g.naam as gebruiker, t.naam as tabel, pg_temp.via_rls(g.id, t.naam) as rls
from gebruikers g cross join tabellen t;

do $$
declare
  v text;
begin
  select string_agg(format('%s/%s: nieuw %s, oud %s', n.gebruiker, n.tabel, pg_temp.aantal(n.rls), pg_temp.aantal(o.rls)), '; ')
    into v
  from uitkomst n join uitkomst_oud o using (gebruiker, tabel)
  where n.rls is distinct from o.rls;
  if v is not null then
    raise exception 'MISLUKT: de oude policies laten andere rijen zien: %', v;
  end if;
end $$;
select pg_temp.gelijk((select count(*) from uitkomst_oud), (select count(*) from uitkomst),
  'oud en nieuw: dezelfde rijen voor elke gebruiker in elke tabel');

\echo 'Alle controles van rls_een_keer_per_query.sql geslaagd.'
rollback;
