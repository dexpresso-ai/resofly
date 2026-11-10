import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// De bouwstenen van het kader waarin een rapportage van Gerrie draait
// (public/rapport-weergave.html). Het script draait hier in een eigen context,
// zonder kader eromheen: dan start het niets op en staat alleen window.RF klaar.
// Getoetst wordt wat een fout getal kan opleveren: opmaak, optellen in centen,
// perioden opvullen, groeperen en de hoofdlijst van een dataset vinden.

type RfApi = Record<string, (...args: unknown[]) => unknown> & { data: Record<string, unknown> };

function loadRf(): RfApi {
  const html = readFileSync(new URL('../../public/rapport-weergave.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'het kader hoort precies één eigen script te hebben');
  const noop = () => undefined;
  const element = { scrollHeight: 0, appendChild: noop, insertBefore: noop, classList: { add: noop, remove: noop } };
  const document = {
    getElementById: () => element, documentElement: { setAttribute: noop, style: { setProperty: noop }, clientWidth: 800 },
    querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ ...element }), body: element,
  };
  const window: Record<string, unknown> = { addEventListener: noop, requestAnimationFrame: noop, setTimeout: noop };
  window.parent = window;
  vm.runInNewContext(scripts[0], { window, document });
  return window.RF as RfApi;
}

const RF = loadRf();
// Intl zet een vaste spatie tussen € en het bedrag; voor de vergelijking maakt dat niet uit.
const s = (v: unknown) => String(v).replace(/\s/g, ' ');
// Wat uit de context van het kader komt, heeft daar zijn eigen Array en Object; vergelijk de inhoud.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test('Nederlandse opmaak van bedragen, getallen, procenten en datums', () => {
  assert.equal(s(RF.euro(1234.5)), '€ 1.234,50');
  assert.equal(s(RF.euro(-12)), '€ -12,00');
  assert.equal(s(RF.euro(99.999, { decimals: 0 })), '€ 100');
  assert.equal(RF.euro(null), '—');
  assert.equal(RF.num(1234567), '1.234.567');
  assert.equal(RF.num(2.345, 1), '2,3');
  assert.equal(s(RF.pct(0.123)), '12,3%');
  assert.equal(RF.date('2026-03-09'), '9 mrt 2026');
  assert.equal(RF.month('2026-03'), 'mrt 2026');
  assert.equal(RF.month('2026-Q2'), 'Q2 2026');
  assert.equal(RF.duration(195), '3u 15m');
  assert.equal(RF.duration(45), '45m');
  assert.equal(RF.hours(12.5), '12,5 u');
  assert.equal(RF.esc('<b>"Jansen" & Zn</b>'), '&lt;b&gt;&quot;Jansen&quot; &amp; Zn&lt;/b&gt;');
});

test('optellen in centen: geen 0,30000000000000004', () => {
  assert.equal(RF.sum([{ v: 0.1 }, { v: 0.2 }], 'v'), 0.3);
  assert.equal(RF.sum([{ a: { b: 1.15 } }, { a: { b: 2.2 } }], 'a.b'), 3.35);
  assert.equal(RF.avg([{ v: 1 }, { v: null }, { v: 3 }], 'v'), 2);
  assert.equal(RF.count([{ ok: true }, { ok: false }], (r: { ok: boolean }) => r.ok), 1);
  assert.equal(RF.change(110, 100), 0.1);
  assert.equal(RF.change(5, 0), null);
});

test('een tijdreeks vult lege maanden met 0', () => {
  const rows = [{ datum: '2026-01-15', bedrag: 100 }, { datum: '2026-03-02', bedrag: 50 }, { datum: '2026-03-30', bedrag: 25 }];
  assert.deepEqual(plain(RF.series(rows, 'datum', 'bedrag', { period: 'month', from: '2026-01-01', to: '2026-04-30' })), [
    { key: '2026-01', label: 'jan 2026', value: 100 },
    { key: '2026-02', label: 'feb 2026', value: 0 },
    { key: '2026-03', label: 'mrt 2026', value: 75 },
    { key: '2026-04', label: 'apr 2026', value: 0 },
  ]);
  const weeks = RF.series(rows, 'datum', null, { period: 'quarter', agg: 'count' }) as Array<{ key: string; value: number }>;
  assert.deepEqual(plain(weeks.map((w) => [w.key, w.value])), [['2026-Q1', 3]]);
});

test('groeperen: grootste eerst, de rest als Overig', () => {
  const rows = [{ k: 'a', v: 1 }, { k: 'b', v: 5 }, { k: 'c', v: 3 }, { k: 'd', v: 2 }];
  const top = RF.rollup(rows, 'k', 'v', { limit: 2 }) as Array<{ label: string; value: number }>;
  assert.deepEqual(plain(top.map((r) => [r.label, r.value])), [['b', 5], ['c', 3], ['Overig', 3]]);
  assert.deepEqual(plain((RF.top(rows, 1, 'v') as Array<{ k: string }>).map((r) => r.k)), ['b']);
});

test('de hoofdlijst van een dataset, welke vorm de bron ook heeft', () => {
  RF.data.groepen = { groups: [{ a: 1 }], totals: { a: 1 } };
  RF.data.facturen = { count: 2, invoices: [{ n: 1 }, { n: 2 }] };
  RF.data.lijst = [{ x: 1 }];
  RF.data.mislukt = null;
  assert.equal((RF.rows('groepen') as unknown[]).length, 1);
  assert.equal((RF.rows('facturen') as unknown[]).length, 2);
  assert.equal((RF.rows('lijst') as unknown[]).length, 1);
  assert.deepEqual(plain(RF.rows('mislukt')), []);
  assert.deepEqual(plain(RF.totals('groepen')), { a: 1 });
  assert.deepEqual(plain(RF.totals('facturen')), {});
});

test('het kader zelf: sandbox-CSP zonder netwerk, en de app lijst het in zonder eigen herkomst', () => {
  const html = readFileSync(new URL('../../public/rapport-weergave.html', import.meta.url), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*('self'|https?:)/);
  const frame = readFileSync(new URL('../components/ReportFrame.tsx', import.meta.url), 'utf8');
  // Het attribuut zelf (niet het commentaar erboven): precies allow-scripts, niets meer.
  const sandboxes = [...frame.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(sandboxes.length > 0, 'geen sandbox-attribuut');
  assert.deepEqual([...new Set(sandboxes)], ['allow-scripts']);
});
