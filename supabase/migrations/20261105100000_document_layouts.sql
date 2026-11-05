-- ============================================================
-- ResoFly — Eigen opmaak voor offertes en facturen
-- Date: 2026-11-05
--
-- Aanleiding:
-- - Een organisatie kan de velden van een offerte en factuur nu zelf op de
--   pagina slepen (Instellingen → Documentopmaak). Die opmaak moet ergens
--   staan, en de edge functions die de verstuurde PDF maken moeten hem lezen.
--
-- Ontwerp:
-- - Eén jsonb-kolom op company_settings: { version, font, invoice, quote }.
--   `null` (of een ontbrekende soort) = de standaardopmaak van ResoFly. Zo
--   verandert er voor wie niets instelt niets aan de opslag.
-- - Bewust op company_settings en niet in een eigen tabel: de opmaak hoort bij
--   de organisatie zoals het briefpapier en de merkkleur, en valt zo onder de
--   policies die er al zijn (lezen: leden; wijzigen: owners en admins).
-- - De database bewaakt alleen dat het een object is en hoe groot het is. De
--   inhoud keurt de code, bij het opslaan én bij het tekenen
--   (normalizeDocumentLayout in src/lib/documentLayout.ts en zijn spiegel in
--   supabase/functions/_shared/): wat uit de database komt, wordt nooit
--   blind getekend.
-- - 256 kB is ruim boven het grootste wat de editor kan maken (60 blokken van
--   600 tekens, twee keer; ~110 kB in UTF-8, zie documentLayout.test.ts) en
--   houdt een rij die bij elke factuur-PDF wordt gelezen klein.
--
-- Veilig opnieuw te draaien.
-- ============================================================

begin;

alter table public.company_settings
  add column if not exists document_layouts jsonb;

alter table public.company_settings
  drop constraint if exists company_settings_document_layouts_check;

alter table public.company_settings
  add constraint company_settings_document_layouts_check check (
    document_layouts is null
    or (
      jsonb_typeof(document_layouts) = 'object'
      and pg_column_size(document_layouts) <= 262144
    )
  );

comment on column public.company_settings.document_layouts is
  'Eigen opmaak van offertes en facturen: { version, font, invoice, quote }. null = de standaardopmaak. Gekeurd door normalizeDocumentLayout (src/lib/documentLayout.ts) bij opslaan en bij het tekenen van de PDF.';

commit;
