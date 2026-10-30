-- ============================================================
-- ResoFly — Bankkoppeling: automatisch synchroniseren (Enable Banking)
-- Date: 2026-10-30
--
-- Aanleiding:
-- - Een gekoppelde rekening werd alleen bijgewerkt als iemand op
--   Synchroniseer drukte. In de praktijk gebeurde dat niet: de gekoppelde
--   rekeningen op staging waren sinds de dag van koppelen niet meer gesynct.
--   bank-sync?cron=sync doet het nu zelf, één keer per dag per rekening.
--
-- Ontwerp:
-- - `last_sync_attempt_at`: wanneer we het voor het laatst probeerden, gelukt
--   of niet. De cron neemt de rekening die het langst niet aan de beurt was.
--   last_synced_at (alleen bij succes) kan dat niet: een rekening die steeds
--   mislukt, stond dan elk uur vooraan en verdrong de rest — en kreeg zo veel
--   meer dan de vier onbeheerde opvragingen per dag die PSD2 toestaat.
-- - `last_sync_error`: waarom de laatste poging mislukte. De klant ziet dat op
--   de bankpagina in plaats van alleen in de function-logs; leeg na een
--   geslaagde sync.
-- - bank-sync werkt ook zonder deze kolommen (valt dan terug op alleen
--   last_synced_at), dus de volgorde van uitrollen maakt niet uit. Alleen de
--   cron heeft ze nodig.
-- ============================================================

begin;

alter table public.bank_accounts
  add column if not exists last_sync_attempt_at timestamptz,
  add column if not exists last_sync_error text;

create index if not exists idx_bank_accounts_sync_due
  on public.bank_accounts(last_sync_attempt_at nulls first)
  where source = 'enablebanking' and is_active;

commit;
