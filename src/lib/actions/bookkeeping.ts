import {
  bookAssetAcquisition, bookAssetDisposal, bookBankTransaction, bookPurchaseInvoice,
  closeFiscalYear, closeVatPeriod, createOpeningBalance, createVatSupplement,
  ensureDefaultLedgerAccounts, generateDepreciationSchedule, insertRow, matchBankTransactions,
  openFiscalYear, postAssetDepreciation, postManualJournalEntry, reopenFiscalYear,
  reverseJournalEntry, setBankTransactionStatus, syncBankAccount, unbookBankTransaction,
  updateRow,
} from '../repository';
import { purchaseTotals } from '../../features/Bookkeeping';
import { flag, list, optText, patchOf, text, type ActionExecutor } from './types';
import type {
  BankAccount, BankRule, FixedAsset, LedgerAccount, PurchaseInvoice, PurchaseInvoiceLine, UUID,
} from '../../types';

/**
 * Uitvoerders voor de boekhoud-handelingen. Elke functie doet precies wat de knop in
 * Grootboek, Bank, Omzetbelasting, Boekjaren of Activa doet — zie
 * `supabase/functions/_shared/actions/bookkeeping.ts` voor wat er aan de gebruiker
 * beloofd wordt op de kaart die hij goedkeurt.
 *
 * De boekingen zelf lopen zonder uitzondering over de RPC's in `repository.ts`: die
 * doen de dubbele-boekhoudcontrole, de periodevergrendeling en het toekennen van een
 * boekstuknummer in één transactie. Hier wordt niets nagerekend.
 */

/** Getal uit de payload; de server heeft hem al gevalideerd. */
function amount(payload: Record<string, unknown>, key: string): number {
  const value = Number(payload[key]);
  if (!Number.isFinite(value)) throw new Error(`Deze actie mist "${key}".`);
  return value;
}

/** Bedrag in centen als leesbare tekst, zoals de boekhoudschermen het tonen. */
const euroCents = (value: number) => `€ ${(value / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Regels uit de payload; de server heeft ze al opgebouwd en gecontroleerd. */
function linesOf(payload: Record<string, unknown>, key = 'lines'): Array<Record<string, unknown>> {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Deze actie mist "${key}".`);
  return value as Array<Record<string, unknown>>;
}

export const BOOKKEEPING_EXECUTORS: Record<string, ActionExecutor> = {
  // ── Rekeningschema ────────────────────────────────────────────────────────
  'ledger.sync_chart': async (payload, ctx) => {
    await ensureDefaultLedgerAccounts(ctx.organizationId);
    return Number(payload.existing ?? 0) === 0
      ? 'Rekeningschema en btw-codes aangemaakt'
      : 'Rekeningschema nagelopen — ontbrekende rekeningen zijn toegevoegd';
  },

  'ledger_account.create': async (payload, ctx) => {
    const created = await insertRow<LedgerAccount>('ledger_accounts', ctx.organizationId, {
      code: text(payload, 'code'),
      name: text(payload, 'name'),
      type: text(payload, 'type'),
      report_group: optText(payload, 'report_group'),
      subtype: null,
      default_vat_code: optText(payload, 'default_vat_code'),
      is_restricted_reserve: flag(payload, 'is_restricted_reserve'),
      is_active: payload.is_active !== false,
    });
    return `Grootboekrekening ${created.code} · ${created.name} aangemaakt`;
  },

  'ledger_account.update': async (payload, ctx) => {
    const updated = await updateRow<LedgerAccount>('ledger_accounts', text(payload, 'account_id'), patchOf(payload), ctx.organizationId);
    return `Grootboekrekening ${updated.code} · ${updated.name} bijgewerkt`;
  },

  // ── Journaal ──────────────────────────────────────────────────────────────
  'journal.post_manual': async (payload, ctx) => {
    const entry = await postManualJournalEntry(ctx.organizationId, {
      date: text(payload, 'date'),
      description: text(payload, 'description'),
      lines: linesOf(payload),
    });
    return `Memoriaalboeking ${entry.entry_number ?? ''} geboekt op ${text(payload, 'date')}`.replace('  ', ' ');
  },

  'journal.reverse': async (payload) => {
    // reverse_journal_entry is security definer en scopet zelf op de organisatie van
    // het boekstuk; de plan-kant heeft het id al binnen deze organisatie opgezocht.
    const reversal = await reverseJournalEntry(text(payload, 'entry_id'), optText(payload, 'date') ?? undefined);
    const original = optText(payload, 'entry_number');
    return `Boekstuk ${original ?? ''} tegengeboekt met ${reversal.entry_number ?? 'een spiegelboeking'}`.replace('  ', ' ');
  },

  'journal.opening_balance': async (payload, ctx) => {
    const entry = await createOpeningBalance(ctx.organizationId, text(payload, 'as_of'), linesOf(payload));
    return `Beginbalans per ${text(payload, 'as_of')} vastgelegd (boekstuk ${entry.entry_number ?? ''})`.replace(' )', ')');
  },

  // ── Leveranciers en inkoopfacturen ────────────────────────────────────────
  'supplier.update': async (payload, ctx) => {
    await updateRow('suppliers', text(payload, 'supplier_id'), patchOf(payload), ctx.organizationId);
    return `Leverancier ${optText(payload, 'name') ?? ''} bijgewerkt`.replace('  ', ' ');
  },

  'purchase_invoice.update': async (payload, ctx) => {
    const invoiceId = text(payload, 'purchase_invoice_id');
    const values: Record<string, unknown> = { ...patchOf(payload) };
    if (Array.isArray(payload.lines)) {
      // Totalen op dezelfde manier als het inkoopfactuurformulier: per (rekening,
      // btw-code, tarief) afronden en dan sommeren, met 4500 als vangnet voor een
      // regel zonder rekening — zo sluit het totaal cent-exact aan op wat
      // book_purchase_invoice straks op 1600 zet.
      const lines = payload.lines as PurchaseInvoiceLine[];
      const fallbackAccountId = ctx.data.ledgerAccounts.find(a => a.code === '4500')?.id ?? null;
      const totals = purchaseTotals(lines, fallbackAccountId);
      values.lines = lines;
      values.subtotal_cents = totals.subtotal_cents;
      values.vat_cents = totals.vat_cents;
      values.total_cents = totals.total_cents;
    }
    const updated = await updateRow<PurchaseInvoice>('purchase_invoices', invoiceId, values, ctx.organizationId);
    return `Concept-inkoopfactuur ${updated.internal_number ?? updated.supplier_invoice_number ?? ''} bijgewerkt (${euroCents(updated.total_cents)})`;
  },

  'purchase_invoice.book': async (payload, ctx) => {
    const entry = await bookPurchaseInvoice(ctx.organizationId, text(payload, 'purchase_invoice_id'));
    const number = optText(payload, 'number');
    const supplier = optText(payload, 'supplier_name');
    return `Inkoopfactuur ${number ?? ''}${supplier ? ` van ${supplier}` : ''} geboekt als ${entry.entry_number ?? 'boekstuk'}`.replace('  ', ' ');
  },

  // ── Bank ──────────────────────────────────────────────────────────────────
  'bank_account.create': async (payload, ctx) => {
    const created = await insertRow<BankAccount>('bank_accounts', ctx.organizationId, {
      name: text(payload, 'name'),
      iban: optText(payload, 'iban'),
      currency: optText(payload, 'currency') ?? 'EUR',
      ledger_account_id: text(payload, 'ledger_account_id'),
      is_active: true,
      source: 'import',
    });
    return `Bankrekening "${created.name}" aangemaakt`;
  },

  'bank_account.update': async (payload, ctx) => {
    const updated = await updateRow<BankAccount>('bank_accounts', text(payload, 'bank_account_id'), patchOf(payload), ctx.organizationId);
    return `Bankrekening "${updated.name}" bijgewerkt`;
  },

  'bank_account.sync': async (payload, ctx) => {
    const bankAccountId = optText(payload, 'bank_account_id') as UUID | null;
    const result = await syncBankAccount(ctx.organizationId, bankAccountId ?? undefined);
    if (result.needsReconsent) {
      throw new Error('De banktoestemming is verlopen. Koppel de bank opnieuw via Bank → Rekeningen & koppeling.');
    }
    const totals = result.results.reduce((acc, r) => ({
      inserted: acc.inserted + (r.error ? 0 : r.inserted),
      skipped: acc.skipped + (r.error ? 0 : r.skipped),
      failed: acc.failed + (r.error ? 1 : 0),
    }), { inserted: 0, skipped: 0, failed: 0 });
    // Ging élke rekening onderuit, dan is er niets opgehaald; dat hoort een fout te
    // zijn en geen geruststellende "0 nieuwe transacties".
    if (totals.failed > 0 && totals.failed === result.results.length) {
      throw new Error(result.results.find(r => r.error)?.error ?? 'Synchroniseren mislukt.');
    }
    const where = optText(payload, 'name');
    return `${totals.inserted} nieuwe en ${totals.skipped} al bekende transacties opgehaald${where ? ` bij ${where}` : ''}`;
  },

  'bank.rematch': async (payload, ctx) => {
    const bankAccountId = optText(payload, 'bank_account_id') as UUID | null;
    const result = await matchBankTransactions(ctx.organizationId, bankAccountId);
    const scope = optText(payload, 'scope');
    return `${result.suggested} transacties kregen een voorstel en ${result.auto_booked} zijn automatisch geboekt${scope ? ` (${scope})` : ''}`;
  },

  'bank_transaction.book': async (payload, ctx) => {
    const transactionId = text(payload, 'transaction_id');
    const mode = text(payload, 'mode');
    const options = mode === 'purchase'
      ? { matchedPurchaseInvoiceId: text(payload, 'purchase_invoice_id') as UUID }
      : { lines: [payload.line as Record<string, unknown>] };
    const entry = await bookBankTransaction(ctx.organizationId, transactionId, options);
    const label = optText(payload, 'label') ?? 'Banktransactie';
    const target = optText(payload, 'target');
    return `${label} van ${euroCents(amount(payload, 'amount_cents'))} geboekt${target ? ` tegen ${target}` : ''} (boekstuk ${entry.entry_number ?? '—'})`;
  },

  'bank_transaction.set_status': async (payload, ctx) => {
    const status = text(payload, 'status') as 'unmatched' | 'ignored';
    await setBankTransactionStatus(ctx.organizationId, text(payload, 'transaction_id'), status);
    const label = optText(payload, 'label') ?? 'Banktransactie';
    return status === 'ignored' ? `${label} genegeerd` : `${label} staat weer op de af-te-letteren-lijst`;
  },

  'bank_transaction.unbook': async (payload, ctx) => {
    await unbookBankTransaction(ctx.organizationId, text(payload, 'transaction_id'));
    return `${optText(payload, 'label') ?? 'Banktransactie'} teruggedraaid — er staat een tegenboeking in het grootboek`;
  },

  'bank_rule.create': async (payload, ctx) => {
    const created = await insertRow<BankRule>('bank_rules', ctx.organizationId, {
      name: text(payload, 'name'),
      priority: amount(payload, 'priority'),
      match_direction: text(payload, 'match_direction'),
      match_counterparty_iban: optText(payload, 'match_counterparty_iban'),
      match_counterparty_name_contains: optText(payload, 'match_counterparty_name_contains'),
      match_description_contains: optText(payload, 'match_description_contains'),
      match_amount_cents: payload.match_amount_cents == null ? null : amount(payload, 'match_amount_cents'),
      target_account_id: optText(payload, 'target_account_id'),
      target_vat_code: optText(payload, 'target_vat_code'),
      auto_book: flag(payload, 'auto_book'),
      is_active: payload.is_active !== false,
    });
    return `Bankregel "${created.name}" aangemaakt${created.auto_book ? ' — hij boekt voortaan automatisch' : ''}`;
  },

  'bank_rule.update': async (payload, ctx) => {
    const updated = await updateRow<BankRule>('bank_rules', text(payload, 'rule_id'), patchOf(payload), ctx.organizationId);
    return `Bankregel "${updated.name}" bijgewerkt`;
  },

  // ── Omzetbelasting ────────────────────────────────────────────────────────
  'vat_return.close_period': async (payload, ctx) => {
    await closeVatPeriod(ctx.organizationId, {
      periodType: text(payload, 'period_type') as 'month' | 'quarter',
      year: amount(payload, 'year'),
      periodIndex: amount(payload, 'period_index'),
      from: text(payload, 'from'),
      to: text(payload, 'to'),
    });
    const saldo = amount(payload, 'saldo_cents');
    return `Btw-periode ${text(payload, 'label')} afgesloten — ${saldo === 0 ? 'nihilaangifte' : `${euroCents(Math.abs(saldo))} ${saldo > 0 ? 'af te dragen' : 'terug te ontvangen'}`} doorgeboekt en de periode is vergrendeld`;
  },

  'vat_return.set_status': async (payload, ctx) => {
    const status = text(payload, 'status');
    await updateRow('vat_returns', text(payload, 'vat_return_id'), { status }, ctx.organizationId);
    return `Btw-aangifte ${optText(payload, 'label') ?? ''} staat nu op ${status === 'filed' ? 'ingediend' : 'betaald'}`.replace('  ', ' ');
  },

  'vat_supplement.create': async (payload, ctx) => {
    const supplement = await createVatSupplement(ctx.organizationId, {
      originalReturnId: text(payload, 'original_return_id'),
      entryIds: list(payload, 'entry_ids'),
      date: optText(payload, 'date') ?? undefined,
      notes: optText(payload, 'notes'),
    });
    const saldo = Number(supplement.rubrieken?.saldo_afgerond ?? supplement.rubrieken?.saldo ?? 0);
    return `Suppletie ${optText(payload, 'label') ?? ''} vastgelegd — ${euroCents(Math.abs(saldo))} ${saldo >= 0 ? 'alsnog te betalen' : 'terug te ontvangen'}`.replace('  ', ' ');
  },

  // ── Boekjaren ─────────────────────────────────────────────────────────────
  'fiscal_year.open': async (payload, ctx) => {
    const year = await openFiscalYear(ctx.organizationId, {
      periodStart: text(payload, 'period_start'),
      periodEnd: text(payload, 'period_end'),
      label: optText(payload, 'label'),
    });
    return `Boekjaar ${year.label} geopend (${year.period_start} t/m ${year.period_end})`;
  },

  'fiscal_year.close': async (payload, ctx) => {
    const year = await closeFiscalYear(ctx.organizationId, text(payload, 'fiscal_year_id'));
    return `Boekjaar ${year.label} afgesloten — resultaat ${euroCents(year.result_cents ?? 0)} geboekt naar ${year.result_account_code ?? 'de resultaatrekening'}`;
  },

  'fiscal_year.reopen': async (payload, ctx) => {
    const year = await reopenFiscalYear(ctx.organizationId, text(payload, 'fiscal_year_id'));
    return `Boekjaar ${year.label} heropend — het jaarafsluitboekstuk is vervallen`;
  },

  // ── Vaste activa ──────────────────────────────────────────────────────────
  'asset.create': async (payload, ctx) => {
    const created = await insertRow<FixedAsset>('fixed_assets', ctx.organizationId, {
      name: text(payload, 'name'),
      asset_number: optText(payload, 'asset_number'),
      category: optText(payload, 'category'),
      acquisition_date: text(payload, 'acquisition_date'),
      acquisition_cost_cents: amount(payload, 'acquisition_cost_cents'),
      residual_value_cents: amount(payload, 'residual_value_cents'),
      useful_life_months: amount(payload, 'useful_life_months'),
      start_date: text(payload, 'start_date'),
      asset_account_id: text(payload, 'asset_account_id'),
      depreciation_account_id: text(payload, 'depreciation_account_id'),
      accumulated_depreciation_account_id: text(payload, 'accumulated_depreciation_account_id'),
      source_purchase_invoice_id: optText(payload, 'source_purchase_invoice_id'),
      notes: optText(payload, 'notes'),
    });
    return `Activum "${created.name}" aangemaakt (${euroCents(created.acquisition_cost_cents)} over ${created.useful_life_months} maanden)`;
  },

  'asset.update': async (payload, ctx) => {
    const updated = await updateRow<FixedAsset>('fixed_assets', text(payload, 'asset_id'), patchOf(payload), ctx.organizationId);
    return `Activum "${updated.name}" bijgewerkt`;
  },

  'asset.book_acquisition': async (payload, ctx) => {
    const asset = await bookAssetAcquisition(
      ctx.organizationId,
      text(payload, 'asset_id'),
      text(payload, 'credit_account_id'),
      optText(payload, 'date') ?? undefined,
    );
    return `Aanschaf van "${asset.name}" geboekt — ${euroCents(asset.acquisition_cost_cents)} staat nu op de balans`;
  },

  'asset.generate_schedule': async (payload, ctx) => {
    const schedule = await generateDepreciationSchedule(ctx.organizationId, text(payload, 'asset_id'));
    return `Afschrijvingsschema van "${optText(payload, 'name') ?? 'het activum'}" berekend: ${schedule.length} termijnen`;
  },

  'asset.post_depreciation': async (payload, ctx) => {
    await postAssetDepreciation(ctx.organizationId, text(payload, 'asset_id'), text(payload, 'through_date'));
    const count = amount(payload, 'count');
    return `${count} afschrijvingstermijn${count === 1 ? '' : 'en'} van "${optText(payload, 'name') ?? 'het activum'}" geboekt (${euroCents(amount(payload, 'total_cents'))})`;
  },

  'asset.dispose': async (payload, ctx) => {
    const asset = await bookAssetDisposal(
      ctx.organizationId,
      text(payload, 'asset_id'),
      text(payload, 'counter_account_id'),
      amount(payload, 'proceeds_cents'),
      optText(payload, 'date') ?? undefined,
    );
    return `Activum "${asset.name}" afgestoten per ${asset.disposal_date ?? text(payload, 'date')} — opbrengst ${euroCents(asset.disposal_proceeds_cents ?? 0)}`;
  },

};
