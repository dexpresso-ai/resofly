-- ============================================================
-- Pagina's delen: een gedeelde pagina die naar een ander dossier verhuist
-- (stap 1C, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §7 en §11).
--
-- Wat er misging. Een pagina onder een pagina van een andere klant zetten gaat
-- met alleen parent_id (nestPageUnder in de app, of een aanroep via de API).
-- documents_page_tree (20261127130000) geeft haar dan in een BEFORE-trigger
-- de klant en het project van haar nieuwe ouder. Maar een trigger "after
-- update of client_id, project_id" vuurt alleen als die kolommen in de update
-- zelf staan, niet als een BEFORE-trigger ze verandert. Zo bleven twee dingen
-- liggen:
--   - documents_page_tree_down: de subpagina's hielden de oude klant, terwijl
--     klant en project gelijk moeten zijn aan die van de bovenste pagina;
--   - documents_drive_scope_changed (20260903000000): de delingen van de
--     pagina werden niet ingetrokken. Na "Bijwerken bij klant" kreeg een
--     contactpersoon van de oude klant, of iemand met een geheime link, de
--     tekst uit het dossier van de nieuwe klant.
--
-- Nu:
--   1. beide triggers vuren ook bij een wijziging van parent_id; de functies
--      kijken zelf of klant of project echt veranderde;
--   2. page_share_status en release_page_to_shares nemen alleen delingen mee
--      waarvan de ontvanger nog bij het dossier van de pagina hoort
--      (page_share_fits, dezelfde regel als revoke_stale_drive_shares). Een
--      vangnet, voor een deling die buiten de triggers om is blijven lopen.
--      page_share_status wordt daarvoor security definer, met dezelfde
--      leesrechten als eerst (organisatie en de module Inhoud).
--
-- Mag opnieuw draaien.
-- ============================================================

-- ── 1. De triggers ook bij parent_id ────────────────────────────────────────

drop trigger if exists documents_page_tree_down on public.documents;
create trigger documents_page_tree_down
  after update of client_id, project_id, parent_id on public.documents
  for each row execute function public.documents_page_tree_down();

drop trigger if exists documents_drive_scope_changed on public.documents;
create trigger documents_drive_scope_changed
  after update of client_id, project_id, parent_id on public.documents
  for each row execute function public.drive_item_scope_changed('document');

-- ── 2. Past de ontvanger nog bij het dossier? ───────────────────────────────

-- Het dossier van een pagina: de klant van haar project, anders haar eigen klant.
create or replace function public.page_dossier_client(p_doc public.documents)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.client_id from public.projects p where p.id = p_doc.project_id and p.organization_id = p_doc.organization_id),
    p_doc.client_id);
$$;

revoke all on function public.page_dossier_client(public.documents) from public, anon, authenticated;

-- Dezelfde regel als revoke_stale_drive_shares (20261013100000), andersom: een
-- collega past altijd, een geheime link alleen buiten een klantdossier, het
-- hoofdadres en een contactpersoon alleen bij de klant van het dossier.
create or replace function public.page_share_fits(p_share public.drive_shares, p_client uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case p_share.recipient_kind
    when 'member' then true
    when 'link' then p_client is null
    when 'client' then p_client is not null and p_share.client_id is not distinct from p_client
    when 'contact' then p_client is not null and exists (
      select 1 from public.client_contacts cc
      where cc.id = p_share.client_contact_id and cc.client_id = p_client and cc.organization_id = p_share.organization_id)
    else false
  end;
$$;

revoke all on function public.page_share_fits(public.drive_shares, uuid) from public, anon, authenticated;

-- ── 3. De status en het bijwerken ───────────────────────────────────────────

create or replace function public.page_share_status(p_document_id uuid)
returns table (
  share_id uuid,
  document_version_id uuid,
  version integer,
  released_at timestamptz,
  is_current boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  v_client uuid;
begin
  select * into v_doc from public.documents d where d.id = p_document_id and d.format = 'page';
  -- Dezelfde grens als de leesregels: de organisatie, de module Inhoud, en
  -- niets uit de prullenbak.
  if not found
     or not public.can_read_org(v_doc.organization_id)
     or not public.can_read_module(v_doc.organization_id, 'content')
     or v_doc.archived_at is not null then
    return;
  end if;
  v_client := public.page_dossier_client(v_doc);

  -- jsonb vergelijkt op inhoud, niet op de volgorde van de sleutels: zo telt
  -- alleen een echte wijziging.
  return query
  select s.id, s.document_version_id, v.version, v.created_at,
         coalesce(v.body = v_doc.body and v.title = v_doc.title, false)
  from public.drive_shares s
  left join public.document_versions v
    on v.id = s.document_version_id and v.document_id = v_doc.id
  where s.organization_id = v_doc.organization_id
    and s.item_type = 'document'
    and s.item_id = v_doc.id
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
    and public.page_share_fits(s, v_client)
  order by s.created_at;
end;
$$;

revoke all on function public.page_share_status(uuid) from public, anon;
grant execute on function public.page_share_status(uuid) to authenticated;

-- De definitie uit 20261128130000, met de vangnetregel erbij.
create or replace function public.release_page_to_shares(p_document_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  v_version public.document_versions;
  v_count integer;
  v_client uuid;
begin
  select * into v_doc from public.documents d where d.id = p_document_id;
  if not found
     or not public.can_write_org(v_doc.organization_id)
     or not public.can_write_module(v_doc.organization_id, 'content') then
    raise exception 'Je mag deze pagina niet delen.' using errcode = '42501';
  end if;
  if v_doc.format <> 'page' then
    raise exception 'Alleen een pagina werk je zo bij.' using errcode = '22023';
  end if;
  if v_doc.archived_at is not null then
    raise exception 'Een pagina in de prullenbak kun je niet delen.' using errcode = '22023';
  end if;
  v_client := public.page_dossier_client(v_doc);

  -- Ziet elke ontvanger de pagina van nu al, dan geen nieuwe versie: anders
  -- vult een dubbele klik de geschiedenis met vrijgaven zonder verschil.
  if not exists (
    select 1
    from public.drive_shares s
    left join public.document_versions v on v.id = s.document_version_id
    where s.item_type = 'document' and s.item_id = v_doc.id and s.organization_id = v_doc.organization_id
      and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
      and public.page_share_fits(s, v_client)
      and (v.id is null or v.body is distinct from v_doc.body or v.title is distinct from v_doc.title)
  ) then
    return 0;
  end if;

  -- save_page_version zet de pagina vast (for update) en controleert de
  -- rechten nog eens, met de gebruiker van deze aanroep.
  v_version := public.save_page_version(v_doc.id, 'vrijgave');

  update public.drive_shares s
     set document_version_id = v_version.id
   where s.item_type = 'document' and s.item_id = v_doc.id and s.organization_id = v_doc.organization_id
     and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
     and public.page_share_fits(s, v_client)
     and s.document_version_id is distinct from v_version.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.release_page_to_shares(uuid) from public, anon;
grant execute on function public.release_page_to_shares(uuid) to authenticated;
