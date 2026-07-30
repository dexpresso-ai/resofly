// ============================================================
// invoice-extract — inkoopfactuur -> concept-inkoopfactuurvoorstel.
//
// Twee routes, één POST-actie (Supabase JWT + org-toegang + schrijfrol):
//  - UBL/e-factuur (XML): DETERMINISTISCH geparst (geen AI, geen tegoed nodig)
//    — leverancier, regels en btw-categorieën komen 1-op-1 uit de XML; de
//    EN16931-categorie (S/Z/E/AE/K) wordt op KIND naar een org-btw-code gemapt.
//  - PDF/afbeelding: AI-uitlezing via Claude (bestaande flow).
// Beide routes leveren hetzelfde VOORSTEL-formaat: de frontend toont het
// vooringevuld in het bestaande concept-inkoopfactuurformulier; de server
// matcht de leverancier deterministisch (BTW-nr -> IBAN -> naam) en valideert
// dat elke rekening/btw-code echt van deze organisatie is. Er wordt niets
// automatisch geboekt.
//
// AI-kosten lopen tegen dezelfde ai_usage-tabel + maandplafond als Gerrie.
// ============================================================

import {
  HttpError, assertModuleAccess, assertWriteRole, createAdminClient, makeCors,
  parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type HttpStatus,
} from '../_shared/edgeAuth.ts';
import {
  extractInvoiceFromDocument, hasAnthropicKey, invoiceExtractModel, SUPPORTED_MIME_TYPES,
  type AccountRef, type VatCodeRef,
} from '../_shared/claudeInvoice.ts';
import { recordAiUsage, userHasBudget } from '../_shared/claudeSummary.ts';
import { parseUblDocument, type ParsedUblDocument } from '../_shared/ubl.ts';

const admin = createAdminClient();

const ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('MEETING_ALLOWED_ORIGINS'), Deno.env.get('BANK_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('INVOICE_ALLOW_LOCAL_DEV') || Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const cors = makeCors(ALLOWED_ORIGINS, ALLOW_LOCAL_DEV);

// Direct-naar-edge base64 (geen R2-omweg): factuurbestanden zijn klein. Cap ruim
// onder de request-limiet; grote scans laten de gebruiker eerst comprimeren.
const MAX_DECODED_BYTES = 10 * 1024 * 1024; // 10 MB
// Ruwe request mag ~base64-inflatie (×1.37) + JSON-overhead boven de decoded cap zitten.
const MAX_REQUEST_BYTES = 15 * 1024 * 1024; // 15 MB

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });
  try {
    if (req.method !== 'POST') throw new HttpError('Method not allowed.', 405 as HttpStatus);
    cors.assert(req);

    // Vroeg afwijzen (vóór we de body bufferen): te grote payload en niet-ingelogde caller.
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength && contentLength > MAX_REQUEST_BYTES) throw new HttpError('Verzoek is te groot.', 413 as HttpStatus);
    const user = await requireUser(admin, req);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(admin, user.id, organizationId);
    assertWriteRole(role);
    // Inkoopfacturen scannen valt onder Financiën; staat die module dicht voor
    // dit teamlid, dan mag het ook niet via deze edge function.
    await assertModuleAccess(admin, user.id, organizationId, 'finance', 'write');

    const file = readFilePayload(body);

    // UBL/e-factuur (XML): deterministisch parsen — geen AI, dus ook geen
    // API-key- of tegoedcontrole nodig.
    if (isXmlFile(file)) {
      const result = await importUblInvoice(organizationId, file);
      return cors.json(req, { ok: true, ...result });
    }

    if (!SUPPORTED_MIME_TYPES.includes(file.mimeType)) {
      throw new HttpError('Bestandstype wordt niet ondersteund. Gebruik PDF, JPG, PNG, WEBP, GIF of een UBL-e-factuur (XML).', 400);
    }
    if (!hasAnthropicKey()) throw new HttpError('AI is nog niet geconfigureerd (ANTHROPIC_API_KEY ontbreekt).', 500);
    if (!(await userHasBudget(admin, user.id))) {
      throw new HttpError('Je AI-tegoed voor deze maand is op. Probeer het volgende maand opnieuw.', 429);
    }

    const proposal = await scanInvoice(organizationId, user.id, file);
    return cors.json(req, { ok: true, ...proposal });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const detail = err instanceof Error ? err.message : 'Onbekende fout.';
    // 5xx-details (Postgres/Anthropic/config) niet naar de client lekken — wel loggen.
    if (status >= 500) console.error('invoice-extract error:', detail);
    const clientMessage = status >= 500 ? 'Er ging iets mis bij het uitlezen van de factuur. Probeer het later opnieuw.' : detail;
    return cors.json(req, { ok: false, error: clientMessage }, status);
  }
});

// ── Bestandspayload ─────────────────────────────────────────────────────────────

interface FilePayload { fileName: string; mimeType: string; dataBase64: string }

function readFilePayload(body: Record<string, unknown>): FilePayload {
  const file = (body.file && typeof body.file === 'object' ? body.file : {}) as Record<string, unknown>;
  const fileName = String(file.name || 'factuur');
  const mimeType = String(file.mimeType || '').toLowerCase();
  const dataBase64 = normalizeBase64(String(file.dataBase64 || ''));
  if (!dataBase64) throw new HttpError('Geen bestand ontvangen.', 400);
  const approxBytes = Math.floor((dataBase64.length * 3) / 4);
  if (approxBytes > MAX_DECODED_BYTES) {
    throw new HttpError(`Bestand is te groot voor de scan (max ${Math.round(MAX_DECODED_BYTES / 1024 / 1024)} MB). Comprimeer of splits het.`, 413);
  }
  return { fileName, mimeType, dataBase64 };
}

function isXmlFile(file: FilePayload): boolean {
  return ['application/xml', 'text/xml'].includes(file.mimeType) || file.fileName.toLowerCase().endsWith('.xml');
}

// ── Kernactie (AI-route) ───────────────────────────────────────────────────────

async function scanInvoice(organizationId: string, userId: string, filePayload: FilePayload) {
  const { fileName, mimeType, dataBase64 } = filePayload;

  // Context laden (org-scoped). Kandidaatrekeningen = zelfde filter als de UI-dropdown.
  const [accounts, vatCodes, suppliers] = await Promise.all([
    loadAccounts(organizationId),
    loadVatCodes(organizationId),
    loadSuppliers(organizationId),
  ]);

  const accountRefs: AccountRef[] = accounts.map((a) => ({ code: a.code, name: a.name, type: a.type, subtype: a.subtype }));
  const vatRefs: VatCodeRef[] = vatCodes.map((v) => ({ code: v.code, label: v.label, rate: v.rate, kind: v.kind }));

  const { extraction, usage, model } = await extractInvoiceFromDocument({ dataBase64, mimeType, accounts: accountRefs, vatCodes: vatRefs });

  // Verbruik loggen (fail-open: een logfout mag het resultaat niet blokkeren).
  await recordAiUsage(admin, organizationId, userId, model, usage).catch((e) => console.warn('ai_usage log mislukt:', e?.message));

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

  const lines = extraction.lines.map((l) => {
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
  let extractedTotals: { subtotal_cents: number | null; vat_cents: number | null; total_cents: number | null } | null = null;
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

  // Leverancier matchen op harde identifiers, anders op exacte naam.
  const match = matchSupplier(extraction.supplier, suppliers);
  if (!extraction.supplier.name) warnings.push('De leverancier kon niet worden herkend. Kies of maak zelf een leverancier.');

  // Voorstel-defaults voor een nieuwe leverancier (meest voorkomende rekening/BTW-code).
  const defaultAccountId = mostCommon(lines.map((l) => l.account_id).filter((x): x is string => !!x));
  const defaultVatCode = mostCommon(lines.map((l) => l.vat_code));

  let confidence = extraction.confidence;
  if (warnings.length && confidence === 'high') confidence = 'medium';

  return {
    method: 'ai' as const,
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
      file_name: fileName,
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
function resolveVatCodeForCategory(
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

/** Leest een UBL-e-factuur deterministisch uit tot hetzelfde voorstel-formaat als de AI-route. */
async function importUblInvoice(organizationId: string, file: FilePayload) {
  let xmlBytes: Uint8Array;
  try {
    xmlBytes = base64ToBytes(file.dataBase64);
  } catch {
    throw new HttpError('Het bestand kon niet worden gedecodeerd (ongeldige inhoud).', 400);
  }
  let doc: ParsedUblDocument;
  try {
    doc = parseUblDocument(new TextDecoder('utf-8').decode(xmlBytes));
  } catch (err) {
    throw new HttpError(err instanceof Error ? err.message : 'De UBL-e-factuur kon niet worden gelezen.', 400);
  }

  const [accounts, vatCodes, suppliers] = await Promise.all([
    loadAccounts(organizationId),
    loadVatCodes(organizationId),
    loadSuppliers(organizationId),
  ]);

  const warnings: string[] = [];
  if (doc.docType === 'creditNote') {
    warnings.push('Dit is een creditnota (UBL CreditNote) — de bedragen zijn negatief overgenomen zodat de creditering tegen de kosten wegvalt.');
  }

  // Leverancier matchen op dezelfde harde identifiers als de AI-route.
  const match = matchSupplier(
    { name: doc.supplier.name, vat_number: doc.supplier.vatNumber, iban: doc.supplier.iban },
    suppliers,
  );
  if (!doc.supplier.name) warnings.push('De leverancier kon niet uit de e-factuur worden gelezen. Kies of maak zelf een leverancier.');
  const matchedSupplier = match.id ? suppliers.find((s) => s.id === match.id) ?? null : null;
  const accountById = new Map(accounts.map((a) => [a.id, a.code]));
  const defaultAccountId = matchedSupplier?.default_expense_account_id && accountById.has(matchedSupplier.default_expense_account_id)
    ? matchedSupplier.default_expense_account_id
    : null;

  const lines = doc.lines.map((l) => {
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
  const displayTotals = (() => {
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
  const totals = displayTotals;
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
    method: 'ubl' as const,
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
      confidence: 'high' as const,
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

// ── Context laden ───────────────────────────────────────────────────────────────

interface AccountRow { id: string; code: string; name: string; type: string; subtype: string | null }
async function loadAccounts(organizationId: string): Promise<AccountRow[]> {
  const { data, error } = await admin.from('ledger_accounts')
    .select('id, code, name, type, subtype')
    .eq('organization_id', organizationId).eq('is_active', true)
    .in('type', ['expense', 'asset']).order('code');
  if (error) throw new HttpError(`Rekeningschema laden mislukt: ${error.message}`, 500);
  return (data ?? []) as AccountRow[];
}

interface VatRow { code: string; label: string; rate: number; kind: string }
async function loadVatCodes(organizationId: string): Promise<VatRow[]> {
  const { data, error } = await admin.from('vat_codes')
    .select('code, label, rate, kind')
    .eq('organization_id', organizationId).eq('is_active', true).order('code');
  if (error) throw new HttpError(`BTW-codes laden mislukt: ${error.message}`, 500);
  return (data ?? []).map((v) => ({ code: String(v.code), label: String(v.label), rate: Number(v.rate) || 0, kind: String(v.kind) }));
}

interface SupplierRow { id: string; name: string; vat_number: string | null; iban: string | null; default_expense_account_id: string | null; default_vat_code: string | null }
async function loadSuppliers(organizationId: string): Promise<SupplierRow[]> {
  const { data, error } = await admin.from('suppliers')
    .select('id, name, vat_number, iban, default_expense_account_id, default_vat_code')
    .eq('organization_id', organizationId);
  if (error) throw new HttpError(`Leveranciers laden mislukt: ${error.message}`, 500);
  return (data ?? []) as SupplierRow[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function normalizeBase64(raw: string): string {
  const s = raw.trim();
  const comma = s.indexOf(',');
  return s.startsWith('data:') && comma !== -1 ? s.slice(comma + 1) : s;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function computeCentsTotals(lines: Array<{ amount_cents: number; vat_rate: number }>) {
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

const normVat = (s: string | null) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normIban = (s: string | null) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normName = (s: string | null) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function matchSupplier(
  sup: { name: string; vat_number: string | null; iban: string | null },
  suppliers: SupplierRow[],
): { id: string | null; by: 'vat' | 'iban' | 'name' | null } {
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
  const name = normName(sup.name);
  if (name.length >= 2) {
    const hit = suppliers.find((s) => normName(s.name) === name);
    if (hit) return { id: hit.id, by: 'name' };
  }
  return { id: null, by: null };
}

function mostCommon<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  const counts = new Map<T, number>();
  for (const it of items) counts.set(it, (counts.get(it) || 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}
