-- ============================================================
-- ResoFly — Per-organization Mollie API key for invoice payment links
-- Date: 2026-06-01
--
-- Goal:
-- - Each organization stores its OWN Mollie API key so invoice payment links
--   are created on that organization's Mollie account (money lands with the
--   right company). This is deliberately SEPARATE from the billing Mollie
--   Connect (organization_mollie_connections), which exists for SaaS licensing.
-- - The key is AES-GCM encrypted by the invoice-workflow Edge Function before
--   it is stored here. This table is service_role-only and is NEVER exposed to
--   anon/authenticated, mirroring organization_mollie_connections.
-- - on delete cascade means a hard organization delete instantly removes the
--   stored credential. Soft "opzeggen" must call deleteInvoiceMollieKey to
--   revoke explicitly (the org row keeps existing).
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.organization_invoice_mollie_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  status text not null default 'not_connected' check (status in ('not_connected','connected','revoked')),
  mode text check (mode is null or mode in ('test','live')),
  -- AES-GCM ciphertext (v1.<iv>.<cipher>); plaintext key never touches the DB.
  api_key_encrypted text,
  -- Last 4 chars for display only ("live_••••3f2a"); not a secret.
  key_suffix text,
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz,
  revoked_at timestamptz,
  last_validated_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_org_invoice_mollie_status
  on public.organization_invoice_mollie_settings(organization_id, status);

alter table public.organization_invoice_mollie_settings enable row level security;

-- Secret storage: the encrypted key must never be readable from the browser.
-- Reads/writes go exclusively through the invoice-workflow Edge Function
-- (service role), which only ever returns masked, non-secret status fields.
revoke all on public.organization_invoice_mollie_settings from anon, authenticated;
grant select, insert, update, delete on public.organization_invoice_mollie_settings to service_role;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'organization_invoice_mollie_settings_updated_at') then
    create trigger organization_invoice_mollie_settings_updated_at
      before update on public.organization_invoice_mollie_settings
      for each row execute function public.set_updated_at();
  end if;
end $$;
