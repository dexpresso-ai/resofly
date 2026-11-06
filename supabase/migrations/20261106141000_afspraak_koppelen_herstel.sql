-- ============================================================
-- ResoFly — Een afspraak koppelen aan een klant, project, taak of notitie werkt weer
-- Date: 2026-11-06
--
-- Sinds 20261101110000_calendar_privacy mag de app (de rol authenticated) de
-- kolommen feed_url en feed_etag van calendar_sources niet meer lezen: dat is
-- het geheime ICS-adres van een agenda. Twee triggerfuncties lazen de hele rij
-- (`select * into v_source from public.calendar_sources`), met de rechten van
-- wie er schrijft. Sindsdien gaf elke poging vanuit de app
--
--   permission denied for table calendar_sources
--
-- bij:
--   - validate_calendar_event_link: een afspraak aan een klant, project of taak
--     koppelen ("Koppelen aan" in de agenda), en daarmee ook de uren die uit
--     zo'n afspraak volgen;
--   - enforce_note_calendar_links_integrity: een notitie bij een afspraak
--     maken of koppelen.
-- Op staging stond er daardoor sinds 1 november geen enkele zulke koppeling bij.
-- Gevonden met de stromentest van de agendakoppeling (tests/stromen/agenda.mjs).
--
-- Herstel: alleen de kolommen lezen die de controle nodig heeft. De functies
-- blijven op de rechten van wie er schrijft (geen security definer): de RLS op
-- calendar_sources bepaalt zo nog steeds welke agenda iemand mag gebruiken.
-- De inhoud is verder gelijk aan de laatste versies (20260907000000 en
-- 20260516000000), zoals ze op staging staan.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.validate_calendar_event_link()
returns trigger language plpgsql as $$
declare
  v_source record;
  v_client_org uuid;
  v_project_org uuid;
  v_project_client uuid;
  v_task_org uuid;
  v_task_project uuid;
  v_task_client uuid;
begin
  select s.organization_id, s.provider, s.provider_calendar_id
    into v_source
    from public.calendar_sources s
   where s.id = new.calendar_source_id;
  if not found then
    raise exception 'calendar_event_links.calendar_source_id verwijst naar een niet-bestaande agenda' using errcode = '23514';
  end if;
  if v_source.organization_id <> new.organization_id then
    raise exception 'calendar_event_links.organization_id wijkt af van de gekoppelde agenda' using errcode = '23514';
  end if;
  if v_source.provider <> new.provider then
    raise exception 'calendar_event_links.provider wijkt af van de gekoppelde agenda-provider' using errcode = '23514';
  end if;
  new.provider_calendar_id := coalesce(new.provider_calendar_id, v_source.provider_calendar_id);

  -- Hangt de afspraak aan een taak, dan bepaalt die taak het project en de
  -- klant. Een losse taak (zonder project én klant) laat de eigen keuze staan.
  if new.task_id is not null then
    select organization_id, project_id, client_id
      into v_task_org, v_task_project, v_task_client
      from public.tasks where id = new.task_id;
    if v_task_org is null then
      raise exception 'calendar_event_links.task_id verwijst naar een niet-bestaande taak' using errcode = '23514';
    end if;
    if v_task_org <> new.organization_id then
      raise exception 'calendar_event_links.task_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
    if v_task_project is not null then
      new.project_id := v_task_project;
    end if;
    if v_task_client is not null then
      new.client_id := v_task_client;
    end if;
  end if;

  if new.project_id is not null then
    select organization_id, client_id into v_project_org, v_project_client
    from public.projects where id = new.project_id;
    if v_project_org is null then
      raise exception 'calendar_event_links.project_id verwijst naar een niet-bestaand project' using errcode = '23514';
    end if;
    if v_project_org <> new.organization_id then
      raise exception 'calendar_event_links.project_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
    -- Leid de klant af uit het project als die niet expliciet is gekozen.
    if new.client_id is null then
      new.client_id := v_project_client;
    end if;
  end if;

  if new.client_id is not null then
    select organization_id into v_client_org from public.clients where id = new.client_id;
    if v_client_org is null then
      raise exception 'calendar_event_links.client_id verwijst naar een niet-bestaande klant' using errcode = '23514';
    end if;
    if v_client_org <> new.organization_id then
      raise exception 'calendar_event_links.client_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.enforce_note_calendar_links_integrity()
returns trigger language plpgsql as $$
declare
  v_note public.notes;
  v_source record;
begin
  if new.visibility_snapshot <> 'organization' then
    raise exception 'Notities koppelen aan privé-agenda-items is geblokkeerd' using errcode = '23514';
  end if;

  if coalesce(new.is_private_masked_snapshot, false) then
    raise exception 'Notities koppelen aan afgeschermde agenda-items is geblokkeerd' using errcode = '23514';
  end if;

  select * into v_note from public.notes where id = new.note_id;
  if not found then
    raise exception 'note_calendar_links.note_id verwijst naar een niet-bestaande notitie' using errcode = '23514';
  end if;
  if v_note.organization_id <> new.organization_id then
    raise exception 'note_calendar_links.organization_id wijkt af van de gekoppelde notitie' using errcode = '23514';
  end if;

  select s.organization_id, s.provider, s.provider_calendar_id, s.visibility
    into v_source
    from public.calendar_sources s
   where s.id = new.calendar_source_id;
  if not found then
    raise exception 'note_calendar_links.calendar_source_id verwijst naar een niet-bestaande agenda' using errcode = '23514';
  end if;
  if v_source.organization_id <> new.organization_id then
    raise exception 'note_calendar_links.organization_id wijkt af van de gekoppelde agenda' using errcode = '23514';
  end if;
  if v_source.provider <> new.provider then
    raise exception 'note_calendar_links.provider wijkt af van de gekoppelde agenda-provider' using errcode = '23514';
  end if;
  if v_source.visibility <> 'organization' then
    raise exception 'Notities koppelen is alleen toegestaan voor agenda’s die met de organisatie gedeeld zijn' using errcode = '23514';
  end if;

  new.provider_calendar_id := coalesce(new.provider_calendar_id, v_source.provider_calendar_id);
  return new;
end;
$$;

-- Triggerfuncties: niemand roept ze rechtstreeks aan (de trigger vuurt toch).
revoke all on function public.validate_calendar_event_link() from public, anon, authenticated;
revoke all on function public.enforce_note_calendar_links_integrity() from public, anon, authenticated;

commit;
