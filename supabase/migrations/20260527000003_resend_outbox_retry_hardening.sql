-- ResoFly finance-core mini-hardening: make Resend failures outbox-aware.
-- Applies after 20260527_finance_core_deep_review_fixes.sql and
-- 20260527_invoice_checkout_failure_pdf_selection_fix.sql.
--
-- Goal:
-- - On every invoice e-mail send failure, mark invoice_email_deliveries as failed.
-- - Mark the linked finance_provider_jobs row as retry/failed.
-- - Store last_error and next_retry_at for later reconciliation.
-- - Preserve the public function signature used by invoice-workflow/index.ts.

begin;

create or replace function public.fail_invoice_email_send(
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.invoice_email_deliveries;
  v_invoice public.invoices;
  v_error text := left(coalesce(nullif(btrim(coalesce(p_error_message, '')), ''), 'Onbekende Resend-verzendfout'), 2000);
  v_retry_after_seconds integer := 300;
  v_max_retries integer := 5;
  v_job_count integer := 0;
begin
  if p_actor_user_id is not null and auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_delivery
  from public.invoice_email_deliveries
  where id = p_delivery_id
    and organization_id = p_organization_id
  for update;

  if not found then
    return;
  end if;

  update public.invoice_email_deliveries
     set status = 'failed',
         failed_at = coalesce(failed_at, now()),
         last_event_at = now(),
         error_message = left(v_error, 1000),
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'providerFailure', jsonb_build_object(
             'provider', 'resend',
             'message', v_error,
             'failed_at', now()
           )
         ),
         updated_at = now()
   where id = v_delivery.id
   returning * into v_delivery;

  update public.invoices
     set last_email_delivery_status = 'failed',
         last_email_failed_at = now(),
         updated_at = now()
   where id = v_delivery.invoice_id
     and organization_id = p_organization_id
   returning * into v_invoice;

  update public.finance_provider_jobs
     set status = case
           when retry_count < v_max_retries then 'retry'
           else 'failed'
         end,
         last_error = v_error,
         response_payload = coalesce(response_payload, '{}'::jsonb) || jsonb_build_object(
           'failure', jsonb_build_object(
             'provider', 'resend',
             'delivery_id', v_delivery.id,
             'invoice_id', v_delivery.invoice_id,
             'message', v_error,
             'failed_at', now()
           )
         ),
         next_retry_at = case
           when retry_count < v_max_retries
             then now() + make_interval(secs => greatest(30, v_retry_after_seconds))
           else null
         end,
         updated_at = now()
   where provider = 'resend'
     and job_type = 'send_invoice_email'
     and (
       idempotency_key = 'invoice-email-' || v_delivery.id::text
       or entity_id = v_delivery.id
     );

  get diagnostics v_job_count = row_count;

  -- Defensive fallback: older data/migrations may contain a delivery without the
  -- provider job row. Create a retryable job so reconciliation still has a target.
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
      'email',
      v_delivery.id,
      'resend',
      'send_invoice_email',
      'retry',
      'invoice-email-' || v_delivery.id::text,
      jsonb_build_object(
        'invoice_id', v_delivery.invoice_id,
        'recipient_email', v_delivery.recipient_email,
        'subject', v_delivery.subject
      ),
      jsonb_build_object(
        'failure', jsonb_build_object(
          'provider', 'resend',
          'delivery_id', v_delivery.id,
          'invoice_id', v_delivery.invoice_id,
          'message', v_error,
          'failed_at', now()
        )
      ),
      v_error,
      now() + make_interval(secs => greatest(30, v_retry_after_seconds))
    )
    on conflict (provider, job_type, idempotency_key) where idempotency_key is not null do update
      set status = case
            when finance_provider_jobs.retry_count < v_max_retries then 'retry'
            else 'failed'
          end,
          last_error = excluded.last_error,
          response_payload = coalesce(finance_provider_jobs.response_payload, '{}'::jsonb) || excluded.response_payload,
          next_retry_at = case
            when finance_provider_jobs.retry_count < v_max_retries then excluded.next_retry_at
            else null
          end,
          updated_at = now();
  end if;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_delivery.invoice_id,
    'email_failed',
    'Factuurmail mislukt',
    left(v_error, 1000),
    jsonb_build_object(
      'delivery_id', v_delivery.id,
      'provider', 'resend',
      'retry_after_seconds', v_retry_after_seconds,
      'outbox_status', case when v_delivery.status = 'failed' then 'retry_scheduled' else 'failed' end
    ),
    p_actor_user_id
  );

  if v_invoice.id is not null then
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (
      p_organization_id,
      p_actor_user_id,
      'invoice_email_send_failed',
      'invoice',
      v_invoice.id,
      v_invoice.number,
      jsonb_build_object(
        'delivery_id', v_delivery.id,
        'provider', 'resend',
        'error', v_error,
        'retry_after_seconds', v_retry_after_seconds
      )
    );
  end if;
end;
$$;

revoke execute on function public.fail_invoice_email_send(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_invoice_email_send(uuid, uuid, uuid, text) to service_role;

-- Backfill: make sure already-failed invoice deliveries have an outbox status/error
-- so support/reconciliation screens can surface them consistently.
update public.finance_provider_jobs j
   set status = case when j.retry_count < 5 then 'retry' else 'failed' end,
       last_error = coalesce(j.last_error, d.error_message, 'Resend-verzending eerder mislukt.'),
       next_retry_at = case when j.retry_count < 5 then coalesce(j.next_retry_at, now() + interval '5 minutes') else null end,
       response_payload = coalesce(j.response_payload, '{}'::jsonb) || jsonb_build_object(
         'backfilled_failure', jsonb_build_object(
           'delivery_id', d.id,
           'invoice_id', d.invoice_id,
           'message', coalesce(d.error_message, 'Resend-verzending eerder mislukt.'),
           'backfilled_at', now()
         )
       ),
       updated_at = now()
from public.invoice_email_deliveries d
where j.provider = 'resend'
  and j.job_type = 'send_invoice_email'
  and (j.entity_id = d.id or j.idempotency_key = 'invoice-email-' || d.id::text)
  and d.status = 'failed'
  and j.status not in ('completed','failed','retry');


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
)
select
  d.organization_id,
  'email',
  d.id,
  'resend',
  'send_invoice_email',
  'retry',
  'invoice-email-' || d.id::text,
  jsonb_build_object('invoice_id', d.invoice_id, 'recipient_email', d.recipient_email, 'subject', d.subject),
  jsonb_build_object(
    'backfilled_failure', jsonb_build_object(
      'delivery_id', d.id,
      'invoice_id', d.invoice_id,
      'message', coalesce(d.error_message, 'Resend-verzending eerder mislukt.'),
      'backfilled_at', now()
    )
  ),
  coalesce(d.error_message, 'Resend-verzending eerder mislukt.'),
  now() + interval '5 minutes'
from public.invoice_email_deliveries d
where d.status = 'failed'
  and not exists (
    select 1
    from public.finance_provider_jobs j
    where j.provider = 'resend'
      and j.job_type = 'send_invoice_email'
      and (j.entity_id = d.id or j.idempotency_key = 'invoice-email-' || d.id::text)
  )
on conflict (provider, job_type, idempotency_key) where idempotency_key is not null do nothing;

commit;
