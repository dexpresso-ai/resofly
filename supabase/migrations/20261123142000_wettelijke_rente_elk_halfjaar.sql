-- ============================================================================
-- Wettelijke rente: elk halfjaar een regel, ook als het tarief gelijk blijft
-- ============================================================================
-- De wettelijke rente (consumenten) en de handelsrente kunnen per 1 januari en
-- per 1 juli veranderen. De aanmaning rekent per halfjaar met het tarief uit
-- statutory_interest_rates, en het laatste tarief gold voor altijd. Bij de
-- controle van de jaarwissel (22 november 2026) bleek: na 1 januari 2027
-- rekent een aanmaning stil door met het tarief van 2026, en niets herinnert
-- eraan dat de tabel bij moet.
--
-- Vanaf nu zegt de laatste regel per soort tot welk halfjaar de tabel is
-- nagelopen:
-- - invoice-workflow zet een waarschuwing in het aanmaningsvoorstel als de
--   rekendatum in een later halfjaar valt (_shared/dunning.ts, staleRate);
-- - dunning.test.ts faalt als de migraties twee weken na het begin van een
--   halfjaar nog geen regel voor dat halfjaar hebben.
--
-- Dat werkt alleen als er ook een regel komt wanneer het tarief NIET
-- verandert. Voor de wettelijke rente ontbrak die voor 1 juli 2026: het tarief
-- bleef 4% (KCBR-informatieblad wettelijke rente, juli 2026: 4% sinds
-- 1 januari 2026; nagelopen op 22 november 2026). Aan de berekening verandert
-- daardoor niets.
--
-- De tarieven per 1 januari 2027 staan er bewust NIET in: op 22 november 2026
-- waren ze niet bekend. De wettelijke rente wordt in december in het
-- Staatsblad vastgesteld, de handelsrente volgt uit de rente van de ECB op
-- 1 januari. Voeg ze toe met een nieuwe migratie zodra ze er zijn, één regel
-- per soort, met de bron in source_note.
--
-- Veilig om opnieuw te draaien.

insert into public.statutory_interest_rates (kind, rate_basis_points, valid_from, source_note) values
  ('consumer', 400, '2026-07-01', 'Wettelijke rente 4% (ongewijzigd) — geverifieerd 2026-11-22 (KCBR-informatieblad juli 2026)')
on conflict (kind, valid_from) do nothing;
