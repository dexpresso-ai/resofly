-- ============================================================
-- ResoFly — Tickets: per-gebruiker leesstatus + notificaties
-- Date: 2026-07-01
--
-- Context:
-- Net als bij klant-mail willen gebruikers zien wélke tickets nieuwe aandacht van
-- de klant nodig hebben, met een melding bij nieuwe binnenkomst. "Klant-activiteit"
-- op een ticket is:
--   1) een ticket dat de KLANT zelf via het portaal aanmaakte (created_by is geen
--      organisatielid — portaalklanten zijn geen lid), of
--   2) een reactie van de klant op de tijdlijn (ticket_note met author_type='client').
--
-- Leesstatus is PER GEBRUIKER en PER TICKET (timestamp): een ticket is 'ongelezen'
-- zolang er klant-activiteit is die nieuwer is dan het moment waarop de gebruiker
-- het ticket voor het laatst opende. Zo duikt een ticket weer op als 'nieuw' bij
-- een nieuwe klantreactie, ook al was het eerder gelezen.
-- ============================================================

begin;

-- Eén leesmarker per gebruiker per ticket. read_at = laatste keer geopend.
create table if not exists public.ticket_reads (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (ticket_id, user_id)
);

create index if not exists idx_ticket_reads_user_org
  on public.ticket_reads(user_id, organization_id);

alter table public.ticket_reads enable row level security;

-- Een gebruiker beheert uitsluitend z'n eigen leesmarkers, binnen een organisatie
-- die hij mag lezen (can_read_org: ook alleen-lezen leden mogen dit).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ticket_reads' and policyname='ticket reads select own') then
    create policy "ticket reads select own" on public.ticket_reads
      for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ticket_reads' and policyname='ticket reads insert own') then
    create policy "ticket reads insert own" on public.ticket_reads
      for insert with check (user_id = auth.uid() and public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ticket_reads' and policyname='ticket reads update own') then
    create policy "ticket reads update own" on public.ticket_reads
      for update using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ticket_reads' and policyname='ticket reads delete own') then
    create policy "ticket reads delete own" on public.ticket_reads
      for delete using (user_id = auth.uid());
  end if;
end $$;

-- Markeer een ticket als (nu) gelezen voor de huidige gebruiker. read_at wordt
-- server-side op now() gezet (geen clock-skew tussen client en berichttijden).
create or replace function public.mark_ticket_read(p_ticket_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.ticket_reads (organization_id, ticket_id, user_id, read_at)
  select t.organization_id, t.id, auth.uid(), now()
    from public.tickets t
   where t.id = p_ticket_id
  on conflict (ticket_id, user_id) do update set read_at = excluded.read_at;
end;
$$;

grant execute on function public.mark_ticket_read(uuid) to authenticated;

-- Ongelezen tickets voor de HUIDIGE gebruiker: klant-activiteit die nieuwer is dan
-- de eigen leesmarker. security_invoker zodat de RLS van tickets/ticket_notes/
-- organization_members van de aanroeper blijft gelden.
create or replace view public.ticket_unread
with (security_invoker = on) as
  select t.id,
         t.organization_id,
         t.client_id,
         t.title
  from public.tickets t
  where greatest(
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

-- Live meldingen: laat de app nieuwe tickets én nieuwe ticketnotities realtime
-- ontvangen. RLS blijft per abonnee gelden (alleen eigen-org events).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='tickets') then
      alter publication supabase_realtime add table public.tickets;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='ticket_notes') then
      alter publication supabase_realtime add table public.ticket_notes;
    end if;
  end if;
end $$;

commit;
