-- ============================================================
-- ResoFly — Klantmeldingen over tickets: teksten per organisatie
-- Date: 2026-10-05
--
-- De e-mailmeldingen uit het klantportaal (20261004000000, edge function
-- portal-notify) worden — net als offerte, factuur, contract en "bestand
-- gedeeld" — per organisatie aanpasbaar in de e-mailteksten-editor
-- (Instellingen → E-mail). Eén tekst per soort melding, dezelfde soorten
-- die de klant in het portaal aan of uit zet:
--
--   portal.ticket.received  ontvangstbevestiging aan wie het ticket indiende
--   portal.ticket.created   een ticket dat het team of een collega aanmaakte
--   portal.ticket.reply     een nieuw antwoord op het ticket
--   portal.ticket.status    een statuswijziging
--
-- Aanpasbaar zijn onderwerp, aanhef & bericht, afsluiting en knoptekst. De
-- rest blijft vast: het ticket met de status, de antwoorden zelf, de link naar
-- het ticket en de regel "Meldingen beheren" onderaan.
--
-- Daarvoor verruimen we de template_key-CHECK op email_templates (zelfde
-- werkwijze als 20260823000000: de naam van de constraint verschilt per
-- installatie, dus opzoeken in pg_constraint). Idempotent.
-- ============================================================

begin;

do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.email_templates'::regclass
      and contype = 'c'
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
    'meetingBooking.confirmed',
    'file.shared',
    'portal.ticket.received',
    'portal.ticket.created',
    'portal.ticket.reply',
    'portal.ticket.status'
  ));

commit;
