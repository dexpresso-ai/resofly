-- ============================================================
-- ResoFly — Uren blijven staan als een agenda verdwijnt
-- Date: 2026-11-06
--
-- Een afspraak die aan een klant, project of taak gekoppeld is, levert een
-- urenpost op (time_entries.calendar_event_link_id → calendar_event_links).
-- Die keten hing met "on delete cascade" aan de agenda zelf:
--
--   calendar_connections → calendar_sources → calendar_event_links → time_entries
--
-- Wie zijn Google- of Microsoft-agenda loskoppelde (vaak om "het even opnieuw
-- te proberen" na een fout), of een ResoFly-agenda verwijderde, wiste daarmee
-- stil alle uren die uit die afspraken kwamen, ook als ze al in een rapport
-- of op een factuur stonden. En het ophalen van de agendalijst ruimt nu
-- agenda's op die bij Google of Microsoft niet meer bestaan; ook dat mag geen
-- uren kosten.
--
-- Nu maakt een trigger vlak vóór het verwijderen van een agenda die uren los
-- van hun afspraak: calendar_event_link_id gaat leeg en de post wordt een
-- gewone ('manual') urenpost. 'calendar' kan niet blijven staan: zulke posten
-- "volgen hun afspraak" en zijn daarom in de app (TimeTracking.tsx) en via de
-- API (api_rest) niet te wijzigen. Zonder afspraak zaten ze dan voorgoed vast.
--
-- Eén afspraak ontkoppelen (de koppeling zelf weghalen) ruimt de afgeleide
-- post nog steeds op: dat is een bewuste handeling op die ene afspraak.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.keep_time_entries_on_calendar_source_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Als eigenaar van de tabel, net als de cascade die hierna komt: die kijkt
  -- ook niet naar de RLS van wie er verwijdert.
  update public.time_entries te
     set calendar_event_link_id = null,
         source = 'manual'
    from public.calendar_event_links l
   where l.calendar_source_id = old.id
     and l.organization_id = old.organization_id
     and te.calendar_event_link_id = l.id
     and te.organization_id = old.organization_id;
  return old;
end;
$$;

revoke all on function public.keep_time_entries_on_calendar_source_delete() from public, anon, authenticated;

drop trigger if exists calendar_sources_keep_time_entries on public.calendar_sources;
create trigger calendar_sources_keep_time_entries
  before delete on public.calendar_sources
  for each row execute function public.keep_time_entries_on_calendar_source_delete();

commit;
