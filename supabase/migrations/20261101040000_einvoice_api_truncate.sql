-- ============================================================
-- ResoFly — E-factuuradres via de API, en geen TRUNCATE voor de app
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md):
--
--   1. WAAR FACTUREN HEEN GAAN. Met een API-sleutel op toegangsniveau
--      "execute" kon een koppeling het e-factuuradres en het kanaal van een
--      klant wijzigen; elke volgende factuur (PDF en UBL) ging dan naar dat
--      adres. Het e-mailadres van een klant vroeg al "execute_high" (het
--      bepaalt wie in het portaal kan); het e-factuuradres is net zo goed
--      "naar buiten". api_rest_write zet resofly.portal_notify = 'quiet' als
--      een sleutel NIET naar buiten mag; deze trigger weigert dan een
--      wijziging van de e-factuurvelden. (Gerrie, MCP en de API-handelingen
--      zetten zo'n wijziging sinds deze ronde op hoog risico: langs een mens.)
--   2. TRUNCATE. Supabase geeft authenticated TRUNCATE op elke tabel. RLS
--      geldt daar niet voor. PostgREST kan het niet uitvoeren en geen functie
--      in de app doet het, maar het hoort er niet: weg, ook voor nieuwe tabellen.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. E-factuurvelden via de API alleen met "execute_high" ───────────────

create or replace function public.clients_einvoice_outward_guard()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('resofly.portal_notify', true), '') <> 'quiet' then
    return new;
  end if;
  if (tg_op = 'INSERT' and (coalesce(new.e_invoicing_enabled, false) or new.e_invoice_email is not null))
     or (tg_op = 'UPDATE' and (
          new.e_invoicing_enabled is distinct from old.e_invoicing_enabled
          or lower(coalesce(new.e_invoice_email, '')) is distinct from lower(coalesce(old.e_invoice_email, ''))
          or new.e_invoice_channel is distinct from old.e_invoice_channel)) then
    raise exception 'Het e-factuuradres en het kanaal bepalen waar de facturen van een klant heen gaan. Wijzigen via de API vraagt toegangsniveau "execute_high".'
      using errcode = 'RS403';
  end if;
  return new;
end;
$$;

revoke all on function public.clients_einvoice_outward_guard() from public, anon, authenticated;

drop trigger if exists clients_einvoice_outward_guard on public.clients;
create trigger clients_einvoice_outward_guard
  before insert or update on public.clients
  for each row execute function public.clients_einvoice_outward_guard();

-- ── 2. Geen TRUNCATE voor de app ───────────────────────────────────────────

revoke truncate on all tables in schema public from authenticated;
alter default privileges for role postgres in schema public revoke truncate on tables from authenticated;

commit;
