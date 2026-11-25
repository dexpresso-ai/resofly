// ============================================================
// meeting-transcribe — opname -> ElevenLabs Scribe -> Claude-notulen.
//
// Bedient drie soorten opnames met exact dezelfde pijplijn: een afspraak uit
// de agenda, sinds 18 september een telefoongesprek (client_calls) en sinds
// 23 november een notitie. Het verschil zit alleen in de modulepoort: een
// gespreksopname valt onder Klanten, een notitie-opname onder Inhoud, een
// afspraakopname onder Agenda. Zie resolveModuleKey().
//
// Acties (alle POST, Supabase JWT + org-toegang):
//  - budget    : is er AI-tegoed om een opname te laten uitschrijven? (alleen lezen)
//  - create    : maak een opname-rij aan (AVG-toestemming verplicht) -> { id }
//  - start     : koppel de R2-audio, controleer het AI-budget, stuur naar Scribe.
//                Webhook-modus -> status 'transcribing' (transcript volgt async);
//                synchrone modus -> transcript + notulen meteen -> status 'done'.
//                Is het tegoed op, dan blijft de opname bewaard op 'uploaded'.
//  - summarize : (her)genereer de notulen uit het opgeslagen transcript.
//  - saveToContent : zet een meeting uit de agenda in Inhoud, in de map
//                Meetings bij de klant (sinds 24 november, _shared/meetingInhoud.ts).
//                Dat gebeurt vanzelf zodra het transcript er is, als de opname
//                daarom vroeg (save_to_content bij 'create'). Deze actie is de
//                knop voor een oudere opname, of als de notitie is gewist.
//  - delete    : verwijder de opname-rij (de R2-audio wist de frontend zelf).
//
// AI-budget: transcriptie en notulen vallen onder hetzelfde maandtegoed als
// Gerrie (_shared/aiBudget.ts). De transcriptie wordt afgerekend in ai_usage
// zodra het transcript binnen is (_shared/transcriptionUsage.ts).
//
// Beveiliging: organization_id komt uit de body maar wordt altijd tegen het
// lidmaatschap van de geverifieerde gebruiker gecontroleerd. Schrijven loopt via
// de service-role (RLS staat alleen lezen toe).
// ============================================================

import { aiBudgetMessage } from '../_shared/aiBudget.ts';
import { takeEmailQuota } from '../_shared/emailQuota.ts';
import {
  HttpError, assertModuleAccess, assertWriteRole, createAdminClient, getModuleLevel, isUuid, makeCors,
  parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type HttpStatus, type OrganizationRole,
} from '../_shared/edgeAuth.ts';
import { elevenlabsConfigured, requestTranscription } from '../_shared/elevenlabs.ts';
import { saveMeetingToContent } from '../_shared/meetingInhoud.ts';
import { completeTranscription, runSummaryForRecording } from '../_shared/meetingPipeline.ts';
import { validDay, validTime } from '../_shared/meetingNote.ts';
import { newRecordingModule, recordingModule, type RecordingModule } from '../_shared/recordingModule.ts';
import { transcriptionBudget, transcriptionCostUsd, transcriptionRefusal } from '../_shared/transcriptionUsage.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { EMAIL_LOGO_SLOT_LIGHT } from '../_shared/emailTemplates/layout.ts';
import { loadSenderBrand, withEmailBrand } from '../_shared/emailBrand.ts';

const admin = createAdminClient();

// Resend-secrets zijn projectbreed al gezet (klant-mail/offerte/factuur). Deze
// functie hergebruikt ze om de notulen naar de genodigden te mailen.
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
const MAX_SUMMARY_RECIPIENTS = 50;

const ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('MEETING_ALLOWED_ORIGINS'), Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('BANK_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('MEETING_ALLOW_LOCAL_DEV') || Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const cors = makeCors(ALLOWED_ORIGINS, ALLOW_LOCAL_DEV);

// Grootste audiobestand dat we uit R2 in het geheugen laden en naar Scribe sturen.
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

// Deze acties wijzigen iets of versturen mail — daarvoor is schrijfrecht op de
// module nodig, niet alleen leesrecht.
const WRITE_ACTIONS = new Set(['create', 'start', 'summarize', 'update', 'sendSummary', 'saveToContent', 'delete']);

// Supabase Edge Runtime heeft een ingebouwde `Deno.serve` — geen deno.land/std
// nodig, wat het bundelen niet meer laat afhangen van een externe fetch.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });
  try {
    if (req.method !== 'POST') throw new HttpError('Method not allowed.', 405 as HttpStatus);
    cors.assert(req);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');

    const user = await requireUser(admin, req);
    const role = await requireOrganizationAccess(admin, user.id, organizationId);
    // Een afspraakopname hangt aan Agenda, een gespreksopname aan Klanten, een
    // notitie-opname aan Inhoud. Alle acties hieronder schrijven (of mailen) en
    // vragen dus schrijfrecht op die module; alleen een leesactie zou met
    // leesrecht volstaan.
    const moduleKey = await resolveModuleKey(organizationId, action, body);
    await assertModuleAccess(admin, user.id, organizationId, moduleKey, WRITE_ACTIONS.has(action) ? 'write' : 'read');

    switch (action) {
      case 'budget': return cors.json(req, await budgetStatus(organizationId, user.id));
      case 'create': return cors.json(req, await createRecording(organizationId, user.id, role, body));
      case 'start': return cors.json(req, await startTranscription(organizationId, role, body));
      case 'summarize': return cors.json(req, await summarize(organizationId, role, body, user.id));
      case 'update': return cors.json(req, await updateRecording(organizationId, role, body));
      case 'sendSummary': return cors.json(req, await sendSummary(organizationId, role, body));
      case 'saveToContent': return cors.json(req, await saveToContent(organizationId, user.id, role, body));
      case 'delete': return cors.json(req, await deleteRecording(organizationId, role, body));
      default: throw new HttpError(`Onbekende actie: ${action}`, 400);
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Onbekende fout.';
    if (status >= 500) console.error('meeting-transcribe error:', message);
    return cors.json(req, { ok: false, error: message }, status);
  }
});

// ── Acties ───────────────────────────────────────────────────────────────────

/**
 * Is er AI-tegoed voor een nieuwe opname? De recorder vraagt het vóór het
 * opnemen, zodat je niet pas na een uur vergaderen hoort dat het uitschrijven
 * moet wachten. Het is het eigen tegoed (en dat van de organisatie): de opname
 * komt op jouw naam.
 */
async function budgetStatus(organizationId: string, userId: string) {
  const budget = await transcriptionBudget(admin, userId, organizationId);
  return { ok: true, allowed: budget.allowed, message: budget.allowed ? null : aiBudgetMessage(budget) };
}

async function createRecording(organizationId: string, userId: string, role: OrganizationRole, body: Record<string, unknown>) {
  assertWriteRole(role);
  if (body.consentGiven !== true) throw new HttpError('Toestemming voor opname is vereist.', 400);

  const provider = body.provider ? String(body.provider) : null;
  if (provider && !['google', 'microsoft', 'native'].includes(provider)) throw new HttpError('Ongeldige provider.', 400);
  const clientId = body.clientId ? String(body.clientId) : null;
  const projectId = body.projectId ? String(body.projectId) : null;
  const callId = body.callId ? String(body.callId) : null;
  const noteId = body.noteId ? String(body.noteId) : null;
  if (clientId && !isUuid(clientId)) throw new HttpError('Ongeldige klant-id.', 400);
  if (projectId && !isUuid(projectId)) throw new HttpError('Ongeldige project-id.', 400);
  if (callId && !isUuid(callId)) throw new HttpError('Ongeldige gesprek-id.', 400);
  if (noteId && !isUuid(noteId)) throw new HttpError('Ongeldige notitie-id.', 400);
  // De poort hierboven koos één module; een opname die aan twee dingen hangt,
  // zou ook onder de andere vallen zonder dat iemand daar het recht voor had.
  if (callId && noteId) throw new HttpError('Een opname hoort bij een gesprek of bij een notitie, niet bij allebei.', 400);

  // Hoort de opname bij een gesprek, dan moet dat gesprek van deze organisatie
  // zijn — anders zou een opname aan andermans dossier gehangen kunnen worden.
  if (callId) {
    const { data: callRow } = await admin.from('client_calls')
      .select('id').eq('id', callId).eq('organization_id', organizationId).maybeSingle();
    if (!callRow) throw new HttpError('Gesprek niet gevonden in deze organisatie.', 404);
  }
  // Hetzelfde voor een notitie.
  if (noteId) {
    const { data: noteRow } = await admin.from('notes')
      .select('id').eq('id', noteId).eq('organization_id', organizationId).maybeSingle();
    if (!noteRow) throw new HttpError('Notitie niet gevonden in deze organisatie.', 404);
  }
  // Alleen een afspraakopname hangt aan de agenda. Een gesprek of notitie
  // krijgt de agenda-velden bewust op null: anders kon iemand met alleen de
  // module Klanten of Inhoud via eventRef een opname op andermans agenda-item
  // zetten.
  const forEvent = !callId && !noteId;
  // Hetzelfde voor klant, project en agenda: alleen koppelen aan rijen van deze organisatie.
  const sourceId = forEvent && body.sourceId && isUuid(String(body.sourceId)) ? String(body.sourceId) : null;
  if (clientId) await assertOrgRow('clients', organizationId, clientId, 'Klant');
  if (projectId) await assertOrgRow('projects', organizationId, projectId, 'Project');
  if (sourceId) await assertOrgRow('calendar_sources', organizationId, sourceId, 'Agenda');

  // Zodra het transcript er is, zet de server de meeting vanzelf in Inhoud
  // (_shared/meetingInhoud.ts). Dan is er geen browser meer, dus wat de app nu
  // weet (de dag en de tijd van de afspraak) gaat mee op de opname. De app
  // vraagt het alleen bij een gedeelde afspraak; wie Inhoud niet mag
  // wijzigen, krijgt het niet, zonder dat de opname daarvoor mislukt. De
  // pijplijn kijkt bij het uitschrijven nog eens naar de rechten.
  const saveToContent = forEvent && body.saveToContent === true
    && (await getModuleLevel(admin, userId, organizationId, 'content')) === 'write';

  const { data, error } = await admin.from('meeting_recordings').insert({
    organization_id: organizationId,
    created_by: userId,
    // Een gespreks- of notitie-opname hangt aan dat ene ding en nergens anders
    // aan (zie forEvent hierboven, en de check meeting_recordings_note_alleen).
    provider: forEvent ? provider : null,
    source_id: sourceId,
    event_ref: forEvent && body.eventRef ? String(body.eventRef).slice(0, 512) : null,
    event_title_snapshot: body.eventTitle ? String(body.eventTitle).slice(0, 300) : null,
    client_id: clientId,
    project_id: projectId,
    call_id: callId,
    note_id: noteId,
    save_to_content: saveToContent,
    meeting_date: forEvent ? validDay(body.meetingDate) : null,
    event_starts_at: forEvent ? validTime(body.eventStartsAt) : null,
    event_ends_at: forEvent ? validTime(body.eventEndsAt) : null,
    consent_given: true,
    consent_at: new Date().toISOString(),
    status: 'uploaded',
  }).select('id').single();
  if (error) throw new HttpError(`Opname aanmaken mislukt: ${error.message}`, 500);
  return { ok: true, id: data.id as string, saveToContent };
}

async function startTranscription(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>) {
  assertWriteRole(role);
  if (!elevenlabsConfigured()) throw new HttpError('Transcriptie is nog niet geconfigureerd (ELEVENLABS_API_KEY ontbreekt).', 500);

  const recordingId = String(body.recordingId || '');
  const storageKey = String(body.storageKey || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);
  // Alleen audio die bij déze opname is geüpload (de media-worker bewaart hem onder
  // <organisatie>/meeting_recording/<opname>/). Met alleen de organisatie als
  // voorvoegsel kon elk bestand van de organisatie naar Scribe, op kosten van het tegoed.
  if (!storageKey.startsWith(`${organizationId}/meeting_recording/${recordingId}/`)) throw new HttpError('Ongeldige storageKey.', 400);

  const rec = await loadRecording(organizationId, recordingId); // org-check (gooit bij onbekende opname)
  // Alleen een verse opname gaat naar Scribe: een tweede 'start' op een opname die
  // al loopt of klaar is, kost opnieuw geld en overschrijft het transcript.
  if (rec.status !== 'uploaded') throw new HttpError('Deze opname wordt al verwerkt of is al verwerkt.', 409);
  const durationSeconds = numOrNull(body.durationSeconds);
  const sizeBytes = numOrNull(body.sizeBytes);
  const mimeType = body.mimeType ? String(body.mimeType) : 'audio/webm';
  const audio = { storage_key: storageKey, mime_type: mimeType, size_bytes: sizeBytes, duration_seconds: durationSeconds };

  // Het AI-budget vóór het geld uitgegeven wordt: transcriptie valt onder hetzelfde
  // maandtegoed als Gerrie en de notulen, op naam van wie de opname maakte (die
  // krijgt ook de kosten). Is het op, dan blijft de opname bewaard: de audio staat
  // al in R2, en met de knop op de kaart kan hij later alsnog.
  const budget = await transcriptionBudget(admin, rec.created_by, organizationId);
  if (!budget.allowed) {
    const message = transcriptionRefusal(budget);
    await admin.from('meeting_recordings').update({ ...audio, error_message: message })
      .eq('id', recordingId).eq('organization_id', organizationId).eq('status', 'uploaded');
    throw new HttpError(message, 429);
  }

  // Voorwaardelijk op 'uploaded', zodat twee gelijktijdige starts er maar één laten winnen.
  // De kosten hier zijn een eerste schatting; de echte volgen uit het transcript.
  const { data: claimed, error: claimError } = await admin.from('meeting_recordings').update({
    ...audio, status: 'transcribing', error_message: null,
    transcription_cost_usd: transcriptionCostUsd(durationSeconds ?? 0),
  }).eq('id', recordingId).eq('organization_id', organizationId).eq('status', 'uploaded').select('id');
  if (claimError) throw new HttpError('Opname bijwerken mislukt.', 500);
  if (!claimed?.length) throw new HttpError('Deze opname wordt al verwerkt of is al verwerkt.', 409);

  try {
    const bytes = await fetchAudioBytes(storageKey);
    const filename = storageKey.split('/').pop() || 'meeting.webm';
    const { requestId, transcript } = await requestTranscription(bytes, mimeType, filename);

    if (requestId) {
      // Async: het transcript (en het afrekenen) volgt via de webhook.
      await admin.from('meeting_recordings').update({ elevenlabs_request_id: requestId }).eq('id', recordingId);
      return { ok: true, status: 'transcribing' };
    }

    // Synchroon: transcript opslaan, afrekenen in ai_usage en samenvatten. Niet
    // opgeslagen betekent: de opname wachtte niet meer (al verwerkt of gewist);
    // dan niets overschrijven, ook niet met een foutstatus.
    const outcome = await completeTranscription(admin, recordingId, transcript!);
    const summary = outcome.summary;
    return { ok: true, status: summary?.summarized ? 'done' : 'transcribed', summary };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Transcriptie mislukt.';
    await admin.from('meeting_recordings').update({ status: 'error', error_message: message }).eq('id', recordingId);
    throw e instanceof HttpError ? e : new HttpError(message, 502);
  }
}

async function summarize(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>, userId: string) {
  assertWriteRole(role);
  const recordingId = String(body.recordingId || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);
  await loadRecording(organizationId, recordingId); // org-check
  // Wie erom vraagt, betaalt (zie runSummaryForRecording).
  const outcome = await runSummaryForRecording(admin, recordingId, { billTo: userId });
  return { ok: true, summary: outcome };
}

/**
 * Werkt de (door de gebruiker gecorrigeerde) transcriptie bij. Zo kan de
 * app-gebruiker de tekst nog aanpassen voordat er notulen van gemaakt/verstuurd
 * worden. Notulen zelf worden bij het versturen ter plekke bewerkt (sendSummary).
 */
async function updateRecording(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>) {
  assertWriteRole(role);
  const recordingId = String(body.recordingId || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);
  await loadRecording(organizationId, recordingId); // org-check

  const patch: Record<string, unknown> = {};
  if (typeof body.transcriptText === 'string') patch.transcript_text = body.transcriptText.slice(0, 200_000);
  if (typeof body.summaryText === 'string') patch.summary_text = body.summaryText.slice(0, 100_000);
  if (Object.keys(patch).length === 0) throw new HttpError('Niets om bij te werken.', 400);

  const { error } = await admin.from('meeting_recordings').update(patch)
    .eq('id', recordingId).eq('organization_id', organizationId);
  if (error) throw new HttpError(`Bijwerken mislukt: ${error.message}`, 500);
  return { ok: true };
}

/**
 * Mailt de notulen naar de genodigden. De frontend geeft de (bewerkbare)
 * ontvangerslijst + het (bewerkbare) onderwerp en de tekst mee — zo kan de
 * gebruiker de inhoud nog aanpassen alvorens door te sturen. Elke genodigde
 * krijgt een eigen mail (privacy: ontvangers zien elkaar niet).
 */
async function sendSummary(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>) {
  assertWriteRole(role);
  if (!RESEND_API_KEY) throw new HttpError('E-mailversturen is niet geconfigureerd (RESEND_API_KEY ontbreekt).', 500);

  const recordingId = String(body.recordingId || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);

  const rec = await loadRecordingForMail(organizationId, recordingId);

  const subject = String(body.subject || '').trim().slice(0, 250)
    || `Samenvatting — ${rec.event_title_snapshot || 'afspraak'}`.slice(0, 250);
  const bodyText = String(body.bodyText || '').trim();
  if (!bodyText) throw new HttpError('De samenvatting heeft geen inhoud om te versturen.', 422);

  const includeTranscript = body.includeTranscript === true;
  const transcript = includeTranscript ? String(rec.transcript_text || '').trim() : '';

  // Ontvangers valideren + ontdubbelen (op lowercase e-mail) + begrenzen.
  const seen = new Set<string>();
  const recipients: { email: string; name: string | null }[] = [];
  for (const raw of Array.isArray(body.recipients) ? body.recipients : []) {
    const email = String((raw as Record<string, unknown>)?.email || '').trim().toLowerCase();
    if (!isEmail(email) || seen.has(email)) continue;
    seen.add(email);
    const name = String((raw as Record<string, unknown>)?.name || '').trim();
    recipients.push({ email, name: name || null });
    if (recipients.length >= MAX_SUMMARY_RECIPIENTS) break;
  }
  if (recipients.length === 0) throw new HttpError('Geen geldige genodigden om naar te versturen.', 422);

  // Naam en logo van de afzender in één query (_shared/emailBrand.ts).
  const senderBrand = await loadSenderBrand(admin, organizationId);
  const company = senderBrand.name;
  const sender = await resolveSenderIdentity(admin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  if (!sender.from) throw new HttpError('Er is geen afzenderadres geconfigureerd (koppel een verzenddomein of zet RESEND_FROM_EMAIL).', 422);

  const html = buildSummaryEmailHtml({ organizationName: company, title: rec.event_title_snapshot, bodyText, transcript });
  const text = buildSummaryEmailText({ organizationName: company, title: rec.event_title_snapshot, bodyText, transcript });

  // Quotum per organisatie (20261101050000): één organisatie maakt het gedeelde Resend-account niet voor iedereen op.
  await takeEmailQuota(admin, organizationId, recipients.length, (message, status) => new HttpError(message, status));
  const nonce = crypto.randomUUID();
  const sent: { email: string; name: string | null }[] = [];
  const failed: { email: string; error: string }[] = [];
  for (const r of recipients) {
    try {
      await sendViaResend(withEmailBrand({
        from: sender.from,
        to: [r.email],
        reply_to: sender.replyTo || sender.fromEmail || undefined,
        subject,
        html,
        text,
      }, senderBrand.email), `meeting-summary-${recordingId}-${sanitizeKey(r.email)}-${nonce}`);
      sent.push(r);
    } catch (e) {
      failed.push({ email: r.email, error: e instanceof Error ? e.message : 'Versturen mislukt.' });
    }
  }

  if (sent.length === 0) throw new HttpError(`De notulen konden niet verstuurd worden: ${failed[0]?.error ?? 'onbekende fout'}`, 502);

  await admin.from('meeting_recordings').update({
    summary_sent_at: new Date().toISOString(),
    summary_recipients: sent,
  }).eq('id', recordingId).eq('organization_id', organizationId);

  return { ok: true, sent: sent.length, failed };
}

/**
 * De knop "Opslaan in Inhoud": zet een meeting uit de agenda in Inhoud, bij de
 * klant van de afspraak (of onder Geen klant) in de map Meetings. Sinds 24
 * november gebeurt dat vanzelf zodra het transcript er is; de knop is er nog
 * voor een opname van daarvoor, of als iemand de notitie heeft gewist. Het
 * werk zelf staat in _shared/meetingInhoud.ts, zodat de knop en de
 * automatische weg precies hetzelfde doen.
 *
 * De poort hierboven gaf al schrijfrecht op Agenda (de opname). De notitie
 * komt in Inhoud, dus daar is ook schrijfrecht nodig: anders zette iemand met
 * alleen Agenda via deze weg mappen en notities in Inhoud.
 */
async function saveToContent(organizationId: string, userId: string, role: OrganizationRole, body: Record<string, unknown>) {
  assertWriteRole(role);
  await assertModuleAccess(admin, userId, organizationId, 'content', 'write');
  const recordingId = String(body.recordingId || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);
  const saved = await saveMeetingToContent(admin, {
    organizationId, recordingId, userId,
    meetingDate: body.meetingDate, eventStartsAt: body.eventStartsAt, eventEndsAt: body.eventEndsAt,
  });
  return { ok: true, ...saved };
}

async function deleteRecording(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>) {
  assertWriteRole(role);
  const recordingId = String(body.recordingId || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);
  const { error } = await admin.from('meeting_recordings').delete().eq('id', recordingId).eq('organization_id', organizationId);
  if (error) throw new HttpError(`Opname verwijderen mislukt: ${error.message}`, 500);
  return { ok: true };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Welke module bewaakt deze aanvraag? Een opname bij een telefoongesprek valt
 * onder Klanten, een opname bij een notitie onder Inhoud, een opname bij een
 * afspraak onder Agenda.
 *
 * ALLEEN bij 'create' mag de body dit bepalen — daar bestaat de opname nog
 * niet. Bij elke andere actie beslist de opname-rij zelf, en worden `callId`
 * en `noteId` uit de body genegeerd.
 *
 * Dat onderscheid is de hele poort. Zou de body ook bij 'delete' of
 * 'sendSummary' meetellen, dan stuurt iemand met alleen de module Klanten een
 * willekeurige `callId` mee naast de `recordingId` van een AGENDA-opname, en
 * loopt hij zo langs het Agenda-recht heen — hij zou andermans notulen kunnen
 * mailen of verwijderen. De extra lookup is de prijs van een poort die niet te
 * omzeilen is door een veld toe te voegen of weg te laten.
 */
async function resolveModuleKey(organizationId: string, action: string, body: Record<string, unknown>): Promise<RecordingModule> {
  const recordingId = body.recordingId ? String(body.recordingId) : '';
  if (isUuid(recordingId)) {
    const { data } = await admin.from('meeting_recordings')
      .select('call_id, note_id').eq('id', recordingId).eq('organization_id', organizationId).maybeSingle();
    return recordingModule(data as { call_id: string | null; note_id: string | null } | null);
  }
  return newRecordingModule(action, body);
}

async function loadRecording(organizationId: string, recordingId: string) {
  const { data, error } = await admin.from('meeting_recordings')
    .select('id, organization_id, status, created_by').eq('id', recordingId).eq('organization_id', organizationId).single();
  if (error || !data) throw new HttpError('Opname niet gevonden in deze organisatie.', 404);
  return data as { id: string; organization_id: string; status: string; created_by: string | null };
}

/** Gooit een 404 als de klant/het project/de agenda niet bij deze organisatie hoort. */
async function assertOrgRow(table: 'clients' | 'projects' | 'calendar_sources', organizationId: string, id: string, label: string): Promise<void> {
  const { data } = await admin.from(table).select('id').eq('id', id).eq('organization_id', organizationId).maybeSingle();
  if (!data) throw new HttpError(`${label} niet gevonden in deze organisatie.`, 404);
}

async function loadRecordingForMail(organizationId: string, recordingId: string) {
  const { data, error } = await admin.from('meeting_recordings')
    .select('id, event_title_snapshot, transcript_text')
    .eq('id', recordingId).eq('organization_id', organizationId).single();
  if (error || !data) throw new HttpError('Opname niet gevonden in deze organisatie.', 404);
  return data as { id: string; event_title_snapshot: string | null; transcript_text: string | null };
}

// ── E-mail (Resend) ────────────────────────────────────────────────────────────

async function sendViaResend(payload: Record<string, unknown>, idempotencyKey: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(String(detail.message || detail.error || res.statusText || 'Resend send failed'));
  }
}

function buildSummaryEmailHtml(input: { organizationName: string; title: string | null; bodyText: string; transcript: string }): string {
  const org = escapeHtml(input.organizationName);
  const heading = escapeHtml(input.title ? `Samenvatting — ${input.title}` : 'Samenvatting van de afspraak');
  const bodyHtml = escapeHtml(input.bodyText).replace(/\n/g, '<br/>');
  const transcriptBlock = input.transcript
    ? `<div style="margin-top:22px;border-top:1px solid #e4e4e7;padding-top:16px;">
         <p style="margin:0 0 8px;font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:.06em;">Transcript</p>
         <div style="white-space:pre-wrap;font-size:13px;line-height:1.6;color:#3f3f46;">${escapeHtml(input.transcript)}</div>
       </div>`
    : '';
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <div style="max-width:640px;margin:0 auto;padding:28px 20px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;padding:28px;line-height:1.6;font-size:15px;">
        ${EMAIL_LOGO_SLOT_LIGHT}<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827;">${heading}</h1>
        <div>${bodyHtml}</div>
        ${transcriptBlock}
      </div>
      <p style="margin:14px 4px 0;color:#8a8a92;font-size:12px;line-height:1.5;">Verstuurd door ${org} via ResoFly.</p>
    </div>
  </body>
</html>`;
}

function buildSummaryEmailText(input: { organizationName: string; title: string | null; bodyText: string; transcript: string }): string {
  const lines = [
    input.title ? `Samenvatting — ${input.title}` : 'Samenvatting van de afspraak',
    '',
    input.bodyText,
  ];
  if (input.transcript) lines.push('', '— Transcript —', '', input.transcript);
  lines.push('', `Verstuurd door ${input.organizationName} via ResoFly.`);
  return lines.join('\n');
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'x';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c] || c));
}

/**
 * Haalt de audiobytes server-side uit R2 via het interne worker-pad.
 * URL en secret vallen terug op de al-geconfigureerde PDF-storage-namen, zodat
 * deze functie dezelfde worker + hetzelfde gedeelde secret hergebruikt zonder
 * dat er een aparte INTERNAL_UPLOAD_SECRET op de edge-kant gezet hoeft te worden.
 */
async function fetchAudioBytes(storageKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const base = (Deno.env.get('MEDIA_WORKER_URL') || Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') || Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') || '').replace(/\/$/, '');
  const secret = Deno.env.get('INTERNAL_UPLOAD_SECRET') || Deno.env.get('INVOICE_PDF_STORAGE_SECRET') || Deno.env.get('QUOTE_PDF_STORAGE_SECRET') || '';
  if (!base || !secret) throw new HttpError('Media-worker niet geconfigureerd (zet MEDIA_WORKER_URL + INTERNAL_UPLOAD_SECRET, of hergebruik de PDF-storage-secrets).', 500);
  const res = await fetch(`${base}/internal/media/${encodeURIComponent(storageKey)}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw new HttpError(`Audio ophalen uit R2 mislukt (${res.status}).`, 502);

  // Grens vóór het inlezen: eerst op de opgegeven lengte, daarna tijdens het lezen
  // (de lengte kan ontbreken of niet kloppen), zodat een te groot object nooit
  // helemaal in het geheugen belandt.
  const tooLarge = () => new HttpError(`Het audiobestand is te groot (maximaal ${MAX_AUDIO_BYTES / (1024 * 1024)} MB).`, 413);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUDIO_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
