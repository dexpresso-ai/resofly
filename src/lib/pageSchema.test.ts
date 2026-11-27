import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PAGE_LINK_PATTERN, PAGE_MARK_TYPES, PAGE_NODE_TYPES, isAllowedPageLink } from './pageSchema.ts';

/**
 * De database keurt een pagina af met een blok of opmaak die niet in
 * public.page_body_allowed() staat. Loopt die lijst uit de pas met
 * src/lib/pageSchema.ts, dan maakt de editor iets wat de database weigert (de
 * gebruiker verliest zijn werk bij opslaan), of de database laat iets toe wat
 * de weergave niet kent. Deze test leest de laatste migratie die de functie
 * definieert en legt de lijsten naast elkaar.
 */
function latestAllowedSql(): string {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const sql = readdirSync(dir)
    .filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort().reverse()
    .map((name) => readFileSync(new URL(name, dir), 'utf8'))
    .find((text) => text.includes('create or replace function public.page_body_allowed()'));
  assert.ok(sql, 'geen migratie met page_body_allowed gevonden');
  const start = sql.indexOf('create or replace function public.page_body_allowed()');
  return sql.slice(start, sql.indexOf('$$;', start));
}

const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('de bloktypen in de editor zijn die van de database', () => {
  const sql = latestAllowedSql();
  const nodes = sql.slice(sql.indexOf("'nodes'"), sql.indexOf("'marks'"));
  assert.deepEqual(quoted(nodes).filter((name) => name !== 'nodes'), [...PAGE_NODE_TYPES]);
});

test('de opmaak en de linkregel zijn die van de database', () => {
  const sql = latestAllowedSql();
  const marks = sql.slice(sql.indexOf("'marks'"), sql.indexOf("'link_pattern'"));
  assert.deepEqual(quoted(marks).filter((name) => name !== 'marks'), [...PAGE_MARK_TYPES]);
  assert.ok(sql.includes(`'link_pattern', '${PAGE_LINK_PATTERN}'`), 'de linkregel verschilt');
});

test('links: https, http, mailto, tel en intern mogen; javascript en data niet', () => {
  for (const ok of ['https://resofly.nl', 'http://voorbeeld.nl', 'mailto:jan@voorbeeld.nl', 'tel:+31612345678', '/app/documenten', '#kop']) {
    assert.ok(isAllowedPageLink(ok), ok);
  }
  for (const nee of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '']) {
    assert.ok(!isAllowedPageLink(nee), nee);
  }
});
