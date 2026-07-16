-- ============================================================
-- ResoFly — Online Office-bewerken: edit-state op attachments
-- Date: 2026-07-15
--
-- Scope:
-- - Office-bestanden (.docx/.xlsx/.pptx e.d.) worden binnen "Bestanden"
--   rechtstreeks in de browser bewerkt via een zelf-gehoste OnlyOffice
--   Document Server (op Cloudflare Containers). Het canonieke bestand blijft
--   op Cloudflare R2; de Document Server haalt het op en schrijft de bewerkte
--   versie terug naar dezelfde storage_key.
-- - Zulke bestanden zijn gewone `attachments` met `entity_type = 'folder'` en
--   een office-mimetype. De entity_type-CHECK en de integriteitstrigger blijven
--   dus ongemoeid — dit zijn geen nieuwe entity-typen.
-- - Deze migratie voegt alleen edit-state toe: een oplopend versienummer (drijft
--   de OnlyOffice document-key + cache-invalidatie), wie het bestand het laatst
--   bewerkte, en een zachte "wordt nu bewerkt door"-markering voor de UI.
--
-- Beveiliging:
-- - Geen nieuwe RLS-policies nodig: de kolommen erven de bestaande
--   attachments-row-policies. De media-api Worker werkt deze velden server-side
--   bij met de service-role (na verificatie van het edit-token), net zoals de
--   bestaande bijlage-routes.
-- ============================================================

begin;

alter table public.attachments
  add column if not exists edit_version integer not null default 1;

-- Wie/heeft-wanneer het bestand het laatst via de online editor opgeslagen.
alter table public.attachments
  add column if not exists last_edited_by uuid references auth.users(id) on delete set null;
alter table public.attachments
  add column if not exists last_edited_at timestamptz;

-- Zachte lock: gezet wanneer een bewerksessie opent, gewist wanneer ze sluit.
-- Puur informatief voor de UI ("wordt bewerkt door …"); OnlyOffice zelf regelt
-- gelijktijdig co-editen, dus dit blokkeert niet hard.
alter table public.attachments
  add column if not exists locked_by uuid references auth.users(id) on delete set null;
alter table public.attachments
  add column if not exists locked_at timestamptz;

commit;
