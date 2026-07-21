-- ============================================================
-- ResoFly — Persoonlijke afzender per teamlid (klant-mail + campagnes)
-- Date: 2026-07-21
--
-- Een ResoFly-gebruiker kan per organisatie een eigen afzendernaam en (optioneel)
-- een eigen afzenderadres instellen, bijv. "Jan de Vries <jan@bedrijf.nl>".
-- Verzenden blijft via Resend + het geverifieerde org-verzenddomein lopen; dit is
-- GEEN mailbox-koppeling (bewust: Gmail/Microsoft-OAuth eerder afgewezen).
--
-- Anti-spoofing: het persoonlijke adres wordt bij het VERZENDEN alleen gebruikt
-- als het domein ervan op dat moment een geverifieerd verzenddomein van de
-- organisatie is (check in _shared/sendingDomain.ts). Vervalt de verificatie,
-- dan valt de mail stil terug op de org-afzender — alleen de naam blijft.
-- ============================================================

begin;

create table if not exists public.user_sender_identities (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  from_name text,
  from_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- Normalisatie + validatie: naam getrimd, adres lowercase en geldig (of null).
create or replace function public.enforce_user_sender_identity_guard()
returns trigger
language plpgsql
as $$
begin
  new.from_name := nullif(btrim(coalesce(new.from_name, '')), '');
  new.from_email := nullif(lower(btrim(coalesce(new.from_email, ''))), '');
  if new.from_email is not null and new.from_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Het persoonlijke afzenderadres is geen geldig e-mailadres.' using errcode = '23514';
  end if;
  if new.from_name is null and new.from_email is null then
    raise exception 'Vul minimaal een afzendernaam of afzenderadres in.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists user_sender_identities_guard on public.user_sender_identities;
create trigger user_sender_identities_guard
  before insert or update on public.user_sender_identities
  for each row execute function public.enforce_user_sender_identity_guard();

drop trigger if exists user_sender_identities_updated on public.user_sender_identities;
create trigger user_sender_identities_updated
  before update on public.user_sender_identities
  for each row execute function public.set_updated_at();

alter table public.user_sender_identities enable row level security;

-- Eigen rij beheren; org-leden mogen elkaars afzender lezen (nuttig voor
-- weergave "verstuurd door"), schrijven kan alleen op je eigen rij.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_sender_identities' and policyname='user sender identities read') then
    create policy "user sender identities read" on public.user_sender_identities for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_sender_identities' and policyname='user sender identities insert own') then
    create policy "user sender identities insert own" on public.user_sender_identities for insert with check (user_id = auth.uid() and public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_sender_identities' and policyname='user sender identities update own') then
    create policy "user sender identities update own" on public.user_sender_identities for update using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_sender_identities' and policyname='user sender identities delete own') then
    create policy "user sender identities delete own" on public.user_sender_identities for delete using (user_id = auth.uid());
  end if;
end $$;

commit;
