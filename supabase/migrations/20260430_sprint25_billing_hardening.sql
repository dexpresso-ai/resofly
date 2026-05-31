-- ============================================================
-- BrandCore — Sprint 2.5 billing/Mollie hardening
-- Date: 2026-04-30
--
-- Purpose:
-- - Close the last checkout race window before Sprint 3 customer portal work.
-- - Keep incomplete local checkout recovery idempotent under parallel retries.
-- - Preserve existing Sprint 1/Sprint 2 behaviour; no Sprint 3 features added.
-- ============================================================

-- Stale duplicate incomplete records have no provider_payment_id and no checkout URL,
-- so they were never handed to Mollie. Cancel older duplicates before adding the guard.
with ranked_incomplete_checkouts as (
  select
    id,
    row_number() over (
      partition by organization_id, payment_type, coalesce(plan_key, ''), license_delta, amount_cents, currency
      order by created_at desc, id desc
    ) as duplicate_rank
  from public.organization_payment_records
  where status in ('open', 'pending')
    and provider_payment_id is null
    and provider_checkout_url is null
)
update public.organization_payment_records p
set status = 'canceled',
    canceled_at = coalesce(p.canceled_at, now()),
    updated_at = now(),
    metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object('sprint25_cancel_reason', 'duplicate_incomplete_checkout_before_unique_guard')
from ranked_incomplete_checkouts r
where p.id = r.id
  and r.duplicate_rank > 1;

create unique index if not exists idx_org_payment_records_one_incomplete_checkout
  on public.organization_payment_records(
    organization_id,
    payment_type,
    coalesce(plan_key, ''),
    license_delta,
    amount_cents,
    currency
  )
  where status in ('open', 'pending')
    and provider_payment_id is null
    and provider_checkout_url is null;

comment on index public.idx_org_payment_records_one_incomplete_checkout is
  'Sprint 2.5: prevents parallel retries from creating multiple incomplete local checkout records for the same organization/payment shape.';
