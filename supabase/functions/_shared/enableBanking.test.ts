import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  amsterdamDate, classifyEbError, clientIpFrom, consentValidUntil, decimalToCents, ebTransactionState,
  fetchAllTransactionPages, isBookedEbTransaction, isPublicIp, mapEbTransaction, pickBookedBalance,
  prepareEbTransactions, psuHeaders, SAFE_CONSENT_DAYS,
} from './enableBanking.ts';

/**
 * Wat er van Enable Banking binnenkomt, bepaalt wat er geboekt kan worden. Een
 * pending-transactie die als echte binnenkomt, of een afschrijving die als
 * ontvangst binnenkomt, valt pas op bij de jaarrekening — tenzij het saldo dat
 * de bank zelf opgeeft naast de boekhouding wordt gelegd.
 */

const tx = (overrides: Record<string, unknown> = {}) => ({
  entry_reference: 'ref-1',
  transaction_amount: { amount: '121.00', currency: 'EUR' },
  credit_debit_indicator: 'CRDT',
  status: 'BOOK',
  booking_date: '2026-10-14',
  value_date: '2026-10-15',
  debtor: { name: 'Klant BV' },
  debtor_account: { iban: 'NL02RABO0123456789' },
  creditor: { name: 'Wij BV' },
  creditor_account: { iban: 'NL91ABNA0417164300' },
  remittance_information: ['Factuur 2026-014', 'dank'],
  ...overrides,
});

test('bedragen naar centen, zonder afrondingslek', () => {
  assert.equal(decimalToCents('121.00'), 12100);
  assert.equal(decimalToCents('0.29'), 29);
  assert.equal(decimalToCents('-12.5'), -1250);
  assert.equal(decimalToCents(7), 700);
  for (const bad of ['', '  ', 'abc', null, undefined, '1,23']) assert.equal(decimalToCents(bad), null, String(bad));
});

test('ontvangst: positief, met de betaler als tegenpartij', () => {
  const m = mapEbTransaction(tx());
  assert.ok(m);
  assert.equal(m.amount_cents, 12100);
  assert.equal(m.counterparty_name, 'Klant BV');
  assert.equal(m.counterparty_iban, 'NL02RABO0123456789');
  assert.equal(m.description, 'Factuur 2026-014 dank');
  assert.equal(m.booking_date, '2026-10-14');
  assert.equal(m.value_date, '2026-10-15');
  assert.equal(m.bank_tx_id, 'ref-1');
  assert.equal('dedup_key' in m, false, 'de sleutel wordt server-side afgeleid');
});

test('afschrijving: negatief, met de ontvanger als tegenpartij', () => {
  const m = mapEbTransaction(tx({ credit_debit_indicator: 'DBIT' }));
  assert.equal(m?.amount_cents, -12100);
  assert.equal(m?.counterparty_name, 'Wij BV');
  // Ook als de bank het teken al in het bedrag zet: niet dubbel omdraaien.
  assert.equal(mapEbTransaction(tx({ credit_debit_indicator: 'DBIT', transaction_amount: { amount: '-121.00', currency: 'EUR' } }))?.amount_cents, -12100);
  assert.equal(mapEbTransaction(tx({ credit_debit_indicator: 'CRDT', transaction_amount: { amount: '-121.00', currency: 'EUR' } }))?.amount_cents, 12100);
});

test('zonder indicator volgt het teken het bedrag (was: altijd een ontvangst)', () => {
  const out = mapEbTransaction(tx({ credit_debit_indicator: undefined, transaction_amount: { amount: '-45.10', currency: 'EUR' } }));
  assert.equal(out?.amount_cents, -4510);
  assert.equal(out?.counterparty_name, 'Wij BV', 'bij een afschrijving is de crediteur de tegenpartij');
  assert.equal(mapEbTransaction(tx({ credit_debit_indicator: '', transaction_amount: { amount: '45.10', currency: 'EUR' } }))?.amount_cents, 4510);
});

test('boekdatum: booking_date, anders value_date, anders transaction_date; geen datum = niet boekbaar', () => {
  assert.equal(mapEbTransaction(tx({ booking_date: null }))?.booking_date, '2026-10-15');
  assert.equal(mapEbTransaction(tx({ booking_date: null, value_date: null, transaction_date: '2026-10-13T09:00:00Z' }))?.booking_date, '2026-10-13');
  assert.equal(mapEbTransaction(tx({ booking_date: null, value_date: null, transaction_date: null })), null);
  assert.equal(mapEbTransaction(tx({ booking_date: 'gisteren', value_date: null })), null);
});

test('€ 0,00 of geen bedrag: niet boekbaar', () => {
  assert.equal(mapEbTransaction(tx({ transaction_amount: { amount: '0.00', currency: 'EUR' } })), null);
  assert.equal(mapEbTransaction(tx({ transaction_amount: {} })), null);
});

test('alleen geboekte transacties komen binnen', () => {
  assert.equal(isBookedEbTransaction(tx()), true);
  assert.equal(isBookedEbTransaction(tx({ status: undefined })), true, 'zonder status: geboekt');
  assert.equal(isBookedEbTransaction(tx({ status: 'book' })), true);
  for (const status of ['PDNG', 'pdng', 'CNCL', 'RJCT', 'SCHD', 'HOLD', 'OTHR']) {
    assert.equal(isBookedEbTransaction(tx({ status })), false, status);
  }
});

test('status: wat komt binnen, wat komt nog, wat nooit', () => {
  assert.equal(ebTransactionState(tx()), 'booked');
  for (const status of ['PDNG', 'pdng', 'SCHD', 'HOLD']) assert.equal(ebTransactionState(tx({ status })), 'pending', status);
  // Geweigerd of geannuleerd: daar ging geen geld over, en het komt ook niet meer.
  for (const status of ['RJCT', 'CNCL']) assert.equal(ebTransactionState(tx({ status })), 'dropped', status);
  // OTHR of iets nieuws: niet raden of het geboekt is.
  for (const status of ['OTHR', 'XYZ']) assert.equal(ebTransactionState(tx({ status })), 'unknown', status);
});

test('een batch: pending, onbekende status en onbruikbare regels geteld, niet ingelezen', () => {
  const out = prepareEbTransactions([
    tx(),
    tx({ status: 'PDNG', booking_date: null }),
    tx({ status: 'PDNG' }),
    tx({ status: 'RJCT' }),
    tx({ status: 'CNCL' }),
    tx({ status: 'OTHR' }),
    tx({ transaction_amount: { amount: '0', currency: 'EUR' } }),
    tx({ credit_debit_indicator: 'DBIT', entry_reference: 'ref-2' }),
  ]);
  assert.equal(out.transactions.length, 2);
  assert.equal(out.pending, 2, 'geweigerd/geannuleerd telt niet als "komt nog"');
  assert.equal(out.unknownStatus, 1);
  assert.equal(out.unusable, 1);
  assert.deepEqual(prepareEbTransactions(undefined), { transactions: [], pending: 0, unknownStatus: 0, unusable: 0 });
});

test('dag in Nederland van een UTC-tijdstip', () => {
  assert.equal(amsterdamDate('2026-10-15T23:30:00Z'), '2026-10-16', 'zomertijd: UTC+2');
  assert.equal(amsterdamDate('2026-12-31T23:30:00Z'), '2027-01-01', 'wintertijd: UTC+1');
  assert.equal(amsterdamDate('2026-10-15T12:00:00+02:00'), '2026-10-15');
  assert.equal(amsterdamDate('2026-10-15'), '2026-10-15');
  for (const bad of [null, undefined, '', 'gisteren']) assert.equal(amsterdamDate(bad), null, String(bad));
});

const bal = (balance_type: string, amount: string, extra: Record<string, unknown> = {}) =>
  ({ balance_type, balance_amount: { amount, currency: 'EUR' }, ...extra });

test('saldo: het geboekte eindsaldo op zijn peildatum', () => {
  const picked = pickBookedBalance([
    bal('CLAV', '9999.00', { reference_date: '2026-10-17' }),   // beschikbaar: incl. kredietlimiet
    bal('XPCD', '1300.00', { reference_date: '2026-10-17' }),   // verwacht: incl. pending
    bal('CLBD', '1250.40', { reference_date: '2026-10-16' }),
  ], 'EUR', '2026-10-17');
  assert.deepEqual(picked, { amount_cents: 125040, date: '2026-10-16', type: 'CLBD' });
});

test('saldo: een recenter tussensaldo gaat voor, op dezelfde dag het eindsaldo', () => {
  assert.equal(pickBookedBalance([
    bal('CLBD', '100.00', { reference_date: '2026-10-16' }),
    bal('ITBD', '150.00', { reference_date: '2026-10-17' }),
  ], 'EUR', '2026-10-17')?.type, 'ITBD');
  assert.equal(pickBookedBalance([
    bal('ITBD', '150.00', { reference_date: '2026-10-16' }),
    bal('CLBD', '100.00', { reference_date: '2026-10-16' }),
  ], 'EUR', '2026-10-17')?.type, 'CLBD');
});

test('saldo: datum ontbreekt', () => {
  // Een eindsaldo zonder datum is niet aan te sluiten.
  assert.equal(pickBookedBalance([bal('CLBD', '100.00')], 'EUR', '2026-10-17'), null);
  // Een tussensaldo zonder datum geldt nu: laatste wijziging, anders vandaag.
  assert.equal(pickBookedBalance([bal('ITBD', '100.00', { last_change_date_time: '2026-10-15T12:00:00Z' })], 'EUR', '2026-10-17')?.date, '2026-10-15');
  // Vlak voor middernacht UTC is het in Nederland al de volgende dag.
  assert.equal(pickBookedBalance([bal('ITBD', '100.00', { last_change_date_time: '2026-10-15T22:45:00Z' })], 'EUR', '2026-10-17')?.date, '2026-10-16');
  assert.equal(pickBookedBalance([bal('ITBD', '100.00')], 'EUR', '2026-10-17')?.date, '2026-10-17');
});

test('saldo: beginsaldo geldt als eindsaldo van de dag ervoor', () => {
  assert.deepEqual(pickBookedBalance([bal('OPBD', '-20.00', { reference_date: '2026-11-01' })], 'EUR', '2026-11-01'),
    { amount_cents: -2000, date: '2026-10-31', type: 'OPBD' });
});

test('saldo: andere valuta, alleen beschikbaar of niets bruikbaars → geen saldo', () => {
  assert.equal(pickBookedBalance([{ balance_type: 'CLBD', balance_amount: { amount: '5.00', currency: 'USD' }, reference_date: '2026-10-16' }], 'EUR', '2026-10-17'), null);
  assert.equal(pickBookedBalance([bal('CLAV', '5.00', { reference_date: '2026-10-16' }), bal('ITAV', '5.00')], 'EUR', '2026-10-17'), null);
  assert.equal(pickBookedBalance(undefined, 'EUR', '2026-10-17'), null);
  assert.equal(pickBookedBalance([bal('CLBD', 'n.v.t.', { reference_date: '2026-10-16' })], 'EUR', '2026-10-17'), null);
});

test('bank-sync gebruikt deze functies en legt het saldo vast', () => {
  const source = readFileSync(new URL('../bank-sync/index.ts', import.meta.url), 'utf8');
  assert.match(source, /from '\.\.\/_shared\/enableBanking\.ts'/);
  assert.match(source, /prepareEbTransactions\(fetched\.transactions\)/, 'transacties lopen door het filter op geboekt');
  assert.match(source, /pickBookedBalance\(/);
  assert.match(source, /rpc\('record_bank_balance'/);
  assert.doesNotMatch(source, /function mapEbTransaction/, 'geen tweede, afwijkende mapping in de edge function');
  // Een al gekoppelde requisition wordt niet opnieuw afgerond of op 'error' gezet.
  assert.match(source, /reqRow\.status === 'linked'/);
  assert.match(source, /\.in\('status', \['created', 'error'\]\)/);
});

test('PSU-headers alleen met een publiek IP van de gebruiker', () => {
  assert.deepEqual(psuHeaders('203.0.113.9, 10.0.0.1', 'Mozilla/5.0'), { 'Psu-Ip-Address': '203.0.113.9', 'Psu-User-Agent': 'Mozilla/5.0' });
  assert.deepEqual(psuHeaders('84.24.1.2:51234', ''), { 'Psu-Ip-Address': '84.24.1.2' }, 'poort eraf, geen lege user-agent');
  assert.deepEqual(psuHeaders('[2a02:a46a:1::5]:443', 'x'), { 'Psu-Ip-Address': '2a02:a46a:1::5', 'Psu-User-Agent': 'x' });
  for (const internal of ['10.1.2.3', '192.168.1.10', '172.20.0.5', '127.0.0.1', '100.64.3.3', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '', null, 'onzin', '999.1.1.1']) {
    assert.deepEqual(psuHeaders(internal as string | null, 'ua'), {}, String(internal));
  }
  assert.equal(psuHeaders('84.24.1.2', 'a'.repeat(900))['Psu-User-Agent']?.length, 512);
  assert.equal(clientIpFrom(' 84.24.1.2 , 1.1.1.1'), '84.24.1.2');
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('172.32.0.1'), true, 'net buiten 172.16/12');
});

test('toestemming: 180 dagen, maar nooit langer dan de bank toestaat', () => {
  const now = Date.parse('2026-10-18T10:00:00Z');
  const days = (d: Date) => (d.getTime() - now) / 86_400_000;
  assert.equal(days(consentValidUntil(now, 180, 180 * 86400)), 180 - 1 / 24, 'precies het maximum: een uur speling');
  assert.equal(days(consentValidUntil(now, 180, 365 * 86400)), 180, 'bank staat meer toe: wat we vragen');
  assert.equal(days(consentValidUntil(now, 180, 90 * 86400)), 90 - 1 / 24, 'bank staat 90 dagen toe');
  assert.equal(days(consentValidUntil(now, 180, null)), SAFE_CONSENT_DAYS, 'onbekend maximum: 90 dagen');
  assert.equal(days(consentValidUntil(now, 180, 0)), SAFE_CONSENT_DAYS);
  assert.equal(days(consentValidUntil(now, 30, null)), 30);
  assert.equal(days(consentValidUntil(now, 180, 600)), 1, 'een absurd kort maximum: minstens een dag');
});

test('fouten van Enable Banking: wat de gebruiker moet doen', () => {
  assert.equal(classifyEbError(401, {}), 'auth');
  assert.equal(classifyEbError(403, { error: 'ACCESS_DENIED' }), 'auth');
  assert.equal(classifyEbError(429, {}), 'rate_limited');
  assert.equal(classifyEbError(500, {}), 'bank_unavailable');
  assert.equal(classifyEbError(503, 'Service Unavailable'), 'bank_unavailable');
  assert.equal(classifyEbError(0, null), 'bank_unavailable', 'geen antwoord');
  assert.equal(classifyEbError(400, { error: 'EXPIRED_SESSION', message: 'Session expired' }), 'reconsent');
  assert.equal(classifyEbError(422, { error: 'CLOSED_SESSION' }), 'reconsent');
  assert.equal(classifyEbError(400, { message: 'The session has been revoked by the PSU' }), 'reconsent');
  assert.equal(classifyEbError(404, { message: 'Account not found' }), 'reconsent');
  assert.equal(classifyEbError(400, { error: 'WRONG_REQUEST_PARAMETERS', message: 'date_from is invalid' }), 'other');
});

test('pagina\'s: tot er geen sleutel meer komt; bij het plafond afgekapt', async () => {
  const pages = [
    { transactions: [1, 2], continuation_key: 'a' },
    { transactions: [], continuation_key: 'b' },              // lege pagina: toch doorgaan
    { transactions: [3], continuation_key: null },
  ];
  const asked: Array<string | null> = [];
  const all = await fetchAllTransactionPages(async (key) => { asked.push(key); return pages[asked.length - 1]; });
  assert.deepEqual(all, { transactions: [1, 2, 3], pages: 3, truncated: false });
  assert.deepEqual(asked, [null, 'a', 'b']);

  // Dezelfde sleutel terug: klaar (niet eindeloos doorvragen).
  let n = 0;
  const same = await fetchAllTransactionPages(async () => { n += 1; return { transactions: [n], continuation_key: 'zelfde' }; });
  assert.deepEqual(same, { transactions: [1, 2], pages: 2, truncated: false });

  // Bank blijft nieuwe sleutels geven: na het plafond afgekapt.
  let k = 0;
  const capped = await fetchAllTransactionPages(async () => { k += 1; return { transactions: [k], continuation_key: `k${k}` }; }, 5);
  assert.deepEqual(capped, { transactions: [1, 2, 3, 4, 5], pages: 5, truncated: true });

  const empty = await fetchAllTransactionPages(async () => null);
  assert.deepEqual(empty, { transactions: [], pages: 1, truncated: false });

  // De tijd is op: wat er is, en afgekapt (de volgende sync gaat verder).
  let t = 0;
  const late = await fetchAllTransactionPages(async () => { t += 1; return { transactions: [t], continuation_key: `t${t}` }; }, 100, () => t >= 2);
  assert.deepEqual(late, { transactions: [1, 2], pages: 2, truncated: true });
});

test('bank-sync: geplande sync, PSU-headers, paginering en eigen grootboekrekening zijn aangesloten', () => {
  const source = readFileSync(new URL('../bank-sync/index.ts', import.meta.url), 'utf8');
  // De cron-ingang komt vóór de origin-check (een cron heeft geen origin) en
  // vergelijkt het secret in constante tijd, alleen via de header.
  const cronAt = source.indexOf("searchParams.get('cron') === 'sync'");
  const originAt = source.indexOf('assertAllowedOrigin(req);');
  assert.ok(cronAt > 0 && originAt > cronAt, 'cron-ingang vóór assertAllowedOrigin');
  assert.match(source, /timingSafeEqual\(provided, BANK_SYNC_CRON_SECRET\)/);
  assert.match(source, /req\.headers\.get\('x-cron-secret'\)/);
  assert.match(source, /rpc\('bank_accounts_due_for_sync'/);
  // Met de gebruiker erbij gaan de PSU-headers mee; de geplande sync heeft ze niet.
  assert.match(source, /syncAccounts\(organizationId, body\.bankAccountId \? String\(body\.bankAccountId\) : null, \{ psu, deadline \}\)/);
  assert.match(source, /syncAccounts\(row\.organization_id, row\.bank_account_id, \{ deadline \}\)/);
  // Alle pagina's, en bij afkappen het startpunt niet vooruit.
  assert.match(source, /fetchAllTransactionPages\(/);
  assert.match(source, /if \(!fetched\.truncated\) \{\s*await supabaseAdmin\.from\('bank_accounts'\)\.update\(\{ last_synced_at/);
  assert.doesNotMatch(source, /guard < 25/, 'geen stille paginalimiet meer');
  // Toestemming begrensd per bank; nieuwe rekening krijgt een eigen grootboekrekening.
  assert.match(source, /consentValidUntil\(Date\.now\(\), EB_CONSENT_DAYS, await maxConsentSeconds\(/);
  assert.match(source, /rpc\('assign_own_bank_ledger_account'/);
  assert.match(source, /\.insert\(\{[\s\S]*?\}\)\.select\('id'\)\.single\(\)/, 'nieuwe rekening: id terug voor de grootboekrekening');
});
