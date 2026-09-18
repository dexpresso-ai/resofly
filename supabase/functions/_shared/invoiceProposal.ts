// ============================================================
// Inkoopfactuur-document -> VOORSTEL voor een concept-inkoopfactuur.
//
// Gedeeld door twee ingangen:
//  - invoice-extract: "Factuur scannen" in het scherm (de gebruiker uploadt).
//  - invoiceInbox.ts: facturen die per e-mail op het factuur-doorstuuradres
//    binnenkomen en automatisch worden klaargezet.
//
// Twee routes, één voorstel-formaat:
//  - UBL/e-factuur (XML): DETERMINISTISCH geparst (geen AI, geen tegoed nodig).
//    Leverancier, regels en btw-categorieën komen 1-op-1 uit de XML; de
//    EN16931-categorie (S/Z/E/AE/K) wordt op KIND naar een org-btw-code gemapt.
//  - PDF/afbeelding: AI-uitlezing via Claude (claudeInvoice.ts).
// De server matcht de leverancier deterministisch (BTW-nr -> IBAN -> e-mail ->
// naam) en valideert dat elke rekening/btw-code echt van deze organisatie is:
// AI-uitvoer wordt nooit vertrouwd, alleen als kandidaat gebruikt.
//
// AI-kosten lopen tegen dezelfde ai_usage-tabel + maandplafond als Gerrie.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { HttpError } from './edgeAuth.ts';
import {
  extractInvoiceFromDocument, extractInvoiceFromText, SUPPORTED_MIME_TYPES,
  type AccountRef, type InvoiceConfidence, type InvoiceExtraction, type VatCodeRef,
} from './claudeInvoice.ts';
import { recordAiUsage } from './claudeSummary.ts';
import { parseUblDocument, type ParsedUblDocument } from './ubl.ts';
import { isXmlFile, normEmail, normIban, normName, normVat } from './invoiceInboxRules.ts';

export { SUPPORTED_MIME_TYPES, isXmlFile, normEmail, normIban, normName, normVat };

// ── Voorstel-formaat (spiegel van src/lib/invoice-scan-api.ts) ─────────────────

export interface ProposalLine {
  description: string;
  /** Bedrag EXCL btw in centen. */
  amount_cents: number;
  vat_code: string;
  vat_rate: number;
  /** Gevalideerde grootboekrekening-id (of null -> vangnet bij boeken). */
  account_id: string | null;
  account_code: string | null;
}

export interface SupplierProposal {
  matchedId: string | null;
  matchedBy: SupplierMatchKind | null;
  name: string;
  vat_number: string | null;
  kvk_number: string | null;
  iban: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  default_expense_account_id: string | null;
  default_vat_code: string | null;
}

export interface ProposalTotals { subtotal_cents: number; vat_cents: number; total_cents: number }

export interface InvoiceProposal {
  supplier: SupplierProposal;
  supplier_invoice_number: string | null;
  date: string | null;
  due_date: string | null;
  currency: string;
  notes: string | null;
  confidence: InvoiceConfidence;
  warnings: string[];
  lines: ProposalLine[];
  totals: ProposalTotals;
  extracted_totals: { subtotal_cents: number | null; vat_cents: number | null; total_cents: number | null } | null;
}

export interface ProposalResult {
  /** 'ubl' = deterministisch geparste e-factuur (XML), 'ai' = Claude-uitlezing. */
  method: 'ai' | 'ubl';
  proposal: InvoiceProposal;
  extraction_meta: Record<string, unknown>;
}

// ── Context van de organisatie ─────────────────────────────────────────────────

export interface AccountRow { id: string; code: string; name: string; type: string; subtype: string | null }
export interface VatRow { code: string; label: string; rate: number; kind: string }
export interface SupplierRow {
  id: string; name: string; vat_number: string | null; iban: string | null; email: string | null;
  default_expense_account_id: string | null; default_vat_code: string | null;
}

export interface ProposalContext { accounts: AccountRow[]; vatCodes: VatRow[]; suppliers: SupplierRow[] }

/** Kandidaatrekeningen = zelfde filter als de UI-dropdown (kosten + activa). */
export async function loadAccounts(admin: SupabaseClient, organizationId: string): Promise<AccountRow[]> {
  const { data, error } = await admin.from('ledger_accounts')
    .select('id, code, name, type, subtype')
    .eq('organization_id', organizationId).eq('is_active', true)
    .in('type', ['expense', 'asset']).order('code');
  if (error) throw new HttpError(`Rekeningschema laden mislukt: ${error.message}`, 500);
  return (data ?? []) as AccountRow[];
}

export async function loadVatCodes(admin: SupabaseClient, organizationId: string): Promise<VatRow[]> {
  const { data, error } = await admin.from('vat_codes')
    .select('code, label, rate, kind')
    .eq('organization_id', organizationId).eq('is_active', true).order('code');
  if (error) throw new HttpError(`BTW-codes laden mislukt: ${error.message}`, 500);
  return (data ?? []).map((v) => ({ code: String(v.code), label: String(v.label), rate: Number(v.rate) || 0, kind: String(v.kind) }));
}

export async function loadSuppliers(admin: SupabaseClient, organizationId: string): Promise<SupplierRow[]> {
  const { data, error } = await admin.from('suppliers')
    .select('id, name, vat_number, iban, email, default_expense_account_id, default_vat_code')
    .eq('organization_id', organizationId);
  if (error) throw new HttpError(`Leveranciers laden mislukt: ${error.message}`, 500);
  return (data ?? []) as SupplierRow[];
}

export async function loadProposalContext(admin: SupabaseClient, organizationId: string): Promise<ProposalContext> {
  const [accounts, vatCodes, suppliers] = await Promise.all([
    loadAccounts(admin, organizationId),
    loadVatCodes(admin, organizationId),
    loadSuppliers(admin, organizationId),
  ]);
  return { accounts, vatCodes, suppliers };
}

// ── Bestandssoort ──────────────────────────────────────────────────────────────

export function normalizeBase64(raw: string): string {
  const s = raw.trim();
  const comma = s.indexOf(',');
  return s.startsWith('data:') && comma !== -1 ? s.slice(comma + 1) : s;
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Base64 zonder de call-stack op te blazen bij grote bestanden. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

// ── AI-route ───────────────────────────────────────────────────────────────────

export interface AiProposalInput { fileName: string; mimeType: string; dataBase64: string }

/**
 * PDF/afbeelding -> voorstel via Claude. De aanroeper controleert vooraf de
 * API-key en het tegoed; het verbruik wordt hier gelogd op `usageUserId`
 * (null = organisatiebreed, zonder persoonlijk plafond).
 */
export async function buildAiProposal(
  admin: SupabaseClient,
  organizationId: string,
  file: AiProposalInput,
  ctx: ProposalContext,
  opts: { usageUserId: string | null },
): Promise<ProposalResult> {
  const { fileName, mimeType, dataBase64 } = file;
  const { extraction, usage, model } = await extractInvoiceFromDocument({
    dataBase64, mimeType, accounts: accountRefs(ctx), vatCodes: vatRefs(ctx),
  });
  // Verbruik loggen (fail-open: een logfout mag het resultaat niet blokkeren).
  await recordAiUsage(admin, organizationId, opts.usageUserId, model, usage)
    .catch((e) => console.warn('ai_usage log mislukt:', e?.message));
  return finishAiProposal(extraction, model, ctx, { file_name: fileName });
}

/**
 * Factuur in de TEKST van een mail (geen bijlage) -> voorstel via Claude.
 * Zelfde na-verwerking als een document; de bron staat in extraction_meta.
 */
export async function buildAiProposalFromText(
  admin: SupabaseClient,
  organizationId: string,
  input: { text: string; label: string },
  ctx: ProposalContext,
  opts: { usageUserId: string | null },
): Promise<ProposalResult> {
  const { extraction, usage, model } = await extractInvoiceFromText({
    text: input.text, accounts: accountRefs(ctx), vatCodes: vatRefs(ctx),
  });
  await recordAiUsage(admin, organizationId, opts.usageUserId, model, usage)
    .catch((e) => console.warn('ai_usage log mislukt:', e?.message));
  return finishAiProposal(extraction, model, ctx, { file_name: input.label, source: 'email_body' });
}

const accountRefs = (ctx: ProposalContext): AccountRef[] =>
  ctx.accounts.map((a) => ({ code: a.code, name: a.name, type: a.type, subtype: a.subtype }));
const vatRefs = (ctx: ProposalContext): VatCodeRef[] =>
  ctx.vatCodes.map((v) => ({ code: v.code, label: v.label, rate: v.rate, kind: v.kind }));

/**
 * Van ruwe AI-uitlezing naar gevalideerd voorstel: rekeningen en btw-codes
 * alleen als ze echt van deze organisatie zijn, bedragen naar centen,
 * totalencontrole, leveranciersmatch.
 */
function finishAiProposal(
  extraction: InvoiceExtraction,
  model: string,
  ctx: ProposalContext,
  meta: Record<string, unknown>,
): ProposalResult {
  const { accounts, vatCodes, suppliers } = ctx;

  // ── Na-verwerking: valideren + omrekenen naar centen ──────────────────────────
  const accountByCode = new Map(accounts.map((a) => [a.code, a.id]));
  const vatByCode = new Map(vatCodes.map((v) => [v.code, v]));
  // Alleen BINNENLANDSE BTW-soorten mogen puur op tarief worden gekozen. Verlegd/
  // ICP/EU/KOR veranderen de boeking ingrijpend (crediteur excl. BTW, andere
  // rubrieken) en mogen NOOIT als vangnet op tarief vallen — die moeten door de AI
  // expliciet als code komen (via vatByCode). Bij gelijk tarief wint de laagste
  // prioriteit (standard vóór reduced vóór zero vóór exempt).
  const DOMESTIC_KIND_PRIORITY: Record<string, number> = { standard: 0, reduced: 1, zero: 2, exempt: 3 };
  const vatByRate = new Map<number, VatRow>();
  for (const v of vatCodes) {
    const pri = DOMESTIC_KIND_PRIORITY[v.kind];
    if (pri === undefined) continue;
    const cur = vatByRate.get(v.rate);
    if (!cur || pri < DOMESTIC_KIND_PRIORITY[cur.kind]) vatByRate.set(v.rate, v);
  }
  const fallbackVat = vatByCode.get('HOOG') ?? vatByRate.get(21) ?? vatCodes[0] ?? null;

  const warnings: string[] = [];

  const lines: ProposalLine[] = extraction.lines.map((l) => {
    // BTW-code: geldige code > code bij tarief > vangnet. De code bepaalt het tarief.
    let vc = l.vat_code ? vatByCode.get(l.vat_code) : undefined;
    if (!vc) vc = vatByRate.get(round2(l.vat_rate));
    if (!vc) vc = fallbackVat ?? undefined;
    const vat_code = vc?.code ?? (l.vat_code ?? 'HOOG');
    const vat_rate = vc ? vc.rate : round2(l.vat_rate);

    // Grootboek: alleen een code die écht bij deze organisatie hoort -> id, anders null.
    const account_id = l.account_code && accountByCode.has(l.account_code) ? accountByCode.get(l.account_code)! : null;
    const account_code = account_id ? l.account_code : null;

    return {
      description: l.description,
      amount_cents: Math.round(l.amount_excl_vat * 100),
      vat_code,
      vat_rate,
      account_id,
      account_code,
    };
  });

  if (lines.length === 0) warnings.push('Er zijn geen factuurregels herkend. Vul ze handmatig aan.');

  const totals = computeCentsTotals(lines);

  // Totalencontrole tegen wat op de factuur staat — op totaal, subtotaal én BTW,
  // zodat een verkeerd BTW-tarief/regelbedrag ook wordt opgemerkt (niet alleen het
  // grand total). Geen totalen uitgelezen = geen controle mogelijk -> waarschuw.
  let extractedTotals: InvoiceProposal['extracted_totals'] = null;
  if (extraction.totals.total_incl_vat != null || extraction.totals.subtotal_excl_vat != null || extraction.totals.vat_amount != null) {
    extractedTotals = {
      subtotal_cents: extraction.totals.subtotal_excl_vat != null ? Math.round(extraction.totals.subtotal_excl_vat * 100) : null,
      vat_cents: extraction.totals.vat_amount != null ? Math.round(extraction.totals.vat_amount * 100) : null,
      total_cents: extraction.totals.total_incl_vat != null ? Math.round(extraction.totals.total_incl_vat * 100) : null,
    };
    const off = (a: number | null, b: number) => a != null && Math.abs(a - b) > 2;
    if (off(extractedTotals.total_cents, totals.total_cents) || off(extractedTotals.subtotal_cents, totals.subtotal_cents) || off(extractedTotals.vat_cents, totals.vat_cents)) {
      warnings.push(
        `De berekende bedragen (excl. € ${(totals.subtotal_cents / 100).toFixed(2)}, BTW € ${(totals.vat_cents / 100).toFixed(2)}, ` +
        `totaal € ${(totals.total_cents / 100).toFixed(2)}) wijken af van de op de factuur vermelde bedragen. ` +
        `Controleer de regels, BTW-codes en bedragen.`,
      );
    }
  } else if (lines.length > 0) {
    warnings.push('De factuurtotalen konden niet worden uitgelezen om de bedragen te controleren. Controleer de regels en BTW extra goed.');
  }

  // Leverancier matchen op harde identifiers, anders op e-mail of exacte naam.
  const match = matchSupplier(extraction.supplier, suppliers);
  if (!extraction.supplier.name) warnings.push('De leverancier kon niet worden herkend. Kies of maak zelf een leverancier.');

  // Voorstel-defaults voor een nieuwe leverancier (meest voorkomende rekening/BTW-code).
  const defaultAccountId = mostCommon(lines.map((l) => l.account_id).filter((x): x is string => !!x));
  const defaultVatCode = mostCommon(lines.map((l) => l.vat_code));

  let confidence = extraction.confidence;
  if (warnings.length && confidence === 'high') confidence = 'medium';

  return {
    method: 'ai',
    proposal: {
      supplier: {
        matchedId: match.id,
        matchedBy: match.by,
        name: extraction.supplier.name,
        vat_number: extraction.supplier.vat_number,
        kvk_number: extraction.supplier.kvk_number,
        iban: extraction.supplier.iban,
        email: extraction.supplier.email,
        phone: extraction.supplier.phone,
        address_line1: extraction.supplier.address_line1,
        postal_code: extraction.supplier.postal_code,
        city: extraction.supplier.city,
        country: extraction.supplier.country,
        default_expense_account_id: defaultAccountId,
        default_vat_code: defaultVatCode,
      },
      supplier_invoice_number: extraction.supplier_invoice_number,
      date: extraction.invoice_date,
      due_date: extraction.due_date,
      currency: extraction.currency || 'EUR',
      notes: extraction.notes,
      confidence,
      warnings,
      lines,
      totals,
      extracted_totals: extractedTotals,
    },
    extraction_meta: {
      model,
      confidence,
      warnings,
      ...meta,
      scanned_at: new Date().toISOString(),
      extracted_totals: extractedTotals,
      supplier_raw: extraction.supplier,
    },
  };
}

// ── UBL-route (deterministisch, geen AI) ───────────────────────────────────────

/**
 * EN16931-categorie -> btw-code van deze organisatie, gemapt op KIND (nooit op
 * de code-string of — voor verlegd/EU — op tarief; die veranderen de boeking
 * fundamenteel). Levert ook het vat_rate voor de regel: bij verlegd/EU-verwerving
 * is dat het tarief van de org-code (zelf aangeven), niet de 0 uit het document.
 */
export function resolveVatCodeForCategory(
  category: string,
  documentRate: number,
  vatCodes: VatRow[],
  warnings: string[],
): { vat_code: string; vat_rate: number } {
  const byKind = (kinds: string[], preferRate?: number): VatRow | undefined => {
    const candidates = vatCodes.filter((v) => kinds.includes(v.kind));
    if (preferRate != null) {
      const exact = candidates.find((v) => Math.abs(v.rate - preferRate) < 0.005);
      if (exact) return exact;
    }
    return candidates[0];
  };

  switch (category) {
    case 'S': {
      const hit = byKind(['standard', 'reduced'], documentRate);
      if (hit && Math.abs(hit.rate - documentRate) < 0.005) return { vat_code: hit.code, vat_rate: hit.rate };
      if (hit) {
        warnings.push(`Btw-tarief ${documentRate}% uit de e-factuur wijkt af van de tarieven van je btw-codes; het documenttarief is aangehouden — controleer de regel.`);
        return { vat_code: hit.code, vat_rate: documentRate };
      }
      warnings.push('Geen standaard-btw-code gevonden voor deze organisatie; controleer de btw per regel.');
      return { vat_code: 'HOOG', vat_rate: documentRate };
    }
    case 'Z': {
      const hit = byKind(['zero']);
      return { vat_code: hit?.code ?? 'NUL', vat_rate: 0 };
    }
    case 'E': {
      const hit = byKind(['exempt']) ?? byKind(['zero']);
      if (!hit) warnings.push('Geen vrijgesteld-btw-code gevonden; controleer de btw per regel.');
      return { vat_code: hit?.code ?? 'VRIJ', vat_rate: 0 };
    }
    case 'AE': {
      // Verlegde btw op een INKOOPfactuur = zelf aangeven én aftrekken (VERL_INK).
      const hit = byKind(['reverse_charge_purchase']);
      if (hit) return { vat_code: hit.code, vat_rate: hit.rate };
      warnings.push('De e-factuur bevat verlegde btw (categorie AE), maar deze organisatie heeft geen verlegd-inkoopcode (VERL_INK). De regel staat nu op 0% — corrigeer de btw-code vóór het boeken.');
      const zero = byKind(['zero']);
      return { vat_code: zero?.code ?? 'NUL', vat_rate: 0 };
    }
    case 'K': {
      // Intracommunautaire levering van de verkoper = EU-verwerving bij ons.
      const hit = byKind(['eu_acquisition']);
      if (hit) return { vat_code: hit.code, vat_rate: hit.rate };
      warnings.push('De e-factuur is een intracommunautaire levering (categorie K), maar deze organisatie heeft geen EU-verwervingscode (EU_VERW). De regel staat nu op 0% — corrigeer de btw-code vóór het boeken.');
      const zero = byKind(['zero']);
      return { vat_code: zero?.code ?? 'NUL', vat_rate: 0 };
    }
    default: {
      // G (export) / O (buiten heffing) en onbekende categorieën: 0% + controle.
      warnings.push(`Btw-categorie '${category}' uit de e-factuur is als 0% overgenomen — controleer de btw-code per regel.`);
      const zero = byKind(['zero']);
      return { vat_code: zero?.code ?? 'NUL', vat_rate: 0 };
    }
  }
}

export interface UblProposalInput { fileName: string; xmlText: string }

/** Leest een UBL-e-factuur deterministisch uit tot hetzelfde voorstel-formaat als de AI-route. */
export async function buildUblProposal(
  admin: SupabaseClient,
  organizationId: string,
  file: UblProposalInput,
  ctx: ProposalContext,
): Promise<ProposalResult> {
  let doc: ParsedUblDocument;
  try {
    doc = parseUblDocument(file.xmlText);
  } catch (err) {
    throw new HttpError(err instanceof Error ? err.message : 'De UBL-e-factuur kon niet worden gelezen.', 400);
  }

  const { accounts, vatCodes, suppliers } = ctx;

  const warnings: string[] = [];
  if (doc.docType === 'creditNote') {
    warnings.push('Dit is een creditnota (UBL CreditNote) — de bedragen zijn negatief overgenomen zodat de creditering tegen de kosten wegvalt.');
  }

  // Leverancier matchen op dezelfde harde identifiers als de AI-route.
  const match = matchSupplier(
    { name: doc.supplier.name, vat_number: doc.supplier.vatNumber, iban: doc.supplier.iban, email: doc.supplier.email },
    suppliers,
  );
  if (!doc.supplier.name) warnings.push('De leverancier kon niet uit de e-factuur worden gelezen. Kies of maak zelf een leverancier.');
  const matchedSupplier = match.id ? suppliers.find((s) => s.id === match.id) ?? null : null;
  const accountById = new Map(accounts.map((a) => [a.id, a.code]));
  const defaultAccountId = matchedSupplier?.default_expense_account_id && accountById.has(matchedSupplier.default_expense_account_id)
    ? matchedSupplier.default_expense_account_id
    : null;

  const lines: ProposalLine[] = doc.lines.map((l) => {
    const resolved = resolveVatCodeForCategory(l.category, l.vatRate, vatCodes, warnings);
    return {
      description: l.description,
      amount_cents: l.netCents,
      vat_code: resolved.vat_code,
      vat_rate: resolved.vat_rate,
      account_id: defaultAccountId,
      account_code: defaultAccountId ? accountById.get(defaultAccountId) ?? null : null,
    };
  });
  if (lines.length === 0) warnings.push('Er zijn geen factuurregels in de e-factuur gevonden. Vul ze handmatig aan.');
  if (doc.hasDocumentAllowanceCharge) {
    warnings.push('Deze e-factuur bevat een korting of toeslag op documentniveau die niet als aparte regel is overgenomen — controleer of het totaal klopt en voeg de korting/toeslag zo nodig handmatig toe.');
  }

  // Totalencontrole tegen wat de afzender zelf vermeldt (±2 cent, zelfde
  // tolerantie als de AI-route). BELANGRIJK: bij verlegde/EU/vrijgestelde regels
  // (AE/K/G/E) brengt de leverancier GEEN btw in rekening — de vat_rate op de
  // regel (bv. 21 bij VERL_INK) dient alleen voor de eigen aangifte/aftrek. Voor
  // de vergelijking met het document tellen we daarom alléén categorie-S-btw mee,
  // anders slaat de check bij elke verleggingsfactuur ten onrechte aan en toont
  // het voorstel een opgeblazen totaal.
  const totals = (() => {
    const byRate = new Map<number, number>();
    let subtotal = 0;
    doc.lines.forEach((dl) => {
      subtotal += dl.netCents;
      if (dl.category === 'S') byRate.set(dl.vatRate, (byRate.get(dl.vatRate) || 0) + dl.netCents);
    });
    let vat = 0;
    byRate.forEach((base, rate) => { vat += Math.round((base * rate) / 100); });
    return { subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat };
  })();
  const extractedTotals = {
    subtotal_cents: doc.totals.netCents,
    vat_cents: doc.totals.vatCents,
    total_cents: doc.totals.grossCents,
  };
  const off = (a: number | null, b: number) => a != null && Math.abs(a - b) > 2;
  if (off(extractedTotals.total_cents, totals.total_cents) || off(extractedTotals.subtotal_cents, totals.subtotal_cents) || off(extractedTotals.vat_cents, totals.vat_cents)) {
    warnings.push(
      `De herberekende bedragen (excl. € ${(totals.subtotal_cents / 100).toFixed(2)}, BTW € ${(totals.vat_cents / 100).toFixed(2)}, ` +
      `totaal € ${(totals.total_cents / 100).toFixed(2)}) wijken af van de totalen in de e-factuur. ` +
      `Controleer de regels en btw-codes.`,
    );
  }

  // Duplicaatsignalering: er is geen unique constraint op leveranciersfactuurnummers,
  // dus een tweede import van dezelfde e-factuur zou stilzwijgend dubbel in de
  // kosten lopen. Signaleren, niet blokkeren (nummerhergebruik komt voor).
  if (doc.number) {
    const { data: existing, error: dupError } = await admin.from('purchase_invoices')
      .select('id, internal_number')
      .eq('organization_id', organizationId)
      .eq('supplier_invoice_number', doc.number)
      .limit(1);
    if (dupError) console.warn('duplicaatcheck inkoopfactuur mislukte:', dupError.message);
    else if ((existing ?? []).length > 0) {
      warnings.push(`Er bestaat al een inkoopfactuur met leveranciersfactuurnummer '${doc.number}' (${(existing![0] as { internal_number: string | null }).internal_number ?? 'zonder intern nummer'}) — mogelijk een duplicaat.`);
    }
  }

  const defaultVatCode = mostCommon(lines.map((l) => l.vat_code));

  return {
    method: 'ubl',
    proposal: {
      supplier: {
        matchedId: match.id,
        matchedBy: match.by,
        name: doc.supplier.name,
        vat_number: doc.supplier.vatNumber,
        kvk_number: doc.supplier.kvkNumber,
        iban: doc.supplier.iban,
        email: doc.supplier.email,
        phone: null,
        address_line1: doc.supplier.addressLine1,
        postal_code: doc.supplier.postalCode,
        city: doc.supplier.city,
        country: doc.supplier.countryCode,
        default_expense_account_id: defaultAccountId,
        default_vat_code: defaultVatCode,
      },
      supplier_invoice_number: doc.number,
      date: doc.issueDate,
      due_date: doc.dueDate,
      currency: doc.currency,
      notes: doc.note,
      confidence: 'high',
      warnings,
      lines,
      totals,
      extracted_totals: extractedTotals,
    },
    extraction_meta: {
      method: 'ubl',
      customization_id: doc.customizationId,
      doc_type: doc.docType,
      buyer_reference: doc.buyerReference,
      payment_reference: doc.paymentReference,
      file_name: file.fileName,
      imported_at: new Date().toISOString(),
      warnings,
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Totalen voor het VOORSTEL: btw per tarief afgerond (zoals de scan altijd toonde). */
export function computeCentsTotals(lines: Array<{ amount_cents: number; vat_rate: number }>): ProposalTotals {
  const byRate = new Map<number, number>();
  let subtotal = 0;
  for (const l of lines) {
    const base = Number(l.amount_cents) || 0;
    subtotal += base;
    byRate.set(l.vat_rate || 0, (byRate.get(l.vat_rate || 0) || 0) + base);
  }
  let vat = 0;
  byRate.forEach((base, rate) => { vat += Math.round((base * rate) / 100); });
  return { subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat };
}

/**
 * Header-totalen van een CONCEPT-inkoopfactuur: btw per (kostenrekening,
 * btw-code, tarief)-groep afgerond, dan gesommeerd — identiek aan
 * `purchaseTotals` in de frontend én aan book_purchase_invoice, zodat het
 * opgeslagen totaal cent-exact aansluit op de crediteurenregel (1600).
 * `fallbackAccountId` spiegelt de server-coalesce van een lege rekening -> 4500.
 */
export function computePurchaseTotals(
  lines: Array<{ amount_cents: number; vat_rate: number; vat_code: string; account_id: string | null }>,
  fallbackAccountId: string | null,
): ProposalTotals {
  const groups = new Map<string, { base: number; rate: number }>();
  let subtotal = 0;
  for (const l of lines) {
    const base = Number(l.amount_cents) || 0;
    subtotal += base;
    const rate = l.vat_rate || 0;
    const account = l.account_id || fallbackAccountId || '';
    const key = `${account}|${(l.vat_code ?? '').trim()}|${rate}`;
    const g = groups.get(key);
    if (g) g.base += base;
    else groups.set(key, { base, rate });
  }
  let vat = 0;
  groups.forEach((g) => { vat += Math.round((g.base * g.rate) / 100); });
  return { subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat };
}

export type SupplierMatchKind = 'vat' | 'iban' | 'email' | 'name';

/**
 * Leverancier herkennen op harde identifiers (BTW-nr, IBAN), dan op e-mailadres,
 * dan pas op exacte naam. Meerdere leveranciers met hetzelfde e-mailadres
 * (een boekhoudkantoor dat voor meerdere partijen factureert) matchen bewust
 * niet: dan beslist een mens.
 */
export function matchSupplier(
  sup: { name: string; vat_number: string | null; iban: string | null; email?: string | null },
  suppliers: SupplierRow[],
): { id: string | null; by: SupplierMatchKind | null } {
  const v = normVat(sup.vat_number);
  if (v.length >= 8) {
    const hit = suppliers.find((s) => normVat(s.vat_number) === v);
    if (hit) return { id: hit.id, by: 'vat' };
  }
  const iban = normIban(sup.iban);
  if (iban.length >= 10) {
    const hit = suppliers.find((s) => normIban(s.iban) === iban);
    if (hit) return { id: hit.id, by: 'iban' };
  }
  const email = normEmail(sup.email);
  if (email.includes('@')) {
    const hits = suppliers.filter((s) => normEmail(s.email) === email);
    if (hits.length === 1) return { id: hits[0].id, by: 'email' };
  }
  const name = normName(sup.name);
  if (name.length >= 2) {
    const hit = suppliers.find((s) => normName(s.name) === name);
    if (hit) return { id: hit.id, by: 'name' };
  }
  return { id: null, by: null };
}

export function mostCommon<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  const counts = new Map<T, number>();
  for (const it of items) counts.set(it, (counts.get(it) || 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}
