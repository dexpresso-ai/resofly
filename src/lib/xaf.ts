import type { AppData, JournalEntry, JournalLine } from '../types';

/**
 * XML Auditfile Financieel (XAF) 3.2 — het standaard uitwisselformaat van de
 * Belastingdienst/SBR waarmee een accountant of een ander boekhoudpakket de
 * volledige administratie kan inlezen (review 3.1: dit was een harde blocker).
 *
 * De export is bewust client-side: sinds de pagineringsfix (review 3.10) bevat
 * AppData het VOLLEDIGE journaal, dus alle gegevens zijn al in de browser. De
 * opbouw volgt het 3.2-schema (http://www.auditfiles.nl/XAF/3.2): header →
 * company (klanten/leveranciers, rekeningschema, btw-codes, perioden,
 * beginbalans, transacties per dagboek).
 *
 * Alleen 'posted' boekstukken tellen mee — 'reversed' (boekjaar-heropening)
 * staat ook in de rapportages niet; een tegengeboekt paar is twee keer posted
 * en telt netto nul, precies zoals in de W&V/balans.
 */

const XAF_NS = 'http://www.auditfiles.nl/XAF/3.2';

const esc = (v: string): string => v
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Bedrag in euro's met twee decimalen (XAF verwacht decimalen, geen centen). */
const amt = (cents: number): string => (Math.abs(cents) / 100).toFixed(2);
const amntTp = (cents: number): 'D' | 'C' => (cents >= 0 ? 'D' : 'C');

const tag = (name: string, value: string | number): string => `<${name}>${esc(String(value))}</${name}>`;

/** Dagboekindeling: elk boekstuk valt op basis van zijn bron in één dagboek. */
const JOURNALS: { jrnID: string; desc: string; jrnTp: string; sources: string[] }[] = [
  { jrnID: 'VRK', desc: 'Verkoopboek', jrnTp: 'S', sources: ['sales_invoice', 'credit_note'] },
  { jrnID: 'INK', desc: 'Inkoopboek', jrnTp: 'P', sources: ['purchase_invoice'] },
  { jrnID: 'BNK', desc: 'Bankboek', jrnTp: 'B', sources: ['payment'] },
  { jrnID: 'OPN', desc: 'Openingsbalans', jrnTp: 'O', sources: ['opening_balance'] },
  // Elk brontype moet in precies één dagboek vallen: een boekstuk waarvan het
  // brontype hier ontbreekt, verdwijnt geruisloos uit <transactions> én uit de
  // totalen, terwijl het in de beginbalans van het volgende jaar wél meetelt —
  // dan sluiten twee auditfiles onderling niet meer aan.
  { jrnID: 'MEM', desc: 'Memoriaal', jrnTp: 'M', sources: ['manual', 'asset_depreciation', 'asset_acquisition', 'asset_disposal', 'vat_return', 'year_close', 'result_appropriation', 'corporate_tax'] },
];

export interface XafInput {
  data: AppData;
  /** Boekjaargrenzen (kunnen een gebroken boekjaar zijn). */
  fiscalYearLabel: string;
  startDate: string;
  endDate: string;
}

export function buildXaf({ data, fiscalYearLabel, startDate, endDate }: XafInput): string {
  const company = data.companySettings;
  const linesByEntry = new Map<string, JournalLine[]>();
  for (const line of data.journalLines) {
    const arr = linesByEntry.get(line.entry_id) ?? [];
    arr.push(line);
    linesByEntry.set(line.entry_id, arr);
  }
  linesByEntry.forEach(arr => arr.sort((a, b) => a.line_index - b.line_index));

  const accountById = new Map(data.ledgerAccounts.map(a => [a.id, a]));
  const posted = data.journalEntries.filter(e => e.status === 'posted');
  const inYear = posted.filter(e => e.date >= startDate && e.date <= endDate);
  const beforeYear = posted.filter(e => e.date < startDate);

  // ---------------- Klanten & leveranciers ----------------
  const custSup: string[] = [];
  for (const c of data.clients) {
    custSup.push('<customerSupplier>'
      + tag('custSupID', `C-${c.client_code || c.id}`)
      + tag('custSupName', c.name || '—')
      + tag('custSupTp', 'C')
      + (c.vat_number ? tag('taxRegIdent', c.vat_number) : '')
      + '</customerSupplier>');
  }
  for (const s of data.suppliers) {
    custSup.push('<customerSupplier>'
      + tag('custSupID', `S-${s.supplier_code || s.id}`)
      + tag('custSupName', s.name || '—')
      + tag('custSupTp', 'S')
      + (s.vat_number ? tag('taxRegIdent', s.vat_number) : '')
      + '</customerSupplier>');
  }
  const clientCode = new Map(data.clients.map(c => [c.id, `C-${c.client_code || c.id}`]));
  const supplierCode = new Map(data.suppliers.map(s => [s.id, `S-${s.supplier_code || s.id}`]));

  // ---------------- Rekeningschema ----------------
  // accTp: B = balansrekening, P = winst-en-verliesrekening.
  const ledger = data.ledgerAccounts.map(a => '<ledgerAccount>'
    + tag('accID', a.code)
    + tag('accDesc', a.name)
    + tag('accTp', a.type === 'revenue' || a.type === 'expense' ? 'P' : 'B')
    + '</ledgerAccount>');

  // ---------------- BTW-codes ----------------
  const vat = data.vatCodes.map(v => '<vatCode>'
    + tag('vatID', v.code)
    + tag('vatDesc', `${v.label} (${v.rate}%)`)
    + '</vatCode>');

  // ---------------- Perioden (maanden binnen het boekjaar) ----------------
  const periods: string[] = [];
  const periodNumberOf = (date: string): number => {
    const [sy, sm] = startDate.split('-').map(Number);
    const [y, m] = date.split('-').map(Number);
    return (y - sy) * 12 + (m - sm) + 1;
  };
  {
    const [sy, sm] = startDate.split('-').map(Number);
    for (let i = 0; i < 12; i++) {
      const y = sy + Math.floor((sm - 1 + i) / 12);
      const m = ((sm - 1 + i) % 12) + 1;
      const first = `${y}-${String(m).padStart(2, '0')}-01`;
      const last = `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
      if (first > endDate) break;
      periods.push('<period>'
        + tag('periodNumber', i + 1)
        + tag('periodDesc', `Periode ${i + 1} (${first} t/m ${last})`)
        + tag('startDatePeriod', first)
        + tag('endDatePeriod', last > endDate ? endDate : last)
        + '</period>');
    }
  }

  // ---------------- Beginbalans ----------------
  // Balansstand per rekening uit alles vóór de startdatum; het cumulatieve
  // W&V-saldo van vóór het boekjaar (nog niet via jaarafsluiting bestemd)
  // wordt als één regel op de resultaatrekening gezet zodat de beginbalans
  // per constructie sluit (elke journaalpost is immers in balans).
  const obByAccount = new Map<string, number>();
  let obResult = 0;
  for (const entry of beforeYear) {
    for (const line of linesByEntry.get(entry.id) ?? []) {
      const account = accountById.get(line.account_id);
      const delta = line.debit_cents - line.credit_cents;
      if (!account || account.type === 'revenue' || account.type === 'expense') {
        obResult += delta;
      } else {
        obByAccount.set(line.account_id, (obByAccount.get(line.account_id) ?? 0) + delta);
      }
    }
  }
  const obLines: string[] = [];
  let obNr = 0;
  let obDebit = 0;
  let obCredit = 0;
  for (const [accountId, cents] of obByAccount) {
    if (cents === 0) continue;
    const account = accountById.get(accountId);
    obNr += 1;
    if (cents >= 0) obDebit += cents; else obCredit += -cents;
    obLines.push('<obLine>'
      + tag('nr', obNr)
      + tag('accID', account?.code ?? '????')
      + tag('amnt', amt(cents))
      + tag('amntTp', amntTp(cents))
      + '</obLine>');
  }
  if (obResult !== 0) {
    const resultCode = data.ledgerAccounts.find(a => a.code === (company?.year_result_account_code || '0510'))?.code
      ?? data.ledgerAccounts.find(a => a.code === '0500')?.code ?? '0500';
    obNr += 1;
    if (obResult >= 0) obDebit += obResult; else obCredit += -obResult;
    obLines.push('<obLine>'
      + tag('nr', obNr)
      + tag('accID', resultCode)
      + tag('amnt', amt(obResult))
      + tag('amntTp', amntTp(obResult))
      + '</obLine>');
  }

  // ---------------- Transacties per dagboek ----------------
  let totalLines = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  const journalXml: string[] = [];
  for (const journal of JOURNALS) {
    const entries = inYear
      .filter(e => journal.sources.includes(e.source_type))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.entry_number ?? '').localeCompare(b.entry_number ?? '')));
    if (entries.length === 0) continue;
    const txXml = entries.map(entry => transactionXml(entry, linesByEntry.get(entry.id) ?? [], {
      accountById, clientCode, supplierCode, periodNumberOf,
      onLine: (debit, credit) => { totalLines += 1; totalDebit += debit; totalCredit += credit; },
    }));
    journalXml.push('<journal>'
      + tag('jrnID', journal.jrnID)
      + tag('desc', journal.desc)
      + tag('jrnTp', journal.jrnTp)
      + txXml.join('')
      + '</journal>');
  }

  const header = '<header>'
    + tag('fiscalYear', fiscalYearLabel)
    + tag('startDate', startDate)
    + tag('endDate', endDate)
    + tag('curCode', 'EUR')
    + tag('dateCreated', new Date().toISOString().slice(0, 10))
    + tag('softwareDesc', 'ResoFly')
    + tag('softwareVersion', '1.0')
    + '</header>';

  const companyXml = '<company>'
    + (company?.kvk_number ? tag('companyIdent', company.kvk_number) : '')
    + tag('companyName', company?.company_name || 'Onbekend')
    + tag('taxRegistrationCountry', 'NL')
    + (company?.vat_number ? tag('taxRegIdent', company.vat_number) : '')
    + `<customersSuppliers>${custSup.join('')}</customersSuppliers>`
    + `<generalLedger>${ledger.join('')}</generalLedger>`
    + `<vatCodes>${vat.join('')}</vatCodes>`
    + `<periods>${periods.join('')}</periods>`
    + '<openingBalance>'
    + tag('opBalDate', startDate)
    + tag('linesCount', obNr)
    + tag('totalDebit', amt(obDebit))
    + tag('totalCredit', amt(obCredit))
    + obLines.join('')
    + '</openingBalance>'
    + '<transactions>'
    + tag('linesCount', totalLines)
    + tag('totalDebit', amt(totalDebit))
    + tag('totalCredit', amt(totalCredit))
    + journalXml.join('')
    + '</transactions>'
    + '</company>';

  return `<?xml version="1.0" encoding="UTF-8"?>\n<auditfile xmlns="${XAF_NS}">${header}${companyXml}</auditfile>`;
}

function transactionXml(
  entry: JournalEntry,
  lines: JournalLine[],
  ctx: {
    accountById: Map<string, { code: string }>;
    clientCode: Map<string, string>;
    supplierCode: Map<string, string>;
    periodNumberOf: (date: string) => number;
    onLine: (debit: number, credit: number) => void;
  },
): string {
  const totalDebit = lines.reduce((s, l) => s + l.debit_cents, 0);
  const lineXml = lines.map((line, i) => {
    ctx.onLine(line.debit_cents, line.credit_cents);
    const cents = line.debit_cents - line.credit_cents;
    const custSupId = line.client_id
      ? ctx.clientCode.get(line.client_id)
      : line.supplier_id
        ? ctx.supplierCode.get(line.supplier_id)
        : undefined;
    const vatXml = line.vat_code
      ? '<vat>'
        + tag('vatID', line.vat_code)
        + tag('vatPerc', String(line.vat_rate ?? 0))
        + tag('vatAmnt', amt(line.vat_amount_cents ?? 0))
        + tag('vatAmntTp', (line.vat_amount_cents ?? 0) >= 0 ? 'D' : 'C')
        + '</vat>'
      : '';
    return '<trLine>'
      + tag('nr', i + 1)
      + tag('accID', ctx.accountById.get(line.account_id)?.code ?? '????')
      + tag('docRef', entry.entry_number ?? entry.id)
      + tag('effDate', entry.date)
      + tag('desc', line.description ?? entry.description ?? '')
      + tag('amnt', amt(cents))
      + tag('amntTp', amntTp(cents))
      + (custSupId ? tag('custSupID', custSupId) : '')
      + vatXml
      + '</trLine>';
  }).join('');

  return '<transaction>'
    + tag('nr', entry.entry_number ?? entry.id)
    + tag('desc', entry.description ?? '')
    + tag('periodNumber', ctx.periodNumberOf(entry.date))
    + tag('trDt', entry.date)
    + tag('amnt', amt(totalDebit))
    + tag('amntTp', 'D')
    + lineXml
    + '</transaction>';
}

export function downloadXaf(input: XafInput): void {
  const xml = buildXaf(input);
  const orgSlug = (input.data.companySettings?.company_name || 'administratie')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `auditfile-${orgSlug}-${input.fiscalYearLabel.replace(/[^0-9a-zA-Z-]/g, '')}.xaf`;
  a.click();
  URL.revokeObjectURL(url);
}
