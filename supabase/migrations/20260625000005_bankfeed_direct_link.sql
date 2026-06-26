-- ============================================================
-- ResoFly — Bankfeed fase 2: directe PSD2-koppeling (provider-generiek)
-- Date: 2026-06-25
--
-- Context:
-- Fase 1 (migr. 20260622000004) legde het datamodel + de match/boek-engine voor
-- banktransacties (afschrift-import). Fase 2 voegt de directe koppeling toe: de
-- gebruiker geeft via zijn bank toestemming (PSD2/SCA) en de `bank-sync` Edge
-- Function haalt de transacties op. Die belanden via dezelfde
-- `import_bank_transactions` RPC in dezelfde `bank_transactions`-tabel en doorlopen
-- dezelfde match/boek-laag — alleen de ingestiebron verschilt.
--
-- Provider-generiek: GoCardless Bank Account Data nam geen nieuwe klanten meer aan,
-- dus de eerste live-provider wordt **Enable Banking** (EU/Fins, AISP, GDPR). Het
-- datamodel blijft provider-onafhankelijk (kolom `provider`) zodat we later kunnen
-- wisselen zonder migratie.
--
-- De Edge Function schrijft met de service-role (RLS-bypass), dus deze tabel krijgt
-- alleen een lees-policy.
-- ============================================================

begin;

create table if not exists public.bank_requisitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  provider text not null default 'enablebanking',
  -- Bij Enable Banking is de bank de ASPSP-naam + land; institution_id bevat de naam.
  institution_id text not null,
  institution_name text,
  institution_country text,
  -- Onze unieke referentie (= `state` in de PSD2-redirect). De provider geeft die
  -- samen met een `code` terug op de redirect.
  reference text not null,
  -- Externe id na afronden (GoCardless: requisition_id; Enable Banking: session_id).
  requisition_id text,
  link text,
  status text not null default 'created',
  accounts jsonb not null default '[]'::jsonb,
  error text,
  linked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_requisitions_provider_check check (provider in ('gocardless','enablebanking')),
  constraint bank_requisitions_status_check check (status in ('created','linked','expired','error')),
  constraint bank_requisitions_reference_unique unique (reference)
);
create index if not exists idx_bank_requisitions_org on public.bank_requisitions(organization_id, created_at desc);

-- Koppel een (gesynchroniseerde) bankrekening aan de consent waarmee hij is opgehaald,
-- zodat de UI per rekening de verloopdatum / herauthenticatie kan tonen.
alter table public.bank_accounts
  add column if not exists bank_requisition_id uuid references public.bank_requisitions(id) on delete set null;

-- Sta de gekoppelde bron toe naast 'import' (fase 1) en 'gocardless'.
alter table public.bank_accounts drop constraint if exists bank_accounts_source_check;
alter table public.bank_accounts
  add constraint bank_accounts_source_check check (source in ('import','gocardless','enablebanking'));

-- Idem voor het afschrift-formaat (een sync legt een bank_statements-batch vast).
alter table public.bank_statements drop constraint if exists bank_statements_format_check;
alter table public.bank_statements
  add constraint bank_statements_format_check check (format in ('camt053','mt940','csv','gocardless','enablebanking'));

-- Eén bankrekening per (organisatie, extern account-id) — voorkomt dubbele rekeningen
-- bij het (her)koppelen. Bewust NIET-partieel: in Postgres zijn NULL-waarden distinct,
-- dus meerdere handmatige rekeningen (zonder extern account-id) blijven toegestaan,
-- terwijl de uniciteit alleen geldt voor echte externe account-id's.
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
