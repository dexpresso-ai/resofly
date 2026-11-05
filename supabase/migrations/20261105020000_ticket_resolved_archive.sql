-- ============================================================
-- ResoFly — Tickets: status "Afgehandeld" en het archief
-- Date: 2026-11-05
--
-- Aanleiding: een ticket waar niets meer aan hoefde, bleef op de werklijst
-- staan. Er was geen status voor "klaar": goedgekeurd zegt "we gaan het doen",
-- geweigerd "we doen het niet" en omgezet "het is een project geworden". Wie
-- een vraag had beantwoord, liet het ticket op nieuw of goedgekeurd staan, en
-- de werklijst (op de ticketpagina en in het klantdossier) groeide dicht.
--
-- 1. Status 'resolved' (Afgehandeld). De app haalt zo'n ticket van de
--    werklijst en toont het in het archief.
-- 2. resolved_at: wanneer het ticket afgehandeld werd. De database zet en wist
--    hem zelf, zodat het archief op die datum sorteert en niemand (app, API,
--    Gerrie) een andere datum kan opgeven.
-- 3. Reageert de klant in het portaal op een afgehandeld ticket, dan gaat het
--    terug naar 'review' (In behandeling). Zonder dat verdween zijn bericht in
--    het archief: de werklijst toont alleen wat niet afgehandeld is, en niemand
--    zou het zien. De statuswijziging staat daarna op naam van de klant, zodat
--    hij er zelf geen mail over krijgt (zie portalNotify.ts).
-- 4. Een afgehandeld ticket telt niet meer als ongelezen (view ticket_unread).
--
-- Veilig opnieuw te draaien: drop … if exists, add column if not exists,
-- create or replace.
-- ============================================================

begin;

-- ── 1. De statussen ─────────────────────────────────────────────────────────
-- Dezelfde naam als de inline-check uit de basis (20260427000000); op staging
-- heet hij ook zo (gecontroleerd op 2026-11-05). apiResourceSpecs.test.ts
-- leest deze regel om de API naast de database te leggen.
alter table public.tickets drop constraint if exists tickets_status_check;
alter table public.tickets
  add constraint tickets_status_check
  check (status in ('new', 'review', 'approved', 'rejected', 'converted', 'resolved'));

-- ── 2. Wanneer afgehandeld ──────────────────────────────────────────────────
alter table public.tickets add column if not exists resolved_at timestamptz;

comment on column public.tickets.resolved_at is
  'Wanneer het ticket op afgehandeld (resolved) kwam. De database zet hem zelf (trigger tickets_10_resolved_at); leeg zolang het ticket niet afgehandeld is.';

create or replace function public.stamp_ticket_resolved_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'resolved' then
    -- Blijft het afgehandeld (bv. alleen de prioriteit wijzigt), dan blijft de
    -- oorspronkelijke datum staan. Een meegestuurde waarde telt nooit.
    if tg_op = 'UPDATE' then
      if old.status = 'resolved' then
        new.resolved_at := coalesce(old.resolved_at, now());
        return new;
      end if;
    end if;
    new.resolved_at := now();
  else
    new.resolved_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_ticket_resolved_at() from public, anon, authenticated;

-- Op ALLE wijzigingen, niet alleen "update of status": anders zet een update
-- van alleen resolved_at er een eigen datum in. De naam zorgt dat hij na
-- tickets_00_conversion_state loopt (triggers gaan op alfabet): die kan de
-- status nog terugzetten, en resolved_at volgt de status zoals hij uiteindelijk
-- wordt opgeslagen.
drop trigger if exists tickets_10_resolved_at on public.tickets;
create trigger tickets_10_resolved_at
  before insert or update on public.tickets
  for each row execute function public.stamp_ticket_resolved_at();

-- ── 3. Een reactie van de klant heropent het ticket ─────────────────────────
create or replace function public.reopen_resolved_ticket_on_client_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_type is distinct from 'client' then return null; end if;

  -- Het bericht van de klant mag hier nooit op stuklopen: gaat het heropenen
  -- mis, dan blijft het bij een waarschuwing en staat zijn reactie er wel.
  begin
    update public.tickets
       set status = 'review'
     where id = new.ticket_id
       and organization_id = new.organization_id
       and status = 'resolved';
    if not found then return null; end if;

    -- portal_activity_on_ticket_update schreef de statusregel net als
    -- 'system' (het portaal schrijft met de service-role, zonder gebruiker).
    -- Het was de klant: zet hem op zijn naam, net als zijn reactie in
    -- portal_activity_on_ticket_note. Dan mailt portal-notify hem er niet
    -- over; zijn collega's in het portaal krijgen de wijziging wel. Dezelfde
    -- transactie, dus dezelfde now() als die regel.
    update public.portal_ticket_activity
       set actor_type = 'client',
           actor_user_id = coalesce(new.author_user_id, new.created_by),
           actor_contact_id = new.author_client_contact_id
     where organization_id = new.organization_id
       and ticket_id = new.ticket_id
       and kind = 'status'
       and old_status = 'resolved'
       and new_status = 'review'
       and created_at = now()
       and notify_status = 'queued';
  exception when others then
    raise warning 'reopen_resolved_ticket_on_client_note: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.reopen_resolved_ticket_on_client_note() from public, anon, authenticated;

drop trigger if exists ticket_notes_reopen_resolved on public.ticket_notes;
create trigger ticket_notes_reopen_resolved
  after insert on public.ticket_notes
  for each row execute function public.reopen_resolved_ticket_on_client_note();

-- ── 4. Afgehandeld is niet ongelezen ────────────────────────────────────────
-- De leesmarker is per persoon. Maakte de klant een ticket aan en handelde
-- een collega het af, dan bleef het voor iedereen die het nooit opende
-- "ongelezen": de teller in de zijbalk bleef staan voor een ticket dat niet
-- meer op de werklijst staat, en Gerrie noemde het onder "nog reageren".
-- Nieuwe klantactiviteit heropent het ticket (stap 3), en dan telt het weer.
-- Verder dezelfde view als in 20260701000002_ticket_reads.sql.
create or replace view public.ticket_unread
with (security_invoker = on) as
  select t.id,
         t.organization_id,
         t.client_id,
         t.title
  from public.tickets t
  where t.status <> 'resolved'
    and greatest(
          -- 1) klant maakte het ticket zelf aan (created_by is geen orglid)
          case when t.created_by is not null
                 and not exists (
                   select 1 from public.organization_members m
                   where m.organization_id = t.organization_id and m.user_id = t.created_by
                 )
               then t.created_at end,
          -- 2) laatste klantreactie op de tijdlijn
          (select max(n.created_at) from public.ticket_notes n
           where n.ticket_id = t.id and n.author_type = 'client')
        ) > coalesce(
          (select r.read_at from public.ticket_reads r
           where r.ticket_id = t.id and r.user_id = auth.uid()),
          'epoch'::timestamptz
        );

grant select on public.ticket_unread to authenticated;

commit;
