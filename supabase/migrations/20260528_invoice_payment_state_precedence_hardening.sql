-- ============================================================================
-- Invoice payment state-precedence hardening — 2026-05-28
-- ----------------------------------------------------------------------------
-- Probleem dat dit oplost
-- ----------------------------------------------------------------------------
-- public.update_invoice_payment_status() (versie 2026-05-27) overschreef de
-- payment-status ALTIJD met de inkomende webhookstatus. Mollie levert webhooks
-- echter "at least once" en zonder gegarandeerde volgorde. Daardoor kon een
-- late of dubbele 'expired'/'failed'/'open' webhook een al op 'paid' gezette
-- betaling terugzetten, terwijl de factuur zelf op 'paid' bleef staan. Dat gaf
-- een onmogelijke combinatie (factuur betaald, betaalrecord mislukt) en
-- verstoorde de reconciliatie.
--
-- Oplossing
-- ----------------------------------------------------------------------------
-- We introduceren een expliciete statusprioriteit. Een nieuwe status mag de
-- bestaande status alleen vervangen als die prioriteit >= de huidige is, met
-- twee uitzonderingen die juist WEL na 'paid' mogen volgen: 'refunded' en
-- 'charged_back' (post-betaling gebeurtenissen). 'paid' blijft daarmee
-- definitief en kan niet worden teruggedraaid door open/pending/expired/failed.
-- Late webhooks worden idempotent genegeerd (zelfde status -> geen wijziging),
-- maar last_webhook_at en metadata worden wel bijgewerkt voor audittrail.
-- ============================================================================

create or replace function public.update_invoice_payment_status(
  p_provider_payment_id text,
  p_status text,
  p_paid_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.invoice_payment_records;
  v_previous_status text;
  v_invoice public.invoices;
  v_event_type text;
  v_title text;
  v_status text := case when p_status in ('open','pending','authorized','paid','failed','expired','canceled','refunded','charged_back') then p_status else 'open' end;
  v_prev_rank integer;
  v_new_rank integer;
  v_apply_status boolean;
begin
  select * into v_payment
  from public.invoice_payment_records
  where provider = 'mollie'
    and provider_payment_id = p_provider_payment_id
  for update;

  if not found then
    raise exception 'Payment record niet gevonden voor provider-payment-id.' using errcode = '02000';
  end if;

  v_previous_status := v_payment.status;

  -- Statusprioriteit. Hoger = verder in de levenscyclus / definitiever.
  -- refunded en charged_back staan bewust boven paid zodat post-betaling
  -- gebeurtenissen wel kunnen worden vastgelegd, maar paid niet kan worden
  -- gedegradeerd naar open/pending/authorized/expired/failed/canceled.
  v_prev_rank := case v_previous_status
    when 'creating' then 0
    when 'open' then 1
    when 'pending' then 2
    when 'authorized' then 3
    when 'expired' then 4
    when 'canceled' then 4
    when 'failed' then 4
    when 'paid' then 5
    when 'refunded' then 6
    when 'charged_back' then 6
    else 0
  end;
  v_new_rank := case v_status
    when 'open' then 1
    when 'pending' then 2
    when 'authorized' then 3
    when 'expired' then 4
    when 'canceled' then 4
    when 'failed' then 4
    when 'paid' then 5
    when 'refunded' then 6
    when 'charged_back' then 6
    else 1
  end;

  -- Pas de status alleen aan als de nieuwe status verder in de levenscyclus
  -- ligt. Gelijke of lagere ranken laten de status ongemoeid (idempotent /
  -- bescherming tegen out-of-order webhooks). Wel altijd metadata + audit-spoor
  -- bijwerken, ongeacht of de status verandert.
  v_apply_status := v_new_rank > v_prev_rank;

  update public.invoice_payment_records
     set status = case when v_apply_status then v_status else status end,
         paid_at = case
           when v_status = 'paid' and v_apply_status then coalesce(v_payment.paid_at, p_paid_at, now())
           else paid_at
         end,
         last_webhook_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
           || jsonb_build_object('lastWebhookStatus', v_status, 'lastWebhookApplied', v_apply_status),
         updated_at = now()
   where id = v_payment.id
   returning * into v_payment;

  -- Als de status niet effectief verandert, geen verdere afgeleide acties
  -- (geen dubbele snapshots, events of audit-logs).
  if not v_apply_status then
    return v_payment;
  end if;

  select * into v_invoice
  from public.invoices
  where id = v_payment.invoice_id and organization_id = v_payment.organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden bij payment record.' using errcode = '02000'; end if;

  if v_status = 'paid' then
    update public.invoices
       set status = 'paid',
           paid_at = coalesce(v_invoice.paid_at, v_payment.paid_at, now()),
           locked_at = coalesce(v_invoice.locked_at, now()),
           locked_reason = coalesce(v_invoice.locked_reason, 'paid'),
           updated_at = now()
     where id = v_invoice.id
     returning * into v_invoice;

    if v_previous_status is distinct from 'paid' then
      perform public.create_invoice_version_snapshot(
        v_invoice.id,
        v_invoice.organization_id,
        'paid',
        null,
        null,
        v_payment.id,
        v_invoice.last_pdf_file_name,
        v_invoice.last_pdf_mime_type,
        v_invoice.last_pdf_size_bytes,
        v_invoice.last_pdf_sha256,
        null,
        jsonb_build_object('provider_payment_id', p_provider_payment_id)
      );
    end if;
  end if;

  v_event_type := case
    when v_status = 'paid' then 'payment_paid'
    when v_status = 'expired' then 'payment_expired'
    when v_status in ('failed','canceled','refunded','charged_back') then 'payment_failed'
    else 'payment_open'
  end;
  v_title := case
    when v_status = 'paid' then 'Factuur betaald'
    when v_status = 'expired' then 'Betaallink verlopen'
    when v_status in ('failed','canceled') then 'Betaling mislukt'
    when v_status = 'refunded' then 'Betaling terugbetaald'
    when v_status = 'charged_back' then 'Betaling teruggeboekt'
    else 'Betaalstatus bijgewerkt'
  end;

  if v_previous_status is distinct from v_status then
    perform public.insert_invoice_workflow_event(
      v_invoice.organization_id,
      v_invoice.id,
      v_event_type,
      v_title,
      'Mollie status: ' || v_status,
      jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id, 'previous_status', v_previous_status, 'status', v_status),
      null
    );
  end if;

  if v_status = 'paid' and v_previous_status is distinct from 'paid' then
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_invoice.organization_id, null, 'invoice_paid', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id));
  end if;

  return v_payment;
end;
$$;

revoke execute on function public.update_invoice_payment_status(text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.update_invoice_payment_status(text, text, timestamptz, jsonb) to service_role;
