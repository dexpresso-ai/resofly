-- Finance core follow-up hardening: failed Mollie checkout cleanup/retry + public PDF selection safety.
-- Applies after 20260527_finance_core_production_hardening.sql and 20260527_finance_core_deep_review_fixes.sql.

begin;

-- Free invoices that were blocked by expired/stale creating payment records before this fix existed.
update public.invoice_payment_records
   set status = 'failed',
       error_message = coalesce(error_message, 'Checkout stayed in creating state until expiry and was failed by invoice checkout failure hardening.'),
       metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
         'auto_failed_by', '20260527_invoice_checkout_failure_pdf_selection_fix',
         'auto_failed_at', now()
       ),
       updated_at = now()
 where provider = 'mollie'
   and status = 'creating'
   and checkout_expires_at is not null
   and checkout_expires_at < now();

-- Mark a checkout preparation/provider failure without leaving the payment record in the active
-- creating/open/pending/authorized set. This frees the one-active-checkout constraint and records
-- the provider job as retryable/failed for later reconciliation.
create or replace function public.fail_invoice_payment_checkout(
  p_payment_record_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_error_message text,
  p_metadata jsonb default '{}'::jsonb,
  p_retry_after_seconds integer default 300,
  p_max_retries integer default 5
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.invoice_payment_records;
  v_invoice public.invoices;
  v_error text := left(coalesce(nullif(btrim(coalesce(p_error_message, '')), ''), 'Onbekende Mollie checkout-fout'), 2000);
  v_provider_payment_id text := nullif(btrim(coalesce(p_metadata->>'providerPaymentId', '')), '');
  v_provider_checkout_url text := nullif(btrim(coalesce(p_metadata->>'checkoutUrl', '')), '');
  v_job_count integer := 0;
begin
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_payment
  from public.invoice_payment_records
  where id = p_payment_record_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Payment record niet gevonden.' using errcode = '02000';
  end if;

  if v_payment.status = 'paid' then
    return v_payment;
  end if;

  update public.invoice_payment_records
     set status = 'failed',
         provider_payment_id = coalesce(v_provider_payment_id, provider_payment_id),
         provider_checkout_url = coalesce(v_provider_checkout_url, provider_checkout_url),
         error_message = v_error,
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'checkoutFailure', jsonb_strip_nulls(jsonb_build_object(
             'message', v_error,
             'failed_at', now(),
             'provider_payment_id', v_provider_payment_id,
             'checkout_url_present', v_provider_checkout_url is not null,
             'metadata', coalesce(p_metadata, '{}'::jsonb)
           ))
         ),
         updated_at = now()
   where id = v_payment.id
   returning * into v_payment;

  update public.finance_provider_jobs
     set status = case when retry_count < coalesce(p_max_retries, 5) then 'retry' else 'failed' end,
         last_error = v_error,
         response_payload = coalesce(response_payload, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         next_retry_at = case
           when retry_count < coalesce(p_max_retries, 5)
             then now() + make_interval(secs => greatest(30, coalesce(p_retry_after_seconds, 300)))
           else null
         end,
         updated_at = now()
   where provider = 'mollie'
     and job_type = 'create_invoice_payment'
     and entity_id = v_payment.id;

  get diagnostics v_job_count = row_count;

  if v_job_count = 0 then
    insert into public.finance_provider_jobs(
      organization_id,
      entity_type,
      entity_id,
      provider,
      job_type,
      status,
      idempotency_key,
      request_payload,
      response_payload,
      last_error,
      next_retry_at
    ) values (
      p_organization_id,
      'payment',
      v_payment.id,
      'mollie',
      'create_invoice_payment',
      'retry',
      coalesce(v_payment.idempotency_key, 'invoice-payment-' || v_payment.id::text),
      jsonb_build_object('invoice_id', v_payment.invoice_id, 'amount_cents', v_payment.amount_cents),
      coalesce(p_metadata, '{}'::jsonb),
      v_error,
      now() + make_interval(secs => greatest(30, coalesce(p_retry_after_seconds, 300)))
    )
    on conflict (provider, job_type, idempotency_key) where idempotency_key is not null do update
      set status = 'retry',
          last_error = excluded.last_error,
          response_payload = coalesce(finance_provider_jobs.response_payload, '{}'::jsonb) || excluded.response_payload,
          next_retry_at = excluded.next_retry_at,
          updated_at = now();
  end if;

  select * into v_invoice
  from public.invoices
  where id = v_payment.invoice_id
    and organization_id = p_organization_id;

  if found then
    perform public.insert_invoice_workflow_event(
      p_organization_id,
      v_payment.invoice_id,
      'payment_failed',
      'Betaallink aanmaken mislukt',
      v_error,
      jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', v_payment.provider_payment_id),
      p_actor_user_id
    );

    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (
      p_organization_id,
      p_actor_user_id,
      'invoice_payment_checkout_failed',
      'invoice',
      v_invoice.id,
      v_invoice.number,
      jsonb_build_object('payment_record_id', v_payment.id, 'error', v_error)
    );
  end if;

  return v_payment;
end;
$$;

revoke execute on function public.fail_invoice_payment_checkout(uuid, uuid, uuid, text, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.fail_invoice_payment_checkout(uuid, uuid, uuid, text, jsonb, integer, integer) to service_role;

commit;
