-- ============================================================
-- ResoFly — Tickets: wie wat schreef ligt vast, en pushmeldingen volgen het
-- recht op Tickets
-- Date: 2026-11-10
--
-- Controle van het ticketsysteem (CHANGELOG_TICKETS_CONTROLE_2026-11-10.md).
--
-- 1. Pushmeldingen over tickets gingen naar elk actief lid, ook naar wie
--    Tickets niet mag lezen (module_access tickets = none). Zo'n lid kreeg op
--    zijn telefoon "Nieuw ticket – <klant>: <titel>" en elke klantreactie. Dat
--    breekt de regel dat modulerechten overal gelden. Nu alleen wie Tickets
--    mag lezen (push_module_member_ids, zoals Financiën dat al deed).
--
-- 2. Een teamlid kon via de database (PostgREST, zonder de app) een notitie
--    plaatsen als de klant (author_type 'client', met de naam en het
--    contact-id van de klant). Het portaal toonde die als bericht van de klant,
--    de collega's van de klant kregen een mail "Jan heeft gereageerd", een
--    afgehandeld ticket ging weer open en agents startten. Met een wijziging
--    kon hij ook de tekst van een echt klantbericht herschrijven, of het
--    omzetten naar een interne teamnotitie. Bij een ticket kon hij
--    created_by_email/created_by_contact_id zetten: dan kreeg die contactpersoon
--    een ontvangstbevestiging van een ticket dat hij nooit indiende. De app en
--    de openbare API doen dit niet; de database liet het wel toe.
--    Nu, voor een ingelogde gebruiker (rol authenticated, dus ook de API en de
--    handelingen die als teamlid schrijven):
--      - een notitie is altijd van het teamlid zelf (author_type 'user',
--        author_user_id = auth.uid()); een poging namens de klant of een
--        collega wordt geweigerd;
--      - een notitie verandert daarna alleen nog van zichtbaarheid
--        (is_internal); tekst, auteur en ticket liggen vast;
--      - een ticket is van wie het aanmaakt (created_by = auth.uid()), en de
--        velden van een indiener uit het portaal (created_by_contact_id,
--        _email, _name) blijven leeg en veranderen niet.
--    De service-role (client-portal, file-transfer) houdt zijn eigen weg: daar
--    komt de klant of het teamlid uit de geverifieerde sessie.
--
-- 3. created_by_contact_id van een ticket wordt nu ook op organisatie
--    gecontroleerd, net als de klant en het project.
--
-- 4. ticket_reads: een leesmarker hoort bij een ticket van dezelfde
--    organisatie (mark_ticket_read deed dat al; de policy niet).
--
-- 5. ticket_unread is een view om te lezen; de schrijfrechten gaan eraf.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Pushmeldingen alleen voor wie Tickets mag lezen ─────────────────────

create or replace function public.push_on_ticket_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_name text;
  v_body text;
begin
  begin
    if new.created_by is not null and exists (
      select 1 from public.organization_members m
      where m.organization_id = new.organization_id and m.user_id = new.created_by
    ) then
      return null; -- intern ticket → geen push
    end if;

    select c.name into v_client_name from public.clients c
     where c.id = new.client_id and c.organization_id = new.organization_id;
    v_body := coalesce(nullif(btrim(v_client_name), ''), 'Onbekende klant')
              || ': ' || coalesce(nullif(btrim(new.title), ''), '(geen titel)');

    perform public.push_enqueue(
      new.organization_id, 'ticket_new',
      -- GEWIJZIGD (20261110100000): alleen wie Tickets mag lezen.
      public.push_module_member_ids(new.organization_id, 'tickets'),
      jsonb_build_object('title', 'Nieuw ticket', 'body', v_body, 'url', '/', 'tag', 'ticket:' || new.id::text)
    );
  exception when others then
    raise warning 'push_on_ticket_insert: %', sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.push_on_ticket_note_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_client_name text;
  v_body text;
begin
  begin
    if new.author_type is distinct from 'client' then return null; end if;

    select t.title, c.name into v_title, v_client_name
    from public.tickets t
    left join public.clients c on c.id = t.client_id and c.organization_id = t.organization_id
    where t.id = new.ticket_id and t.organization_id = new.organization_id;

    v_body := coalesce(nullif(btrim(v_client_name), ''), 'Onbekende klant')
              || ': ' || coalesce(nullif(btrim(v_title), ''), '(ticket)');

    perform public.push_enqueue(
      new.organization_id, 'ticket_note_client',
      -- GEWIJZIGD (20261110100000): alleen wie Tickets mag lezen.
      public.push_module_member_ids(new.organization_id, 'tickets'),
      jsonb_build_object('title', 'Nieuwe reactie', 'body', v_body, 'url', '/', 'tag', 'ticket:' || new.ticket_id::text)
    );
  exception when others then
    raise warning 'push_on_ticket_note_insert: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.push_on_ticket_insert() from public, anon, authenticated;
revoke all on function public.push_on_ticket_note_insert() from public, anon, authenticated;

-- ── 2. Wie wat schreef ligt vast ───────────────────────────────────────────

create or replace function public.ticket_authorship_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Alleen een ingelogde gebruiker (de app, de API en de handelingen als
  -- teamlid). De service-role legt de indiener zelf vast uit de geverifieerde
  -- portaalsessie.
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_by_contact_id := null;
    new.created_by_email := null;
    new.created_by_name := null;
  else
    new.created_by := old.created_by;
    new.created_by_contact_id := old.created_by_contact_id;
    new.created_by_email := old.created_by_email;
    new.created_by_name := old.created_by_name;
  end if;
  return new;
end;
$$;

revoke all on function public.ticket_authorship_guard() from public, anon, authenticated;

drop trigger if exists tickets_05_authorship on public.tickets;
create trigger tickets_05_authorship
  before insert or update on public.tickets
  for each row execute function public.ticket_authorship_guard();

create or replace function public.ticket_note_authorship_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.author_type is distinct from 'user' or new.author_client_contact_id is not null then
      raise exception 'Een teamlid plaatst geen bericht namens de klant.' using errcode = '42501';
    end if;
    if new.author_user_id is not null and new.author_user_id is distinct from auth.uid() then
      raise exception 'Een notitie plaats je op je eigen naam.' using errcode = '42501';
    end if;
    new.author_user_id := auth.uid();
    new.created_by := auth.uid();
    return new;
  end if;

  -- Wijzigen: alleen de zichtbaarheid. Een bericht dat de klant al zag (of
  -- schreef) herschrijf je niet; plaats een nieuw bericht of verwijder het.
  if new.ticket_id is distinct from old.ticket_id
     or new.body is distinct from old.body
     or new.author_type is distinct from old.author_type
     or new.author_user_id is distinct from old.author_user_id
     or new.author_client_contact_id is distinct from old.author_client_contact_id
     or new.author_name is distinct from old.author_name
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Van een notitie op de tijdlijn wijzig je alleen of de klant hem ziet.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.ticket_note_authorship_guard() from public, anon, authenticated;

drop trigger if exists ticket_notes_05_authorship on public.ticket_notes;
create trigger ticket_notes_05_authorship
  before insert or update on public.ticket_notes
  for each row execute function public.ticket_note_authorship_guard();

-- ── 3. De indiener van een ticket hoort bij dezelfde organisatie ───────────

create or replace function public.enforce_tickets_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'tickets.client_id');
  perform public.assert_same_org_reference('public.projects', new.converted_to_project_id, new.organization_id, 'tickets.converted_to_project_id');
  -- TOEGEVOEGD (20261110100000)
  perform public.assert_same_org_reference('public.client_contacts', new.created_by_contact_id, new.organization_id, 'tickets.created_by_contact_id');
  return new;
end; $$;

revoke all on function public.enforce_tickets_org_integrity() from public, anon, authenticated;

drop trigger if exists tickets_org_integrity on public.tickets;
create trigger tickets_org_integrity
  before insert or update of organization_id, client_id, converted_to_project_id, created_by_contact_id on public.tickets
  for each row execute function public.enforce_tickets_org_integrity();

-- ── 4. Een leesmarker hoort bij een ticket van dezelfde organisatie ────────

drop policy if exists "ticket reads insert own" on public.ticket_reads;
create policy "ticket reads insert own" on public.ticket_reads
  for insert
  with check (
    user_id = auth.uid()
    and public.can_read_org(organization_id)
    and exists (select 1 from public.tickets t where t.id = ticket_reads.ticket_id and t.organization_id = ticket_reads.organization_id)
  );

drop policy if exists "ticket reads update own" on public.ticket_reads;
create policy "ticket reads update own" on public.ticket_reads
  for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.tickets t where t.id = ticket_reads.ticket_id and t.organization_id = ticket_reads.organization_id)
  );

-- ── 5. ticket_unread is alleen om te lezen ─────────────────────────────────

revoke insert, update, delete, truncate, references, trigger on public.ticket_unread from anon, authenticated;

commit;
