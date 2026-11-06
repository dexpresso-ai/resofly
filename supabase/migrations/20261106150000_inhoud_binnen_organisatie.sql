-- ============================================================
-- ResoFly — Documenten, notities en mappen blijven binnen hun organisatie
-- Date: 2026-11-06
--
-- Gevonden met de stromentest van de documenten (tests/stromen/documenten.mjs)
-- en de review van de documentenmodule:
--
--   1. Een document kon aan een klant, project of map van een ÁNDERE
--      organisatie hangen. Notities en bijlagen hadden een controle op klant
--      en project, documenten niet; notities misten de map, mappen de klant.
--      Wie het id van andermans klant kende (uit een oude export, een gedeelde
--      link), zette dat op een eigen document en las bij "delen" de naam van
--      die klant terug in de foutmelding ("Dit hoort bij klantdossier “…”"):
--      drive_item_client zocht die naam op zonder organisatiefilter.
--   2. "Laatst gewijzigd" van een document liep alleen mee als de app de datum
--      zelf meestuurde. Na een bewerking via Gerrie, de API of de Word-editor
--      bleef de oude datum staan, en zakte het document weg in de lijst.
--   3. De maker (created_by) van een document, notitie, map of deling was
--      achteraf te wijzigen, een notitie kon op naam van een collega worden
--      aangemaakt, en bij het intrekken van een deling kon je een ander als
--      "ingetrokken door" invullen.
--
-- De controles draaien als eigenaar van de tabel (security definer), en
-- alleen als een koppeling echt verandert. Met de rechten van de gebruiker
-- ging het mis: wie Inhoud mag schrijven maar Klanten niet mag zien, kon zijn
-- eigen document niet meer opslaan, want de klant was voor hem onzichtbaar.
-- Dat zat al in de notitiecontrole (een notitie bij een klant opslaan met
-- Klanten op "geen"); die is hier op dezelfde manier rechtgezet.
--
-- Op staging stond er geen enkele rij die deze regels breekt (6 november:
-- 0 van 17 documenten en 8 mappen).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Koppelingen binnen de organisatie ───────────────────────────────────

create or replace function public.enforce_documents_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.client_id is distinct from old.client_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'documents.client_id');
  end if;
  if tg_op = 'INSERT' or new.project_id is distinct from old.project_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'documents.project_id');
  end if;
  if tg_op = 'INSERT' or new.folder_id is distinct from old.folder_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.content_folders', new.folder_id, new.organization_id, 'documents.folder_id');
  end if;
  return new;
end; $$;

revoke all on function public.enforce_documents_org_integrity() from public, anon, authenticated;

drop trigger if exists documents_org_integrity on public.documents;
create trigger documents_org_integrity
  before insert or update of organization_id, client_id, project_id, folder_id on public.documents
  for each row execute function public.enforce_documents_org_integrity();

create or replace function public.enforce_notes_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.client_id is distinct from old.client_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'notes.client_id');
  end if;
  if tg_op = 'INSERT' or new.project_id is distinct from old.project_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'notes.project_id');
  end if;
  if tg_op = 'INSERT' or new.folder_id is distinct from old.folder_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.content_folders', new.folder_id, new.organization_id, 'notes.folder_id');
  end if;
  return new;
end; $$;

revoke all on function public.enforce_notes_org_integrity() from public, anon, authenticated;

-- Ook bij een andere map vuren, niet alleen bij klant en project.
drop trigger if exists notes_org_integrity on public.notes;
create trigger notes_org_integrity
  before insert or update of organization_id, client_id, project_id, folder_id on public.notes
  for each row execute function public.enforce_notes_org_integrity();

-- De klant van een map. validate_content_folder controleerde het project en de
-- bovenliggende map, de klant zelf niet. Een eigen trigger, zodat de bestaande
-- validatie (die bij elke wijziging draait) ongemoeid blijft.
create or replace function public.enforce_content_folders_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.client_id is distinct from old.client_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'content_folders.client_id');
  end if;
  return new;
end; $$;

revoke all on function public.enforce_content_folders_org_integrity() from public, anon, authenticated;

drop trigger if exists content_folders_org_integrity on public.content_folders;
create trigger content_folders_org_integrity
  before insert or update of organization_id, client_id on public.content_folders
  for each row execute function public.enforce_content_folders_org_integrity();

-- ── 2. Delen: alles binnen de organisatie van de deling ────────────────────

CREATE OR REPLACE FUNCTION public.drive_item_client(p_organization_id uuid, p_item_type text, p_item_id uuid)
 RETURNS TABLE(client_id uuid, project_id uuid, item_name text, client_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id  uuid;
  v_project_id uuid;
  v_name       text;
  v_att        public.attachments;
begin
  if p_item_type = 'folder' then
    select f.client_id, f.project_id, f.name into v_client_id, v_project_id, v_name
    from public.content_folders f
    where f.id = p_item_id and f.organization_id = p_organization_id;
    if not found then
      raise exception 'Deze map bestaat niet (meer) in deze organisatie.' using errcode = '02000';
    end if;

  elsif p_item_type = 'note' then
    select n.client_id, n.project_id, n.title into v_client_id, v_project_id, v_name
    from public.notes n
    where n.id = p_item_id and n.organization_id = p_organization_id;
    if not found then
      raise exception 'Deze notitie bestaat niet (meer) in deze organisatie.' using errcode = '02000';
    end if;

  elsif p_item_type = 'document' then
    select d.client_id, d.project_id, d.title into v_client_id, v_project_id, v_name
    from public.documents d
    where d.id = p_item_id and d.organization_id = p_organization_id;
    if not found then
      raise exception 'Dit document bestaat niet (meer) in deze organisatie.' using errcode = '02000';
    end if;

  elsif p_item_type = 'attachment' then
    select * into v_att
    from public.attachments a
    where a.id = p_item_id and a.organization_id = p_organization_id;
    if not found then
      raise exception 'Dit bestand bestaat niet (meer) in deze organisatie.' using errcode = '02000';
    end if;
    v_name := v_att.name;

    -- Een attachment kent zelf geen klant; die hangt aan het ding waar hij aan
    -- vastzit. Alleen de types die in de drive voorkomen (plus de voor de hand
    -- liggende buren) worden hier vertaald; de rest weigeren we bewust.
    case v_att.entity_type
      when 'folder' then
        select f.client_id, f.project_id into v_client_id, v_project_id
        from public.content_folders f where f.id = v_att.entity_id and f.organization_id = p_organization_id;
      when 'client' then
        select c.id into v_client_id
        from public.clients c where c.id = v_att.entity_id and c.organization_id = p_organization_id;
      when 'project' then
        select p.client_id, p.id into v_client_id, v_project_id
        from public.projects p where p.id = v_att.entity_id and p.organization_id = p_organization_id;
      when 'note' then
        select n.client_id, n.project_id into v_client_id, v_project_id
        from public.notes n where n.id = v_att.entity_id and n.organization_id = p_organization_id;
      when 'document' then
        select d.client_id, d.project_id into v_client_id, v_project_id
        from public.documents d where d.id = v_att.entity_id and d.organization_id = p_organization_id;
      when 'task' then
        select t.client_id, t.project_id into v_client_id, v_project_id
        from public.tasks t where t.id = v_att.entity_id and t.organization_id = p_organization_id;
      when 'ticket' then
        select t.client_id into v_client_id
        from public.tickets t where t.id = v_att.entity_id and t.organization_id = p_organization_id;
      else
        raise exception 'Dit soort bestand (%) kan niet via de bestandenmodule worden gedeeld.', v_att.entity_type
          using errcode = '23514';
    end case;

  else
    raise exception 'Onbekend itemtype om te delen: %', p_item_type using errcode = '23514';
  end if;

  -- Zelfde regel als de Inhoud-verkenner: hangt er een project aan, dan telt de
  -- klant van dát project — niet een eventueel afwijkende klantkoppeling op het
  -- item zelf. Zo kan een item nooit "van niemand" lijken terwijl het via het
  -- project wél bij een klant hoort.
  if v_project_id is not null then
    select coalesce(p.client_id, v_client_id) into v_client_id
    from public.projects p
    where p.id = v_project_id and p.organization_id = p_organization_id;
  end if;

  return query
  select
    v_client_id,
    v_project_id,
    nullif(btrim(coalesce(v_name, '')), ''),
    -- Alleen een klant van deze organisatie heeft hier een naam. Eerst zonder
    -- dat filter: wie het id van andermans klant op een eigen document zette,
    -- las bij "delen" diens naam terug in de foutmelding.
    (select c.name from public.clients c where c.id = v_client_id and c.organization_id = p_organization_id);
end;
$function$;

revoke all on function public.drive_item_client(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.drive_item_client(uuid, text, uuid) to service_role;

-- ── 3. "Laatst gewijzigd" bij documenten ────────────────────────────────────

drop trigger if exists documents_updated on public.documents;
create trigger documents_updated
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ── 4. Wie iets maakte of introk, ligt vast ────────────────────────────────

create or replace function public.keep_content_creator()
returns trigger
language plpgsql
as $$
begin
  -- De server (service role) en het opruimen na een verwijderd account
  -- (on delete set null) hebben geen auth.uid() en mogen wel. Gerrie schrijft
  -- als het teamlid zelf (action_member_write), met diens id als maker.
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.created_by <> auth.uid() then
      raise exception 'Je kunt alleen iets op je eigen naam aanmaken.' using errcode = '42501';
    end if;
  elsif new.created_by is distinct from old.created_by then
    raise exception 'Wie iets heeft aangemaakt, kun je achteraf niet veranderen.' using errcode = '42501';
  end if;
  return new;
end; $$;

revoke all on function public.keep_content_creator() from public, anon, authenticated;

drop trigger if exists documents_keep_creator on public.documents;
create trigger documents_keep_creator
  before insert or update of created_by on public.documents
  for each row execute function public.keep_content_creator();

drop trigger if exists notes_keep_creator on public.notes;
create trigger notes_keep_creator
  before insert or update of created_by on public.notes
  for each row execute function public.keep_content_creator();

drop trigger if exists content_folders_keep_creator on public.content_folders;
create trigger content_folders_keep_creator
  before insert or update of created_by on public.content_folders
  for each row execute function public.keep_content_creator();

-- Delingen maakt de server (file-share); vanuit de app wijzig je ze alleen.
drop trigger if exists drive_shares_keep_creator on public.drive_shares;
create trigger drive_shares_keep_creator
  before insert or update of created_by on public.drive_shares
  for each row execute function public.keep_content_creator();

-- "Ingetrokken door" is altijd wie intrekt; de app vulde het zelf in, en wat
-- de app invult, kan een gebruiker via de API ook anders invullen.
create or replace function public.drive_share_revoked_by_self()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and new.revoked_at is not null
     and (old.revoked_at is null or new.revoked_by is distinct from old.revoked_by) then
    new.revoked_by := auth.uid();
  end if;
  return new;
end; $$;

revoke all on function public.drive_share_revoked_by_self() from public, anon, authenticated;

drop trigger if exists drive_shares_revoked_by_self on public.drive_shares;
create trigger drive_shares_revoked_by_self
  before update of revoked_at, revoked_by on public.drive_shares
  for each row execute function public.drive_share_revoked_by_self();

commit;
