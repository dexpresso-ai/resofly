-- ============================================================
-- ResoFly — "Word-modus" voor interne Documents
-- Date: 2026-07-16
--
-- Scope:
-- - Een `documents`-rij kan nu óf rich-text (HTML in `content`, zoals altijd) óf een
--   Word-document (.docx op Cloudflare R2, bewerkt via Collabora/WOPI) zijn.
-- - `storage_key IS NULL`  → rich-text document (RichTextEditor).
-- - `storage_key IS NOT NULL` → Word-document; de bytes staan op R2, `content` bewaart een
--   platte-tekst/HTML-spiegel puur voor previews (excerpts) en de client-side zoekfunctie.
-- - Deze migratie voegt alleen kolommen toe; bestaande rich-text-documenten blijven
--   ongewijzigd (storage_key = NULL).
--
-- Beveiliging:
-- - Geen nieuwe RLS-policies: de kolommen erven de bestaande documents-row-policies. De
--   media-api Worker werkt versie/size server-side bij met de service-role (na verificatie
--   van het WOPI-edit-token), net als bij attachments.
-- ============================================================

begin;

alter table public.documents
  add column if not exists storage_key text;
alter table public.documents
  add column if not exists mime_type text;
alter table public.documents
  add column if not exists size_bytes integer;
alter table public.documents
  add column if not exists edit_version integer not null default 1;
alter table public.documents
  add column if not exists last_edited_by uuid references auth.users(id) on delete set null;
alter table public.documents
  add column if not exists last_edited_at timestamptz;

commit;
