import type { ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { normalizeDate } from './dedup.ts';

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

  // Alleen geboekte posten. Een post met status PDNG (nog niet geboekt) of INFO
  // kwam eerder als geboekt binnen; verdwijnt hij later of verandert hij, dan
  // klopt de bank niet meer.
  const entryStatus = (ntry: Element): string => {
    const sts = firstLocal(ntry, 'Sts');
    return (text(sts ? firstLocal(sts, 'Cd') : null) || text(sts)).toUpperCase();
  };
  const bookedEntries = entries.filter(ntry => { const st = entryStatus(ntry); return !st || st === 'BOOK'; });
  const pendingCount = entries.length - bookedEntries.length;

  const transactions: ParsedBankTransaction[] = bookedEntries.map(ntry => {
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

    // Tegenpartij + omschrijving uit de transactiedetails. Bij een batch (meer
    // TxDtls in één post) gingen alle omschrijvingen behalve de eerste verloren;
    // nu staan ze er samen in, met het aantal. AddtlNtryInf hoort bij de post
    // zelf (niet bij TxDtls) en is vaak de enige omschrijving van een pinbetaling.
    const allTxDtls = local(ntry, 'TxDtls');
    const txDtls = allTxDtls[0] ?? ntry;
    const ustrd = (el: Element) => local(el, 'Ustrd').map(text).filter(Boolean).join(' ').trim();
    const batchText = allTxDtls.length > 1
      ? `Batch van ${allTxDtls.length} posten: ${allTxDtls.map(ustrd).filter(Boolean).slice(0, 10).join(' | ')}`.trim()
      : '';
    const rmt = batchText || ustrd(txDtls)
      || text(firstLocal(txDtls, 'AddtlNtryInf')) || text(firstLocal(ntry, 'AddtlNtryInf'));
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

  // Periode + begin/eindsaldo uit de Stmt-blokken. Een export over meerdere
  // dagen bevat per dag een afschrift van dezelfde rekening: dan geldt het
  // beginsaldo van het eerste en het eindsaldo van het laatste. Eerder telden
  // alleen de saldi en de periode van dag 1, met een onterechte melding over
  // meerdere rekeningen.
  const stmts = local(doc, 'Stmt');
  const balanceOf = (st: Element | null, code: string): number | null => {
    for (const bal of st ? local(st, 'Bal') : []) {
      const cd = text(firstLocal(bal, 'Cd')).toUpperCase();
      if (cd === code) {
        const ind = text(firstLocal(bal, 'CdtDbtInd')).toUpperCase();
        const amt = Math.round((parseFloat(text(firstLocal(bal, 'Amt'))) || 0) * 100);
        return ind === 'DBIT' ? -amt : amt;
      }
    }
    return null;
  };
  const ibanOf = (st: Element): string => { const acct = firstLocal(st, 'Acct'); return text(acct ? firstLocal(acct, 'IBAN') : null).replace(/\s/g, '').toUpperCase(); };
  const fromOf = (st: Element): string => { const f = firstLocal(st, 'FrToDt'); return f ? text(firstLocal(f, 'FrDtTm')).slice(0, 10) : ''; };
  const toOf = (st: Element): string => { const f = firstLocal(st, 'FrToDt'); return f ? text(firstLocal(f, 'ToDtTm')).slice(0, 10) : ''; };
  const ibans = [...new Set(stmts.map(ibanOf).filter(Boolean))];
  const sameAccount = ibans.length <= 1;
  const ordered = sameAccount ? [...stmts].sort((a, b) => (fromOf(a) || toOf(a)).localeCompare(fromOf(b) || toOf(b))) : stmts;
  const firstStmt = ordered[0] ?? null;
  const lastStmt = sameAccount ? (ordered[ordered.length - 1] ?? null) : firstStmt;

  const warnings: string[] = [];
  const skipped = bookedEntries.length - transactions.length;
  if (pendingCount > 0) {
    warnings.push(`${pendingCount} post(en) overgeslagen die de bank nog niet heeft geboekt (status in behandeling). Importeer later opnieuw; dan komen ze mee.`);
  }
  if (skipped > 0) {
    warnings.push(`${skipped} regel(s) overgeslagen: geen leesbare boekdatum of een bedrag van € 0,00.`);
  }
  // Meerdere Stmt-blokken = meerdere rekeningen in één bestand. We lezen álle
  // entries in, maar begin-/eindsaldo komen uit het eerste blok — dan klopt de
  // saldo-aansluiting niet en moet de gebruiker per rekening exporteren.
  const stmtCount = stmts.length;
  if (stmtCount > 1 && !sameAccount) {
    warnings.push(`Dit bestand bevat ${stmtCount} afschriften (meerdere rekeningen). Alle transacties komen op deze ene bankrekening binnen en het begin-/eindsaldo is dat van het eerste afschrift. Exporteer bij voorkeur per rekening.`);
  }

  return {
    format: 'camt053',
    file_name: fileName,
    file_hash: null,
    period_start: firstStmt && fromOf(firstStmt) ? normalizeDate(fromOf(firstStmt)) : null,
    period_end: lastStmt && toOf(lastStmt) ? normalizeDate(toOf(lastStmt)) : null,
    opening_balance_cents: balanceOf(firstStmt, 'OPBD'),
    closing_balance_cents: balanceOf(lastStmt, 'CLBD'),
    warnings,
    transactions,
  };
}
