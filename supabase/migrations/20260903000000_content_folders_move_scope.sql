-- ============================================================
-- ResoFly — Verplaatsen naar een andere klant, een ander project, elke map
-- Date: 2026-09-03
--
-- Aanleiding:
-- In de verkenner (Inhoud én klantdossier > Bestanden) kon je sinds 2026-09-02
-- selecteren en slepen, maar alleen binnen de map-scope waar je al stond.
-- Verplaatsen naar een andere klant of een ander project kon niet — en dat is
-- precies wat ontbrak: een verkeerd opgeborgen offerte hoort met één handeling
-- in het juiste dossier te belanden.
--
-- Wat er in de weg stond:
-- `validate_content_folder()` (20260729000000) zette klant en project van een
-- bestaande map vast na aanmaken, met als reden dat de submappen anders in de
-- oude scope zouden achterblijven. Die reden is terecht; het slot was alleen de
-- verkeerde oplossing. Deze migratie vervangt het slot door een cascade: wijzigt
-- de scope van een map, dan gaat álles eronder mee.
--
-- Wat deze migratie doet:
-- 1. `validate_content_folder()`: het verbod op scope-wijziging vervalt. Alle
--    andere regels blijven staan (ouder in dezelfde scope, project bij dezelfde
--    klant, geen lus, dieptegrens).
-- 2. Nieuwe AFTER UPDATE-trigger `content_folders_cascade_scope`: zet de nieuwe
--    klant/projectscope door naar de directe submappen (die op hun beurt
--    hetzelfde doen, zodat de hele boom volgt) en naar de notities en documenten
--    in de map. Geüploade bestanden hangen aan de map zelf (attachments.entity_id)
--    en verhuizen dus vanzelf mee.
-- 3. Deelhygiëne. Portaal- en deellinktoegang worden al LIVE afgeleid uit het
--    item (drive_item_client), dus een contactpersoon van de oude klant is de
--    toegang op het moment van verhuizen al kwijt. Maar de deling zélf bleef als
--    "actief" staan: het personen-icoontje in de lijst en de ontvangerlijst in
--    het deelvenster logen dan. `revoke_stale_drive_shares()` trekt na een
--    verhuizing de delingen in die volgens de kernregel niet meer mogen:
--    contactpersonen van een andere klant, en open deellinks zodra een item
--    klantgerelateerd wordt. Collega-delingen blijven staan; die collega's
--    mochten toch al alles zien.
--
-- Beveiliging:
-- - De cascade draait als SECURITY DEFINER: submappen en inhoud moeten ALTIJD
--   mee, ook als RLS toevallig een rij zou wegfilteren — anders blijft een halve
--   boom in de oude scope achter. De module-poort blijft wél gelden:
--   `zzz_module_write_gate` op notes/documents/content_folders controleert de
--   rechten van de ingelogde gebruiker, en dat is dezelfde module ('content')
--   als de map die hij zojuist mocht verplaatsen.
-- - RLS-policies ongewijzigd.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Scope mag wijzigen; de rest van de regels blijft ────────────────────
create or replace function public.validate_content_folder()
returns trigger language plpgsql as $$
declare
  parent_org uuid;
  parent_client uuid;
  parent_project uuid;
  project_org uuid;
  project_client uuid;
  cursor_id uuid;
  guard int := 0;
begin
  if new.project_id is not null then
    select organization_id, client_id into project_org, project_client
    from public.projects where id = new.project_id;

    if not found then
      raise exception 'Project bestaat niet.';
    end if;
    if project_org <> new.organization_id then
      raise exception 'Project hoort bij een andere organisatie.';
    end if;
    if project_client is distinct from new.client_id then
      raise exception 'Project hoort bij een andere klant.';
    end if;
  end if;

  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'Een map kan niet zijn eigen bovenliggende map zijn.';
    end if;

    select organization_id, client_id, project_id
      into parent_org, parent_client, parent_project
    from public.content_folders where id = new.parent_id;

    if not found then
      raise exception 'Bovenliggende map bestaat niet.';
    end if;
    if parent_org <> new.organization_id then
      raise exception 'Bovenliggende map hoort bij een andere organisatie.';
    end if;
    if parent_client is distinct from new.client_id then
      raise exception 'Bovenliggende map hoort bij een andere klant.';
    end if;
    if parent_project is distinct from new.project_id then
      raise exception 'Bovenliggende map hoort bij een ander project.';
    end if;

    -- Loop omhoog door de voorouders. Kom je new.id tegen, dan zou er een
    -- cyclische structuur ontstaan (een map in zijn eigen submap).
    cursor_id := new.parent_id;
    while cursor_id is not null loop
      guard := guard + 1;
      if cursor_id = new.id then
        raise exception 'Cyclische mapstructuur is niet toegestaan.';
      end if;
      if guard > 100 then
        raise exception 'Maximale mapdiepte overschreden.';
      end if;
      select parent_id into cursor_id from public.content_folders where id = cursor_id;
    end loop;
  end if;
  return new;
end; $$;

-- ── 2. Deelhygiëne na een verhuizing ───────────────────────────────────────
-- Trekt de delingen van één item in die na een verhuizing niet meer mogen.
-- Intrekken lukt altijd (20260823010000), dus dit kan een verplaatsing nooit
-- blokkeren. De klant wordt live afgeleid, precies zoals het portaal dat doet.
create or replace function public.revoke_stale_drive_shares(p_item_type text, p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.drive_shares s
  set revoked_at = now(),
      revoked_by = auth.uid()
  where s.item_type = p_item_type
    and s.item_id = p_item_id
    and s.revoked_at is null
    and (
      -- Contactpersoon van een andere klant dan waar het item nú bij hoort.
      -- Kan de klant niet meer worden vastgesteld, dan ook intrekken: fail closed.
      (s.recipient_kind = 'contact'
        and (select cc.client_id from public.client_contacts cc where cc.id = s.client_contact_id)
            is distinct from
            (select ctx.client_id from public.drive_item_client_safe(s.organization_id, s.item_type, s.item_id) ctx))
      or
      -- Open deellink op een item dat nu klantgerelateerd is: de andere helft
      -- van het slot uit enforce_drive_share_rules.
      (s.recipient_kind = 'link'
        and (select ctx.client_id from public.drive_item_client_safe(s.organization_id, s.item_type, s.item_id) ctx)
            is not null)
    );
end;
$$;

comment on function public.revoke_stale_drive_shares(text, uuid) is
  'Trekt na een verhuizing de delingen in die volgens de kernregel niet meer mogen (contact van een andere klant, open deellink op klantstuk).';

revoke all on function public.revoke_stale_drive_shares(text, uuid) from public, anon, authenticated;

-- ── 3. De cascade op mappen ────────────────────────────────────────────────
create or replace function public.cascade_content_folder_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_att record;
begin
  if new.client_id is not distinct from old.client_id
     and new.project_id is not distinct from old.project_id then
    return null;
  end if;

  -- Submappen volgen; hun eigen trigger neemt het daarna over voor de laag
  -- eronder, zodat de hele boom mee verhuist — hoe diep ook.
  update public.content_folders
  set client_id = new.client_id,
      project_id = new.project_id
  where parent_id = new.id
    and organization_id = new.organization_id
    and (client_id is distinct from new.client_id or project_id is distinct from new.project_id);

  -- Notities en documenten in deze map horen vanaf nu bij de nieuwe klant en
  -- het nieuwe project. (updated_at blijft: verhuizen is geen inhoudswijziging.)
  update public.notes
  set client_id = new.client_id,
      project_id = new.project_id
  where folder_id = new.id
    and organization_id = new.organization_id
    and (client_id is distinct from new.client_id or project_id is distinct from new.project_id);

  update public.documents
  set client_id = new.client_id,
      project_id = new.project_id
  where folder_id = new.id
    and organization_id = new.organization_id
    and (client_id is distinct from new.client_id or project_id is distinct from new.project_id);

  -- Delingen die met de nieuwe klant niet meer mogen: van de map zelf en van de
  -- geüploade bestanden erin (die hangen aan de map en krijgen zelf geen update).
  perform public.revoke_stale_drive_shares('folder', new.id);
  for v_att in
    select a.id
    from public.attachments a
    where a.entity_type = 'folder'
      and a.entity_id = new.id
      and a.organization_id = new.organization_id
  loop
    perform public.revoke_stale_drive_shares('attachment', v_att.id);
  end loop;

  return null;
end;
$$;

drop trigger if exists content_folders_cascade_scope on public.content_folders;
create trigger content_folders_cascade_scope
  after update of client_id, project_id on public.content_folders
  for each row execute function public.cascade_content_folder_scope();

-- ── 4. Notities, documenten en bestanden die zélf verhuizen ────────────────
-- Zelfde deelhygiëne als hierboven, maar voor een los item dat van klant of
-- project wisselt (notitie/document) of aan een andere map wordt gehangen
-- (bestand). Vuurt bij elke bewaaractie die deze kolommen meestuurt, maar doet
-- alleen iets als er werkelijk iets veranderd is.
create or replace function public.drive_item_scope_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_TABLE_NAME = 'attachments' then
    if new.entity_type is not distinct from old.entity_type
       and new.entity_id is not distinct from old.entity_id then
      return null;
    end if;
  elsif new.client_id is not distinct from old.client_id
     and new.project_id is not distinct from old.project_id then
    return null;
  end if;

  perform public.revoke_stale_drive_shares(TG_ARGV[0], new.id);
  return null;
end;
$$;

drop trigger if exists notes_drive_scope_changed on public.notes;
create trigger notes_drive_scope_changed
  after update of client_id, project_id on public.notes
  for each row execute function public.drive_item_scope_changed('note');

drop trigger if exists documents_drive_scope_changed on public.documents;
create trigger documents_drive_scope_changed
  after update of client_id, project_id on public.documents
  for each row execute function public.drive_item_scope_changed('document');

drop trigger if exists attachments_drive_scope_changed on public.attachments;
create trigger attachments_drive_scope_changed
  after update of entity_type, entity_id on public.attachments
  for each row execute function public.drive_item_scope_changed('attachment');

commit;
