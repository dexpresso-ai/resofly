import {
  addCorporateTaxCorrection, addDgaInterestRate, addShareEncumbrance, addShareTransaction,
  adoptAnnualAccounts, appropriateResult, bookDgaInterest, createShareholder, declareDividend,
  extendPreparationTerm, fileAnnualAccounts, postPayrollJournal, prepareAnnualAccounts,
  reverseAnnualAccounts, reverseCorporateTaxReturn, reverseDgaInterest, reverseDividendDistribution,
  reverseResultAppropriation, saveFiscalYearSizeInputs, signAnnualAccounts, updateShareholder,
  upsertCompanySettings,
  type ShareholderInput,
} from '../repository';
import { finalizeCorporateTax, saveCorporateTax } from '../../services/corporateTaxService';
import { renderAnnualAccountsPdf, renderAnnualAccountsPublication } from '../../services/annualAccountsService';
import { euro, dateNL } from '../format';
import { optText, text, type ActionExecutor } from './types';
import type { CompanySettingsInput, LegalForm } from '../../types';

/**
 * Uitvoerders voor de handelingen van de ZAKELIJKE MODULE (BV/Vpb). Elke functie
 * doet precies wat de knop in het scherm doet — zie
 * `supabase/functions/_shared/actions/business.ts` voor wat er aan de gebruiker
 * beloofd wordt op de kaart die hij goedkeurt.
 *
 * De zwaardere handelingen lopen niet over een gewone tabel maar over een RPC of
 * een edge function: de resultaatbestemming, het dividend, de Vpb en de hele
 * levenscyclus van de jaarrekening doen balanstests, inhoudingen en boekstukken
 * die nergens anders horen te worden nagebouwd. Daarom geeft de server een kant-en-
 * klare `input` mee en zet de uitvoerder die zonder omweg door.
 */

const euroCents = (cents: number) => euro(cents / 100);

/** De kant-en-klare argumenten die de server voor de repository-functie klaarzette. */
function argsOf<T>(payload: Record<string, unknown>, key = 'input'): T {
  const value = payload[key];
  if (!value || typeof value !== 'object') throw new Error(`Deze actie mist "${key}".`);
  return value as T;
}

/** " 2025" of "" — zodat een ontbrekend label geen dubbele spatie oplevert. */
function suffix(payload: Record<string, unknown>, key: string): string {
  const value = optText(payload, key);
  return value ? ` ${value}` : '';
}

function numberOf(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Deze actie mist "${key}".`);
  return value;
}

export const BUSINESS_EXECUTORS: Record<string, ActionExecutor> = {
  // ── De module zelf ────────────────────────────────────────────────────────
  'business.set_legal_form': async (payload, ctx) => {
    const legalForm = text(payload, 'legal_form') as LegalForm;
    const current = ctx.data.companySettings;
    if (!current) throw new Error('Er zijn nog geen bedrijfsgegevens vastgelegd; vul die eerst in bij Instellingen → Facturatie.');
    // Het scherm slaat het hele formulier op; de kolommen die niet van dat
    // formulier zijn (id, organisatie, sporen) horen niet in de upsert.
    const settings: Record<string, unknown> = { ...current, legal_form: legalForm };
    for (const key of ['id', 'organization_id', 'created_by', 'created_at', 'updated_at']) delete settings[key];
    await upsertCompanySettings(ctx.organizationId, settings as unknown as CompanySettingsInput);
    return `Rechtsvorm vastgelegd op ${optText(payload, 'label') ?? legalForm}`;
  },

  // ── Aandeelhoudersregister ────────────────────────────────────────────────
  'shareholder.create': async (payload, ctx) => {
    const created = await createShareholder(ctx.organizationId, argsOf<ShareholderInput>(payload));
    return `Aandeelhouder "${created.name}" toegevoegd aan het register`;
  },

  'shareholder.update': async (payload, ctx) => {
    const shareholderId = text(payload, 'shareholder_id');
    await updateShareholder(ctx.organizationId, shareholderId, argsOf<ShareholderInput>(payload));
    return `Gegevens van aandeelhouder "${optText(payload, 'name') ?? 'de aandeelhouder'}" bijgewerkt`;
  },

  'share_transaction.create': async (payload, ctx) => {
    await addShareTransaction(ctx.organizationId, argsOf<Parameters<typeof addShareTransaction>[1]>(payload));
    return `${optText(payload, 'summary') ?? 'Aandelenmutatie'} vastgelegd in het register`;
  },

  'share_encumbrance.create': async (payload, ctx) => {
    await addShareEncumbrance(ctx.organizationId, argsOf<Parameters<typeof addShareEncumbrance>[1]>(payload));
    return `${optText(payload, 'summary') ?? 'Bezwaring'} vastgelegd in het register`;
  },

  // ── Resultaatbestemming ───────────────────────────────────────────────────
  'result_appropriation.create': async (payload, ctx) => {
    const created = await appropriateResult(ctx.organizationId, argsOf<Parameters<typeof appropriateResult>[1]>(payload));
    const label = optText(payload, 'fiscal_year_label') ?? 'het boekjaar';
    return created.dividend_cents > 0
      ? `Resultaatbestemming ${label} geboekt: ${euroCents(created.reserves_cents)} naar de reserves en ${euroCents(created.dividend_cents)} als dividendschuld`
      : `Resultaatbestemming ${label} geboekt: ${euroCents(created.reserves_cents)} naar de overige reserves`;
  },

  'result_appropriation.reverse': async (payload, ctx) => {
    await reverseResultAppropriation(ctx.organizationId, text(payload, 'appropriation_id'));
    return `Resultaatbestemming van ${dateNL(optText(payload, 'decision_date'))} teruggedraaid`;
  },

  // ── Dividend ──────────────────────────────────────────────────────────────
  'dividend.declare': async (payload, ctx) => {
    await declareDividend(ctx.organizationId, argsOf<Parameters<typeof declareDividend>[1]>(payload));
    return `Dividend van ${euroCents(numberOf(payload, 'gross_cents'))} vastgelegd, dividendbelasting ingehouden en beide boekstukken geboekt`;
  },

  'dividend.reverse': async (payload, ctx) => {
    await reverseDividendDistribution(ctx.organizationId, text(payload, 'distribution_id'));
    return `Dividenduitkering van ${euroCents(numberOf(payload, 'gross_cents'))} van ${dateNL(optText(payload, 'decision_date'))} teruggedraaid`;
  },

  // ── DGA: rekening-courant ─────────────────────────────────────────────────
  'dga.add_interest_rate': async (payload, ctx) => {
    await addDgaInterestRate(ctx.organizationId, argsOf<Parameters<typeof addDgaInterestRate>[1]>(payload));
    return `Rentepercentage ${text(payload, 'rate_label')} voor de rekening-courant DGA vastgelegd vanaf ${dateNL(optText(payload, 'valid_from'))}`;
  },

  'dga.book_interest': async (payload, ctx) => {
    const year = numberOf(payload, 'year');
    const posting = await bookDgaInterest(ctx.organizationId, year);
    return `Rente over de rekening-courant DGA ${year} geboekt: ${euroCents(posting.interest_cents)}`;
  },

  'dga.reverse_interest': async (payload, ctx) => {
    const posting = await reverseDgaInterest(ctx.organizationId, text(payload, 'posting_id'));
    return `Renteboeking ${posting.year} teruggedraaid: ${euroCents(posting.interest_cents)}`;
  },

  // ── Loonjournaalpost ──────────────────────────────────────────────────────
  'payroll.post_journal': async (payload, ctx) => {
    const entry = await postPayrollJournal(ctx.organizationId, argsOf<Parameters<typeof postPayrollJournal>[1]>(payload));
    const number = entry.entry_number ? ` als ${entry.entry_number}` : '';
    return `Loonjournaalpost "${text(payload, 'description')}" geboekt${number}`;
  },

  // ── Vennootschapsbelasting ────────────────────────────────────────────────
  'corporate_tax.add_correction': async (payload, ctx) => {
    await addCorporateTaxCorrection(ctx.organizationId, argsOf<Parameters<typeof addCorporateTaxCorrection>[1]>(payload));
    return `Fiscale correctie "${optText(payload, 'label') ?? ''}" toegevoegd aan ${optText(payload, 'fiscal_year_label') ?? 'het boekjaar'}`;
  },

  'corporate_tax.save_draft': async (payload, ctx) => {
    const result = await saveCorporateTax(ctx.organizationId, text(payload, 'fiscal_year_id'), optText(payload, 'note'));
    return `Vpb-berekening${suffix(payload, 'fiscal_year_label')} opgeslagen als concept: ${euroCents(result.computation.taxCents)} belasting, nog niet geboekt`;
  },

  'corporate_tax.finalize': async (payload, ctx) => {
    const result = await finalizeCorporateTax(ctx.organizationId, text(payload, 'fiscal_year_id'), optText(payload, 'note'));
    return `Vennootschapsbelasting${suffix(payload, 'fiscal_year_label')} vastgesteld en geboekt: ${euroCents(result.computation.taxCents)} op 9900 tegen 1540`;
  },

  'corporate_tax.reverse': async (payload, ctx) => {
    const reversed = await reverseCorporateTaxReturn(ctx.organizationId, text(payload, 'return_id'));
    return `Vpb-berekening ${reversed.year} teruggedraaid; de reservering van ${euroCents(reversed.tax_cents)} is vervallen`;
  },

  // ── Groottecriteria en jaarrekening ───────────────────────────────────────
  'annual_accounts.save_size_inputs': async (payload, ctx) => {
    const saved = await saveFiscalYearSizeInputs(ctx.organizationId, argsOf<Parameters<typeof saveFiscalYearSizeInputs>[1]>(payload));
    return `Groottegegevens${suffix(payload, 'fiscal_year_label')} vastgelegd: gemiddeld ${saved.average_employees} werknemers`;
  },

  'annual_accounts.prepare': async (payload, ctx) => {
    await prepareAnnualAccounts(ctx.organizationId, argsOf<Parameters<typeof prepareAnnualAccounts>[1]>(payload));
    return `Jaarrekening${suffix(payload, 'fiscal_year_label')} opgemaakt en de cijfers bevroren`;
  },

  'annual_accounts.sign': async (payload, ctx) => {
    const signatureId = text(payload, 'signature_id');
    const signature = await signAnnualAccounts(ctx.organizationId, signatureId, argsOf<Parameters<typeof signAnnualAccounts>[2]>(payload));
    const name = optText(payload, 'person_name') ?? signature.personName;
    return signature.signed
      ? `Handtekening van ${name} vastgelegd op ${dateNL(signature.signedOn)}`
      : `Reden van de ontbrekende handtekening van ${name} vastgelegd`;
  },

  'annual_accounts.extend_term': async (payload, ctx) => {
    const input = argsOf<Parameters<typeof extendPreparationTerm>[2]>(payload);
    await extendPreparationTerm(ctx.organizationId, text(payload, 'annual_account_id'), input);
    return `Opmaaktermijn${suffix(payload, 'fiscal_year_label')} verlengd met ${input.months} maand${input.months === 1 ? '' : 'en'}`;
  },

  'annual_accounts.adopt': async (payload, ctx) => {
    const input = argsOf<Parameters<typeof adoptAnnualAccounts>[2]>(payload);
    await adoptAnnualAccounts(ctx.organizationId, text(payload, 'annual_account_id'), input);
    return `Jaarrekening${suffix(payload, 'fiscal_year_label')} vastgesteld op ${dateNL(input.adoptionDate)}`;
  },

  'annual_accounts.file': async (payload, ctx) => {
    const input = argsOf<Parameters<typeof fileAnnualAccounts>[2]>(payload);
    await fileAnnualAccounts(ctx.organizationId, text(payload, 'annual_account_id'), input);
    return `Deponering van jaarrekening${suffix(payload, 'fiscal_year_label')} vastgelegd op ${dateNL(input.filingDate)}`;
  },

  'annual_accounts.reverse': async (payload, ctx) => {
    await reverseAnnualAccounts(ctx.organizationId, text(payload, 'annual_account_id'), text(payload, 'reason'));
    return `Jaarrekening${suffix(payload, 'fiscal_year_label')} ingetrokken`;
  },

  'annual_accounts.render_pdf': async (payload, ctx) => {
    const result = await renderAnnualAccountsPdf(ctx.organizationId, text(payload, 'annual_account_id'));
    const stored = result.archive?.stored ? 'gearchiveerd' : `niet gearchiveerd (${result.archive?.reason ?? 'onbekende reden'})`;
    return `Jaarrekening-PDF${suffix(payload, 'fiscal_year_label')} gemaakt en ${stored} — ${result.fileName}`;
  },

  'annual_accounts.render_publication': async (payload, ctx) => {
    const result = await renderAnnualAccountsPublication(ctx.organizationId, text(payload, 'annual_account_id'));
    const stored = result.archive?.stored ? 'gearchiveerd' : `niet gearchiveerd (${result.archive?.reason ?? 'onbekende reden'})`;
    return `Publicatiestuk${suffix(payload, 'fiscal_year_label')} gemaakt en ${stored} — ${result.fileName}`;
  },
};
