import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, parseDutchAmount, parseDutchAmountCents } from './money.ts';
import { amountToCents, normalizeDate } from './bankImport/dedup.ts';
import { parseCsv } from './bankImport/csv.ts';
import { parseMt940 } from './bankImport/mt940.ts';
import { parseCamt053 } from './bankImport/camt053.ts';

/**
 * Zekerheidstest (6 november 2026): de rekenregels en de bankbestandlezers
 * met duizenden willekeurige invoeren. Een vaste startwaarde, zodat een fout
 * altijd terugkomt. Wat moet:
 * - een bedrag zoals een mens het typt, komt er precies zo uit;
 * - onzin geeft null of een nette foutmelding, nooit NaN, Infinity of een crash;
 * - subtotaal + btw = totaal, op de cent;
 * - een bankbestand met rommel gooit hooguit een Error met uitleg, geen TypeError.
 */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = '0123456789.,-+€ ()eE/\\:;"\'abcxyzé\t\n −٣';
function garbage(next: () => number, max = 12): string {
  const n = Math.floor(next() * max);
  let s = '';
  for (let i = 0; i < n; i += 1) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return s;
}

const nlThousands = (cents: number) => new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);

test('bedragen zoals een mens ze typt: altijd precies terug', () => {
  const next = rng(20261106);
  for (let i = 0; i < 4000; i += 1) {
    const cents = Math.round((next() - 0.5) * 2 * 1e9);
    const abs = Math.abs(cents);
    const sign = cents < 0 ? '-' : '';
    const euros = Math.trunc(abs / 100);
    const rest = String(abs % 100).padStart(2, '0');
    const forms = [
      sign + nlThousands(abs),                      // -1.234.567,89
      `${sign}${euros},${rest}`,                    // -1234567,89
      `${sign}${euros}.${rest}`,                    // -1234567.89 (twee decimalen: geen duizendtal)
      `€ ${sign}${nlThousands(abs)}`,               // € -1.234,56
      `${nlThousands(abs)}${cents < 0 ? '-' : ''}`, // 1.234,56- (bankstijl)
    ];
    for (const form of forms) {
      assert.equal(parseDutchAmountCents(form), cents, `"${form}"`);
    }
  }
});

test('onzin als bedrag: null of een eindig getal, nooit NaN of een crash', () => {
  const next = rng(42);
  for (let i = 0; i < 20000; i += 1) {
    const raw = garbage(next);
    const euros = parseDutchAmount(raw);
    assert.ok(euros === null || Number.isFinite(euros), `parseDutchAmount("${raw}") = ${euros}`);
    const cents = parseDutchAmountCents(raw);
    assert.ok(cents === null || Number.isInteger(cents), `parseDutchAmountCents("${raw}") = ${cents}`);
    const bank = amountToCents(raw);
    assert.ok(Number.isInteger(bank), `amountToCents("${raw}") = ${bank}`);
  }
});

test('bankbedragen in elke gangbare schrijfwijze', () => {
  const next = rng(7);
  for (let i = 0; i < 3000; i += 1) {
    const cents = Math.round((next() - 0.5) * 2 * 1e8);
    const abs = Math.abs(cents);
    const euros = Math.trunc(abs / 100);
    const rest = String(abs % 100).padStart(2, '0');
    const enThousands = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs / 100);
    const neg = cents < 0;
    const forms = [
      `${neg ? '-' : ''}${nlThousands(abs)}`,   // ING/Rabo NL: -1.234,56
      `${neg ? '-' : ''}${enThousands}`,        // Engelse export: -1,234.56
      `${neg ? '-' : ''}${euros}.${rest}`,      // kaal met punt
      `${neg ? '-' : ''}${euros},${rest}`,      // kaal met komma
      neg ? `(${euros},${rest})` : `${euros},${rest}`, // haakjes = negatief
    ];
    for (const form of forms) assert.equal(amountToCents(form), cents, `"${form}"`);
  }
});

test('datums: elke schrijfwijze dezelfde dag, en 31 februari bestaat niet', () => {
  const next = rng(1990);
  for (let i = 0; i < 3000; i += 1) {
    const day = new Date(Date.UTC(2000 + Math.floor(next() * 60), 0, 1) + Math.floor(next() * 366) * 86400000);
    const y = day.getUTCFullYear(); const m = day.getUTCMonth() + 1; const d = day.getUTCDate();
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const p2 = (n: number) => String(n).padStart(2, '0');
    const forms = [iso, `${d}-${m}-${y}`, `${p2(d)}-${p2(m)}-${y}`, `${p2(d)}.${p2(m)}.${y}`, `${p2(d)}/${p2(m)}/${y}`,
      `${y}${p2(m)}${p2(d)}`, `${iso}T23:59:59+01:00`, `${p2(d)}-${p2(m)}-${String(y).slice(2)}`];
    for (const form of forms) assert.equal(normalizeDate(form), iso, `"${form}"`);
  }
  for (const bad of ['31-2-2026', '30-02-2026', '2026-02-30', '2026-13-01', '00-01-2026', '32-01-2026', '2025-02-29']) {
    assert.equal(normalizeDate(bad), null, bad);
  }
  assert.equal(normalizeDate('29-02-2024'), '2024-02-29', 'schrikkeljaar');
  // Maandnamen, Nederlands en Engels.
  assert.equal(normalizeDate('5 mei 2026'), '2026-05-05');
  assert.equal(normalizeDate('05-okt-2026'), '2026-10-05');
  assert.equal(normalizeDate('1 maart 2026'), '2026-03-01');
  assert.equal(normalizeDate('Jan 5, 2026'), '2026-01-05');
  assert.equal(normalizeDate('5 xyz 2026'), null);
  // Gevonden door deze test: de soepele Date-lezer maakte van rommel het jaar 103.
  assert.equal(normalizeDate('c)103('), null);
  assert.equal(normalizeDate('1000-01-01'), null, 'een jaar buiten 1900–2100 is rommel');
});

test('onzin als datum: een geldige ISO-datum of null, nooit een crash', () => {
  const next = rng(31);
  for (let i = 0; i < 20000; i += 1) {
    const raw = garbage(next, 16);
    const out = normalizeDate(raw);
    assert.ok(out === null || /^\d{4}-\d{2}-\d{2}$/.test(out), `normalizeDate("${raw}") = ${out}`);
  }
});

test('factuurtotalen: subtotaal + btw = totaal, btw per tarief, op de cent', () => {
  const next = rng(2026);
  const rates = [0, 9, 21];
  for (let i = 0; i < 3000; i += 1) {
    const n = 1 + Math.floor(next() * 8);
    const lines = Array.from({ length: n }, () => ({
      quantity: Math.round((next() * 20 - 2) * 4) / 4,          // ook kwartjes en negatieve (korting)
      unit_price: Math.round(next() * 500000) / 10000,          // tot vier decimalen
      vat: rates[Math.floor(next() * rates.length)],
    }));
    const t = computeTotals(lines);
    assert.ok(Number.isInteger(t.totalCents));
    assert.equal(Math.round(t.subtotal * 100) + Math.round(t.vat * 100), t.totalCents);
    assert.equal(Math.round(t.total * 100), t.totalCents);
    const breakdownVat = t.vatBreakdown.reduce((s, r) => s + Math.round(r.vat * 100), 0);
    assert.equal(breakdownVat, Math.round(t.vat * 100));
  }
  // Onzin in een regel telt als nul, geen NaN.
  const odd = computeTotals([{ quantity: 'abc' as unknown as number, unit_price: 10, vat: 21 }, { quantity: 1, unit_price: Number.NaN, vat: 21 }]);
  assert.equal(odd.totalCents, 0);
});

test('bankbestanden met rommel: hooguit een Error met uitleg, nooit een TypeError', () => {
  const next = rng(99);
  const pieces = [':20:', ':25:NL91ABNA0417164300', ':60F:C260105EUR1000,00', ':61:2601050105D12,50NTRF', ':86:/NAME/x', ':62F:', '-',
    'Datum;Bedrag;Omschrijving', '05-01-2026;12,50;x', ';;;', '"', '<Document>', '<Ntry>', '<Amt Ccy="EUR">', '</Ntry>', '<Stmt>', '\u0000', 'é'];
  for (let i = 0; i < 1500; i += 1) {
    const n = Math.floor(next() * 14);
    const text = Array.from({ length: n }, () => (next() < 0.7 ? pieces[Math.floor(next() * pieces.length)] : garbage(next, 20))).join(next() < 0.5 ? '\n' : '');
    // camt.053 leest XML met DOMParser; die heeft Node niet (de browser wel).
    const parsers = typeof DOMParser === 'undefined'
      ? [['csv', parseCsv], ['mt940', parseMt940]] as const
      : [['csv', parseCsv], ['mt940', parseMt940], ['camt053', parseCamt053]] as const;
    for (const [name, parse] of parsers) {
      try {
        const statement = parse(text, `fuzz.${name}`);
        for (const tx of statement.transactions) {
          assert.ok(Number.isInteger(tx.amount_cents), `${name}: bedrag ${tx.amount_cents}`);
          assert.ok(tx.booking_date === null || /^\d{4}-\d{2}-\d{2}$/.test(String(tx.booking_date)), `${name}: datum ${tx.booking_date}`);
        }
      } catch (error) {
        assert.ok(error instanceof Error, `${name}: geen Error maar ${String(error)}`);
        assert.ok(!(error instanceof TypeError) && !(error instanceof RangeError), `${name} crashte op ${JSON.stringify(text.slice(0, 80))}: ${(error as Error).message}`);
      }
    }
  }
});
