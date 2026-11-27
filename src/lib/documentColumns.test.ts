import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOCUMENT_CORE_COLUMNS } from './documentColumns.ts';

// Stap 1A-2: de kern laadt documenten zonder tekst. Komt content of body er
// weer in, dan laadt elke start weer alle tekst van alle documenten mee.
test('de kern laadt geen tekst en geen pagina-inhoud', () => {
  const columns = DOCUMENT_CORE_COLUMNS.split(',');
  assert.ok(!columns.includes('content'), 'content staat in de kern');
  assert.ok(!columns.includes('body'), 'body staat in de kern');
  for (const nodig of ['id', 'title', 'excerpt', 'format', 'parent_id', 'folder_id', 'storage_key', 'updated_at']) {
    assert.ok(columns.includes(nodig), `${nodig} ontbreekt`);
  }
});

test('elke kolom van de kern bestaat in de migraties', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const sql = ['20260604000000_internal_documents.sql', '20260616000002_content_folders.sql', '20260716000000_document_word_mode.sql', '20261127130000_paginas_datamodel.sql']
    .map((name) => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  for (const column of DOCUMENT_CORE_COLUMNS.split(',')) {
    assert.ok(new RegExp(`\\b${column}\\b`).test(sql), `${column} niet gevonden in de migraties van documents`);
  }
});
