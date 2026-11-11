-- ============================================================
-- ResoFly — Berichten: eigen mappen per klant
-- Date: 2026-11-11
--
-- WAAROM
-- Bij een klant met veel post werd de lijst op Berichten één lange stapel:
-- offertes, facturen, een project en losse vragen door elkaar, alleen op
-- datum. Teams ordenen hun mail van oudsher in mappen per klant ("Offertes",
-- "Project website/Feedback"). Dat kan nu: per klant een eigen mappenboom, en
-- een gesprek kun je van map naar map verplaatsen.
--
-- WAT
-- 1. Tabel client_email_folders: de mappen van één klant, genest via
--    parent_id. Hooguit vijf lagen diep; een naam komt per plek één keer voor.
-- 2. client_email_threads.folder_id: in welke map een GESPREK staat. Bewust
--    het gesprek en niet het losse bericht: een antwoord van de klant hoort bij
--    het gesprek, en komt dus vanzelf in dezelfde map. Leeg = "Zonder map".
-- 3. RPC's voor alles wat schrijft (maken, hernoemen, verplaatsen,
--    verwijderen, gesprekken verplaatsen). Security definer met een eigen
--    rechtencheck (schrijven op Klanten), net als delete_client_email; de app
--    schrijft niet rechtstreeks in deze tabellen.
-- 4. De view client_email_thread_overview krijgt folder_id erbij, achteraan.
--
-- VALKUILEN DIE HIER BEWUST ZIJN AFGEVANGEN
-- - Een map verwijderen gooit nooit mail of submappen weg: wat erin staat,
--   schuift één laag omhoog. Met "on delete cascade" verdween eerst de hele
--   onderliggende boom, en wie een lege bovenmap opruimde was ongemerkt ook
--   zijn submappen kwijt. Komt een submap daarbij naast een map met dezelfde
--   naam, dan krijgt hij er " (2)" achter.
-- - Verhuist een gesprek naar een andere klant (opnieuw koppelen), dan past
--   de map niet meer; de trigger zet hem dan op "Zonder map" in plaats van de
--   mailverwerking te laten vastlopen op een foutmelding.
-- - CREATE OR REPLACE VIEW zonder WITH-clausule zet security_invoker terug op
--   uit. Dan las de view met de rechten van de eigenaar en zag een teamlid de
--   gesprekken van andere organisaties. De optie staat er dus expliciet bij.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Mappen
-- ------------------------------------------------------------
create table if not exists public.client_email_folders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  parent_id uuid references public.client_email_folders(id) on delete cascade,
  name text not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.client_email_folders
  drop constraint if exists client_email_folders_name_check;
alter table public.client_email_folders
  add constraint client_email_folders_name_check
  check (char_length(btrim(name)) between 1 and 80);

-- Eén naam per plek, zonder op hoofdletters te letten ("Offertes" en
-- "offertes" naast elkaar is één map te veel). De wortel van een klant heeft
-- geen parent_id; daar staat het klant-id voor in.
create unique index if not exists uidx_client_email_folders_name
  on public.client_email_folders (client_id, coalesce(parent_id, client_id), lower(name));
create index if not exists idx_client_email_folders_org_client
  on public.client_email_folders (organization_id, client_id);
create index if not exists idx_client_email_folders_parent
  on public.client_email_folders (parent_id) where parent_id is not null;

comment on table public.client_email_folders is
  'Mappen voor klantmail op Berichten: per klant een eigen boom (parent_id), hooguit vijf lagen. Schrijven via de rpc''s *_client_email_folder en move_client_email_threads.';

drop trigger if exists client_email_folders_updated on public.client_email_folders;
create trigger client_email_folders_updated
  before update on public.client_email_folders
  for each row execute function public.set_updated_at();

-- De boom heel houden: dezelfde organisatie en klant als de bovenliggende map,
-- geen kringen, hooguit vijf lagen (ook als je een map mét submappen
-- verplaatst), en een map blijft bij de klant waarvoor hij gemaakt is.
create or replace function public.client_email_folders_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_parent_org uuid;
  v_parent_client uuid;
  v_depth integer := 1;
  v_height integer := 0;
  v_cycle boolean := false;
begin
  new.name := btrim(regexp_replace(coalesce(new.name, ''), '\s+', ' ', 'g'));

  if tg_op = 'UPDATE'
     and (new.organization_id is distinct from old.organization_id or new.client_id is distinct from old.client_id) then
    raise exception 'Een map blijft bij de klant waarvoor hij gemaakt is.' using errcode = '22023';
  end if;

  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'Een map kan niet in zichzelf staan.' using errcode = '22023';
    end if;

    select f.organization_id, f.client_id into v_parent_org, v_parent_client
      from public.client_email_folders f where f.id = new.parent_id;
    if v_parent_org is null
       or v_parent_org <> new.organization_id
       or v_parent_client <> new.client_id then
      raise exception 'De bovenliggende map hoort bij een andere klant.' using errcode = '22023';
    end if;

    with recursive up as (
      select f.id, f.parent_id, 1 as lvl from public.client_email_folders f where f.id = new.parent_id
      union all
      select f.id, f.parent_id, up.lvl + 1
        from public.client_email_folders f join up on f.id = up.parent_id
       where up.lvl < 50
    )
    select coalesce(max(lvl), 0) + 1, coalesce(bool_or(id = new.id), false)
      into v_depth, v_cycle
      from up;
    if v_cycle then
      raise exception 'Een map kan niet in een van zijn eigen submappen.' using errcode = '22023';
    end if;
  end if;

  -- Bij verplaatsen gaan de submappen mee: die tellen voor de diepte.
  if tg_op = 'UPDATE' then
    with recursive down as (
      select f.id, 1 as lvl from public.client_email_folders f where f.parent_id = new.id
      union all
      select f.id, down.lvl + 1
        from public.client_email_folders f join down on f.parent_id = down.id
       where down.lvl < 50
    )
    select coalesce(max(lvl), 0) into v_height from down;
  end if;

  if v_depth + v_height > 5 then
    raise exception 'Mappen gaan hooguit vijf lagen diep.' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists client_email_folders_guard on public.client_email_folders;
create trigger client_email_folders_guard
  before insert or update on public.client_email_folders
  for each row execute function public.client_email_folders_guard();

alter table public.client_email_folders enable row level security;

drop policy if exists "client email folders read" on public.client_email_folders;
create policy "client email folders read" on public.client_email_folders
  for select using (public.can_read_org(organization_id));
do $$ begin perform public.apply_module_gate('client_email_folders', 'clients'); end $$;

-- Alleen de rpc's hieronder schrijven; geen policy en geen tabelrecht.
revoke all on public.client_email_folders from anon;
revoke insert, update, delete, truncate on public.client_email_folders from authenticated;
grant select on public.client_email_folders to authenticated;
grant all on public.client_email_folders to service_role;

-- ------------------------------------------------------------
-- 2. In welke map een gesprek staat
-- ------------------------------------------------------------
alter table public.client_email_threads
  add column if not exists folder_id uuid references public.client_email_folders(id) on delete set null;

create index if not exists idx_client_email_threads_folder
  on public.client_email_threads (folder_id) where folder_id is not null;

comment on column public.client_email_threads.folder_id is
  'Map van dit gesprek (client_email_folders, dezelfde klant). Leeg = Zonder map. Een nieuw antwoord blijft in dezelfde map.';

create or replace function public.client_email_threads_folder_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_folder_org uuid;
  v_folder_client uuid;
begin
  -- Opnieuw gekoppeld aan een andere klant: de map van de oude klant past
  -- niet meer. Stil terug naar "Zonder map"; de mailverwerking mag hier niet
  -- op stuklopen.
  if tg_op = 'UPDATE'
     and new.client_id is distinct from old.client_id
     and new.folder_id is not distinct from old.folder_id then
    new.folder_id := null;
  end if;

  if new.folder_id is null then
    return new;
  end if;

  select f.organization_id, f.client_id into v_folder_org, v_folder_client
    from public.client_email_folders f where f.id = new.folder_id;
  if v_folder_org is null
     or v_folder_org <> new.organization_id
     or v_folder_client <> new.client_id then
    raise exception 'Deze map hoort bij een andere klant dan het gesprek.' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists client_email_threads_folder_guard on public.client_email_threads;
create trigger client_email_threads_folder_guard
  before insert or update of folder_id, client_id on public.client_email_threads
  for each row execute function public.client_email_threads_folder_guard();

-- ------------------------------------------------------------
-- 3. Schrijven: alleen via deze functies
-- ------------------------------------------------------------

-- Een map maken, bovenaan bij de klant of in een andere map.
create or replace function public.create_client_email_folder(
  p_organization_id uuid,
  p_client_id uuid,
  p_name text,
  p_parent_id uuid default null
)
returns public.client_email_folders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_parent public.client_email_folders;
  v_row public.client_email_folders;
begin
  if auth.role() is distinct from 'service_role'
     and not public.can_write_module(p_organization_id, 'clients') then
    raise exception 'Je hebt geen schrijfrechten op Klanten, dus je kunt geen mappen maken.' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'Geef de map een naam.' using errcode = '22023';
  end if;
  if char_length(v_name) > 80 then
    raise exception 'Een mapnaam is hooguit 80 tekens.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id and c.organization_id = p_organization_id) then
    raise exception 'Klant niet gevonden.' using errcode = 'P0002';
  end if;
  if p_parent_id is not null then
    select * into v_parent from public.client_email_folders f
     where f.id = p_parent_id and f.organization_id = p_organization_id;
    if not found or v_parent.client_id <> p_client_id then
      raise exception 'De bovenliggende map bestaat niet (meer) bij deze klant.' using errcode = 'P0002';
    end if;
  end if;
  if exists (
    select 1 from public.client_email_folders f
     where f.client_id = p_client_id
       and f.parent_id is not distinct from p_parent_id
       and lower(f.name) = lower(v_name)
  ) then
    raise exception 'Er staat al een map "%" op deze plek.', v_name using errcode = '23505';
  end if;

  insert into public.client_email_folders (organization_id, client_id, parent_id, name, created_by)
  values (p_organization_id, p_client_id, p_parent_id, v_name, auth.uid())
  returning * into v_row;
  return v_row;
exception
  when unique_violation then
    raise exception 'Er staat al een map "%" op deze plek.', v_name using errcode = '23505';
end;
$$;

-- Een andere naam geven.
create or replace function public.rename_client_email_folder(
  p_organization_id uuid,
  p_folder_id uuid,
  p_name text
)
returns public.client_email_folders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_folder public.client_email_folders;
begin
  if auth.role() is distinct from 'service_role'
     and not public.can_write_module(p_organization_id, 'clients') then
    raise exception 'Je hebt geen schrijfrechten op Klanten, dus je kunt geen mappen wijzigen.' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'Geef de map een naam.' using errcode = '22023';
  end if;
  if char_length(v_name) > 80 then
    raise exception 'Een mapnaam is hooguit 80 tekens.' using errcode = '22023';
  end if;
  select * into v_folder from public.client_email_folders f
   where f.id = p_folder_id and f.organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'Map niet gevonden.' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.client_email_folders f
     where f.client_id = v_folder.client_id
       and f.parent_id is not distinct from v_folder.parent_id
       and f.id <> v_folder.id
       and lower(f.name) = lower(v_name)
  ) then
    raise exception 'Er staat al een map "%" op deze plek.', v_name using errcode = '23505';
  end if;

  update public.client_email_folders set name = v_name
   where id = v_folder.id
  returning * into v_folder;
  return v_folder;
exception
  when unique_violation then
    raise exception 'Er staat al een map "%" op deze plek.', v_name using errcode = '23505';
end;
$$;

-- Een map (met alles erin) in een andere map zetten; null = bovenaan.
create or replace function public.move_client_email_folder(
  p_organization_id uuid,
  p_folder_id uuid,
  p_parent_id uuid default null
)
returns public.client_email_folders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_folder public.client_email_folders;
  v_parent public.client_email_folders;
begin
  if auth.role() is distinct from 'service_role'
     and not public.can_write_module(p_organization_id, 'clients') then
    raise exception 'Je hebt geen schrijfrechten op Klanten, dus je kunt geen mappen verplaatsen.' using errcode = '42501';
  end if;
  select * into v_folder from public.client_email_folders f
   where f.id = p_folder_id and f.organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'Map niet gevonden.' using errcode = 'P0002';
  end if;
  if v_folder.parent_id is not distinct from p_parent_id then
    return v_folder;
  end if;
  if p_parent_id is not null then
    select * into v_parent from public.client_email_folders f
     where f.id = p_parent_id and f.organization_id = p_organization_id;
    if not found or v_parent.client_id <> v_folder.client_id then
      raise exception 'Je kunt een map alleen binnen dezelfde klant verplaatsen.' using errcode = '22023';
    end if;
  end if;
  if exists (
    select 1 from public.client_email_folders f
     where f.client_id = v_folder.client_id
       and f.parent_id is not distinct from p_parent_id
       and f.id <> v_folder.id
       and lower(f.name) = lower(v_folder.name)
  ) then
    raise exception 'Daar staat al een map "%". Geef een van beide eerst een andere naam.', v_folder.name using errcode = '23505';
  end if;

  -- Kringen en diepte bewaakt de trigger (client_email_folders_guard).
  update public.client_email_folders set parent_id = p_parent_id
   where id = v_folder.id
  returning * into v_folder;
  return v_folder;
end;
$$;

-- Een map verwijderen. Wat erin staat — gesprekken en submappen — schuift één
-- laag omhoog: er gaat nooit mail verloren, en ook geen ordening eronder.
create or replace function public.delete_client_email_folder(
  p_organization_id uuid,
  p_folder_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_folder public.client_email_folders;
  v_child record;
  v_name text;
  v_n integer;
  v_threads integer := 0;
  v_folders integer := 0;
begin
  if auth.role() is distinct from 'service_role'
     and not public.can_write_module(p_organization_id, 'clients') then
    raise exception 'Je hebt geen schrijfrechten op Klanten, dus je kunt geen mappen verwijderen.' using errcode = '42501';
  end if;
  select * into v_folder from public.client_email_folders f
   where f.id = p_folder_id and f.organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'Map niet gevonden.' using errcode = 'P0002';
  end if;

  update public.client_email_threads
     set folder_id = v_folder.parent_id
   where organization_id = p_organization_id
     and folder_id = v_folder.id;
  get diagnostics v_threads = row_count;

  -- Eerst de te verwijderen map opzij: een submap met dezelfde naam (Offertes
  -- in Offertes) mag dan gewoon zijn plek innemen.
  update public.client_email_folders
     set name = 'verwijderd ' || v_folder.id::text
   where id = v_folder.id;

  for v_child in
    select f.id, f.name from public.client_email_folders f
     where f.parent_id = v_folder.id
     order by lower(f.name)
  loop
    v_name := v_child.name;
    v_n := 1;
    while exists (
      select 1 from public.client_email_folders s
       where s.client_id = v_folder.client_id
         and s.parent_id is not distinct from v_folder.parent_id
         and s.id <> v_folder.id
         and lower(s.name) = lower(v_name)
    ) loop
      v_n := v_n + 1;
      v_name := left(v_child.name, 72) || ' (' || v_n || ')';
    end loop;
    update public.client_email_folders
       set parent_id = v_folder.parent_id, name = v_name
     where id = v_child.id;
    v_folders := v_folders + 1;
  end loop;

  delete from public.client_email_folders where id = v_folder.id;

  return jsonb_build_object(
    'threads_moved', v_threads,
    'folders_moved', v_folders,
    'parent_id', v_folder.parent_id
  );
end;
$$;

-- Eén of meer gesprekken in een map zetten; null = terug naar "Zonder map".
create or replace function public.move_client_email_threads(
  p_organization_id uuid,
  p_thread_ids uuid[],
  p_folder_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_found integer;
  v_client uuid;
  v_moved integer := 0;
begin
  if auth.role() is distinct from 'service_role'
     and not public.can_write_module(p_organization_id, 'clients') then
    raise exception 'Je hebt geen schrijfrechten op Klanten, dus je kunt geen gesprekken verplaatsen.' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_ids
    from unnest(coalesce(p_thread_ids, '{}'::uuid[])) as x
   where x is not null;
  if cardinality(v_ids) = 0 then
    return 0;
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'Verplaats hooguit 500 gesprekken tegelijk.' using errcode = '22023';
  end if;

  select count(*) into v_found
    from public.client_email_threads t
   where t.organization_id = p_organization_id and t.id = any(v_ids);
  if v_found <> cardinality(v_ids) then
    raise exception 'Een of meer gesprekken bestaan niet (meer). Ververs de lijst en probeer het opnieuw.' using errcode = 'P0002';
  end if;

  if p_folder_id is not null then
    select f.client_id into v_client
      from public.client_email_folders f
     where f.id = p_folder_id and f.organization_id = p_organization_id;
    if v_client is null then
      raise exception 'Map niet gevonden.' using errcode = 'P0002';
    end if;
    if exists (
      select 1 from public.client_email_threads t
       where t.organization_id = p_organization_id and t.id = any(v_ids) and t.client_id <> v_client
    ) then
      raise exception 'Een map hoort bij één klant. Verplaats alleen gesprekken van die klant naar deze map.' using errcode = '22023';
    end if;
  end if;

  update public.client_email_threads t
     set folder_id = p_folder_id
   where t.organization_id = p_organization_id
     and t.id = any(v_ids)
     and t.folder_id is distinct from p_folder_id;
  get diagnostics v_moved = row_count;
  return v_moved;
end;
$$;

-- ------------------------------------------------------------
-- 4. De lijst op Berichten weet in welke map een gesprek staat
-- ------------------------------------------------------------
create or replace view public.client_email_thread_overview
with (security_invoker = on) as
select
  t.id,
  t.organization_id,
  t.created_by,
  t.client_id,
  c.name  as client_name,
  c.email as client_email,
  t.subject,
  t.last_message_at,
  t.last_direction,
  t.created_at,
  t.updated_at,
  coalesce(stats.message_count, 0)::integer          as message_count,
  coalesce(stats.unread_count, 0)::integer           as unread_count,
  coalesce(stats.has_delivery_problem, false)        as has_delivery_problem,
  lm.id         as last_email_id,
  lm.direction  as last_email_direction,
  lm.from_name  as last_from_name,
  lm.from_email as last_from_email,
  lm.status     as last_status,
  lm.created_at as last_email_at,
  left(regexp_replace(left(coalesce(lm.body_text, ''), 800), '\s+', ' ', 'g'), 200) as last_preview,
  t.folder_id
from public.client_email_threads t
join public.clients c on c.id = t.client_id
left join lateral (
  select count(*) as message_count,
         count(*) filter (
           where e.direction = 'inbound'
             and not exists (
               select 1 from public.client_email_reads r
                where r.client_email_id = e.id and r.user_id = auth.uid()
             )
         ) as unread_count,
         bool_or(e.status in ('bounced', 'failed', 'complained')) as has_delivery_problem
    from public.client_emails e
   where e.thread_id = t.id
     and e.deleted_at is null
) stats on true
left join lateral (
  select e.id, e.direction, e.from_name, e.from_email, e.status, e.body_text, e.created_at
    from public.client_emails e
   where e.thread_id = t.id
     and e.deleted_at is null
   order by e.created_at desc
   limit 1
) lm on true;

comment on view public.client_email_thread_overview is
  'Eén regel per klantgesprek voor de pagina Berichten: klantnaam, aantal berichten, laatste bericht, de ongelezen-teller van de huidige gebruiker en de map. security_invoker: de RLS van de onderliggende tabellen geldt.';

revoke all on public.client_email_thread_overview from anon;
grant select on public.client_email_thread_overview to authenticated;

-- ------------------------------------------------------------
-- 5. Rechten op de functies
-- ------------------------------------------------------------
revoke all on function public.client_email_folders_guard() from public, anon, authenticated;
revoke all on function public.client_email_threads_folder_guard() from public, anon, authenticated;

revoke all on function public.create_client_email_folder(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.rename_client_email_folder(uuid, uuid, text) from public, anon;
revoke all on function public.move_client_email_folder(uuid, uuid, uuid) from public, anon;
revoke all on function public.delete_client_email_folder(uuid, uuid) from public, anon;
revoke all on function public.move_client_email_threads(uuid, uuid[], uuid) from public, anon;
grant execute on function public.create_client_email_folder(uuid, uuid, text, uuid) to authenticated, service_role;
grant execute on function public.rename_client_email_folder(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.move_client_email_folder(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.delete_client_email_folder(uuid, uuid) to authenticated, service_role;
grant execute on function public.move_client_email_threads(uuid, uuid[], uuid) to authenticated, service_role;

commit;
