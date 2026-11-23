import type { ParsedBankAccountSection, ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { compactAccount } from './check.ts';
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

  // Per afschrift (Stmt) de eigen rekening. Die gaat mee met elke regel, zodat
  // het scherm vóór het inlezen kan zien of het bestand bij de gekozen rekening
  // hoort (check.ts). Eerder ging een bestand met twee rekeningen in zijn geheel
  // de gekozen rekening in, met een waarschuwing pas ná het inlezen.
  const ibanOf = (st: Element): string => {
    const acct = firstLocal(st, 'Acct');
    if (!acct) return '';
    const othr = firstLocal(acct, 'Othr');
    return compactAccount(text(firstLocal(acct, 'IBAN')) || text(othr ? firstLocal(othr, 'Id') : null));
  };
  const stmts = local(doc, 'Stmt');
  const entries: Array<{ ntry: Element; account: string }> = stmts.length > 0
    ? stmts.flatMap(st => { const account = ibanOf(st); return local(st, 'Ntry').map(ntry => ({ ntry, account })); })
    : local(doc, 'Ntry').map(ntry => ({ ntry, account: '' }));
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
  const bookedEntries = entries.filter(({ ntry }) => { const st = entryStatus(ntry); return !st || st === 'BOOK'; });
  const pendingCount = entries.length - bookedEntries.length;

  const transactions: ParsedBankTransaction[] = bookedEntries.map(({ ntry, account }) => {
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

    // Bij een bijschrijving is de tegenpartij de Debtor, bij een afschrijving de
    // Creditor. Een storno (RvslInd) draait dat om: in de teruggeboekte incasso
    // van KPN (een bijschrijving) is de Debtor de zzp'er zelf, van de
    // oorspronkelijke incasso. Eerder stond er dan "je eigen naam en IBAN" als
    // tegenpartij, en leek het een privéstorting terwijl KPN kosten met btw
    // terugboekte. Wijst de gekozen kant toch naar de eigen rekening, dan nemen
    // we de andere.
    const rltdPties = firstLocal(txDtls, 'RltdPties');
    let counterpartyName: string | null = null;
    let counterpartyIban: string | null = null;
    if (rltdPties) {
      const side = (debtor: boolean) => {
        const party = firstLocal(rltdPties, debtor ? 'Dbtr' : 'Cdtr');
        const acct = firstLocal(rltdPties, debtor ? 'DbtrAcct' : 'CdtrAcct');
        return {
          name: (party ? text(firstLocal(party, 'Nm')) : '') || null,
          iban: (acct ? text(firstLocal(acct, 'IBAN')) : '') || null,
        };
      };
      const reversal = text(firstLocal(ntry, 'RvslInd')).toLowerCase() === 'true';
      const debtorSide = reversal ? sign < 0 : sign > 0;
      let party = side(debtorSide);
      if (account && compactAccount(party.iban) === account) {
        const other = side(!debtorSide);
        if (other.name || other.iban) party = other;
      }
      counterpartyName = party.name;
      counterpartyIban = party.iban;
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
      account: account || null,
    };
  }).filter(t => t.booking_date && t.amount_cents !== 0);

  // Periode + begin/eindsaldo per rekening uit de Stmt-blokken. Een export over
  // meerdere dagen bevat per dag een afschrift van dezelfde rekening: dan geldt
  // het beginsaldo van het eerste en het eindsaldo van het laatste. Bij twee
  // rekeningen in één bestand neemt het scherm het blok van de gekozen
  // rekening (check.ts); eerder telde het saldo van het eerste afschrift, ook
  // als dat van de andere rekening was.
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
  // Beginsaldo: OPBD, of anders PRCD (het eindsaldo van het vorige afschrift,
  // dus hetzelfde bedrag). Een afschrift met alleen PRCD gaf eerder beginsaldo
  // null, en dan was er geen afschriftcontrole.
  const openingOf = (st: Element): number | null => balanceOf(st, 'OPBD') ?? balanceOf(st, 'PRCD');
  const fromOf = (st: Element): string => { const f = firstLocal(st, 'FrToDt'); return f ? text(firstLocal(f, 'FrDtTm')).slice(0, 10) : ''; };
  const toOf = (st: Element): string => { const f = firstLocal(st, 'FrToDt'); return f ? text(firstLocal(f, 'ToDtTm')).slice(0, 10) : ''; };
  const byAccount = new Map<string, Element[]>();
  for (const st of stmts) {
    const key = ibanOf(st);
    byAccount.set(key, [...(byAccount.get(key) ?? []), st]);
  }
  const accounts: ParsedBankAccountSection[] = [...byAccount.entries()].map(([account, group]) => {
    const ordered = [...group].sort((a, b) => (fromOf(a) || toOf(a)).localeCompare(fromOf(b) || toOf(b)));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    return {
      account,
      period_start: fromOf(first) ? normalizeDate(fromOf(first)) : null,
      period_end: toOf(last) ? normalizeDate(toOf(last)) : null,
      opening_balance_cents: openingOf(first),
      closing_balance_cents: balanceOf(last, 'CLBD'),
    };
  });
  const main = accounts[0] ?? null;

  const warnings: string[] = [];
  const skipped = bookedEntries.length - transactions.length;
  if (pendingCount > 0) {
    warnings.push(`${pendingCount} post(en) overgeslagen die de bank nog niet heeft geboekt (status in behandeling). Importeer later opnieuw; dan komen ze mee.`);
  }
  if (skipped > 0) {
    warnings.push(`${skipped} regel(s) overgeslagen: geen leesbare boekdatum of een bedrag van € 0,00.`);
  }

  return {
    format: 'camt053',
    file_name: fileName,
    file_hash: null,
    period_start: main?.period_start ?? null,
    period_end: main?.period_end ?? null,
    opening_balance_cents: main?.opening_balance_cents ?? null,
    closing_balance_cents: main?.closing_balance_cents ?? null,
    warnings,
    transactions,
    accounts: accounts.filter(a => a.account),
  };
}
