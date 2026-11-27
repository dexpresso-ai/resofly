-- ============================================================
-- Pagina's: afbeeldingen, bestanden en subpagina's horen bij de pagina (stap 1A-4b)
--
-- Zie docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md (§8 en §18).
--
-- Een pagina verwijst naar een bijlage (afbeelding, bestand) met attachmentId
-- en naar een subpagina met pageId. page_body_problem() keek alleen of dat op
-- een id leek. Wie een id van een andere organisatie of een ander dossier in
-- body zette (via de API, Gerrie of een geplakt blok), kreeg die verwijzing
-- erdoor. Een collega met leesrecht zag dan via de editor de naam van iets
-- uit een ander dossier, en straks (1C) een klant ook.
--
-- Nu, bij elke nieuwe of gewijzigde body van een pagina:
--   - een afbeelding of bestand bestaat in deze organisatie, en hoort bij
--     hetzelfde dossier (dezelfde klant, of allebei geen klant) als de pagina;
--   - een subpagina is een pagina van deze organisatie, en niet de pagina zelf.
--
-- Alleen verwijzingen die er nieuw bij komen, worden nagekeken. Wordt een
-- bestand later verwijderd, dan blijft de oude verwijzing staan; de editor toont
-- dan "niet gevonden". Keken we alles na, dan kon na zo'n verwijdering niemand
-- de pagina meer opslaan.
--
-- Een verwijzing naar iets dat niet (meer) bestaat, mag ook als hij nieuw is:
-- anders kon je geen oude versie terugzetten waarin een inmiddels verwijderde
-- afbeelding stond. Zo'n verwijzing laat niets zien. Wat wél bestaat, maar in
-- een andere organisatie of een ander dossier, wordt geweigerd.
--
-- De trigger heet documents_page_verwijzingen, zodat hij na documents_page_tree
-- draait (triggers lopen op naam): een nieuwe subpagina heeft dan al de klant
-- van haar ouder.
--
-- Mag veilig opnieuw draaien: create or replace, drop trigger if exists.
-- ============================================================

-- De verwijzingen in een body: soort (image, fileBlock, subpage) en id.
create or replace function public.page_body_refs(p_body jsonb)
returns table(kind text, ref_id text)
language sql
immutable
set search_path = public
as $$
  select v->>'type', coalesce(v->'attrs'->>'attachmentId', v->'attrs'->>'pageId')
  from jsonb_path_query(coalesce(p_body, '{}'::jsonb),
         'strict $.** ? (@.type == "image" || @.type == "fileBlock" || @.type == "subpage")') v;
$$;

revoke all on function public.page_body_refs(jsonb) from public, anon;

-- Het dossier van een bijlage: de klant van het ding waar hij aan vastzit. Hangt
-- er een project aan, dan telt de klant van dat project (dezelfde regel als
-- drive_item_client). Geeft bruikbaar = false als de bijlage niet in deze
-- organisatie bestaat of aan iets hangt dat niet in een pagina hoort.
create or replace function public.page_attachment_dossier(p_organization_id uuid, p_attachment_id uuid,
                                                          out bruikbaar boolean, out klant uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_type text;
  v_entity uuid;
  v_project uuid;
begin
  bruikbaar := false;
  klant := null;
  select a.entity_type, a.entity_id into v_type, v_entity
  from public.attachments a
  where a.id = p_attachment_id and a.organization_id = p_organization_id;
  if v_type is null then
    return;
  end if;
  case v_type
    when 'document' then
      select d.client_id, d.project_id into klant, v_project
      from public.documents d where d.id = v_entity and d.organization_id = p_organization_id;
    when 'folder' then
      select f.client_id, f.project_id into klant, v_project
      from public.content_folders f where f.id = v_entity and f.organization_id = p_organization_id;
    when 'note' then
      select n.client_id, n.project_id into klant, v_project
      from public.notes n where n.id = v_entity and n.organization_id = p_organization_id;
    when 'client' then
      select c.id into klant
      from public.clients c where c.id = v_entity and c.organization_id = p_organization_id;
    when 'project' then
      v_project := v_entity;
    else
      -- Een bon, factuur of chatbericht hoort niet in een pagina.
      return;
  end case;
  if v_project is not null then
    select coalesce(p.client_id, klant) into klant
    from public.projects p where p.id = v_project and p.organization_id = p_organization_id;
  end if;
  bruikbaar := true;
end;
$$;

revoke all on function public.page_attachment_dossier(uuid, uuid) from public, anon, authenticated;

create or replace function public.documents_page_verwijzingen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid := new.client_id;
  v_ref record;
  v_dossier record;
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if new.format is distinct from 'page' or new.body is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.body is not distinct from old.body then
    return new;
  end if;
  if new.project_id is not null then
    select coalesce(p.client_id, v_client) into v_client
    from public.projects p where p.id = new.project_id and p.organization_id = new.organization_id;
  end if;

  for v_ref in
    select r.kind, r.ref_id from public.page_body_refs(new.body) r
    except
    select r.kind, r.ref_id from public.page_body_refs(case when tg_op = 'UPDATE' and old.format = 'page' then old.body end) r
  loop
    if coalesce(v_ref.ref_id, '') !~ v_uuid then
      raise exception 'Een afbeelding, bestand of subpagina zonder geldige verwijzing.' using errcode = '22023';
    end if;
    if v_ref.kind = 'subpage' then
      if v_ref.ref_id::uuid = new.id or exists (
        select 1 from public.documents d
        where d.id = v_ref.ref_id::uuid and (d.organization_id <> new.organization_id or d.format is distinct from 'page')
      ) then
        raise exception 'Een subpagina moet een andere pagina van deze organisatie zijn.' using errcode = '22023';
      end if;
    elsif exists (select 1 from public.attachments a where a.id = v_ref.ref_id::uuid) then
      select * into v_dossier from public.page_attachment_dossier(new.organization_id, v_ref.ref_id::uuid);
      if not v_dossier.bruikbaar then
        raise exception 'Deze afbeelding of dit bestand hoort niet bij deze organisatie.' using errcode = '22023';
      end if;
      if v_dossier.klant is distinct from v_client then
        raise exception 'Een afbeelding of bestand uit een ander dossier kan niet in deze pagina.' using errcode = '22023';
      end if;
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.documents_page_verwijzingen() from public, anon, authenticated;

drop trigger if exists documents_page_verwijzingen on public.documents;
create trigger documents_page_verwijzingen
  before insert or update of body on public.documents
  for each row execute function public.documents_page_verwijzingen();
