-- ============================================================
-- ResoFly — Bankfeed fase 2: directe PSD2-koppeling (GoCardless Bank Account Data)
-- Date: 2026-06-22
--
-- Context:
-- Fase 1 legde het datamodel + de journaliseer-engine voor banktransacties. Fase 2
-- voegt de directe koppeling toe: in plaats van een afschrift te uploaden, geeft de
-- gebruiker via zijn bank toestemming (PSD2/SCA) en haalt de `bank-sync` Edge Function
-- de transacties op. Die transacties belanden via dezelfde `import_bank_transactions`
-- RPC in dezelfde `bank_transactions`-tabel en doorlopen dezelfde match/boek-laag.
--
-- Deze migratie voegt alleen de consent-administratie toe (`bank_requisitions`,
-- 90-dagen levenscyclus) + een koppeling op `bank_accounts`. De Edge Function schrijft
-- met de service-role (RLS-bypass), dus deze tabel krijgt alleen een lees-policy.
--
-- Kernbeslissing: GoCardless-credentials zijn app-breed (de app is de TPP), dus die
-- staan als globale Edge-Function-secrets (GOCARDLESS_SECRET_ID/KEY), niet per
-- organisatie zoals de Mollie-key. Per org bewaren we alleen requisitions + de
-- gekoppelde rekeningen.
-- ============================================================

begin;

create table if not exists public.bank_requisitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  provider text not null default 'gocardless',
  institution_id text not null,
  institution_name text,
  -- Onze unieke referentie; GoCardless geeft die als ?ref= terug op de redirect.
  reference text not null,
  requisition_id text,
  link text,
  status text not null default 'created',
  accounts jsonb not null default '[]'::jsonb,
  error text,
  linked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_requisitions_provider_check check (provider in ('gocardless')),
  constraint bank_requisitions_status_check check (status in ('created','linked','expired','error')),
  constraint bank_requisitions_reference_unique unique (reference)
);
create index if not exists idx_bank_requisitions_org on public.bank_requisitions(organization_id, created_at desc);

-- Koppel een (gesynchroniseerde) bankrekening aan de consent waarmee hij is opgehaald,
-- zodat de UI per rekening de verloopdatum / herauthenticatie kan tonen.
alter table public.bank_accounts
  add column if not exists bank_requisition_id uuid references public.bank_requisitions(id) on delete set null;

-- Eén bankrekening per (organisatie, extern GoCardless-account) — voorkomt dubbele
-- rekeningen bij het (her)koppelen. Bewust GEEN partiële index: in Postgres zijn
-- NULL-waarden standaard distinct, dus meerdere handmatige rekeningen (zonder extern
-- account-id) per organisatie blijven toegestaan, terwijl de uniciteit alleen geldt
-- voor echte externe account-id's.
create unique index if not exists idx_bank_accounts_external
  on public.bank_accounts(organization_id, external_account_id);

-- Triggers (updated_at + org-lock).
drop trigger if exists bank_requisitions_touch_updated_at on public.bank_requisitions;
create trigger bank_requisitions_touch_updated_at before update on public.bank_requisitions
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists bank_requisitions_prevent_org_change on public.bank_requisitions;
create trigger bank_requisitions_prevent_org_change before update of organization_id on public.bank_requisitions
  for each row execute function public.prevent_organization_id_change();

-- RLS: lezen voor organisatieleden; schrijven uitsluitend via de bank-sync Edge
-- Function (service-role, RLS-bypass), dus geen insert/update/delete-policy.
alter table public.bank_requisitions enable row level security;
drop policy if exists "bank_requisitions read" on public.bank_requisitions;
create policy "bank_requisitions read" on public.bank_requisitions
  for select using (public.can_read_org(organization_id));

commit;
