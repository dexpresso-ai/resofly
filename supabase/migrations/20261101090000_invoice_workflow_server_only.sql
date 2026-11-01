-- ============================================================
-- ResoFly — Een uitgegeven factuur ligt vast, ook voor wie Financiën mag schrijven
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt C;
-- open punt van 26 september, ruimer dan toen gedacht).
--
--   1. FACTUREN. De bewaking (enforce_invoice_immutability, freeze_booked,
--      block_delete) kijkt naar de OUDE status, locked_at en journal_entry_id.
--      Die drie kon iedereen met schrijfrecht op Financiën zelf wijzigen. Met
--      twee verzoeken was een verzonden en geboekte factuur weer een concept:
--      regels en nummer aanpassen of verwijderen (met betalingen, verzendingen,
--      versies en creditnota's), en een journaalpost zonder brondocument.
--      Nu:
--        - de workflowvelden (vergrendeling, boeking, deellink, verzending,
--          versies, PDF, terugbetaling, chargeback, herinneringen) zet alleen
--          de server;
--        - een uitgegeven factuur gaat niet meer terug naar concept;
--        - "terugbetaald" registreert alleen de server.
--      Handmatig op verzonden, betaald, geannuleerd, ongeldig of afgeboekt
--      zetten blijft kunnen (het formulier en Gerrie doen dat).
--   2. INKOOPFACTUREN hadden geen enkele bewaking. Nu zet alleen de server de
--      status, de boeking en de betaling (Boeken, bank), en ligt een geboekte
--      inkoopfactuur vast.
--   3. OFFERTES. Een offerte die naar de klant ging of waarover de klant
--      besliste, kon worden verwijderd, en met hem de akkoordverklaring van de
--      klant. Nu niet meer (bewaarplicht).
--
-- De service-role, pg_cron en security-definer-functies (de workflows) mogen
-- alles: alleen anon, authenticated en authenticator worden bewaakt, zoals bij
-- enforce_quote_workflow_fields_server_only.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Facturen ────────────────────────────────────────────────────────────

create or replace function public.enforce_invoice_workflow_fields_server_only()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.locked_at is not null or new.locked_reason is not null or new.journal_entry_id is not null or new.public_token_hash is not null or new.public_token_created_at is not null or new.public_token_expires_at is not null or new.resend_last_email_id is not null or new.last_email_delivery_status is not null or new.last_email_delivery_at is not null or new.last_email_opened_at is not null or new.last_email_clicked_at is not null or new.last_email_failed_at is not null or new.latest_version_id is not null or new.sent_version_id is not null or new.paid_version_id is not null or new.last_pdf_file_name is not null or new.last_pdf_mime_type is not null or new.last_pdf_size_bytes is not null or new.last_pdf_sha256 is not null or new.source_quote_version_id is not null or new.refunded_at is not null or new.charged_back_at is not null or new.last_reminder_at is not null
       or coalesce(new.refunded_amount, 0) <> 0
       or coalesce(new.charged_back_amount, 0) <> 0
       or coalesce(new.reminder_level, 0) <> 0
       or new.status = 'refunded' then
      raise exception 'Vergrendeling, boeking, deellink, verzending en terugbetaling van een factuur zet alleen de server.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (new.locked_at,
      new.locked_reason,
      new.journal_entry_id,
      new.public_token_hash,
      new.public_token_created_at,
      new.public_token_expires_at,
      new.resend_last_email_id,
      new.last_email_delivery_status,
      new.last_email_delivery_at,
      new.last_email_opened_at,
      new.last_email_clicked_at,
      new.last_email_failed_at,
      new.latest_version_id,
      new.sent_version_id,
      new.paid_version_id,
      new.last_pdf_file_name,
      new.last_pdf_mime_type,
      new.last_pdf_size_bytes,
      new.last_pdf_sha256,
      new.source_quote_version_id,
      new.refunded_amount,
      new.refunded_at,
      new.charged_back_amount,
      new.charged_back_at,
      new.reminder_level,
      new.last_reminder_at)
     is distinct from
     (old.locked_at,
      old.locked_reason,
      old.journal_entry_id,
      old.public_token_hash,
      old.public_token_created_at,
      old.public_token_expires_at,
      old.resend_last_email_id,
      old.last_email_delivery_status,
      old.last_email_delivery_at,
      old.last_email_opened_at,
      old.last_email_clicked_at,
      old.last_email_failed_at,
      old.latest_version_id,
      old.sent_version_id,
      old.paid_version_id,
      old.last_pdf_file_name,
      old.last_pdf_mime_type,
      old.last_pdf_size_bytes,
      old.last_pdf_sha256,
      old.source_quote_version_id,
      old.refunded_amount,
      old.refunded_at,
      old.charged_back_amount,
      old.charged_back_at,
      old.reminder_level,
      old.last_reminder_at) then
    raise exception 'Vergrendeling, boeking, deellink, verzending en terugbetaling van een factuur zet alleen de server.'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if new.status = 'draft' then
      raise exception 'Een uitgegeven factuur gaat niet terug naar concept. Annuleer de factuur of maak een creditnota.'
        using errcode = '23514';
    end if;
    if new.status = 'refunded' then
      raise exception 'Een terugbetaling registreert de server (via Mollie of "Terugbetalen").'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_invoice_workflow_fields_server_only() from public, anon, authenticated;

drop trigger if exists invoices_workflow_fields_server_only on public.invoices;
create trigger invoices_workflow_fields_server_only
  before insert or update on public.invoices
  for each row execute function public.enforce_invoice_workflow_fields_server_only();

-- ── 2. Inkoopfacturen ──────────────────────────────────────────────────────

create or replace function public.enforce_purchase_invoice_server_fields()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if coalesce(new.status, 'draft') <> 'draft'
       or new.journal_entry_id is not null
       or coalesce(new.payment_status, 'unpaid') <> 'unpaid'
       or new.paid_at is not null then
      raise exception 'Een nieuwe inkoopfactuur is een concept; boeken en betalen gaat via Boekhouding.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (new.status, new.journal_entry_id, new.payment_status, new.paid_at)
     is distinct from (old.status, old.journal_entry_id, old.payment_status, old.paid_at) then
    raise exception 'Status, boeking en betaling van een inkoopfactuur wijzigt alleen de server (Boeken, bank).'
      using errcode = '42501';
  end if;

  if old.journal_entry_id is not null and (
       new.lines is distinct from old.lines
       or new.date is distinct from old.date
       or new.supplier_id is distinct from old.supplier_id
       or new.supplier_invoice_number is distinct from old.supplier_invoice_number
       or new.internal_number is distinct from old.internal_number
       or new.subtotal_cents is distinct from old.subtotal_cents
       or new.vat_cents is distinct from old.vat_cents
       or new.total_cents is distinct from old.total_cents
       or new.currency is distinct from old.currency) then
    raise exception 'Deze inkoopfactuur is geboekt en ligt vast. Boek de journaalpost tegen om te corrigeren.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_purchase_invoice_server_fields() from public, anon, authenticated;

drop trigger if exists purchase_invoices_server_fields on public.purchase_invoices;
create trigger purchase_invoices_server_fields
  before insert or update on public.purchase_invoices
  for each row execute function public.enforce_purchase_invoice_server_fields();

-- ── 3. Offertes: verstuurd = bewaren ───────────────────────────────────────

create or replace function public.quote_block_delete_when_sent()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return old;
  end if;
  if old.sent_at is not null
     or old.client_decision_at is not null
     or old.status in ('sent', 'accepted', 'rejected', 'expired', 'paid', 'overdue') then
    raise exception 'Deze offerte is naar de klant gestuurd en valt onder de bewaarplicht. Trek hem in of laat hem verlopen in plaats van verwijderen.'
      using errcode = '23514';
  end if;
  return old;
end;
$$;

revoke all on function public.quote_block_delete_when_sent() from public, anon, authenticated;

drop trigger if exists quotes_block_delete_when_sent on public.quotes;
create trigger quotes_block_delete_when_sent
  before delete on public.quotes
  for each row execute function public.quote_block_delete_when_sent();

commit;
