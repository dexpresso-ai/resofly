-- ============================================================
-- ResoFly — Een nieuwe database krijgt wat staging met de hand kreeg
-- Date: 2026-11-04
--
-- Een database die vanaf nul uit de migraties wordt opgebouwd, is vergeleken
-- met staging: tabellen, kolommen, constraints, indexen, functies, triggers,
-- policies, rechten en de referentiedata. Op twee punten week staging af,
-- omdat daar ooit in de SQL-editor iets is gerepareerd zonder migratie. Die
-- reparaties staan nu hier, zodat een nieuwe database (productie, een
-- testomgeving) hetzelfde krijgt.
--
-- Op staging verandert er niets: de functie is daar al precies zo, en de
-- prijzen worden alleen gezet waar ze nog 0 zijn.
--
-- 1. invoice_token_hash. digest() staat in het schema `extensions`. De versie
--    uit 20260526000000 noemt hem zonder schema en heeft geen eigen
--    search_path, dus vanuit een security-definer-functie met
--    `search_path = public` (zoals resolve_invoice_public_link) faalt hij:
--    "function digest(text, unknown) does not exist ... during inlining".
--    Staging kreeg daarom deze versie.
-- 2. De jaarprijzen van de abonnementen. 20260626000002 voegde de kolommen toe
--    met 0, en 0 betekent: geen jaarabonnement (billing/index.ts weigert het,
--    Instellingen toont de keuze niet). Op staging zijn ze daarna met de hand
--    gezet op twaalf keer de maandprijs.
-- ============================================================

begin;

create or replace function public.invoice_token_hash(p_token text)
returns text
language sql
immutable
set search_path to 'public', 'extensions'
as $function$
  select encode(
    extensions.digest(coalesce(p_token, '')::text, 'sha256'::text),
    'hex'
  );
$function$;

update public.billing_plans as plan
   set yearly_price_cents = prices.yearly_price_cents,
       extra_seat_yearly_price_cents = prices.extra_seat_yearly_price_cents
  from (values
    ('starter', 18000, 10800),
    ('team', 46800, 9600),
    ('pro', 118800, 8400)
  ) as prices(plan_key, yearly_price_cents, extra_seat_yearly_price_cents)
 where plan.plan_key = prices.plan_key
   and plan.yearly_price_cents = 0
   and plan.extra_seat_yearly_price_cents = 0;

commit;
