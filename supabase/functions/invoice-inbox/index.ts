// ============================================================
// invoice-inbox — de knoppen van de factuur-inbox (inkoopfacturen per e-mail,
// en sinds 2026-11-18 ook bonnen die in de app zijn gefotografeerd).
//
// De automatische verwerking van mail start in mail-inbound; hier komen de
// handelingen van een mens in het scherm:
//   upload   een bon insturen: de foto naar R2, een item op de werklijst, en
//            meteen verwerken terwijl de app wacht (Gerrie aan het werk). Mag
//            ieder teamlid dat schrijft. Wie Financiën mag bewerken, krijgt een
//            concept ('receipt'); wie dat niet mag, dient een declaratie in
//            ('declaration') en krijgt alleen zijn eigen bon terug te zien.
//   process  opnieuw uitlezen en klaarzetten (na een storing, of als de AI
//            eerder niet beschikbaar was)
//   prepare  klaarzetten op basis van het bewaarde voorstel, met een gekozen
//            of nieuw aan te maken leverancier; met allowDuplicate ook een
//            als dubbel gemarkeerd item ("Toch klaarzetten")
//   reject   negeren (geen factuur / niet van ons); de rij blijft bewaard
//   restore  een genegeerd item terug op de werklijst en opnieuw verwerken
//   decline  een declaratie afwijzen, met een reden die de indiener leest
//   link     "zelf invullen": een met de hand gemaakt concept aan het item
//            hangen, met het bestand als bewijsstuk
//
// Auth zoals invoice-extract: Supabase JWT + org-lidmaatschap + schrijfrol.
// Alles behalve upload vraagt daarnaast de module Financiën met schrijfrecht.
// Elke actie controleert dat het item bij de organisatie uit het verzoek hoort;
// de verwerking zelf zit in _shared/invoiceInbox.ts.
//
// Daarnaast één pad zonder gebruiker, voor pg_cron (x-cron-secret):
//   ?cron=sweep  vastgelopen of tijdelijk mislukte items opnieuw oppakken en
//                bijlagen van afgedane items van R2 opruimen. Het secret is
//                INVOICE_INBOX_CRON_SECRET, met INVOICE_REMINDER_CRON_SECRET
//                als terugval (zelfde patroon als de herinnerings- en dunning-cron).
// ============================================================

import {
  HttpError, assertModuleAccess, assertWriteRole, createAdminClient, getModuleLevel, isUuid, makeCors,
  parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type HttpStatus,
} from '../_shared/edgeAuth.ts';
import {
  createUploadItem, declineDeclaration, linkInboxItem, loadInboxRow, processInboxItem, purgeInboxAttachments,
  rejectInboxItem, restoreInboxItem, runInBackground, sweepInbox,
  type InboxRow, type ProcessOptions,
} from '../_shared/invoiceInbox.ts';
import { base64ToBytes, normalizeBase64 } from '../_shared/invoiceProposal.ts';
import {
  bytesMatchType, declarationView, isUploadableReceipt, MAX_UPLOADS_PER_HOUR, normalizeDocumentMime, uploadChannelFor,
} from '../_shared/invoiceInboxRules.ts';

const admin = createAdminClient();

const CRON_SECRET = Deno.env.get('INVOICE_INBOX_CRON_SECRET') || Deno.env.get('INVOICE_REMINDER_CRON_SECRET') || '';

const ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('MEETING_ALLOWED_ORIGINS'), Deno.env.get('BANK_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('INVOICE_ALLOW_LOCAL_DEV') || Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const cors = makeCors(ALLOWED_ORIGINS, ALLOW_LOCAL_DEV);

// Een bon gaat als base64 mee, zoals bij invoice-extract. De app verkleint een
// foto vooraf tot ruim onder een megabyte; een pdf-scan kan groter zijn.
const MAX_DECODED_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_REQUEST_BYTES = 15 * 1024 * 1024; // base64 (×1.37) + JSON

type Action = 'process' | 'prepare' | 'reject' | 'restore' | 'upload' | 'decline' | 'link';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });

  // De opruimronde: geen gebruiker, geen CORS — server-naar-server met een secret.
  const cron = new URL(req.url).searchParams.get('cron');
  if (cron) return await handleCron(req, cron);

  try {
    if (req.method !== 'POST') throw new HttpError('Method not allowed.', 405 as HttpStatus);
    cors.assert(req);
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength && contentLength > MAX_REQUEST_BYTES) throw new HttpError('Verzoek is te groot.', 413);
    const user = await requireUser(admin, req);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(admin, user.id, organizationId);
    assertWriteRole(role);

    const action = String(body.action || '') as Action;
    // Een bon insturen mag ieder teamlid dat schrijft; wat het wordt (concept
    // of declaratie) hangt aan zijn recht op Financiën, zie handleUpload.
    if (action === 'upload') return cors.json(req, await handleUpload(body, user, organizationId));

    await assertModuleAccess(admin, user.id, organizationId, 'finance', 'write');

    const inboxId = String(body.inboxId || '');
    if (!isUuid(inboxId)) throw new HttpError('Ongeldig inbox-item.', 400);

    const row = await loadInboxRow(admin, inboxId);
    if (!row || row.organization_id !== organizationId) throw new HttpError('Inbox-item niet gevonden.', 404);

    let item: InboxRow;
    switch (action) {
      case 'process': {
        item = await processInboxItem(admin, row.id, { allowDuplicate: body.allowDuplicate === true, actorUserId: user.id });
        break;
      }
      case 'prepare': {
        const supplierId = typeof body.supplierId === 'string' && body.supplierId ? body.supplierId : null;
        if (supplierId && !isUuid(supplierId)) throw new HttpError('Ongeldige leverancier.', 400);
        const supplierOverride: ProcessOptions['supplierOverride'] = supplierId
          ? { supplierId }
          : body.createSupplier === true ? { createSupplier: true } : null;
        item = await processInboxItem(admin, row.id, {
          useStoredProposal: true,
          allowDuplicate: body.allowDuplicate === true || row.status === 'duplicate',
          supplierOverride,
          actorUserId: user.id,
          // Klaarzetten is klaarzetten: boeken doet de gebruiker daarna zelf.
          noAutoBook: true,
        });
        break;
      }
      case 'reject':
        item = await rejectInboxItem(admin, row, user.id);
        break;
      case 'restore':
        item = await restoreInboxItem(admin, row, user.id);
        break;
      case 'decline':
        item = await declineDeclaration(admin, row, user.id, typeof body.note === 'string' ? body.note : '');
        break;
      case 'link': {
        const purchaseInvoiceId = String(body.purchaseInvoiceId || '');
        if (!isUuid(purchaseInvoiceId)) throw new HttpError('Ongeldige inkoopfactuur.', 400);
        item = await linkInboxItem(admin, row, purchaseInvoiceId, user.id);
        break;
      }
      default:
        throw new HttpError('Onbekende actie.', 400);
    }

    return cors.json(req, { ok: true, item });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const detail = err instanceof Error ? err.message : 'Onbekende fout.';
    if (status >= 500) console.error('invoice-inbox error:', detail);
    const clientMessage = status === 502 ? detail
      : status >= 500 ? 'Er ging iets mis bij het verwerken van de factuur. Probeer het later opnieuw.' : detail;
    return cors.json(req, { ok: false, error: clientMessage }, status);
  }
});

// ── Een bon uit de app ──────────────────────────────────────────────────────────

/**
 * Vastleggen, opslaan en meteen verwerken. De app wacht op het antwoord (hij
 * toont zolang Gerrie aan het werk); de verwerking staat daarnaast in
 * waitUntil, zodat hij afloopt als de verbinding onderweg wegvalt. Gebeurt dat
 * vóór de verwerking begon, dan pakt de opruimronde hem op.
 *
 * Het antwoord verschilt per kanaal. Wie Financiën mag bewerken, krijgt het
 * hele item en het concept terug, net als op de werklijst. Een declarant
 * krijgt alleen zijn eigen bon (declarationView): geen waarschuwingen, geen
 * reden, geen ids. Een waarschuwing kan een andere factuur noemen of het IBAN
 * dat bij een leverancier bekend is.
 */
async function handleUpload(body: Record<string, unknown>, user: { id: string; email?: string }, organizationId: string) {
  const channel = uploadChannelFor(await getModuleLevel(admin, user.id, organizationId, 'finance'));

  const clientRequestId = String(body.clientRequestId || '');
  if (!isUuid(clientRequestId)) throw new HttpError('Ongeldig verzoek-id.', 400);
  const file = readUploadFile(body);

  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count, error: countError } = await admin.from('purchase_invoice_inbox')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId).eq('submitted_by', user.id).gte('received_at', since);
  if (countError) throw new HttpError(`Limiet controleren mislukt: ${countError.message}`, 500);
  if ((count ?? 0) >= MAX_UPLOADS_PER_HOUR) {
    throw new HttpError(`Je hebt het afgelopen uur al ${MAX_UPLOADS_PER_HOUR} bonnen ingestuurd. Probeer het over een tijdje opnieuw.`, 429);
  }

  const { row, created } = await createUploadItem(admin, {
    organizationId, channel, submittedBy: user.id, submitterEmail: user.email ?? null, clientRequestId, file,
  });

  let item = row;
  if (created || row.status === 'received') {
    const task = processInboxItem(admin, row.id, {});
    await runInBackground(task, 'invoice-inbox upload');
    try {
      item = await task;
    } catch (err) {
      // 409: een tweede verzoek met dezelfde foto, terwijl de eerste nog loopt.
      if (!(err instanceof HttpError) || err.status !== 409) throw err;
      item = (await loadInboxRow(admin, row.id)) ?? row;
    }
  }

  if (channel === 'declaration') return { ok: true, channel, declaration: declarationView(item) };
  return { ok: true, channel, item, invoice: await invoiceSummary(item) };
}

function readUploadFile(body: Record<string, unknown>): { name: string; mimeType: string; bytes: Uint8Array } {
  const file = (body.file && typeof body.file === 'object' ? body.file : {}) as Record<string, unknown>;
  const name = String(file.name || '').trim().slice(0, 120) || 'bon.jpg';
  const mimeType = normalizeDocumentMime(name, String(file.mimeType || ''));
  if (!isUploadableReceipt(name, mimeType)) {
    throw new HttpError('Alleen een foto (JPG, PNG of WEBP) of een pdf-scan kan als bon worden ingestuurd.', 400);
  }
  const dataBase64 = normalizeBase64(String(file.dataBase64 || ''));
  if (!dataBase64) throw new HttpError('Geen foto ontvangen.', 400);
  if (Math.floor((dataBase64.length * 3) / 4) > MAX_DECODED_BYTES) {
    throw new HttpError(`Het bestand is te groot (max ${Math.round(MAX_DECODED_BYTES / 1024 / 1024)} MB).`, 413);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(dataBase64);
  } catch {
    throw new HttpError('Het bestand kon niet worden gelezen (ongeldige inhoud).', 400);
  }
  if (!bytes.byteLength) throw new HttpError('Geen foto ontvangen.', 400);
  if (!bytesMatchType(bytes, mimeType)) {
    throw new HttpError('Dit bestand is geen foto of pdf die ResoFly kan lezen. Maak een nieuwe foto of kies een JPG of pdf.', 400);
  }
  return { name, mimeType, bytes };
}

/** Het concept bij een bon, voor de uitslag in het scherm (alleen voor wie Financiën mag bewerken). */
async function invoiceSummary(item: InboxRow) {
  if (!item.purchase_invoice_id) return null;
  const { data } = await admin.from('purchase_invoices')
    .select('id, internal_number, date, total_cents, currency, supplier_id, status')
    .eq('id', item.purchase_invoice_id).eq('organization_id', item.organization_id).maybeSingle();
  if (!data) return null;
  const pi = data as { id: string; internal_number: string | null; date: string; total_cents: number; currency: string; supplier_id: string | null; status: string };
  let supplierName: string | null = null;
  if (pi.supplier_id) {
    const { data: sup } = await admin.from('suppliers').select('name')
      .eq('id', pi.supplier_id).eq('organization_id', item.organization_id).maybeSingle();
    supplierName = (sup as { name?: string } | null)?.name ?? null;
  }
  return { ...pi, supplier_name: supplierName };
}

// ── Cron ────────────────────────────────────────────────────────────────────────

async function handleCron(req: Request, cron: string): Promise<Response> {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  if (!CRON_SECRET) return json({ ok: false, error: 'INVOICE_INBOX_CRON_SECRET (of INVOICE_REMINDER_CRON_SECRET) ontbreekt in de Edge Function secrets.' }, 500);
  const provided = req.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, CRON_SECRET)) return json({ ok: false, error: 'Ongeldig of ontbrekend cron-secret.' }, 401);
  if (cron !== 'sweep') return json({ ok: false, error: `Onbekende cron: ${cron}` }, 400);
  try {
    const sweep = await sweepInbox(admin, { limit: 5 });
    const purge = await purgeInboxAttachments(admin, { limit: 25 });
    return json({ ok: true, sweep, purge });
  } catch (err) {
    console.error('invoice-inbox cron error:', err instanceof Error ? err.message : String(err));
    return json({ ok: false, error: 'Opruimronde mislukt door een serverfout.' }, 500);
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
