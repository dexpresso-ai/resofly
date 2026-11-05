-- ============================================================
-- ResoFly — Financiën: twee hulpfuncties niet voor anon
-- Date: 2026-11-05
--
-- 20261105000000 maakte twee kleine SQL-hulpfuncties: like_contains_pattern
-- (de letterlijke "bevat"-voorwaarde van bankregels) en
-- ledger_reserved_code_purpose (welke rekeningcodes voor systeemrekeningen
-- gereserveerd zijn). Het zijn geen security-definer-functies, en Supabase
-- geeft elke nieuwe functie in public standaard EXECUTE aan anon en
-- authenticated (en Postgres aan PUBLIC). Sinds 20261101000000 heeft anon in
-- public nergens rechten; de rooktest van de uitrol viel er dan ook over.
--
-- ledger_reserved_code_purpose wordt aangeroepen vanuit de trigger op
-- ledger_accounts, en die trigger draait met de rechten van wie schrijft
-- (security invoker): authenticated en service_role houden hem dus.
-- like_contains_pattern draait alleen binnen match_bank_transactions (security
-- definer) en heeft verder niemand nodig dan de server.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

revoke all on function public.like_contains_pattern(text) from public, anon, authenticated;
grant execute on function public.like_contains_pattern(text) to service_role;

revoke all on function public.ledger_reserved_code_purpose(text) from public, anon;
grant execute on function public.ledger_reserved_code_purpose(text) to authenticated, service_role;

commit;
