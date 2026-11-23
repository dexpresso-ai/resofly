-- Openstaand na een deelbetaling: het dashboard en de klantpagina tellen wat
-- er van een verstuurde factuur nog openstaat, niet het volle factuurbedrag.
--
-- Waarom: Vandaag ("Openstaand", "Te laat betaald"), de stroom en de klantpagina
-- telden het factuurtotaal van elke verstuurde factuur. Een factuur van
-- € 1.210 waarvan € 400 betaald was, stond er zo voor € 1.210, terwijl het
-- grootboek (Openstaande posten) en Gerrie € 810 zeiden (controle uren van
-- 22 november, bevinding 4). Een deelcreditnota ging er ook niet af.
--
-- De app laadt de betalingen zelf niet bij het opstarten: die zitten in de
-- groepen financeHistory en bank (src/lib/dataGroups.ts), en tests/laden
-- bewaakt dat de kern ze niet ophaalt. Deze functie geeft daarom per
-- verstuurde, geboekte factuur alleen het openstaande bedrag, met dezelfde
-- som als de rest van de database: invoice_open_receivable_cents (geboekt min
-- bank, Mollie en creditnota's).
--
-- Een factuur zonder boeking (een organisatie zonder rekeningschema) staat er
-- niet in; daar telt de app het factuurbedrag, zoals voorheen.
--
-- Rechten zoals bank_transactions_to_reconcile: één keer gecontroleerd, lezen
-- in de organisatie én de module Financiën. Zonder dat recht geen rijen en geen
-- fout (anders dan list_filed_vat_periods, die een fout geeft): de kern roept
-- deze functie bij elk opstarten aan, ook voor een teamlid zonder Financiën,
-- en de werkruimte mag er niet op stuklopen. Zo'n teamlid ziet de bedragen
-- toch niet. Een andere organisatie geeft om dezelfde reden niets.
--
-- Bestaande gegevens veranderen niet; de functie leest alleen.
-- Veilig om opnieuw te draaien (create or replace).

create or replace function public.list_open_invoice_amounts(p_organization_id uuid)
returns table(invoice_id uuid, open_cents bigint)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    return;
  end if;
  return query
    select i.id, coalesce(public.invoice_open_receivable_cents(p_organization_id, i.id), 0)::bigint
    from public.invoices i
    where i.organization_id = p_organization_id
      and i.status in ('sent', 'overdue')
      and i.journal_entry_id is not null;
end;
$function$;

comment on function public.list_open_invoice_amounts(uuid) is
  'Per verstuurde, geboekte factuur het openstaande bedrag in centen (invoice_open_receivable_cents), voor het dashboard en de klantpagina. Zonder leesrecht op Financiën: geen rijen.';

revoke all on function public.list_open_invoice_amounts(uuid) from public, anon;
grant execute on function public.list_open_invoice_amounts(uuid) to authenticated, service_role;
