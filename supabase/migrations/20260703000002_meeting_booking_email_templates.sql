-- ============================================================
-- ResoFly — Meeting Booking-e-mails per organisatie instelbaar maken
-- Date: 2026-07-03
--
-- De boekingstool verstuurt twee klantgerichte e-mails:
--  - meetingBooking.linkSent   (link naar de klant om een moment te kiezen)
--  - meetingBooking.confirmed  (bevestiging na het boeken)
--
-- Die moeten — net als offerte/factuur/herinnering/creditfactuur/contract —
-- per organisatie aanpasbaar zijn in de bestaande e-mailteksten-editor. Daarvoor
-- verruimen we de template_key-CHECK op email_templates. Idempotent voor staging.
-- ============================================================

begin;

do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.email_templates'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%template_key%'
  loop
    execute format('alter table public.email_templates drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.email_templates
  add constraint email_templates_template_key_check
  check (template_key in (
    'quote.sent',
    'invoice.sent',
    'invoice.reminder.1',
    'invoice.reminder.2',
    'invoice.reminder.3',
    'creditNote.sent',
    'contract.sent',
    'contract.signed.client',
    'meetingBooking.linkSent',
    'meetingBooking.confirmed'
  ));

commit;
