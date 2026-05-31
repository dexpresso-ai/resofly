-- ============================================================
-- BrandCore — Sprint 2 final hardening: Mollie checkout recovery
-- Date: 2026-04-30
--
-- Purpose:
-- - Add supporting indexes for retry-safe checkout recovery.
-- - Prevent generic audit-log spam from duplicate webhook receive_count updates.
--   Payment and license audit entries remain explicit through log_billing_audit.
-- ============================================================

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

-- Billing events are an internal idempotency ledger. Duplicate Mollie webhooks update
-- receive_count/last_seen_at and should not create generic audit-log noise. Business
-- audit remains covered by explicit log_billing_audit calls in apply_paid_organization_payment.
drop trigger if exists organization_billing_events_audit on public.organization_billing_events;
comment on table public.organization_billing_events is 'Internal billing/webhook idempotency ledger. Duplicate receive_count updates are intentionally not mirrored into audit_logs.';
