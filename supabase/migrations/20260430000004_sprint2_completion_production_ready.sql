-- ============================================================
-- BrandCore — Sprint 2 completion production-ready fixes
-- Date: 2026-04-30
--
-- Purpose:
-- - Make reusable open checkout lookup price/currency-safe.
-- - Add refresh_token_version for safe Mollie refresh-token rotation CAS.
-- - Keep the upgrade path idempotent for earlier Sprint 2 installs.
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

alter table public.billing_plans
  add column if not exists is_active boolean not null default true;

alter table public.organization_mollie_connections
  add column if not exists refresh_token_version integer not null default 0 check (refresh_token_version >= 0);

alter table public.organization_payment_records
  add column if not exists amount_cents integer not null default 0 check (amount_cents >= 0),
  add column if not exists currency text not null default 'EUR';

alter table public.organization_billing_events
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists receive_count integer not null default 1 check (receive_count >= 1);

-- The previous final-hardening index missed amount/currency, which made open checkout reuse unsafe after price changes.
drop index if exists public.idx_org_payment_records_reusable_open_checkout;
create index if not exists idx_org_payment_records_reusable_open_checkout
  on public.organization_payment_records(organization_id, payment_type, plan_key, license_delta, amount_cents, currency, status, created_at desc)
  where status in ('open','pending')
    and provider_payment_id is not null
    and provider_checkout_url is not null;

create index if not exists idx_org_payment_records_recoverable_incomplete_checkout
  on public.organization_payment_records(organization_id, payment_type, license_delta, plan_key, amount_cents, currency, created_at desc)
  where status in ('open','pending')
    and provider_payment_id is null
    and provider_checkout_url is null;

drop trigger if exists organization_billing_events_audit on public.organization_billing_events;
comment on table public.organization_billing_events is 'Internal billing/webhook idempotency ledger. Duplicate receive_count updates are intentionally not mirrored into audit_logs.';
