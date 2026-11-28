-- ============================================================
-- Pagina's: de prullenbak (stap 1A-5b)
--
-- Zie docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md (§4 en §18) en
-- docs/changelog/CHANGELOG_PAGINAS_PRULLENBAK_2026-11-28.md.
--
-- Weggooien was tot nu toe definitief: de app verwijderde de pagina, en de
-- database nam haar subpagina's mee (parent_id … on delete cascade). Hun
-- bijlagen bleven daarbij achter, in de opslag en in het quotum.
--
-- Nu:
--   - trash_page() zet archived_at op de pagina en al haar subpagina's;
--   - een pagina in de prullenbak is voor iedereen onzichtbaar en niet te
--     wijzigen (een restrictive policy), met haar versies en bijlagen. Gerrie, de MCP en de API filteren
--     zelf (actions/types.ts en gerrieCore.ts), want die draaien als service role;
--   - restore_page() zet haar terug, met de subpagina's die er tegelijk in
--     gingen. Ligt de ouder nog in de prullenbak, dan komt ze los in het dossier;
--   - list_page_trash() toont de prullenbak;
--   - na 30 dagen gaat alles definitief weg (purge_page_trash, dagelijks via
--     pg_cron), en delete_page_forever() kan dat eerder. De bijlagen van die
--     pagina's gaan naar de opruimwachtrij (storage_purge_queue, reden
--     'document'), in plaats van achter te blijven.
--
-- Mag veilig opnieuw draaien: create or replace, drop … if exists, en de
-- cron-taak wordt vervangen.
-- ============================================================

-- ── 1. Onzichtbaar en onveranderlijk ────────────────────────────────────────
-- Alleen pagina's komen in de prullenbak (trash_page); andere documenten
-- hebben altijd archived_at null. with check: archived_at zet je niet zelf,
-- dat gaat via trash_page.

drop policy if exists "documents niet uit de prullenbak" on public.documents;
create policy "documents niet uit de prullenbak" on public.documents
  as restrictive
  for all
  to authenticated
  using (archived_at is null)
  with check (archived_at is null);

-- Ook de versies en de bijlagen van zo'n pagina: die hebben hun eigen
-- policies (op organisatie), en waren anders per id nog te lezen. De hulp is
-- security definer: onder de policy hierboven ziet de lezer de pagina zelf niet
-- meer, en zou hij dus denken dat ze niet in de prullenbak ligt.
create or replace function public.document_in_trash(p_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.documents d where d.id = p_document_id and d.archived_at is not null);
$$;

revoke all on function public.document_in_trash(uuid) from public, anon;
grant execute on function public.document_in_trash(uuid) to authenticated;

drop policy if exists "document_versions niet uit de prullenbak" on public.document_versions;
create policy "document_versions niet uit de prullenbak" on public.document_versions
  as restrictive
  for all
  to authenticated
  using (not public.document_in_trash(document_id));

drop policy if exists "attachments niet uit de prullenbak" on public.attachments;
create policy "attachments niet uit de prullenbak" on public.attachments
  as restrictive
  for all
  to authenticated
  using (entity_type <> 'document' or not public.document_in_trash(entity_id));

-- ── 2. Weggooien ────────────────────────────────────────────────────────────

create or replace function public.trash_page(p_page_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  -- clock_timestamp, niet now(): binnen één transactie geeft now() steeds
  -- hetzelfde moment, en dan liepen twee keer weggooien samen in de prullenbak.
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  select * into v_doc from public.documents d where d.id = p_page_id;
  if not found
     or not public.can_write_org(v_doc.organization_id)
     or not public.can_write_module(v_doc.organization_id, 'content') then
    raise exception 'Je mag deze pagina niet weggooien.' using errcode = '42501';
  end if;
  if v_doc.format is distinct from 'page' then
    raise exception 'Alleen een pagina gaat naar de prullenbak.' using errcode = '22023';
  end if;
  if v_doc.archived_at is not null then
    return 0;
  end if;

  -- De pagina en al haar subpagina's, met hetzelfde moment: zo gaan ze ook
  -- samen terug. Wat al eerder in de prullenbak lag, houdt zijn eigen moment.
  with recursive boom as (
    select d.id from public.documents d where d.id = v_doc.id
    union
    select d.id from public.documents d join boom b on d.parent_id = b.id
    where d.organization_id = v_doc.organization_id
  )
  update public.documents d
     set archived_at = v_now, archived_by = auth.uid()
    from boom
   where d.id = boom.id and d.archived_at is null;
  get diagnostics v_count = row_count;

  -- Wie ze nog open had, bewerkt niet verder.
  delete from public.document_edit_claims c
   using public.documents d
   where c.document_id = d.id and d.organization_id = v_doc.organization_id and d.archived_at = v_now;
  return v_count;
end;
$$;

revoke all on function public.trash_page(uuid) from public, anon;
grant execute on function public.trash_page(uuid) to authenticated;

-- ── 3. Terugzetten ──────────────────────────────────────────────────────────

create or replace function public.restore_page(p_page_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  v_count integer;
begin
  select * into v_doc from public.documents d where d.id = p_page_id;
  if not found
     or not public.can_write_org(v_doc.organization_id)
     or not public.can_write_module(v_doc.organization_id, 'content') then
    raise exception 'Je mag deze pagina niet terugzetten.' using errcode = '42501';
  end if;
  if v_doc.archived_at is null then
    return 0;
  end if;

  with recursive boom as (
    select d.id from public.documents d where d.id = v_doc.id
    union
    select d.id from public.documents d join boom b on d.parent_id = b.id
    where d.organization_id = v_doc.organization_id and d.archived_at = v_doc.archived_at
  )
  update public.documents d
     set archived_at = null, archived_by = null
    from boom
   where d.id = boom.id;
  get diagnostics v_count = row_count;

  -- Ligt de ouder nog in de prullenbak, dan zou de pagina onder iets hangen
  -- dat niemand ziet: dan komt ze los in het dossier.
  if v_doc.parent_id is not null and exists (
    select 1 from public.documents p where p.id = v_doc.parent_id and p.archived_at is not null
  ) then
    update public.documents set parent_id = null where id = v_doc.id;
  end if;
  return v_count;
end;
$$;

revoke all on function public.restore_page(uuid) from public, anon;
grant execute on function public.restore_page(uuid) to authenticated;

-- ── 4. De prullenbak bekijken ───────────────────────────────────────────────
-- Per keer weggooien één regel: de pagina die je weggooide, met hoeveel
-- subpagina's er tegelijk mee gingen.

create or replace function public.list_page_trash(p_organization_id uuid)
returns table (
  id uuid, title text, archived_at timestamptz, archived_by uuid,
  client_id uuid, project_id uuid, subpages integer, purge_on timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_read_org(p_organization_id) or not public.can_read_module(p_organization_id, 'content') then
    raise exception 'Je mag de prullenbak van deze organisatie niet zien.' using errcode = '42501';
  end if;
  return query
  select d.id, d.title, d.archived_at, d.archived_by, d.client_id, d.project_id,
         (with recursive boom as (
            select c.id from public.documents c where c.parent_id = d.id and c.archived_at = d.archived_at
            union
            select c.id from public.documents c join boom b on c.parent_id = b.id where c.archived_at = d.archived_at
          ) select count(*)::integer from boom),
         d.archived_at + interval '30 days'
  from public.documents d
  left join public.documents p on p.id = d.parent_id
  where d.organization_id = p_organization_id
    and d.format = 'page'
    and d.archived_at is not null
    and (p.id is null or p.archived_at is distinct from d.archived_at)
  order by d.archived_at desc, d.title;
end;
$$;

revoke all on function public.list_page_trash(uuid) from public, anon;
grant execute on function public.list_page_trash(uuid) to authenticated;

-- ── 5. Definitief weg, met de bijlagen ──────────────────────────────────────

create or replace function public.page_trash_purge_tree(p_organization_id uuid, p_root_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  with recursive boom as (
    select d.id from public.documents d
    where d.id = any (p_root_ids) and d.organization_id = p_organization_id and d.format = 'page'
    union
    select d.id from public.documents d join boom b on d.parent_id = b.id
  )
  select coalesce(array_agg(id), '{}') into v_ids from boom;
  if cardinality(v_ids) = 0 then
    return 0;
  end if;

  -- De bijlagen van deze pagina's: eerst in de opruimwachtrij (die haalt ze
  -- uit de opslag), dan de rijen weg. Bestanden uit het dossier waar een
  -- bestandsblok naar wees, horen bij hun map en blijven staan.
  insert into public.storage_purge_queue (organization_id, storage_key, reason, purge_after)
  select p_organization_id, a.storage_key, 'document', now()
  from public.attachments a
  where a.organization_id = p_organization_id
    and a.entity_type = 'document'
    and a.entity_id = any (v_ids)
    and coalesce(a.storage_key, '') <> ''
    and not exists (
      select 1 from public.storage_purge_queue q where q.storage_key = a.storage_key and q.reason = 'document'
    );
  delete from public.attachments a
   where a.organization_id = p_organization_id and a.entity_type = 'document' and a.entity_id = any (v_ids);

  delete from public.documents d where d.id = any (v_ids) and d.organization_id = p_organization_id;
  return cardinality(v_ids);
end;
$$;

revoke all on function public.page_trash_purge_tree(uuid, uuid[]) from public, anon, authenticated;

create or replace function public.delete_page_forever(p_page_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
begin
  select * into v_doc from public.documents d where d.id = p_page_id;
  if not found
     or not public.can_write_org(v_doc.organization_id)
     or not public.can_write_module(v_doc.organization_id, 'content') then
    raise exception 'Je mag deze pagina niet verwijderen.' using errcode = '42501';
  end if;
  if v_doc.format is distinct from 'page' or v_doc.archived_at is null then
    raise exception 'Alleen een pagina in de prullenbak kun je definitief verwijderen.' using errcode = '22023';
  end if;
  return public.page_trash_purge_tree(v_doc.organization_id, array[v_doc.id]);
end;
$$;

revoke all on function public.delete_page_forever(uuid) from public, anon;
grant execute on function public.delete_page_forever(uuid) to authenticated;

-- Na 30 dagen: alles wat zo lang in de prullenbak ligt.
create or replace function public.purge_page_trash()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org record;
  v_total integer := 0;
begin
  for v_org in
    select d.organization_id, array_agg(d.id) as ids
    from public.documents d
    where d.format = 'page' and d.archived_at < now() - interval '30 days'
    group by d.organization_id
  loop
    v_total := v_total + public.page_trash_purge_tree(v_org.organization_id, v_org.ids);
  end loop;
  return v_total;
end;
$$;

revoke all on function public.purge_page_trash() from public, anon, authenticated;

-- Dagelijks om 03:43 UTC, als pg_cron er is. Opnieuw draaien vervangt de taak.
do $$
begin
  if to_regclass('cron.job') is not null
     and to_regprocedure('cron.schedule(text,text,text)') is not null
     and to_regprocedure('cron.unschedule(bigint)') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'resofly-page-trash-purge';
    perform cron.schedule('resofly-page-trash-purge', '43 3 * * *', 'select public.purge_page_trash();');
  else
    raise notice 'pg_cron staat niet aan: plan purge_page_trash() zelf in.';
  end if;
end;
$$;
