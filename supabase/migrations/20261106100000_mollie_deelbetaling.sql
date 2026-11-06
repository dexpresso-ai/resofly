-- ============================================================
-- Mollie bij een deelbetaling (6 november 2026).
--
-- Mollie kent geen deelbetalingen. Een factuur die via Mollie als e-factuur is
-- uitgegeven, staat daar open voor het hele bedrag of is betaald; de betaallink
-- van Mollie vraagt altijd het hele bedrag. Betaalt de klant een deel per bank,
-- of komt er een creditnota, dan weet Mollie dat niet. De edge functions vangen
-- dat nu op (eigen betaallink voor het restbedrag, de factuur bij Mollie op
-- betaald zetten zodra er niets meer openstaat). Deze migratie doet het deel
-- dat in de database hoort:
--
-- 1. update_invoice_payment_status zette de factuur bij ELKE betaalde
--    Mollie-betaling op 'paid', ook als die maar een deel dekte (bijvoorbeeld
--    een link van € 600 terwijl er na een teruggedraaide bankboeking weer
--    € 1.000 openstond). De factuur stond dan betaald met geld open, en kreeg
--    geen herinnering meer. Nu blijft hij open, met een melding "deelbetaling".
-- 2. Betaalde de klant meer dan er openstond (de link van Mollie voor het hele
--    bedrag na een deelbetaling per bank, of twee links), dan was dat nergens
--    te zien. Nu staat er een melding "te veel betaald" bij de factuur, met het
--    bedrag, zodat iemand het verschil terugbetaalt.
-- 3. Nieuwe soorten gebeurtenissen op de tijdlijn: payment_partial,
--    payment_overpaid, e_invoice_settled en e_invoice_partial.
--
-- Veilig opnieuw te draaien: create or replace, en de check wordt vervangen.
-- ============================================================

begin;

-- 3. De soorten gebeurtenissen: de bestaande lijst (zoals op staging) plus vier.
alter table public.invoice_workflow_events drop constraint if exists invoice_workflow_events_event_type_check;
alter table public.invoice_workflow_events add constraint invoice_workflow_events_event_type_check check (event_type = any (array[
  'created_from_quote', 'public_token_created', 'public_link_created', 'sent_to_client', 'email_sent', 'email_delivered',
  'email_opened', 'email_clicked', 'email_bounced', 'email_failed', 'email_complained', 'client_viewed', 'payment_link_created',
  'payment_open', 'payment_paid', 'payment_failed', 'payment_expired', 'invoice_version_created', 'invoice_pdf_attached',
  'locked', 'expired', 'cancelled', 'void', 'written_off', 'payment_refunded', 'credit_note_issued', 'payment_charged_back',
  'chargeback_reversed', 'credit_note_emailed', 'marked_overdue', 'reminder_sent', 'reminder_failed', 'dunning_proposed',
  'dunning_sent', 'dunning_failed', 'dunning_cancelled', 'e_invoice_sent', 'e_invoice_delivered', 'e_invoice_failed',
  -- TOEGEVOEGD (20261106100000):
  'payment_partial',     -- een betaling die maar een deel dekte; de factuur blijft open
  'payment_overpaid',    -- er kwam meer binnen dan er openstond
  'e_invoice_settled',   -- de factuur staat bij Mollie op betaald (buiten Mollie om)
  'e_invoice_partial'    -- deelbetaling op een Mollie-factuur: Mollie vraagt nog het hele bedrag
]::text[]));

-- Een bedrag in centen als "€ 1.234,56" — voor de teksten op de tijdlijn.
create or replace function public.euro_label_nl(p_cents bigint)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case when p_cents < 0 then '-' else '' end || '€ '
    || translate(to_char(abs(coalesce(p_cents, 0))::numeric / 100, 'FM999,999,999,990.00'), ',.', '.,');
$$;

-- 1 en 2. update_invoice_payment_status — gebaseerd op de versie van
-- 20261105000000. Nieuw: na het boeken van een betaalde betaling kijkt hij wat
-- er nog openstaat volgens het grootboek.
--   - meer dan nul: deelbetaling, de factuur blijft open;
--   - minder dan nul: te veel betaald, melding met het bedrag;
--   - weet het grootboek het niet (de betaling of de factuur is niet geboekt):
--     zoals eerder, de factuur gaat op betaald.
create or replace function public.update_invoice_payment_status(
  p_provider_payment_id text,
  p_status text,
  p_paid_at timestamp with time zone default null::timestamp with time zone,
  p_metadata jsonb default '{}'::jsonb
)
returns invoice_payment_records
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  v_payment_entry uuid;
  v_open_after bigint;
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

  -- De trigger invoice_payment_records_autobook boekt een betaalde betaling
  -- (1102 aan 1300) zodra deze update klaar is.
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

  -- TOEGEVOEGD (20261106100000): wat er na deze betaling nog openstaat. Alleen
  -- als de betaling echt geboekt is (de trigger hierboven) en de factuur in het
  -- grootboek staat; anders weet het grootboek het niet en geldt het oude gedrag.
  if v_status = 'paid' then
    select pr.journal_entry_id into v_payment_entry
    from public.invoice_payment_records pr
    where pr.id = v_payment.id;
    if v_payment_entry is not null and v_invoice.journal_entry_id is not null then
      v_open_after := public.invoice_open_receivable_cents(v_invoice.organization_id, v_invoice.id);
    end if;
  end if;

  if v_status = 'paid' and v_invoice.status in ('cancelled','void','written_off','refunded') then
    perform public.insert_invoice_workflow_event(
      v_invoice.organization_id,
      v_invoice.id,
      'payment_paid',
      'Betaling ontvangen op een afgehandelde factuur',
      'Mollie meldt een betaling van ' || public.euro_label_nl(v_payment.amount_cents) || ', maar de factuur staat op ' || v_invoice.status
        || '. De status is niet gewijzigd; '
        || case when v_payment_entry is not null then 'de betaling is wel geboekt' else 'de betaling is niet automatisch geboekt' end
        || '. Controleer of het bedrag moet worden terugbetaald.',
      jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id,
                         'invoice_status', v_invoice.status, 'needs_review', true, 'open_after_cents', v_open_after),
      null
    );
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_invoice.organization_id, null, 'payment_succeeded', 'invoice', v_invoice.id, v_invoice.number,
            jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id,
                               'invoice_status', v_invoice.status, 'closed_invoice', true, 'needs_review', true));
    return v_payment;
  end if;

  -- TOEGEVOEGD (20261106100000): een deelbetaling laat de factuur open. Eerder
  -- ging hij op betaald met geld open: geen herinnering meer, en wie de
  -- factuur zag, dacht dat alles binnen was.
  if v_status = 'paid' and v_open_after is not null and v_open_after > 0 and v_invoice.status <> 'paid' then
    perform public.insert_invoice_workflow_event(
      v_invoice.organization_id,
      v_invoice.id,
      'payment_partial',
      'Deelbetaling ontvangen via Mollie',
      'Mollie meldt een betaling van ' || public.euro_label_nl(v_payment.amount_cents) || '. Er staat nog '
        || public.euro_label_nl(v_open_after) || ' open; de factuur blijft open.',
      jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id,
                         'previous_status', v_previous_status, 'status', v_status, 'open_after_cents', v_open_after),
      null
    );
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_invoice.organization_id, null, 'payment_succeeded', 'invoice', v_invoice.id, v_invoice.number,
            jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id,
                               'partial', true, 'open_after_cents', v_open_after));
    return v_payment;
  end if;

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

    -- TOEGEVOEGD (20261106100000): te veel betaald. Het geld staat op het
    -- Mollie-saldo en debiteuren staat voor deze factuur negatief (we zijn de
    -- klant geld schuldig). Iemand moet het verschil terugbetalen.
    if v_open_after is not null and v_open_after < 0 then
      perform public.insert_invoice_workflow_event(
        v_invoice.organization_id,
        v_invoice.id,
        'payment_overpaid',
        'Te veel betaald: ' || public.euro_label_nl(-v_open_after),
        'Via Mollie kwam ' || public.euro_label_nl(v_payment.amount_cents) || ' binnen, terwijl er minder openstond: de klant betaalde '
          || public.euro_label_nl(-v_open_after) || ' te veel. Betaal het verschil terug (bij de betaling in Mollie, of per bank) of verreken het met de klant.',
        jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id,
                           'overpaid_cents', -v_open_after, 'needs_review', true),
        null
      );
      -- Het auditlog kent een vaste lijst acties: 'payment_succeeded', met de
      -- reden in de metadata.
      insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
      values (v_invoice.organization_id, null, 'payment_succeeded', 'invoice', v_invoice.id, v_invoice.number,
              jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id,
                                 'overpaid', true, 'overpaid_cents', -v_open_after, 'needs_review', true));
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
$function$;

revoke all on function public.update_invoice_payment_status(text, text, timestamp with time zone, jsonb) from public, anon, authenticated;
grant execute on function public.update_invoice_payment_status(text, text, timestamp with time zone, jsonb) to service_role;
-- Alleen voor de databasefuncties zelf (die draaien als eigenaar).
revoke all on function public.euro_label_nl(bigint) from public, anon, authenticated;
grant execute on function public.euro_label_nl(bigint) to service_role;

commit;
