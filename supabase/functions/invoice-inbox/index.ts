// ============================================================
// invoice-inbox — de knoppen van de factuur-inbox (inkoopfacturen per e-mail).
//
// De automatische verwerking start in mail-inbound; hier komen de handelingen
// van een mens in het scherm:
//   process  opnieuw uitlezen en klaarzetten (na een storing, of als de AI
//            eerder niet beschikbaar was)
//   prepare  klaarzetten op basis van het bewaarde voorstel, met een gekozen
//            of nieuw aan te maken leverancier; met allowDuplicate ook een
//            als dubbel gemarkeerd item ("Toch klaarzetten")
//   reject   negeren (geen factuur / niet van ons); de rij blijft bewaard
//   restore  een genegeerd item terug op de werklijst en opnieuw verwerken
//
// Auth zoals invoice-extract: Supabase JWT + org-lidmaatschap + schrijfrol +
// de module Financiën. Elke actie controleert dat het item bij de organisatie
// uit het verzoek hoort; de verwerking zelf zit in _shared/invoiceInbox.ts.
//
// Daarnaast één pad zonder gebruiker, voor pg_cron (x-cron-secret):
//   ?cron=sweep  vastgelopen of tijdelijk mislukte items opnieuw oppakken en
//                bijlagen van afgedane items van R2 opruimen. Het secret is
//                INVOICE_INBOX_CRON_SECRET, met INVOICE_REMINDER_CRON_SECRET
//                als terugval (zelfde patroon als de herinnerings- en dunning-cron).
// ============================================================

import {
  HttpError, assertModuleAccess, assertWriteRole, createAdminClient, isUuid, makeCors,
  parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type HttpStatus,
} from '../_shared/edgeAuth.ts';
import {
  loadInboxRow, processInboxItem, purgeInboxAttachments, rejectInboxItem, restoreInboxItem, sweepInbox,
  type InboxRow, type ProcessOptions,
} from '../_shared/invoiceInbox.ts';

const admin = createAdminClient();

const CRON_SECRET = Deno.env.get('INVOICE_INBOX_CRON_SECRET') || Deno.env.get('INVOICE_REMINDER_CRON_SECRET') || '';

const ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('MEETING_ALLOWED_ORIGINS'), Deno.env.get('BANK_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('INVOICE_ALLOW_LOCAL_DEV') || Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const cors = makeCors(ALLOWED_ORIGINS, ALLOW_LOCAL_DEV);

type Action = 'process' | 'prepare' | 'reject' | 'restore';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });

  // De opruimronde: geen gebruiker, geen CORS — server-naar-server met een secret.
  const cron = new URL(req.url).searchParams.get('cron');
  if (cron) return await handleCron(req, cron);

  try {
    if (req.method !== 'POST') throw new HttpError('Method not allowed.', 405 as HttpStatus);
    cors.assert(req);
    const user = await requireUser(admin, req);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(admin, user.id, organizationId);
    assertWriteRole(role);
    await assertModuleAccess(admin, user.id, organizationId, 'finance', 'write');

    const action = String(body.action || '') as Action;
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
        });
        break;
      }
      case 'reject':
        item = await rejectInboxItem(admin, row, user.id);
        break;
      case 'restore':
        item = await restoreInboxItem(admin, row, user.id);
        break;
      default:
        throw new HttpError('Onbekende actie.', 400);
    }

    return cors.json(req, { ok: true, item });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const detail = err instanceof Error ? err.message : 'Onbekende fout.';
    if (status >= 500) console.error('invoice-inbox error:', detail);
    const clientMessage = status >= 500 ? 'Er ging iets mis bij het verwerken van de factuur. Probeer het later opnieuw.' : detail;
    return cors.json(req, { ok: false, error: clientMessage }, status);
  }
});

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
