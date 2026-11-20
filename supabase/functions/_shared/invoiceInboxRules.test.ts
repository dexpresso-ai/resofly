import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptDocumentVat, autoBookEligible, discardDraftAllowed, invoiceDateConcern, isDocumentAttachment, isPurchaseVatCode,
  looksLikeInvoice, looksLikeInvoiceText, normalizeDocumentMime, pickZeroPurchaseCode, purchaseLineTotals, purgeEligible,
  PURCHASE_VAT_KINDS, retryEligibility, roundCents, safeFileName, sameInvoice, todayInAmsterdam,
} from './invoiceInboxRules.ts';

/**
 * De factuur-inbox boekt en ruimt op zonder dat er iemand kijkt. Deze regels
 * beslissen wanneer dat mag; een verschuiving erin merk je pas aan een dubbel
 * geboekte factuur of een verdwenen bewijsstuk. Daarom vaste gevallen.
 */

test('welke bijlage een factuur kan zijn', () => {
  assert.equal(isDocumentAttachment('factuur.pdf', 'application/octet-stream'), true);
  assert.equal(isDocumentAttachment('factuur.PDF', ''), true);
  assert.equal(isDocumentAttachment('e-factuur.xml', 'text/xml'), true);
  assert.equal(isDocumentAttachment('scan', 'image/jpeg'), true);
  assert.equal(isDocumentAttachment('voorwaarden.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), false);
  assert.equal(normalizeDocumentMime('factuur.pdf', 'application/octet-stream'), 'application/pdf');
  assert.equal(normalizeDocumentMime('foto.JPG', ''), 'image/jpeg');
  assert.equal(normalizeDocumentMime('x.bin', ''), 'application/octet-stream');
  assert.equal(safeFileName('Factuur Jansen (sept) €.pdf'), 'Factuur_Jansen_sept_.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'etc_passwd');
});

test('een factuur heeft regels én een bedrag', () => {
  const base = { supplier: { name: 'X' }, supplier_invoice_number: null, lines: [{}], totals: { total_cents: 0 }, extracted_totals: null };
  assert.equal(looksLikeInvoice({ ...base, totals: { total_cents: 12100 } }), true);
  assert.equal(looksLikeInvoice({ ...base, extracted_totals: { total_cents: 500 } }), true);
  assert.equal(looksLikeInvoice(base), false);
  assert.equal(looksLikeInvoice({ ...base, lines: [], totals: { total_cents: 100 } }), false);
});

test('mailtekst is pas een factuur met factuurwoorden en meerdere bedragen', () => {
  const invoiceMail = 'Factuur 2026-0142 van Groothandel BV. Levering kantoorartikelen 120,00. BTW 21% 25,20. Totaal te betalen € 145,20 binnen 14 dagen op IBAN NL00BANK0123456789. Vervaldatum 2 oktober 2026. Met vriendelijke groet, de administratie.';
  assert.equal(looksLikeInvoiceText(invoiceMail), true);
  assert.equal(looksLikeInvoiceText('Hierbij onze factuur, zie de bijlage. Met vriendelijke groet, Piet. ' + 'x'.repeat(200)), false);
  assert.equal(looksLikeInvoiceText('Bedankt voor je bestelling van € 50,00, de factuur volgt.'), false);
  assert.equal(looksLikeInvoiceText(''), false);
  assert.equal(looksLikeInvoiceText(null), false);
});

test('dezelfde factuur twee keer bijgevoegd', () => {
  const a = { supplier: { name: 'Groothandel BV' }, supplier_invoice_number: 'F-2026-001', lines: [{}], totals: { total_cents: 12100 }, extracted_totals: null };
  assert.equal(sameInvoice(a, { ...a, supplier_invoice_number: 'F2026001' }), true);
  assert.equal(sameInvoice(a, { ...a, supplier_invoice_number: 'F-2026-002' }), false);
  assert.equal(sameInvoice({ ...a, supplier_invoice_number: null }, { ...a, supplier_invoice_number: null, totals: { total_cents: 12101 } }), true);
  assert.equal(sameInvoice({ ...a, supplier_invoice_number: null }, { ...a, supplier_invoice_number: null, supplier: { name: 'Ander' } }), false);
});

test('automatisch boeken alleen als er niets te kiezen valt', () => {
  const ok = { supplierCreated: false, supplierMatch: 'vat', confidence: 'high' as const, warnings: [], lines: [{ account_id: 'a', amount_cents: 100 }], totals: { total_cents: 121 }, ibanVerified: true };
  assert.deepEqual(autoBookEligible(ok), { ok: true });
  assert.equal(autoBookEligible({ ...ok, supplierCreated: true }).ok, false);
  // Een leverancier die de inbox eerder aanmaakte, eerst laten bevestigen: anders
  // vergelijkt "het IBAN klopt" het IBAN uit een ongecontroleerde mail met zichzelf.
  assert.equal(autoBookEligible({ ...ok, supplierUnverified: true }).ok, false);
  assert.equal(autoBookEligible({ ...ok, supplierUnverified: false }).ok, true);
  assert.equal(autoBookEligible({ ...ok, supplierMatch: 'name' }).ok, false);
  assert.equal(autoBookEligible({ ...ok, confidence: 'medium' }).ok, false);
  assert.equal(autoBookEligible({ ...ok, warnings: ['totalen wijken af'] }).ok, false);
  assert.equal(autoBookEligible({ ...ok, lines: [{ account_id: null, amount_cents: 100 }] }).ok, false);
  assert.equal(autoBookEligible({ ...ok, totals: { total_cents: 0 } }).ok, false);
  // Vreemde valuta boekt het grootboek niet om: nooit vanzelf boeken.
  assert.equal(autoBookEligible({ ...ok, currency: 'USD' }).ok, false);
  assert.equal(autoBookEligible({ ...ok, currency: 'eur' }).ok, true);
});

test('ander IBAN dan bekend bij de leverancier: nooit vanzelf boeken', () => {
  // Hét patroon van factuurfraude: een echte leverancier, een echt ogende
  // factuur, en alleen het rekeningnummer is anders.
  const ok = { supplierCreated: false, supplierMatch: 'vat', confidence: 'high' as const, warnings: [], lines: [{ account_id: 'a', amount_cents: 100 }], totals: { total_cents: 121 }, ibanVerified: true };
  assert.deepEqual(autoBookEligible({ ...ok, ibanMismatch: false }), { ok: true });
  const blocked = autoBookEligible({ ...ok, ibanMismatch: true });
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? '' : blocked.why, /IBAN/);
});

test('de opruimronde pakt alleen storingen opnieuw op, en niet eindeloos', () => {
  const now = new Date('2026-09-18T12:00:00Z');
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const row = (over: Record<string, unknown>) => ({ status: 'received', reason: null, attempts: 0, processing_started_at: null, updated_at: ago(30), ...over });
  assert.equal(retryEligibility(row({}), now).retry, true);
  assert.equal(retryEligibility(row({ updated_at: ago(1) }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'processing', processing_started_at: ago(11) }), now).retry, true);
  assert.equal(retryEligibility(row({ status: 'processing', processing_started_at: ago(2) }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'failed', reason: 'processing_error', attempts: 2 }), now).retry, true);
  assert.equal(retryEligibility(row({ status: 'failed', reason: 'storage_failed' }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'failed', reason: 'processing_error', attempts: 4 }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'needs_review', reason: 'ai_unavailable' }), now).retry, true);
  assert.equal(retryEligibility(row({ status: 'needs_review', reason: 'supplier_unknown' }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'needs_review', reason: 'rate_limited', updated_at: ago(30) }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'needs_review', reason: 'rate_limited', updated_at: ago(90) }), now).retry, true);
  assert.equal(retryEligibility(row({ status: 'ready' }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'duplicate' }), now).retry, false);
});

test('bijlagen van afgedane items gaan pas na een wachttijd weg, bewijsstukken nooit', () => {
  const now = new Date('2026-09-18T12:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const row = (over: Record<string, unknown>) => ({ status: 'rejected', purged_at: null, purchase_invoice_id: null, updated_at: daysAgo(31), attachments: [{ storage_key: 'k' }], ...over });
  assert.equal(purgeEligible(row({}), now), true);
  assert.equal(purgeEligible(row({ updated_at: daysAgo(10) }), now), false);
  assert.equal(purgeEligible(row({ status: 'duplicate', updated_at: daysAgo(60) }), now), false);
  assert.equal(purgeEligible(row({ status: 'duplicate', updated_at: daysAgo(91) }), now), true);
  assert.equal(purgeEligible(row({ purchase_invoice_id: 'pi' }), now), false);
  assert.equal(purgeEligible(row({ status: 'ready', updated_at: daysAgo(400) }), now), false);
  assert.equal(purgeEligible(row({ purged_at: daysAgo(1) }), now), false);
  assert.equal(purgeEligible(row({ attachments: [{ storage_key: null }] }), now), false);
});

test('alleen op e-mailadres herkend, of zonder vergelijkbaar IBAN: niet vanzelf boeken', () => {
  // Het afzenderadres is niet geverifieerd: een vervalste "bekende leverancier"
  // zonder IBAN op de factuur werd anders gewoon geboekt.
  const ok = { supplierCreated: false, supplierMatch: 'vat', confidence: 'high' as const, warnings: [], lines: [{ account_id: 'a', amount_cents: 100 }], totals: { total_cents: 121 }, ibanVerified: true };
  assert.deepEqual(autoBookEligible(ok), { ok: true });
  const byEmail = autoBookEligible({ ...ok, supplierMatch: 'email' });
  assert.equal(byEmail.ok, false);
  assert.match(byEmail.ok ? '' : byEmail.why, /e-mailadres/);
  const noIban = autoBookEligible({ ...ok, ibanVerified: false });
  assert.equal(noIban.ok, false);
  assert.match(noIban.ok ? '' : noIban.why, /IBAN/);
});

// ── Inkoop: btw-soorten, totalen en de datum (controle eenmanszaak, 2026-11-19) ──

const KINDS: Record<string, string> = {
  HOOG: 'standard', LAAG: 'reduced', NUL: 'zero', VRIJ: 'exempt', KOR: 'kor',
  VERL_INK: 'reverse_charge_purchase', EU_VERW: 'eu_acquisition', IMPORT: 'import_non_eu',
  ICP_DIENST: 'icp_services', ICP_GOED: 'icp_goods', VERL_VERK: 'reverse_charge_sales', EXPORT: 'zero',
};
const opts = (kor = false) => ({ kindOf: (code: string) => KINDS[code], kor, fallbackAccountId: 'acc-4500' });
const regel = (amount_cents: number, vat_code = 'HOOG', vat_rate = 21, extra: Record<string, unknown> = {}) =>
  ({ amount_cents, vat_code, vat_rate, account_id: null as string | null, ...extra });

test('alleen inkoopcodes op een inkoopregel; export en ICP zijn verkoop', () => {
  for (const kind of ['standard', 'reduced', 'zero', 'exempt', 'reverse_charge_purchase', 'eu_acquisition', 'import_non_eu', 'kor']) {
    assert.equal(isPurchaseVatCode({ kind }), true, kind);
  }
  for (const kind of ['icp_goods', 'icp_services', 'reverse_charge_sales']) assert.equal(isPurchaseVatCode({ kind }), false, kind);
  // "Export buiten EU" is soort zero met rubriek 3a: omzet, geen inkoop.
  assert.equal(isPurchaseVatCode({ kind: 'zero', sales_box: '3a' }), false);
  assert.equal(isPurchaseVatCode({ kind: 'zero', sales_box: '1e' }), true);
  assert.deepEqual([...PURCHASE_VAT_KINDS].sort(), ['eu_acquisition', 'exempt', 'import_non_eu', 'kor', 'reduced', 'reverse_charge_purchase', 'standard', 'zero']);
});

test('een bonregel zonder btw krijgt NUL, nooit EXPORT (die stond op alfabet vooraan)', () => {
  const codes = [
    { code: 'EXPORT', kind: 'zero', sales_box: '3a' },
    { code: 'NUL', kind: 'zero', sales_box: '1e' },
    { code: 'VRIJ', kind: 'exempt', sales_box: null },
  ];
  assert.equal(pickZeroPurchaseCode(codes)?.code, 'NUL');
  // Zonder rubriek (oude gegevens) valt een code die export heet ook af.
  assert.equal(pickZeroPurchaseCode([{ code: 'EXPORT', kind: 'zero' }, { code: 'ZERO', kind: 'zero' }])?.code, 'ZERO');
  assert.equal(pickZeroPurchaseCode([{ code: 'EXPORT', kind: 'zero', sales_box: '3a' }]), undefined);
});

test('totalen: gewone btw telt bij het totaal, per rekening en code afgerond', () => {
  assert.deepEqual(purchaseLineTotals([regel(10000)], opts()), {
    subtotal_cents: 10000, vat_cents: 2100, total_cents: 12100, self_assessed_vat_cents: 0, non_deductible_vat_cents: 0,
  });
  // Twee regels van € 1,03 in één groep: 21% van € 2,06 = 43 cent, niet 2 × 22.
  assert.equal(purchaseLineTotals([regel(103), regel(103)], opts()).vat_cents, 43);
  // Op twee rekeningen boekt de database twee groepen: 22 + 22.
  assert.equal(purchaseLineTotals([regel(103, 'HOOG', 21, { account_id: 'a' }), regel(103, 'HOOG', 21, { account_id: 'b' })], opts()).vat_cents, 44);
  // Zonder rekening valt de regel op 4500, in dezelfde groep als een regel die 4500 noemt.
  assert.equal(purchaseLineTotals([regel(103), regel(103, 'HOOG', 21, { account_id: 'acc-4500' })], opts()).vat_cents, 43);
});

test('totalen: verlegde btw (2a, 4a, 4b) zit niet in het totaal', () => {
  for (const code of ['VERL_INK', 'EU_VERW', 'IMPORT']) {
    assert.deepEqual(purchaseLineTotals([regel(10000, code, 21)], opts()), {
      subtotal_cents: 10000, vat_cents: 0, total_cents: 10000, self_assessed_vat_cents: 2100, non_deductible_vat_cents: 0,
    }, code);
  }
  // Gemengd: alleen de gewone btw telt mee.
  const gemengd = purchaseLineTotals([regel(10000, 'EU_VERW', 21), regel(5000, 'HOOG', 21), regel(2000, 'NUL', 0)], opts());
  assert.deepEqual([gemengd.subtotal_cents, gemengd.vat_cents, gemengd.total_cents, gemengd.self_assessed_vat_cents], [17000, 1050, 18050, 2100]);
});

test('totalen met de KOR: de btw van de leverancier betaal je, maar trek je niet af', () => {
  const binnenland = purchaseLineTotals([regel(10000)], opts(true));
  assert.deepEqual([binnenland.vat_cents, binnenland.total_cents, binnenland.non_deductible_vat_cents], [2100, 12100, 2100]);
  const verlegd = purchaseLineTotals([regel(10000, 'EU_VERW', 21)], opts(true));
  assert.deepEqual([verlegd.vat_cents, verlegd.total_cents, verlegd.self_assessed_vat_cents, verlegd.non_deductible_vat_cents], [0, 10000, 2100, 0]);
});

test('totalen: het btw-bedrag van de leverancier telt, behalve bij verlegd en 0%', () => {
  // € 8,26 × 21% = € 1,73; op de bon staat € 1,74.
  assert.deepEqual(purchaseLineTotals([regel(826, 'HOOG', 21, { vat_cents: 174 })], opts()).total_cents, 1000);
  // De rest van de groep rekent gewoon door: 174 + 21% van € 1,03.
  assert.equal(purchaseLineTotals([regel(826, 'HOOG', 21, { vat_cents: 174 }), regel(103)], opts()).vat_cents, 174 + 22);
  // Bij verlegde btw en bij 0% negeert de boeking het veld.
  assert.equal(purchaseLineTotals([regel(10000, 'EU_VERW', 21, { vat_cents: 1 })], opts()).self_assessed_vat_cents, 2100);
  assert.equal(purchaseLineTotals([regel(10000, 'NUL', 0, { vat_cents: 5 })], opts()).vat_cents, 0);
  // Ook met de KOR: je betaalt wat er op de factuur staat.
  assert.equal(purchaseLineTotals([regel(826, 'HOOG', 21, { vat_cents: 174 })], opts(true)).total_cents, 1000);
  // Geen heel getal: telt niet als ingevuld.
  assert.equal(purchaseLineTotals([regel(826, 'HOOG', 21, { vat_cents: 1.5 })], opts()).vat_cents, 173);
  assert.equal(purchaseLineTotals([regel(826, 'HOOG', 21, { vat_cents: null })], opts()).vat_cents, 173);
});

test('een creditnota rondt af zoals de database (van nul af)', () => {
  assert.equal(roundCents(-220.5), -221);
  assert.equal(roundCents(220.5), 221);
  assert.equal(purchaseLineTotals([regel(-1050)], opts()).vat_cents, -221);
});

test('zonder de soorten telt alle btw mee, zoals vóór 20261119 (oude aanroepers)', () => {
  assert.equal(purchaseLineTotals([regel(10000, 'EU_VERW', 21)]).total_cents, 12100);
});

test('het btw-bedrag van de bon wordt overgenomen: € 10,00 blijft € 10,00', () => {
  const bon = adoptDocumentVat([regel(826)], { total_cents: 1000, vat_cents: 174 }, opts());
  assert.equal(bon.adopted, true);
  assert.equal(bon.lines[0].vat_cents, 174);
  assert.equal(purchaseLineTotals(bon.lines, opts()).total_cents, 1000);
  // Alleen het totaal gelezen: dan telt het totaal.
  const alleenTotaal = adoptDocumentVat([regel(826)], { total_cents: 1000, vat_cents: null }, opts());
  assert.equal(purchaseLineTotals(alleenTotaal.lines, opts()).total_cents, 1000);
  // Alleen de btw gelezen.
  const alleenBtw = adoptDocumentVat([regel(826)], { total_cents: null, vat_cents: 174 }, opts());
  assert.equal(purchaseLineTotals(alleenBtw.lines, opts()).vat_cents, 174);
});

test('het btw-bedrag komt op de grootste regel, en de groep blijft kloppen', () => {
  // Drie regels in één groep: berekend 21% van € 24,56 = € 5,16; op de bon € 5,17.
  const regels = [regel(331), regel(1795), regel(330)];
  const bon = adoptDocumentVat(regels, { total_cents: 2456 + 517, vat_cents: 517 }, opts());
  assert.equal(bon.adopted, true);
  assert.deepEqual(bon.lines.map((l) => l.vat_cents ?? null), [null, 378, null]);
  assert.equal(purchaseLineTotals(bon.lines, opts()).total_cents, 2456 + 517);
  // De invoer blijft ongemoeid.
  assert.equal(regels[1].vat_cents, undefined);
});

test('geen overname: klopt het al, is het verschil te groot, of zit het niet in de btw', () => {
  assert.equal(adoptDocumentVat([regel(10000)], { total_cents: 12100, vat_cents: 2100 }, opts()).adopted, false);
  // Drie cent of meer is geen afronding: dan waarschuwt de totalencontrole.
  const groot = adoptDocumentVat([regel(826)], { total_cents: 1003, vat_cents: null }, opts());
  assert.equal(groot.adopted, false);
  assert.equal(groot.lines[0].vat_cents, undefined);
  // De cent zit in het bedrag exclusief (bon: € 8,27 + € 1,73): geen btw aftrekken die er niet staat.
  assert.equal(adoptDocumentVat([regel(826)], { total_cents: 1000, vat_cents: 173 }, opts()).adopted, false);
  // Geen regel met gewone btw om het op te zetten.
  assert.equal(adoptDocumentVat([regel(10000, 'EU_VERW', 21)], { total_cents: 10001, vat_cents: null }, opts()).adopted, false);
  assert.equal(adoptDocumentVat([regel(10000, 'NUL', 0)], { total_cents: 10001, vat_cents: null }, opts()).adopted, false);
  assert.equal(adoptDocumentVat([regel(826)], null, opts()).adopted, false);
  assert.equal(adoptDocumentVat([regel(826)], { total_cents: null, vat_cents: null }, opts()).adopted, false);
});

test('een juist gelezen verlegde factuur klopt met het totaal op de factuur', () => {
  // Google Ireland: € 100,00, btw verlegd. Eerder: berekend totaal € 121,00,
  // dus de waarschuwing dat de bedragen afweken.
  const totalen = purchaseLineTotals([regel(10000, 'EU_VERW', 21)], opts());
  assert.equal(totalen.total_cents, 10000);
  assert.equal(adoptDocumentVat([regel(10000, 'EU_VERW', 21)], { total_cents: 10000, vat_cents: 0 }, opts()).adopted, false);
});

test('een onwaarschijnlijke factuurdatum: toekomst, vóór de start, meer dan een jaar terug', () => {
  const ctx = { today: '2026-11-19', bookkeepingStart: '2026-01-01' };
  assert.equal(invoiceDateConcern('2026-11-16', ctx), null);
  assert.equal(invoiceDateConcern('2026-11-19', ctx), null);
  assert.equal(invoiceDateConcern('2026-01-01', ctx), null);
  assert.equal(invoiceDateConcern('2062-11-16', ctx)?.kind, 'future');
  assert.match(invoiceDateConcern('2062-11-16', ctx)!.message, /16-11-2062 ligt in de toekomst/);
  assert.equal(invoiceDateConcern('2026-11-20', ctx)?.kind, 'future');
  assert.equal(invoiceDateConcern('2025-12-31', ctx)?.kind, 'before_start');
  assert.match(invoiceDateConcern('2025-12-31', ctx)!.message, /vóór de startdatum van je boekhouding \(01-01-2026\)/);
  // Zonder startdatum, of met een start van jaren terug: meer dan een jaar oud.
  assert.equal(invoiceDateConcern('2025-11-18', { today: '2026-11-19' })?.kind, 'old');
  assert.equal(invoiceDateConcern('2025-11-19', { today: '2026-11-19' }), null);
  assert.equal(invoiceDateConcern('2022-06-01', { today: '2026-11-19', bookkeepingStart: '2020-01-01' })?.kind, 'old');
  // Geen of een kapotte datum: daar gaat deze regel niet over.
  assert.equal(invoiceDateConcern(null, ctx), null);
  assert.equal(invoiceDateConcern('16-11-2026', ctx), null);
});

test('vandaag is de dag in Nederland, niet in UTC', () => {
  assert.equal(todayInAmsterdam(new Date('2026-12-31T23:30:00Z')), '2027-01-01');
  assert.equal(todayInAmsterdam(new Date('2026-06-30T21:59:00Z')), '2026-06-30');
  assert.equal(todayInAmsterdam(new Date('2026-06-30T22:00:00Z')), '2026-07-01');
});

test('automatisch boeken: nooit met een onwaarschijnlijke of niet gelezen datum', () => {
  const base = {
    supplierCreated: false, supplierMatch: 'vat', confidence: 'high' as const, warnings: [] as string[],
    lines: [{ account_id: 'a', amount_cents: 10000 }], totals: { total_cents: 12100 }, ibanVerified: true, currency: 'EUR',
  };
  assert.deepEqual(autoBookEligible(base), { ok: true });
  const verdict = autoBookEligible({ ...base, dateConcern: 'De factuurdatum 16-11-2062 ligt in de toekomst.' });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { why: string }).why, /factuurdatum/);
  assert.deepEqual(autoBookEligible({ ...base, dateConcern: null }), { ok: true });
});

test('negeren gooit alleen een concept weg dat nooit geboekt is', () => {
  assert.deepEqual(discardDraftAllowed({ channel: 'receipt', invoiceStatus: 'draft', journalEntries: 0 }), { ok: true });
  assert.deepEqual(discardDraftAllowed({ channel: 'email', invoiceStatus: 'draft', journalEntries: 0 }), { ok: true });
  // Geboekt en tegengeboekt: de boekstukken verwijzen ernaar (bewaarplicht).
  assert.equal(discardDraftAllowed({ channel: 'receipt', invoiceStatus: 'draft', journalEntries: 2 }).ok, false);
  assert.equal(discardDraftAllowed({ channel: 'receipt', invoiceStatus: 'booked', journalEntries: 1 }).ok, false);
  // Een declaratie gaat met een reden weg, via Afwijzen.
  assert.equal(discardDraftAllowed({ channel: 'declaration', invoiceStatus: 'draft', journalEntries: 0 }).ok, false);
});
