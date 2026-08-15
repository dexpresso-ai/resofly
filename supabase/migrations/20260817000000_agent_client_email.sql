-- ============================================================
-- ResoFly — een agent mag mailtjes naar klanten klaarzetten
-- Date: 2026-08-17
--
-- Tot nu toe kon een geplande agent alleen documenten versturen die al bestonden
-- (factuur, offerte, herinnering). Hij mag nu ook een VRIJE klantmail voorstellen,
-- dezelfde soort mail als je vanaf de klantenkaart stuurt (mail-functie, actie
-- `sendClientEmail`: eigen verzenddomein, thread + logging in client_emails).
--
-- Twee schrijfwijzen, per agent te kiezen:
--   compose   — de agent schrijft per klant zelf een tekst.
--   template  — JIJ legt onderwerp + tekst vast; de agent kiest alleen WIE hem
--               krijgt. De tekst wordt server-side met {{variabelen}} ingevuld
--               (_shared/mergeTokens.ts) en het model kan er niet meer aan komen.
--
-- Veiligheidsinvariant blijft ongewijzigd: de agent VERSTUURT NIETS. Het voorstel
-- landt in ai_action_audit ('proposed') en de gebruiker vinkt in de app mail voor
-- mail af; pas dan gaat er iets weg, via de sessie van die gebruiker (dus mét
-- diens RLS en modulerechten). `max_emails_per_run` is het harde plafond op hoe
-- veel mails één run mag klaarzetten — zonder dat kan één ongelukkige opdracht
-- een wachtrij van honderden mails opleveren.
--
-- Beveiliging: geen nieuwe RLS nodig; ai_agents is al owner/admin-leesbaar en
-- schrijven loopt uitsluitend via de service-role in `gerrie-agent-runner`.
-- ============================================================

begin;

alter table public.ai_agents
  add column if not exists email_mode text not null default 'compose'
    check (email_mode in ('compose', 'template'));

alter table public.ai_agents
  add column if not exists email_subject text
    check (email_subject is null or char_length(email_subject) <= 300);

alter table public.ai_agents
  add column if not exists email_body text
    check (email_body is null or char_length(email_body) <= 8000);

alter table public.ai_agents
  add column if not exists max_emails_per_run int not null default 5
    check (max_emails_per_run between 1 and 25);

comment on column public.ai_agents.email_mode is
  'compose = de agent schrijft de klantmail zelf; template = onderwerp/tekst hieronder zijn leidend en het model mag ze niet wijzigen.';
comment on column public.ai_agents.email_subject is
  'Vast onderwerp bij email_mode=template. Mag {{variabelen}} bevatten (zie _shared/mergeTokens.ts).';
comment on column public.ai_agents.email_body is
  'Vaste tekst bij email_mode=template, platte tekst met {{variabelen}}.';
comment on column public.ai_agents.max_emails_per_run is
  'Hard plafond op het aantal klantmails dat één run mag klaarzetten.';

commit;
