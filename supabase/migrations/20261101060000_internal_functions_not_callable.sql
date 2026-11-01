-- ============================================================
-- ResoFly — Interne functies niet meer rechtstreeks aan te roepen
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt U).
--
-- Van de 131 security-definer-functies die elke ingelogde gebruiker via
-- /rest/v1/rpc kan aanroepen, controleerden deze acht niet wie er belt.
-- Ze zijn bedoeld als bouwsteen binnen andere functies (die als eigenaar
-- draaien), niet voor de browser. De app, de edge functions en de workers
-- roepen ze nergens rechtstreeks aan.
--   - book_invoice_payment, ensure_sales_invoice_booked: boeken in het
--     grootboek van elke organisatie waarvan je de ids kent, met een zelf
--     gekozen p_created_by. (De module-gate op de financiële tabellen hield
--     een niet-lid al tegen; dit is het tweede slot.)
--   - expire_stale_organization_invitations: uitnodigingen van elke
--     organisatie op verlopen zetten.
--   - first_open_booking_date, org_creative_in_grace: lezen over een andere
--     organisatie.
--   - company_size_class_for_year, company_size_evaluate_year: rekenhulpen.
--   - rls_auto_enable: een event-trigger, nooit voor de app.
--
-- Niet op deze lijst, met opzet: org_has_creative en
-- organization_reserved_license_count. Die staan in RLS-policies en in
-- triggers die als de gebruiker draaien, en moeten dus aanroepbaar blijven.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

revoke all on function public.book_invoice_payment(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.ensure_sales_invoice_booked(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.expire_stale_organization_invitations(uuid) from public, anon, authenticated;
revoke all on function public.first_open_booking_date(uuid, date) from public, anon, authenticated;
revoke all on function public.org_creative_in_grace(uuid) from public, anon, authenticated;
revoke all on function public.company_size_class_for_year(integer, bigint, bigint, numeric, boolean) from public, anon, authenticated;
revoke all on function public.company_size_evaluate_year(integer, bigint, bigint, numeric, boolean) from public, anon, authenticated;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;

grant execute on function public.book_invoice_payment(uuid, uuid, uuid) to service_role;
grant execute on function public.ensure_sales_invoice_booked(uuid, uuid, uuid) to service_role;
grant execute on function public.expire_stale_organization_invitations(uuid) to service_role;
grant execute on function public.first_open_booking_date(uuid, date) to service_role;
grant execute on function public.org_creative_in_grace(uuid) to service_role;
grant execute on function public.company_size_class_for_year(integer, bigint, bigint, numeric, boolean) to service_role;
grant execute on function public.company_size_evaluate_year(integer, bigint, bigint, numeric, boolean) to service_role;

commit;
