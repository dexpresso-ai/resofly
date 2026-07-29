-- ============================================================
-- ResoFly — Dossiermappen ook binnen projectmappen
-- Date: 2026-07-29
--
-- Aanleiding:
-- - `content_folders` was uitsluitend klant-scoped. Op de Inhoud-pagina kon je
--   daardoor wél mappen (en submappen, onbeperkt diep) maken op klantniveau,
--   maar niet ín een projectmap: "+ Nieuw" toonde daar geen "Nieuwe map".
--
-- Wat deze migratie doet:
-- - Voegt `project_id` toe (nullable). null = klantniveau (bestaand gedrag,
--   alle bestaande rijen), gevuld = de map leeft binnen die projectmap.
-- - Scherpt `validate_content_folder()` aan: de bovenliggende map moet nu ook
--   dezelfde projectscope hebben, een gevuld `project_id` moet naar een project
--   van dezelfde organisatie én dezelfde klant wijzen, en klant/project van een
--   bestaande map liggen na aanmaken vast (anders zouden kinderen achterblijven
--   in de oude scope). Cykel-preventie en de dieptegrens blijven ongewijzigd,
--   zodat submappen in submappen onbeperkt kunnen blijven nestelen.
--
-- Beveiliging: RLS-policies blijven ongewijzigd (org-leden lezen/schrijven).
-- ============================================================

begin;

alter table public.content_folders
  add column if not exists project_id uuid references public.projects(id) on delete cascade;

create index if not exists idx_content_folders_org_scope
  on public.content_folders(organization_id, client_id, project_id, parent_id, position);
create index if not exists idx_content_folders_project
  on public.content_folders(project_id);

-- Valideer de hiërarchie: de bovenliggende map hoort bij dezelfde organisatie,
-- dezelfde klant én dezelfde projectscope; een projectmap hoort bij de klant van
-- dat project; en een map kan nooit een (klein)kind van zichzelf worden.
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
  -- Klant- en projectscope liggen vast na aanmaken: verplaatsen zou de
  -- onderliggende submappen in de oude scope achterlaten.
  if tg_op = 'UPDATE' then
    if new.client_id is distinct from old.client_id then
      raise exception 'De klant van een bestaande map kan niet worden gewijzigd.';
    end if;
    if new.project_id is distinct from old.project_id then
      raise exception 'Het project van een bestaande map kan niet worden gewijzigd.';
    end if;
  end if;

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
    -- cyclische structuur ontstaan.
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

commit;
