import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { CALLOUT_VARIANTS, MENTION_KINDS, PAGE_LINK_PATTERN, PAGE_MARK_TYPES, PAGE_NODE_TYPES, TABLE_CELL_ALIGNS, calloutVariant, isAllowedPageLink, mentionKind } from './pageSchema.ts';

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

// Stap 1A-4a: de database kijkt ook wat er in een callout en een tabelcel
// staat. Een soort die de app wel kent en de database niet, gaat verloren bij
// opslaan; andersom komt er een stijl op de pagina die de app niet bedoelde.
test('de soorten callout en het uitlijnen in een cel zijn die van de database', () => {
  const sql = latestAllowedSql();
  const variants = sql.slice(sql.indexOf("'callout_variants'"), sql.indexOf("'cell_aligns'"));
  assert.deepEqual(quoted(variants).filter((name) => name !== 'callout_variants'), [...CALLOUT_VARIANTS]);
  const aligns = sql.slice(sql.indexOf("'cell_aligns'"));
  assert.deepEqual(quoted(aligns).filter((name) => name !== 'cell_aligns'), [...TABLE_CELL_ALIGNS]);
});

// Stap 2-1a: de soorten @-vermelding. Kent de app een soort die de database
// niet kent, dan mislukt opslaan; andersom toont de app er niets bij.
test('de soorten @-vermelding zijn die van de database', () => {
  const sql = latestAllowedSql();
  const kinds = sql.slice(sql.indexOf("'mention_kinds'"), sql.indexOf("'callout_variants'"));
  assert.deepEqual(quoted(kinds).filter((name) => name !== 'mention_kinds'), [...MENTION_KINDS]);
  assert.equal(mentionKind('invoice'), 'invoice');
  for (const value of ['', 'Client', 'leverancier', null, 3]) assert.equal(mentionKind(value), null);
});

test('een onbekende soort callout wordt info', () => {
  assert.equal(calloutVariant('tip'), 'tip');
  assert.equal(calloutVariant('let-op'), 'let-op');
  for (const value of ['', 'INFO', 'red; background: url(x)', null, undefined, 3]) assert.equal(calloutVariant(value), 'info');
});

test('links: https, http, mailto, tel en intern mogen; javascript en data niet', () => {
  for (const ok of ['https://resofly.nl', 'http://voorbeeld.nl', 'mailto:jan@voorbeeld.nl', 'tel:+31612345678', '/app/documenten', '#kop']) {
    assert.ok(isAllowedPageLink(ok), ok);
  }
  for (const nee of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '']) {
    assert.ok(!isAllowedPageLink(nee), nee);
  }
});
