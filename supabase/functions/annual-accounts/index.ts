// ============================================================
// Jaarrekening en publicatiestuk — de PDF-kant van fase 5.
//
// Waarom server-side: de jaarrekening moet onveranderlijk zijn. Zij hoort exact
// overeen te komen met wat de algemene vergadering heeft vastgesteld en met wat
// is gedeponeerd. Client-side genereren zou haar per definitie tot concept
// degraderen. Dit is hetzelfde model als de verzonden offerte en factuur: de
// server genereert, hasht en bewaart; een herdruk geeft letterlijk dezelfde
// bytes terug.
//
// DE ENIGE BRON IS DE BEVROREN SNAPSHOT. get_annual_account levert het volledige
// stuk inclusief annual_accounts.snapshot; daar staan de cijfers in zoals ze bij
// het opmaken zijn vastgelegd, met een sha256 eroverheen. Er wordt hier GEEN
// enkele rapport-RPC aangeroepen — dat zou een herdruk laten afwijken van het
// vastgestelde stuk, en dat is precies wat niet mag.
//
// Acties:
//   previewPdf         — genereren en teruggeven, niets opslaan. Voor het scherm.
//   renderPdf          — de jaarrekening genereren, archiveren en teruggeven.
//   renderPublication  — idem voor het publicatiestuk (per groottecategorie).
//   downloadPdf        — het gearchiveerde exemplaar teruggeven; is er geen,
//                        dan opnieuw uit dezelfde bevroren snapshot opbouwen.
//   downloadPublication— idem.
//
// Autorisatie volgt corporate-tax: geverifieerde gebruiker, lidmaatschap van de
// organisatie, en daar bovenop de modulepoort. Die laatste is hier niet optioneel:
// deze functie draait op de service-role en get_annual_account slaat dan zijn
// eigen can_read_module-controle over. Zonder assertModuleAccess zou dit een
// achterdeur zijn naar de financiële module van een teamlid dat die juist niet mag.
//
// ARCHIVERING IS BEST EFFORT, EN DAT ZEGGEN WE OOK. De private-R2-worker heeft
// (nog) geen route voor jaarrekeningen; zolang die ontbreekt, wordt de PDF wel
// gegenereerd en teruggegeven maar niet opgeslagen. Het antwoord bevat dan
// archive.stored = false met de reden erbij — nooit stil laten mislukken, want
// een stuk dat de gebruiker denkt te hebben gearchiveerd en dat er niet is, is
// erger dan een zichtbare foutmelding.
// ============================================================

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import {
  HttpError,
  assertModuleAccess,
  assertWriteRole,
  createAdminClient,
  makeCors,
  parseAllowedOrigins,
  requireOrganizationAccess,
  requireUser,
} from '../_shared/edgeAuth.ts';
import { bytesToBase64, renderReportDocument, sha256HexBytes } from '../_shared/reportPdf.ts';
import { buildAnnualAccountsDocument, buildPublicationDocument } from '../_shared/annualAccountsLayout.ts';

const admin = createAdminClient();
const cors = makeCors(
  parseAllowedOrigins([Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS'), Deno.env.get('APP_ALLOWED_ORIGINS')]),
  (Deno.env.get('ALLOW_LOCAL_DEV') ?? '1') === '1',
);

// Dezelfde worker als de offerte- en contractsnapshots; alleen de route en het
// sleutelvoorvoegsel zijn anders. De namen vallen terug op de bestaande secrets
// zodat er niets extra's gezet hoeft te worden zodra de route bestaat.
const PDF_STORAGE_WORKER_URL = (
  Deno.env.get('ANNUAL_ACCOUNTS_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
  ''
).replace(/\/$/, '');
const PDF_STORAGE_SECRET =
  Deno.env.get('ANNUAL_ACCOUNTS_PDF_STORAGE_SECRET') ||
  Deno.env.get('QUOTE_PDF_STORAGE_SECRET') ||
  Deno.env.get('INVOICE_PDF_STORAGE_SECRET') ||
  '';
const STORAGE_ROUTE = '/internal/annual-account-snapshot';

type Json = Record<string, unknown>;
type Variant = 'annual' | 'publication';

type Archive = {
  stored: boolean;
  provider: 'r2' | 'none';
  key: string | null;
  attachmentId: string | null;
  reason?: string;
};

// ------------------------------------------------------------ gegevens
/** De bevroren jaarrekening. De enige databaseheen-en-weer die deze functie doet. */
async function loadAnnualAccount(organizationId: string, annualAccountId: string): Promise<Json> {
  const { data, error } = await admin.rpc('get_annual_account', {
    p_organization_id: organizationId,
    p_annual_account_id: annualAccountId,
  });
  if (error) throw new HttpError(error.message, 400);
  if (!data || typeof data !== 'object') throw new HttpError('Jaarrekening niet gevonden.', 404);
  return data as Json;
}

/**
 * Alleen de accentkleur. Dat is opmaak, geen inhoud: de cijfers komen uit de
 * bevroren snapshot en veranderen niet mee met de huisstijl. Briefpapier
 * (invoice_template_data_url) wordt bewust NIET gebruikt — een Letter- of
 * A5-sjabloon zou de paginagrootte van een A4-jaarrekening kapen.
 */
async function loadAccentColor(organizationId: string): Promise<string | null> {
  const { data, error } = await admin
    .from('company_settings')
    .select('invoice_accent_color')
    .eq('organization_id', organizationId)
    .limit(1);
  if (error) return null;
  const value = data?.[0]?.invoice_accent_color;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// ------------------------------------------------------------ genereren
async function buildPdf(account: Json, variant: Variant, accentColor: string | null) {
  const document = variant === 'publication'
    ? buildPublicationDocument(account, { accentColor })
    : buildAnnualAccountsDocument(account, { accentColor });
  const bytes = await renderReportDocument(document);
  return {
    bytes,
    fileName: document.fileName,
    sha256: await sha256HexBytes(bytes),
  };
}

// ------------------------------------------------------------ archiveren
async function archivePdf(params: {
  organizationId: string;
  annualAccountId: string;
  userId: string;
  variant: Variant;
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
}): Promise<Archive> {
  const { organizationId, annualAccountId, userId, variant, fileName, bytes, sha256 } = params;

  if (!PDF_STORAGE_WORKER_URL || !PDF_STORAGE_SECRET) {
    return {
      stored: false,
      provider: 'none',
      key: null,
      attachmentId: null,
      reason: 'Private opslag is niet geconfigureerd (storage worker URL of secret ontbreekt). De PDF is wel gegenereerd.',
    };
  }

  const key = `${organizationId}/annual-account-pdfs/${annualAccountId}/${crypto.randomUUID()}-${fileName}`;
  const response = await fetch(`${PDF_STORAGE_WORKER_URL}${STORAGE_ROUTE}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PDF_STORAGE_SECRET}`,
      'Content-Type': 'application/pdf',
      'X-Storage-Key': key,
      'X-SHA256': sha256,
      'X-Size-Bytes': String(bytes.byteLength),
    },
    // Cast omdat de Deno-typings Uint8Array<ArrayBufferLike> niet als BodyInit
    // accepteren; fetch slikt een Uint8Array wel degelijk (zie quote-workflow).
    body: bytes as unknown as BodyInit,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    console.error('annual-accounts: opslaan in private R2 mislukt', {
      status: response.status,
      message,
      key,
      organizationId,
      annualAccountId,
    });
    return {
      stored: false,
      provider: 'none',
      key: null,
      attachmentId: null,
      reason: `Opslaan in private opslag mislukte (${response.status}): ${message || response.statusText}. De PDF is wel gegenereerd.`,
    };
  }

  // De bijlage-rij. entity_type 'annual_account' bestaat sinds migratie
  // 20260812010000 in de CHECK, in enforce_attachments_org_integrity() én in
  // attachment_module() — die drie horen bij elkaar; ontbreekt er één, dan faalt
  // deze insert ná de upload en blijft er een verweesd bestand in R2 achter.
  const { data: attachment, error: attachmentError } = await admin
    .from('attachments')
    .insert({
      organization_id: organizationId,
      entity_type: 'annual_account',
      entity_id: annualAccountId,
      name: fileName,
      mime_type: 'application/pdf',
      size_bytes: bytes.byteLength,
      storage_key: key,
      created_by: userId,
    })
    .select('id')
    .single();

  if (attachmentError || !attachment) {
    console.error('annual-accounts: registreren van de bijlage mislukt', attachmentError?.message);
    return {
      stored: false,
      provider: 'none',
      key,
      attachmentId: null,
      reason: `Het bestand is opgeslagen maar kon niet als bijlage worden geregistreerd: ${attachmentError?.message ?? 'onbekende fout'}.`,
    };
  }

  const column = variant === 'publication' ? 'publication_attachment_id' : 'pdf_attachment_id';
  const { error: linkError } = await admin
    .from('annual_accounts')
    .update({ [column]: attachment.id })
    .eq('id', annualAccountId)
    .eq('organization_id', organizationId);

  if (linkError) {
    console.error('annual-accounts: koppelen van de bijlage mislukt', linkError.message);
    return {
      stored: true,
      provider: 'r2',
      key,
      attachmentId: String(attachment.id),
      reason: `Het bestand is opgeslagen, maar kon niet aan de jaarrekening worden gekoppeld: ${linkError.message}.`,
    };
  }

  return { stored: true, provider: 'r2', key, attachmentId: String(attachment.id) };
}

// ------------------------------------------------------------ ophalen
/** Het gearchiveerde exemplaar. Null = er is er geen (of hij is niet leesbaar). */
async function loadArchived(
  organizationId: string,
  account: Json,
  variant: Variant,
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const attachmentId = variant === 'publication' ? account.publicationAttachmentId : account.pdfAttachmentId;
  if (!attachmentId || typeof attachmentId !== 'string') return null;
  if (!PDF_STORAGE_WORKER_URL || !PDF_STORAGE_SECRET) return null;

  const { data, error } = await admin
    .from('attachments')
    .select('name, storage_key')
    .eq('id', attachmentId)
    .eq('organization_id', organizationId)
    .limit(1);
  if (error || !data?.[0]?.storage_key) return null;

  const response = await fetch(
    `${PDF_STORAGE_WORKER_URL}${STORAGE_ROUTE}/${encodeURIComponent(String(data[0].storage_key))}`,
    { headers: { Authorization: `Bearer ${PDF_STORAGE_SECRET}` } },
  );
  if (!response.ok) {
    console.warn('annual-accounts: gearchiveerde PDF niet opgehaald', response.status, data[0].storage_key);
    return null;
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    fileName: String(data[0].name || 'jaarrekening.pdf'),
  };
}

// ------------------------------------------------------------ HTTP
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });

  try {
    cors.assert(req);
    if (req.method !== 'POST') throw new HttpError('Alleen POST.', 400);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const annualAccountId = String(body.annualAccountId || '');
    if (!organizationId || !annualAccountId) {
      throw new HttpError('organizationId en annualAccountId zijn verplicht.', 400);
    }

    const user = await requireUser(admin, req);
    const role = await requireOrganizationAccess(admin, user.id, organizationId);

    const writeActions = new Set(['renderPdf', 'renderPublication']);
    const readActions = new Set(['previewPdf', 'downloadPdf', 'downloadPublication']);
    if (!writeActions.has(action) && !readActions.has(action)) {
      throw new HttpError(`Onbekende actie: ${action}`, 400);
    }

    // De modulepoort moet hier staan: deze functie draait op de service-role en
    // dan slaat get_annual_account zijn eigen can_read_module-controle over.
    await assertModuleAccess(admin, user.id, organizationId, 'finance', writeActions.has(action) ? 'write' : 'read');
    if (writeActions.has(action)) assertWriteRole(role);

    const account = await loadAnnualAccount(organizationId, annualAccountId);
    const accentColor = await loadAccentColor(organizationId);

    // Welk document: het publicatiestuk of de volledige jaarrekening.
    const variant: Variant = action === 'renderPublication' || action === 'downloadPublication'
      ? 'publication'
      : action === 'previewPdf' && String(body.variant || '') === 'publication'
        ? 'publication'
        : 'annual';

    // ── Voorbeeld: exact dezelfde bytes als het definitieve stuk, alleen niet
    //    opgeslagen. Eén renderer, geen drift tussen concept en definitief.
    if (action === 'previewPdf') {
      const pdf = await buildPdf(account, variant, accentColor);
      return cors.json(req, {
        ok: true,
        variant,
        source: 'generated',
        fileName: pdf.fileName,
        mimeType: 'application/pdf',
        sizeBytes: pdf.bytes.byteLength,
        sha256: pdf.sha256,
        snapshotHash: account.snapshotHash ?? null,
        snapshotStale: account.snapshotStale === true,
        status: account.status ?? null,
        base64: bytesToBase64(pdf.bytes),
      });
    }

    // ── Genereren én archiveren.
    if (writeActions.has(action)) {
      const pdf = await buildPdf(account, variant, accentColor);
      const archive = await archivePdf({
        organizationId,
        annualAccountId,
        userId: user.id,
        variant,
        fileName: pdf.fileName,
        bytes: pdf.bytes,
        sha256: pdf.sha256,
      });
      return cors.json(req, {
        ok: true,
        variant,
        source: 'generated',
        fileName: pdf.fileName,
        mimeType: 'application/pdf',
        sizeBytes: pdf.bytes.byteLength,
        sha256: pdf.sha256,
        snapshotHash: account.snapshotHash ?? null,
        snapshotStale: account.snapshotStale === true,
        status: account.status ?? null,
        archive,
        base64: bytesToBase64(pdf.bytes),
      });
    }

    // ── Downloaden: eerst het gearchiveerde exemplaar. Dat is het stuk dat is
    //    vastgesteld en gedeponeerd; opnieuw opbouwen is de terugval en wordt als
    //    zodanig benoemd, zodat het scherm het verschil kan tonen.
    const archived = await loadArchived(organizationId, account, variant);
    if (archived) {
      return cors.json(req, {
        ok: true,
        variant,
        source: 'archived',
        fileName: archived.fileName,
        mimeType: 'application/pdf',
        sizeBytes: archived.bytes.byteLength,
        sha256: await sha256HexBytes(archived.bytes),
        snapshotHash: account.snapshotHash ?? null,
        snapshotStale: account.snapshotStale === true,
        status: account.status ?? null,
        base64: bytesToBase64(archived.bytes),
      });
    }

    const pdf = await buildPdf(account, variant, accentColor);
    return cors.json(req, {
      ok: true,
      variant,
      source: 'regenerated',
      note: 'Er is geen gearchiveerd exemplaar; dit stuk is opnieuw opgebouwd uit dezelfde bevroren cijfers.',
      fileName: pdf.fileName,
      mimeType: 'application/pdf',
      sizeBytes: pdf.bytes.byteLength,
      sha256: pdf.sha256,
      snapshotHash: account.snapshotHash ?? null,
      snapshotStale: account.snapshotStale === true,
      status: account.status ?? null,
      base64: bytesToBase64(pdf.bytes),
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Onbekende fout';
    return cors.json(req, { ok: false, error: message }, status);
  }
});
