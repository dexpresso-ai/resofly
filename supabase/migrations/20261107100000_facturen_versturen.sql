-- ============================================================
-- ResoFly — Facturen versturen: per e-mail of via Mollie, te kiezen in Instellingen
-- Date: 2026-11-07
--
-- Vraag: "Bouw een functionaliteit in dat men niet verplicht via Mollie hoeft
-- te factureren, maar dat Resofly dit ook per mail kan doen." En: "dat je via
-- instellingen kunt kiezen of je via Mollie of per mail de facturen verzendt."
--
-- Tot nu toe was de Mollie-koppeling zelf de keuze. Was Mollie gekoppeld, dan
-- ging er bij elke factuur, herinnering en aanmaning een betaallink van Mollie
-- mee, bood het klantportaal "Betaal nu" aan, en gaf Mollie de e-factuur uit
-- bij klanten die op "via Mollie" stonden. Wie dat niet wilde, kon alleen
-- Mollie ontkoppelen.
--
-- invoice_send_method:
--   'email'  — ResoFly mailt de factuur zelf (PDF, of de e-factuur met de PDF
--              erin). Geen betaallink van Mollie, nergens; de klant betaalt per
--              overboeking. Ook als Mollie gekoppeld is.
--   'mollie' — zoals het was: met een betaallink van Mollie, en de e-factuur via
--              Mollie bij klanten die daarop staan.
--   null     — nog niet gekozen: zoals het was. Met een gekoppeld Mollie-account
--              is dat via Mollie, zonder per e-mail. Zo verandert er voor
--              bestaande organisaties niets tot iemand kiest.
--
-- De edge functions (invoice-workflow, client-portal, Gerrie) lezen de keuze;
-- de regels staan in supabase/functions/_shared/eInvoicing.ts. Opslaan doet
-- het scherm met een eigen update (alleen owners en admins: de policies op
-- company_settings), net als de Jitsi-server.
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

alter table public.company_settings
  add column if not exists invoice_send_method text;

alter table public.company_settings
  drop constraint if exists company_settings_invoice_send_method_check;
alter table public.company_settings
  add constraint company_settings_invoice_send_method_check
  check (invoice_send_method is null or invoice_send_method in ('email', 'mollie'));

comment on column public.company_settings.invoice_send_method is
  'Hoe facturen de deur uit gaan: email = ResoFly mailt ze, zonder Mollie; mollie = met een betaallink van Mollie en de e-factuur via Mollie waar de klant dat heeft; null = nog niet gekozen (via Mollie zodra Mollie gekoppeld is).';

commit;
