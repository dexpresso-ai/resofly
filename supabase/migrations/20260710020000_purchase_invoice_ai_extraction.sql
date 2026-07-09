-- ============================================================
-- Inkoopfacturen: herkomst + AI-extractie-metadata.
--
-- Voor de AI-inkoopfactuurherkenning ("Factuur scannen"): we leggen vast of een
-- inkoopfactuur handmatig is ingevoerd of door de AI is uitgelezen, plus de ruwe
-- extractie (model, confidence, uitgelezen velden, tijdstip). Puur additief en
-- backward-compatible: bestaande rijen krijgen source='manual'.
--
-- Er komt GEEN nieuwe boekingslogica bij: de AI vult enkel het bestaande
-- concept-inkoopfactuurformulier voor; boeken loopt gewoon via
-- book_purchase_invoice (voorstel -> mens bevestigt -> boeken).
-- ============================================================

alter table public.purchase_invoices
  add column if not exists source text not null default 'manual',
  add column if not exists extraction_meta jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'purchase_invoices_source_check'
  ) then
    alter table public.purchase_invoices
      add constraint purchase_invoices_source_check
      check (source in ('manual', 'ai_scan', 'bank', 'import'));
  end if;
end $$;

comment on column public.purchase_invoices.source is
  'Herkomst van de inkoopfactuur: manual (handmatig ingevoerd), ai_scan (door AI uitgelezen), bank, import.';
comment on column public.purchase_invoices.extraction_meta is
  'AI-extractie-metadata (model, confidence, ruwe uitlezing, tijdstip) — alleen gevuld bij source=ai_scan.';
