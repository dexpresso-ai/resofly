-- ============================================================
-- ResoFly — Klant-mail: per-gebruiker leesstatus + notificaties
-- Date: 2026-07-01
--
-- Context:
-- Inkomende klant-antwoorden verschijnen in de Communicatie-tab. Gebruikers
-- willen zien welke berichten nieuw (ongelezen) zijn en een melding krijgen bij
-- nieuwe post. Leesstatus is PER GEBRUIKER: leest een teamlid een bericht, dan
-- blijft het voor collega's ongelezen tot zij het zelf openen.
--
-- Aanpak:
-- - `client_email_reads`: één rij per (bericht, gebruiker) die 'gelezen' markeert.
--   De gebruiker schrijft z'n eigen markers rechtstreeks (RLS, geen Edge Function
--   nodig) — het is een persoonlijke voorkeur, geen wijziging aan org-data.
-- - View `client_email_unread`: inkomende berichten die de huidige gebruiker nog
--   niet gelezen heeft. De frontend telt hieruit de globale + per-klant badge.
-- - `client_emails` toevoegen aan de realtime-publicatie zodat de app een live
--   melding kan tonen zodra er een inkomend bericht binnenkomt (RLS blijft gelden:
--   een gebruiker ontvangt alleen events voor z'n eigen organisatie).
-- ============================================================

begin;

-- Eén leesmarker per gebruiker per bericht. client_id is gedenormaliseerd zodat de
-- per-klant badge zonder join te bepalen is.
create table if not exists public.client_email_reads (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  client_email_id uuid not null references public.client_emails(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (client_email_id, user_id)
);

create index if not exists idx_client_email_reads_user_org
  on public.client_email_reads(user_id, organization_id);
create index if not exists idx_client_email_reads_user_client
  on public.client_email_reads(user_id, client_id);

alter table public.client_email_reads enable row level security;

-- Een gebruiker beheert uitsluitend z'n eigen leesmarkers, binnen een organisatie
-- die hij mag lezen. can_read_org (niet can_write_org): ook alleen-lezen leden
-- mogen hun eigen post als gelezen markeren.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_email_reads' and policyname='client email reads select own') then
    create policy "client email reads select own" on public.client_email_reads
      for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_email_reads' and policyname='client email reads insert own') then
    create policy "client email reads insert own" on public.client_email_reads
      for insert with check (user_id = auth.uid() and public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_email_reads' and policyname='client email reads delete own') then
    create policy "client email reads delete own" on public.client_email_reads
      for delete using (user_id = auth.uid());
  end if;
end $$;

-- Ongelezen inkomende berichten voor de HUIDIGE gebruiker. security_invoker zodat
-- de onderliggende RLS van client_emails (can_read_org) blijft gelden; de expliciete
-- user_id-filter maakt 'gelezen door mij' onafhankelijk van reads-RLS.
create or replace view public.client_email_unread
with (security_invoker = on) as
  select e.id,
         e.organization_id,
         e.client_id,
         e.thread_id,
         e.subject,
         e.from_email,
         e.from_name,
         e.received_at,
         e.created_at
  from public.client_emails e
  where e.direction = 'inbound'
    and not exists (
      select 1 from public.client_email_reads r
      where r.client_email_id = e.id
        and r.user_id = auth.uid()
    );

grant select on public.client_email_unread to authenticated;

-- Live meldingen: laat de app inkomende berichten realtime ontvangen. RLS wordt
-- per abonnee gehandhaafd, dus alleen eigen-org events komen door.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'client_emails'
    ) then
      alter publication supabase_realtime add table public.client_emails;
    end if;
  end if;
end $$;

commit;
