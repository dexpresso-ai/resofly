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

-- rls_auto_enable en de event-trigger ensure_rls komen uit het Supabase-dashboard
-- ("Enable RLS automatically on new tables"), niet uit een migratie: op staging
-- stonden ze er al. Op een nieuwe database bestonden ze dan niet, en liep de
-- revoke hieronder stuk. Daarom hier dezelfde functie en trigger, letterlijk
-- zoals op staging (pg_get_functiondef); bestaan ze al, dan verandert er niets.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

do $$
begin
  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls on ddl_command_end
      when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      execute function public.rls_auto_enable();
  end if;
end $$;

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
