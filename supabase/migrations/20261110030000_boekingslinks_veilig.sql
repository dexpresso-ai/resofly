-- ============================================================
-- ResoFly — Boekingslinks: vastgelopen boekingen, voorbije blokken,
-- annuleren en de maker van de link
-- Date: 2026-11-10
--
-- Controle van de boekingslinks (docs/changelog/CHANGELOG_BOEKINGSLINKS_2026-11-10.md).
--
--   1. VASTGELOPEN BOEKING. Viel meeting-booking-public om tussen reserveren
--      en afronden, dan zette de "zelfherstellende" opruiming na twee minuten
--      alleen het tijdblok terug op open. De boeking zelf bleef op 'pending'
--      staan en telde voorgoed mee. Bij een link voor één boeking (de
--      standaard) kon daarna niemand meer boeken ("maximum bereikt"), en het
--      vrijgekomen blok gaf bij elke poging een fout: de unieke index staat
--      maar één lopende boeking per blok toe. Nu gaat zo'n boeking op 'failed'
--      en komt het blok vrij. Dat gebeurt na tien minuten in plaats van twee:
--      een edge function draait hooguit 400 seconden, dus wat dan nog op
--      'pending' staat, is zeker dood. Bij twee minuten kon een trage
--      agenda-aanroep zijn eigen blok nog kwijtraken terwijl hij het boekte.
--   2. VOORBIJE BLOKKEN. Een blok dat al begonnen was, stond tot het eind op
--      de boekingspagina, en reserveren keek niet naar de begintijd. Een klant
--      kon om 10.20 uur het blok van 10.00 uur nog boeken.
--   3. DE MAKER VAN DE LINK. Een boeking zet een afspraak in de agenda namens
--      wie de link maakte, met diens koppeling. Was die persoon geen actief
--      teamlid meer, of mocht hij niet meer in de Agenda schrijven, dan werkte
--      zijn link gewoon door. Een link kan nu nooit meer dan zijn maker.
--   4. ANNULEREN. cancel_meeting_booking zette het blok altijd terug op open,
--      ook bij een boeking die al mislukt of nog bezig was. Had iemand anders
--      dat blok intussen geboekt, dan stond het weer open en kon het een
--      tweede keer geboekt worden. Nu annuleert hij alleen een bevestigde
--      boeking, en gaat het blok alleen terug als er geen andere lopende
--      boeking op staat.
--   5. INVOER. Naam hooguit 160 tekens zonder stuurtekens, e-mailadres hooguit
--      254 tekens.
--   6. VANGNET. Een blok en een boeking horen bij een link van dezelfde
--      organisatie (alleen de service-role schrijft hier, maar de database
--      dwingt het nu ook af).
--   7. EENMALIG. Boekingen die al langer dan tien minuten op 'pending' staan,
--      gaan op 'failed', en hun blok gaat weer open.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Vastgelopen pogingen opruimen ────────────────────────────────────────
--
-- Eén plek voor de regel, zodat reserveren (publiek) en het beheerscherm
-- (meeting-booking: lijst, details, verwijderen) dezelfde stand zien.

create index if not exists idx_meeting_bookings_pending
  on public.meeting_bookings(organization_id, created_at)
  where status = 'pending';

create or replace function public.release_stale_meeting_bookings(
  p_organization_id uuid,
  p_booking_link_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.meeting_bookings b
     set status = 'failed', cancelled_at = now()
   where b.organization_id = p_organization_id
     and (p_booking_link_id is null or b.booking_link_id = p_booking_link_id)
     and b.status = 'pending'
     and b.created_at < now() - interval '10 minutes';
  get diagnostics v_count = row_count;

  -- Apart van de update hierboven: een tweede statement ziet de boekingen al
  -- op 'failed' staan. In één statement met een CTE zag de controle hieronder
  -- ze nog als lopend, en ging er geen enkel blok open.
  update public.meeting_booking_slots s
     set status = 'open', pending_at = null
   where s.organization_id = p_organization_id
     and (p_booking_link_id is null or s.booking_link_id = p_booking_link_id)
     and s.status = 'pending'
     and coalesce(s.pending_at, s.created_at) < now() - interval '10 minutes'
     and not exists (
       select 1 from public.meeting_bookings o
        where o.slot_id = s.id and o.status in ('pending', 'confirmed')
     );

  return v_count;
end;
$$;

revoke all on function public.release_stale_meeting_bookings(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_stale_meeting_bookings(uuid, uuid) to service_role;

-- ── 2. Reserveren (fase A) ──────────────────────────────────────────────────
--
-- Zelfde handtekening en terugkeer als 20260703000000; nieuw zijn de controle
-- op de maker, op de begintijd, op de lengte van de invoer, en de opruiming
-- hierboven. Let op: starts_at, ends_at en booking_id zijn hier ook de namen
-- van de uitvoerkolommen, dus elke kolom in een query staat met zijn tabel erbij.

create or replace function public.reserve_meeting_slot_by_token(
  p_token_hash text,
  p_slot_id uuid,
  p_name text,
  p_email text
)
returns table(booking_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.meeting_booking_links;
  v_slot public.meeting_booking_slots;
  v_total integer;
  v_week integer;
  v_booking_id uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
  -- Stuurtekens (een regeleinde in een naam) worden een spatie: de naam komt
  -- in de titel van de afspraak en in de onderwerpregel van de melding.
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]+', ' ', 'g')), '');
begin
  if v_email = '' or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Vul een geldig e-mailadres in.' using errcode = '23514';
  end if;
  if v_name is not null and length(v_name) > 160 then
    v_name := left(v_name, 160);
  end if;

  select * into v_link from public.meeting_booking_links l where l.public_token_hash = p_token_hash;
  if not found then raise exception 'Deze boekingslink is niet (meer) geldig.' using errcode = '02000'; end if;
  if v_link.status <> 'active' then raise exception 'Deze boekingslink is gesloten.' using errcode = '23514'; end if;
  if v_link.public_token_expires_at is null or v_link.public_token_expires_at < now() then
    raise exception 'Deze boekingslink is verlopen.' using errcode = '23514';
  end if;

  -- De afspraak komt in de agenda namens de maker. Is die geen actief teamlid
  -- meer met schrijfrecht op de Agenda, dan boekt de link niets meer.
  if v_link.user_id is null or not exists (
    select 1 from public.organization_members m
     where m.organization_id = v_link.organization_id
       and m.user_id = v_link.user_id
       and m.status = 'active'
       and m.role in ('owner', 'admin', 'member')
       and public.member_module_level(m.role, m.module_access, 'calendar') = 'write'
  ) then
    raise exception 'Deze boekingslink is niet meer beschikbaar. Neem contact op met de afzender.' using errcode = '23514';
  end if;

  -- Serialiseer gelijktijdige boekingen per link.
  perform pg_advisory_xact_lock(hashtext(v_link.id::text), hashtext('meeting_booking_slot'));

  perform public.release_stale_meeting_bookings(v_link.organization_id, v_link.id);

  select * into v_slot from public.meeting_booking_slots s
    where s.id = p_slot_id and s.booking_link_id = v_link.id for update;
  if not found then raise exception 'Dit moment bestaat niet (meer). Kies een ander moment.' using errcode = '02000'; end if;
  if v_slot.status <> 'open' then raise exception 'Dit moment is net door iemand anders gekozen. Kies een ander moment.' using errcode = '23514'; end if;
  if v_slot.starts_at <= now() then
    raise exception 'Dit moment is al voorbij. Kies een ander moment.' using errcode = '23514';
  end if;

  select count(*) into v_total from public.meeting_bookings b
    where b.booking_link_id = v_link.id and b.status in ('pending', 'confirmed');
  if v_total >= v_link.max_total_bookings then
    raise exception 'Via deze link zijn al alle afspraken gemaakt die er gemaakt kunnen worden.' using errcode = '23514';
  end if;

  select count(*) into v_week
    from public.meeting_bookings b
    join public.meeting_booking_slots s on s.id = b.slot_id
    where b.booking_link_id = v_link.id
      and b.status in ('pending', 'confirmed')
      and date_trunc('week', (s.starts_at at time zone 'Europe/Amsterdam'))
        = date_trunc('week', (v_slot.starts_at at time zone 'Europe/Amsterdam'));
  if v_week >= v_link.max_per_week then
    raise exception 'In die week is het maximum aantal afspraken al bereikt. Kies een moment in een andere week.' using errcode = '23514';
  end if;

  update public.meeting_booking_slots s set status = 'pending', pending_at = now() where s.id = v_slot.id;

  insert into public.meeting_bookings(booking_link_id, slot_id, organization_id, client_id, booked_name, booked_email, status)
    values (v_link.id, v_slot.id, v_link.organization_id, v_link.client_id, v_name, v_email, 'pending')
    returning id into v_booking_id;

  return query select v_booking_id, v_slot.starts_at, v_slot.ends_at;
end;
$$;

revoke all on function public.reserve_meeting_slot_by_token(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reserve_meeting_slot_by_token(text, uuid, text, text) to service_role;

-- ── 3. Annuleren door een teamlid ───────────────────────────────────────────

create or replace function public.cancel_meeting_booking(
  p_organization_id uuid,
  p_booking_id uuid
)
returns table(native_event_id uuid, external_event_id text, external_provider text, source_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.meeting_bookings;
  v_source uuid;
begin
  select * into v_booking from public.meeting_bookings b
    where b.id = p_booking_id and b.organization_id = p_organization_id for update;
  if not found then raise exception 'Boeking niet gevonden.' using errcode = '02000'; end if;
  if v_booking.status = 'pending' then
    raise exception 'Deze boeking wordt nog verwerkt. Probeer het over een paar minuten opnieuw.' using errcode = '23514';
  end if;
  if v_booking.status = 'failed' then
    raise exception 'Deze boeking is nooit doorgegaan; er valt niets te annuleren.' using errcode = '23514';
  end if;

  select mbl.source_id into v_source from public.meeting_booking_links mbl where mbl.id = v_booking.booking_link_id;

  if v_booking.status = 'confirmed' then
    update public.meeting_bookings b set status = 'cancelled', cancelled_at = now() where b.id = p_booking_id;
    -- Het blok alleen terug op open als niemand anders er intussen op staat.
    update public.meeting_booking_slots s set status = 'open', pending_at = null
     where s.id = v_booking.slot_id
       and s.status in ('booked', 'pending')
       and not exists (
         select 1 from public.meeting_bookings o
          where o.slot_id = s.id and o.id <> p_booking_id and o.status in ('pending', 'confirmed')
       );
  end if;

  -- Ook bij een al geannuleerde boeking: dan ruimt de edge function een
  -- achtergebleven agenda-item alsnog op (de provider antwoordt dan 404/410).
  return query select v_booking.native_event_id, v_booking.external_event_id, v_booking.external_provider, v_source;
end;
$$;

revoke all on function public.cancel_meeting_booking(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_meeting_booking(uuid, uuid) to service_role;

-- ── 4. Org-integriteit op blokken en boekingen ──────────────────────────────

create or replace function public.enforce_meeting_booking_slots_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.meeting_booking_links', new.booking_link_id, new.organization_id, 'meeting_booking_slots.booking_link_id');
  return new;
end;
$$;

drop trigger if exists meeting_booking_slots_org_integrity on public.meeting_booking_slots;
create trigger meeting_booking_slots_org_integrity
  before insert or update of organization_id, booking_link_id on public.meeting_booking_slots
  for each row execute function public.enforce_meeting_booking_slots_org_integrity();

create or replace function public.enforce_meeting_bookings_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.meeting_booking_links', new.booking_link_id, new.organization_id, 'meeting_bookings.booking_link_id');
  perform public.assert_same_org_reference('public.meeting_booking_slots', new.slot_id, new.organization_id, 'meeting_bookings.slot_id');
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'meeting_bookings.client_id');
  return new;
end;
$$;

drop trigger if exists meeting_bookings_org_integrity on public.meeting_bookings;
create trigger meeting_bookings_org_integrity
  before insert or update of organization_id, booking_link_id, slot_id, client_id on public.meeting_bookings
  for each row execute function public.enforce_meeting_bookings_org_integrity();

revoke all on function public.enforce_meeting_booking_slots_org_integrity() from public, anon, authenticated;
revoke all on function public.enforce_meeting_bookings_org_integrity() from public, anon, authenticated;

-- ── 5. Eenmalig: wat nu al vastzit ──────────────────────────────────────────

update public.meeting_bookings b
   set status = 'failed', cancelled_at = coalesce(b.cancelled_at, now())
 where b.status = 'pending'
   and b.created_at < now() - interval '10 minutes';

update public.meeting_booking_slots s
   set status = 'open', pending_at = null
 where s.status = 'pending'
   and coalesce(s.pending_at, s.created_at) < now() - interval '10 minutes'
   and not exists (
     select 1 from public.meeting_bookings o
      where o.slot_id = s.id and o.status in ('pending', 'confirmed')
   );

commit;
