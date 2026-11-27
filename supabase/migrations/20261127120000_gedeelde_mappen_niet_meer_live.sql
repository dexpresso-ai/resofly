-- ============================================================
-- ResoFly — Een gedeelde map vult zich niet meer vanzelf
-- Date: 2026-11-27
--
-- Tot nu toe was een gedeelde map live: drive_share_items las bij elke
-- weergave wat er nú in de map stond. Zette een collega er later een bestand,
-- notitie of document in, dan zag de klant dat meteen, zonder dat iemand op
-- Delen drukte. Vastgelegd op 27 november 2026: "klantbestanden worden pas
-- gedeeld, wanneer de gebruiker van de app de deel functie gebruikt"
-- (docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md, §7, stap 0).
--
-- Nu:
--   1. drive_share_entries houdt per mapdeling bij wélke items gedeeld zijn.
--      Een map delen (of opnieuw delen) legt vast wat er op dat moment in
--      staat (drive_share_capture). Daarna komt er alleen iets bij via "Ook
--      delen" (drive_share_add_items), met schrijfrechten op Inhoud.
--   2. drive_share_items geeft van een mapdeling alleen die items terug, en
--      alleen zolang ze in de map (of een submap) staan en bij dezelfde klant
--      horen, zoals voorheen. Verplaats je een gedeeld item uit de map, dan
--      verdwijnt het bij de ontvanger. Zet je het terug, dan staat het er weer:
--      het blijft in de lijst. Omdat het portaal en de deellink ook voor het
--      downloaden op drive_share_items leunen, is een niet-gedeeld item ook
--      niet te downloaden.
--   3. drive_share_folder_gaps vertelt de drive welke items in een map nog
--      niet gedeeld zijn, voor het label "Niet gedeeld" en de balk erboven.
--   4. Bestaande mapdelingen krijgen één keer hun huidige inhoud in de lijst,
--      zodat er bij de ontvanger niets verdwijnt.
--
-- Wie wat wanneer aan een deling toevoegde, staat in drive_share_entries zelf
-- (added_by, added_at). Een regel in het logboek per item zou bij het delen van
-- een volle map honderden regels geven.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. De lijst van gedeelde items per mapdeling ───────────────────────────

create table if not exists public.drive_share_entries (
  share_id uuid not null references public.drive_shares(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  item_type text not null check (item_type in ('attachment', 'note', 'document')),
  item_id uuid not null,
  added_by uuid references auth.users(id) on delete set null default auth.uid(),
  added_at timestamptz not null default now(),
  primary key (share_id, item_type, item_id)
);

create index if not exists idx_drive_share_entries_org
  on public.drive_share_entries (organization_id);
create index if not exists idx_drive_share_entries_item
  on public.drive_share_entries (organization_id, item_type, item_id);

alter table public.drive_share_entries enable row level security;

-- Lezen zoals drive_shares, in de snelle vorm (20261122200000). Schrijven kan
-- alleen via de functies hieronder: er is bewust geen policy voor insert,
-- update of delete.
drop policy if exists "drive_share_entries read" on public.drive_share_entries;
create policy "drive_share_entries read" on public.drive_share_entries
  for select to authenticated
  using (organization_id = any ((select public.my_organization_ids())::uuid[]));

-- Delen hoort bij de module Inhoud, net als de delingen zelf.
select public.apply_module_gate('drive_share_entries', 'content');

-- ── 2. Eén bron voor "wat staat er nu in deze map" ─────────────────────────
-- Vastleggen, tonen en aanvullen gebruiken allemaal deze boom, zodat ze niet
-- uit elkaar kunnen lopen. Dezelfde regel als drive_share_items had: elk blad
-- hoort bij dezelfde klant als de map, anders zou een submap of een later
-- verplaatste notitie van een ándere klant meeliften. Geen rechten voor de app:
-- alleen voor de functies in dit bestand.

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
   and coalesce((select p.client_id from public.projects p where p.id = d.project_id), d.client_id)
       is not distinct from v_client;
end;
$$;

revoke all on function public.drive_folder_tree_items(uuid, uuid) from public, anon, authenticated;

-- ── 3. Vastleggen wat er bij het delen in de map staat ──────────────────────

create or replace function public.drive_share_capture(p_share_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_share public.drive_shares;
  v_count integer;
begin
  select * into v_share from public.drive_shares s where s.id = p_share_id;
  if not found or v_share.item_type <> 'folder' then
    return 0;
  end if;

  insert into public.drive_share_entries (share_id, organization_id, item_type, item_id, added_by)
  select v_share.id, v_share.organization_id, t.item_type, t.item_id, coalesce(auth.uid(), v_share.created_by)
  from public.drive_folder_tree_items(v_share.organization_id, v_share.item_id) t
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Alleen de deeldienst (file-share, service-role) roept dit rechtstreeks aan,
-- bij opnieuw delen; een nieuwe deling legt de trigger hieronder vast.
revoke all on function public.drive_share_capture(uuid) from public, anon, authenticated;
grant execute on function public.drive_share_capture(uuid) to service_role;

create or replace function public.drive_shares_capture_entries()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.item_type = 'folder' then
    perform public.drive_share_capture(new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.drive_shares_capture_entries() from public, anon, authenticated;

drop trigger if exists drive_shares_capture_entries on public.drive_shares;
create trigger drive_shares_capture_entries
  after insert on public.drive_shares
  for each row execute function public.drive_shares_capture_entries();

-- ── 4. Tonen: alleen wat gedeeld is ─────────────────────────────────────────
-- Zelfde naam, argumenten en uitvoer als in 20260823000000, zodat het portaal
-- en de deellink niets hoeven te veranderen. Alleen de tak voor een map is
-- anders.

create or replace function public.drive_share_items(p_share_id uuid)
returns table (
  item_type text,
  item_id uuid,
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
  v_share public.drive_shares;
begin
  select * into v_share from public.drive_shares s where s.id = p_share_id;
  if not found then
    return;
  end if;

  if v_share.item_type = 'folder' then
    return query
    select t.item_type, t.item_id, t.name, t.mime_type, t.size_bytes, t.storage_key, t.modified, t.path
    from public.drive_folder_tree_items(v_share.organization_id, v_share.item_id) t
    where exists (
      select 1 from public.drive_share_entries e
      where e.share_id = v_share.id and e.item_type = t.item_type and e.item_id = t.item_id
    );

  elsif v_share.item_type = 'attachment' then
    return query
    select 'attachment'::text, a.id, a.name, a.mime_type, a.size_bytes::bigint, a.storage_key, a.created_at, ''::text
    from public.attachments a
    where a.id = v_share.item_id and a.organization_id = v_share.organization_id;

  elsif v_share.item_type = 'note' then
    return query
    select 'note'::text, n.id, n.title, 'text/html'::text, 0::bigint, null::text,
           coalesce(n.updated_at, n.created_at), ''::text
    from public.notes n
    where n.id = v_share.item_id and n.organization_id = v_share.organization_id;

  else
    return query
    select 'document'::text, d.id, d.title,
           coalesce(d.mime_type, 'text/html'), coalesce(d.size_bytes, 0)::bigint, d.storage_key,
           coalesce(d.updated_at, d.created_at), ''::text
    from public.documents d
    where d.id = v_share.item_id and d.organization_id = v_share.organization_id;
  end if;
end;
$$;

revoke all on function public.drive_share_items(uuid) from public, anon, authenticated;
grant execute on function public.drive_share_items(uuid) to service_role;

-- ── 5. Aanvullen: "Ook delen" ───────────────────────────────────────────────
-- Voor de app. De organisatie komt uit de deling zelf, nooit uit de invoer.

create or replace function public.drive_share_add_items(p_share_id uuid, p_items jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_share public.drive_shares;
  v_want integer;
  v_found integer;
  v_count integer;
begin
  select * into v_share from public.drive_shares s where s.id = p_share_id;
  if not found
     or not public.can_write_org(v_share.organization_id)
     or not public.can_write_module(v_share.organization_id, 'content') then
    raise exception 'Je mag deze deling niet aanvullen.' using errcode = '42501';
  end if;
  if v_share.item_type <> 'folder' then
    raise exception 'Alleen een gedeelde map kun je aanvullen.' using errcode = '22023';
  end if;
  if v_share.revoked_at is not null or (v_share.expires_at is not null and v_share.expires_at <= now()) then
    raise exception 'Deze deling loopt niet meer.' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then
    raise exception 'Geef de items op als lijst, hoogstens 500.' using errcode = '22023';
  end if;

  -- Geen tijdelijke tabel: in een security definer-functie zou een tijdelijke
  -- tabel die de aanroeper vooraf met dezelfde naam aanmaakt (met een eigen
  -- trigger) met de rechten van de eigenaar draaien.
  -- Elk item moet nu in de gedeelde map staan en bij dezelfde klant horen.
  with want as (
    select distinct x->>'item_type' as item_type, (x->>'item_id')::uuid as item_id
    from jsonb_array_elements(p_items) x
  ),
  tree as (
    select t.item_type, t.item_id
    from public.drive_folder_tree_items(v_share.organization_id, v_share.item_id) t
  )
  select (select count(*) from want),
         (select count(*) from want w join tree t on t.item_type = w.item_type and t.item_id = w.item_id)
    into v_want, v_found;
  if v_found < v_want then
    raise exception 'Niet alles staat in de gedeelde map.' using errcode = '22023';
  end if;

  insert into public.drive_share_entries (share_id, organization_id, item_type, item_id, added_by)
  select distinct v_share.id, v_share.organization_id, x->>'item_type', (x->>'item_id')::uuid, auth.uid()
  from jsonb_array_elements(p_items) x
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.drive_share_add_items(uuid, jsonb) from public, anon;
grant execute on function public.drive_share_add_items(uuid, jsonb) to authenticated, service_role;

-- ── 6. Wat in een map nog niet gedeeld is ───────────────────────────────────
-- Per lopende mapdeling die deze map omvat (de map zelf of een map erboven):
-- de items die direct in deze map staan en nog niet in die deling zitten.

create or replace function public.drive_share_folder_gaps(p_folder_id uuid)
returns table (share_id uuid, item_type text, item_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select f.organization_id into v_org from public.content_folders f where f.id = p_folder_id;
  if v_org is null or not public.can_read_module(v_org, 'content') then
    return;
  end if;

  return query
  with recursive up as (
    select f.id, f.parent_id, 0 as depth
    from public.content_folders f
    where f.id = p_folder_id and f.organization_id = v_org
    union all
    select p.id, p.parent_id, up.depth + 1
    from public.content_folders p
    join up on p.id = up.parent_id
    where up.depth < 20 and p.organization_id = v_org
  ),
  covering as (
    select s.id, s.item_id
    from public.drive_shares s
    join up on s.item_type = 'folder' and s.item_id = up.id
    where s.organization_id = v_org
      and s.revoked_at is null
      and (s.expires_at is null or s.expires_at > now())
  )
  select c.id, t.item_type, t.item_id
  from covering c
  cross join lateral public.drive_folder_tree_items(v_org, c.item_id) t
  where t.folder_id = p_folder_id
    and not exists (
      select 1 from public.drive_share_entries e
      where e.share_id = c.id and e.item_type = t.item_type and e.item_id = t.item_id
    );
end;
$$;

revoke all on function public.drive_share_folder_gaps(uuid) from public, anon;
grant execute on function public.drive_share_folder_gaps(uuid) to authenticated, service_role;

-- ── 7. Bestaande mapdelingen: één keer de huidige inhoud vastleggen ────────
-- Zo verdwijnt er bij de ontvanger niets. Alleen delingen die nog geen lijst
-- hebben, zodat opnieuw draaien niets toevoegt wat er intussen in de map kwam.

do $$
declare
  r record;
begin
  for r in
    select s.id
    from public.drive_shares s
    where s.item_type = 'folder'
      and s.revoked_at is null
      and not exists (select 1 from public.drive_share_entries e where e.share_id = s.id)
  loop
    perform public.drive_share_capture(r.id);
  end loop;
end;
$$;

-- ── 8. E-mailsjabloon "Nieuw in een gedeelde map" ─────────────────────────
-- "Ook delen" stuurt de ontvanger een melding, die je per keer kunt uitzetten
-- (vastgelegd op 27 november: "Ja ik wil een melding die men ook uit kan
-- zetten"). Een organisatie kan de tekst aanpassen, net als bij "Bestand
-- gedeeld". Dezelfde lijst als in 20261013100000, met file.added erbij.

do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.email_templates'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%template_key%'
  loop
    execute format('alter table public.email_templates drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.email_templates
  add constraint email_templates_template_key_check
  check (template_key in (
    'quote.sent',
    'invoice.sent',
    'invoice.reminder.1',
    'invoice.reminder.2',
    'invoice.reminder.3',
    'creditNote.sent',
    'contract.sent',
    'contract.signed.client',
    'meetingBooking.linkSent',
    'meetingBooking.confirmed',
    'file.shared',
    'file.added',
    'file.transfer',
    'portal.ticket.received',
    'portal.ticket.created',
    'portal.ticket.reply',
    'portal.ticket.status'
  ));

commit;
