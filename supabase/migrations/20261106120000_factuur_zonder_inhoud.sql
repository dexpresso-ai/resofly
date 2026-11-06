-- ============================================================
-- Een factuur zonder inhoud gaat niet de deur uit (6 november 2026).
--
-- Gevonden bij de zekerheidstest: wie op "Versturen" klikte bij een lege
-- conceptfactuur (geen regels, of alleen een lege regel), stuurde de klant een
-- factuur van € 0 en verbruikte een factuurnummer. De database liet ook toe
-- dat een factuur zonder regels rechtstreeks (via de API) op 'sent' kwam.
--
-- Nu weigert de database het uitgeven (concept -> verstuurd, te laat of
-- betaald, of meteen zo aanmaken) als geen enkele regel een omschrijving of
-- een bedrag heeft. invoice-workflow weigert al vóór het mailen, met dezelfde
-- regel; de status gaat daar pas ná het mailen op 'sent', dus anders ging de
-- mail eerst de deur uit. Annuleren of wissen van een leeg concept mag gewoon.
--
-- Op staging staat geen enkele verstuurde factuur zonder regels.
-- Veilig opnieuw te draaien.
-- ============================================================

begin;

create or replace function public.enforce_invoice_has_content()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.status not in ('sent', 'overdue', 'paid') then return new; end if;
  -- Alleen op het moment van uitgeven: een factuur die al uit is, ligt vast.
  if tg_op = 'UPDATE' and old.status is distinct from 'draft' then return new; end if;
  if new.lines is not null and jsonb_typeof(new.lines) = 'array' and exists (
    select 1 from jsonb_array_elements(new.lines) l
    where jsonb_typeof(l) = 'object'
      and (nullif(btrim(coalesce(l->>'description', '')), '') is not null
           -- Zonder cast-fout: een aantal of prijs die geen getal is, meldt
           -- invoices_lines_numeric al (die trigger komt alfabetisch eerder).
           or (case when coalesce(l->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'quantity')::numeric else 0 end)
              * (case when coalesce(l->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'unit_price')::numeric else 0 end) <> 0)
  ) then
    return new;
  end if;
  raise exception 'Factuur % heeft nog geen regels. Zet erin wat je factureert voordat je hem verstuurt.', coalesce(new.number, '')
    using errcode = '23514';
end;
$function$;

-- De naam komt alfabetisch ná invoices_lines_numeric, zodat die eerst de getallen controleert.
drop trigger if exists invoices_lines_present on public.invoices;
create trigger invoices_lines_present
  before insert or update of status, lines on public.invoices
  for each row execute function public.enforce_invoice_has_content();

-- Een triggerfunctie vuurt ook zonder EXECUTE (migrationGrants.test.ts).
revoke all on function public.enforce_invoice_has_content() from public, anon, authenticated;

commit;
