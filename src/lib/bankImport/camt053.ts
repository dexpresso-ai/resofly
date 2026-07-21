import type { ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { normalizeDate } from './dedup';

/**
 * CAMT.053-parser (ISO 20022 bankafschrift, het formaat dat élke NL-bank levert).
 * We lezen op entry-niveau (Ntry): bedrag + CdtDbtInd voor het teken, datums,
 * de bankreferentie als bank_tx_id, en de eerste TxDtls voor tegenpartij +
 * omschrijving. Eén transactie per Ntry is voldoende voor aflettering.
 */
export function parseCamt053(xml: string, fileName: string): ParsedBankStatement {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Dit lijkt geen geldig CAMT.053-bestand (XML kon niet worden gelezen).');
  }

  const text = (el: Element | null | undefined): string => (el?.textContent ?? '').trim();
  // Zoek op lokale naam, namespace-agnostisch (getElementsByTagNameNS('*', naam)).
  // Zo werkt het ongeacht of de bank de CAMT-tags zonder prefix (default namespace)
  // of mét prefix (bv. <ns2:Ntry>) levert — beide komen voor.
  const local = (root: Element | Document, name: string): Element[] =>
    Array.from(root.getElementsByTagNameNS('*', name));
  const firstLocal = (root: Element, name: string): Element | null => local(root, name)[0] ?? null;

  const entries = local(doc, 'Ntry');
  if (entries.length === 0) {
    throw new Error('Geen transacties (Ntry) gevonden in dit CAMT.053-bestand.');
  }

  const transactions: ParsedBankTransaction[] = entries.map(ntry => {
    const indicator = text(firstLocal(ntry, 'CdtDbtInd')).toUpperCase();
    const sign = indicator === 'DBIT' ? -1 : 1;
    const amtEl = firstLocal(ntry, 'Amt');
    const currency = amtEl?.getAttribute('Ccy') || 'EUR';
    const amount = Math.round((parseFloat(text(amtEl)) || 0) * 100) * sign;

    const bookgDtEl = firstLocal(ntry, 'BookgDt');
    const valDtEl = firstLocal(ntry, 'ValDt');
    const bookingDate = normalizeDate(text(firstLocal(bookgDtEl ?? ntry, 'Dt')) || text(firstLocal(bookgDtEl ?? ntry, 'DtTm')).slice(0, 10));
    const valueDate = valDtEl ? normalizeDate(text(firstLocal(valDtEl, 'Dt')) || text(firstLocal(valDtEl, 'DtTm')).slice(0, 10)) : null;

    const bankTxId = text(firstLocal(ntry, 'AcctSvcrRef')) || text(firstLocal(ntry, 'NtryRef')) || null;

    // Tegenpartij + omschrijving uit de eerste transactiedetails.
    const txDtls = firstLocal(ntry, 'TxDtls') ?? ntry;
    const rmt = local(txDtls, 'Ustrd').map(text).filter(Boolean).join(' ').trim()
      || text(firstLocal(txDtls, 'AddtlNtryInf'));
    const endToEnd = text(firstLocal(txDtls, 'EndToEndId')) || null;
    const structuredRef = text(firstLocal(firstLocal(txDtls, 'CdtrRefInf') ?? txDtls, 'Ref')) || null;

    // Bij een bijschrijving is de tegenpartij de Debtor, bij een afschrijving de Creditor.
    const rltdPties = firstLocal(txDtls, 'RltdPties');
    let counterpartyName: string | null = null;
    let counterpartyIban: string | null = null;
    if (rltdPties) {
      const party = sign > 0 ? firstLocal(rltdPties, 'Dbtr') : firstLocal(rltdPties, 'Cdtr');
      const acct = sign > 0 ? firstLocal(rltdPties, 'DbtrAcct') : firstLocal(rltdPties, 'CdtrAcct');
      counterpartyName = (party ? text(firstLocal(party, 'Nm')) : '') || null;
      counterpartyIban = (acct ? text(firstLocal(acct, 'IBAN')) : '') || null;
    }

    return {
      booking_date: bookingDate ?? valueDate ?? '',
      value_date: valueDate,
      amount_cents: amount,
      currency,
      counterparty_name: counterpartyName,
      counterparty_iban: counterpartyIban,
      description: rmt || null,
      structured_reference: structuredRef,
      end_to_end_id: endToEnd,
      bank_tx_id: bankTxId,
    };
  }).filter(t => t.booking_date && t.amount_cents !== 0);

  // Periode + begin/eindsaldo uit het Stmt-blok.
  const stmt = local(doc, 'Stmt')[0] ?? null;
  const balances = stmt ? local(stmt, 'Bal') : [];
  const balanceCents = (code: string): number | null => {
    for (const bal of balances) {
      const cd = text(firstLocal(bal, 'Cd')).toUpperCase();
      if (cd === code) {
        const ind = text(firstLocal(bal, 'CdtDbtInd')).toUpperCase();
        const amt = Math.round((parseFloat(text(firstLocal(bal, 'Amt'))) || 0) * 100);
        return ind === 'DBIT' ? -amt : amt;
      }
    }
    return null;
  };
  const frToDt = stmt ? firstLocal(stmt, 'FrToDt') : null;

  const warnings: string[] = [];
  const skipped = entries.length - transactions.length;
  if (skipped > 0) {
    warnings.push(`${skipped} regel(s) overgeslagen: geen leesbare boekdatum of een bedrag van € 0,00.`);
  }
  // Meerdere Stmt-blokken = meerdere rekeningen in één bestand. We lezen álle
  // entries in, maar begin-/eindsaldo komen uit het eerste blok — dan klopt de
  // saldo-aansluiting niet en moet de gebruiker per rekening exporteren.
  const stmtCount = local(doc, 'Stmt').length;
  if (stmtCount > 1) {
    warnings.push(`Dit bestand bevat ${stmtCount} afschriften (meerdere rekeningen). Alle transacties komen op deze ene bankrekening binnen en het begin-/eindsaldo is dat van het eerste afschrift. Exporteer bij voorkeur per rekening.`);
  }

  return {
    format: 'camt053',
    file_name: fileName,
    file_hash: null,
    period_start: frToDt ? normalizeDate(text(firstLocal(frToDt, 'FrDtTm')).slice(0, 10)) : null,
    period_end: frToDt ? normalizeDate(text(firstLocal(frToDt, 'ToDtTm')).slice(0, 10)) : null,
    opening_balance_cents: balanceCents('OPBD'),
    closing_balance_cents: balanceCents('CLBD'),
    warnings,
    transactions,
  };
}
