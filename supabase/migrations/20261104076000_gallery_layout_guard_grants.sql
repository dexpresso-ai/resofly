-- ============================================================
-- ResoFly — Galerij: de triggerfunctie van de weergave dicht voor anon
-- Date: 2026-11-04
--
-- Aanleiding:
-- - 20261104075000_gallery_layout.sql maakte public.enforce_gallery_layout_guard()
--   zonder de revoke die elke nieuwe functie sinds 20261101000000 krijgt.
--   Postgres geeft een nieuwe functie EXECUTE aan PUBLIC; de default privileges
--   uit 20261101000000 halen alleen de directe grant aan anon weg, niet die via
--   PUBLIC. De rooktest na de uitrol op staging zag het meteen: "anon heeft weer
--   rechten op: functie enforce_gallery_layout_guard()".
-- - Onschuldig — een triggerfunctie is niet los aan te roepen — maar de lijn is:
--   anon heeft in public nergens rechten. Zelfde regel als bij de andere
--   triggerfuncties (zie 20261104030000): dicht voor public, anon en
--   authenticated. Een trigger vuurt ongeacht EXECUTE-rechten; lokaal
--   nagelopen: als authenticated wordt een geldige weergave bewaard en een
--   foute geweigerd.
-- - Bewust een eigen migratie en niet een aanpassing van 20261104075000: die is
--   op staging al toegepast en zou daar niet opnieuw draaien.
-- - Voortaan bewaakt migrationGrants.test.ts dit ook voor triggerfuncties.
-- ============================================================

begin;

revoke all on function public.enforce_gallery_layout_guard() from public, anon, authenticated;

commit;
