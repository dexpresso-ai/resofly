-- ============================================================
-- ResoFly — Eigen-domein e-mail (fase 1, onderdeel A): verzenddomeinen
-- Date: 2026-06-18
--
-- Context:
-- Tot nu toe verstuurt elke organisatie via één globaal afzenderadres
-- (RESEND_FROM_EMAIL). Met deze tabel kan elke organisatie haar eigen domein
-- koppelen (bijv. eigendomeinnaam.nl) en vanaf haar eigen adres mailen. Het
-- domein wordt bij Resend geregistreerd; de DNS-records die de klant moet
-- plaatsen worden hier opgeslagen zodat het instellingenscherm ze kan tonen en
-- de verificatiestatus kan bijwerken.
--
-- Geen secrets in deze tabel: domeinnaam, Resend-domein-id en DNS-records zijn
-- niet-gevoelig. Eén gedeelde app-Resend-key (Edge Function secret) bedient alle
-- organisatie-domeinen, dus per-org sleutelopslag is niet nodig.
--
-- Schrijven loopt uitsluitend via de `mail` Edge Function (service role), omdat
-- het aanmaken/verifiëren Resend-API-calls vereist. De client leest alleen
-- (RLS: can_read_org).
-- ============================================================

create extension if not exists pgcrypto;

begin;

create table if not exists public.organization_email_domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  domain text not null,
  provider text not null default 'resend',
  resend_domain_id text,
  region text,
  from_email text,
  from_name text,
  status text not null default 'pending'
    check (status in ('pending','verified','failed','temporary_failure')),
  dns_records jsonb not null default '[]'::jsonb,
  is_default boolean not null default false,
  last_checked_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_email_domains_domain_not_blank check (length(btrim(domain)) > 0),
  constraint organization_email_domains_org_domain_unique unique (organization_id, domain)
);

create index if not exists idx_org_email_domains_org
  on public.organization_email_domains(organization_id, created_at desc);

-- Hoogstens één standaard-verzenddomein per organisatie.
create unique index if not exists idx_org_email_domains_one_default
  on public.organization_email_domains(organization_id)
  where is_default;

drop trigger if exists organization_email_domains_updated on public.organization_email_domains;
create trigger organization_email_domains_updated
before update on public.organization_email_domains
for each row execute function public.set_updated_at();

alter table public.organization_email_domains enable row level security;

-- Alleen-lezen voor leden; schrijven gebeurt via de `mail` Edge Function
-- (service role), die zelf de rol (owner/admin) afdwingt.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'organization_email_domains'
      and policyname = 'organization email domains read'
  ) then
    create policy "organization email domains read"
      on public.organization_email_domains
      for select using (public.can_read_org(organization_id));
  end if;
end $$;

commit;
