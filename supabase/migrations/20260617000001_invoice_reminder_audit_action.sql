-- ResoFly: voeg de audit-actie 'invoice_reminder_sent' toe aan audit_logs_action_check.
--
-- complete_invoice_reminder_send (migratie 20260617000000) schrijft een audit-log met
-- action = 'invoice_reminder_sent'. Die waarde ontbrak nog in de check-constraint
-- (laatst gezet in 20260603000000_invoice_chargebacks_external_refunds.sql), waardoor de
-- eerste herinnering faalde met:
--   new row for relation "audit_logs" violates check constraint "audit_logs_action_check" (23514)
--
-- We droppen + re-adden de constraint met exact de bestaande lijst plus de nieuwe actie.

begin;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.audit_logs'::regclass
      and conname = 'audit_logs_action_check'
  ) then
    alter table public.audit_logs drop constraint audit_logs_action_check;
  end if;

  alter table public.audit_logs
    add constraint audit_logs_action_check
    check (action in (
      'created','updated','deleted','invited','accepted','revoked','role_changed','disabled','expired',
      'mollie_connected','plan_changed','seat_purchased','seat_downgrade_requested',
      'payment_succeeded','payment_failed','payment_expired','subscription_cancelled',
      'licensed_seats_changed','invitation_blocked_insufficient_seats','billing_synced',
      'quote_submitted_for_approval','quote_internal_approved','quote_internal_rejected',
      'quote_sent_to_client','quote_client_accepted','quote_client_rejected',
      'quote_email_delivered','quote_email_failed','quote_version_created','quote_pdf_attached',
      'invoice_created_from_quote','invoice_sent_to_client','invoice_payment_link_created','invoice_paid',
      'invoice_refunded','credit_note_issued',
      'invoice_charged_back','chargeback_reversed','credit_note_emailed',
      'invoice_reminder_sent'
    ));
end $$;

commit;
