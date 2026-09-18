// ============================================================
// invoice-extract — inkoopfactuur -> concept-inkoopfactuurvoorstel.
//
// Eén POST-actie (Supabase JWT + org-toegang + schrijfrol) rond de gedeelde
// voorstel-opbouw in _shared/invoiceProposal.ts:
//  - UBL/e-factuur (XML): DETERMINISTISCH geparst (geen AI, geen tegoed nodig).
//  - PDF/afbeelding: AI-uitlezing via Claude.
// Beide routes leveren hetzelfde VOORSTEL-formaat: de frontend toont het
// vooringevuld in het bestaande concept-inkoopfactuurformulier. Er wordt niets
// automatisch geboekt. (De automatische e-mailflow — invoiceInbox.ts — gebruikt
// dezelfde opbouw, zodat scan en inbox nooit uiteenlopen.)
//
// AI-kosten lopen tegen dezelfde ai_usage-tabel + maandplafond als Gerrie.
// ============================================================

import {
  HttpError, assertModuleAccess, assertWriteRole, createAdminClient, makeCors,
  parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type HttpStatus,
} from '../_shared/edgeAuth.ts';
import { hasAnthropicKey } from '../_shared/claudeInvoice.ts';
import { userHasBudget } from '../_shared/claudeSummary.ts';
import {
  base64ToBytes, buildAiProposal, buildUblProposal, isXmlFile, loadProposalContext,
  normalizeBase64, SUPPORTED_MIME_TYPES,
} from '../_shared/invoiceProposal.ts';

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
    if (isXmlFile(file.fileName, file.mimeType)) {
      let xmlText: string;
      try {
        xmlText = new TextDecoder('utf-8').decode(base64ToBytes(file.dataBase64));
      } catch {
        throw new HttpError('Het bestand kon niet worden gedecodeerd (ongeldige inhoud).', 400);
      }
      const ctx = await loadProposalContext(admin, organizationId);
      const result = await buildUblProposal(admin, organizationId, { fileName: file.fileName, xmlText }, ctx);
      return cors.json(req, { ok: true, ...result });
    }

    if (!SUPPORTED_MIME_TYPES.includes(file.mimeType)) {
      throw new HttpError('Bestandstype wordt niet ondersteund. Gebruik PDF, JPG, PNG, WEBP, GIF of een UBL-e-factuur (XML).', 400);
    }
    if (!hasAnthropicKey()) throw new HttpError('AI is nog niet geconfigureerd (ANTHROPIC_API_KEY ontbreekt).', 500);
    if (!(await userHasBudget(admin, user.id))) {
      throw new HttpError('Je AI-tegoed voor deze maand is op. Probeer het volgende maand opnieuw.', 429);
    }

    const ctx = await loadProposalContext(admin, organizationId);
    const result = await buildAiProposal(admin, organizationId, file, ctx, { usageUserId: user.id });
    return cors.json(req, { ok: true, ...result });
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
