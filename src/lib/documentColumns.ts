// ============================================================
// Wat de app bij het opstarten van een document laadt (stap 1A-2 van
// docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md, §6).
//
// Zonder de tekst (content) en zonder de inhoud van een pagina (body). Die
// konden samen honderden kB per document zijn, en de kern laadt bij elke start
// en na elke wijziging. De tekst van één document haal je op als je het
// opent (loadContentHtml), en zoeken in de tekst doet de database
// (search_documents). Voor tegels en lijsten is er excerpt: de eerste 200
// tekens, zonder HTML, die de database zelf bijhoudt.
//
// documentColumns.test.ts bewaakt dat content en body er niet in komen.
// ============================================================

export const DOCUMENT_CORE_COLUMNS = [
  'id', 'organization_id', 'created_by', 'client_id', 'project_id', 'folder_id',
  'title', 'document_type', 'created_at', 'updated_at',
  'storage_key', 'mime_type', 'size_bytes', 'edit_version', 'last_edited_by', 'last_edited_at',
  'format', 'parent_id', 'position', 'icon', 'cover', 'full_width', 'excerpt', 'archived_at', 'archived_by',
].join(',');
