// ============================================================
// gerrie-agent-runner — de headless motor voor "Gerrie Routines"
// (gebruikers bouwen eigen geplande/terugkerende agents).
//
// Dual-path Edge Function (zelfde vorm als web-push):
//  1. ?cron=tick  — server-to-server, geauthenticeerd met x-cron-secret
//     (AGENTS_CRON_SECRET). pg_cron roept dit per minuut aan (GERRIE_ROUTINES_SETUP.md).
//     Claimt due agents (lease) en draait elk via HETZELFDE brein als de chat
//     (_shared/gerrieCore.ts) met een no-op emit (geen browser).
//  2. app-pad    — Supabase-JWT + owner/admin; beheer (create/update/status/delete)
//     en "nu draaien". Lezen doet de client rechtstreeks via RLS (owner/admin).
//
// Veiligheidsinvariant (v1): een geplande agent voert NOOIT onbewaakt schrijf-acties
// uit. 'report'-agents krijgen alleen lees-tools; 'propose'-agents mogen daarnaast één
// actie VOORSTELLEN, die (net als in de chat) in ai_action_audit ('proposed') belandt
// en pas door een mens in de app wordt uitgevoerd. Budget is FAIL-CLOSED op dit pad.
//
// Tenant-grens: de runner draait als service-role (RLS uit). organization_id komt
// ALTIJD uit ai_agents.organization_id, nooit uit het model; elke tool-query is
// org-scoped in gerrieCore.
// ============================================================

import {
  supabaseAdmin, HttpError, ANTHROPIC_API_KEY, TOOL_DEFINITIONS, toolCatalog, AGENT_FORBIDDEN_TOOLS,
  resolveModelKind, runAgent, buildContext, createConversation, insertMessage,
  recordUsage, costUsd, checkUserBudget, requireUser, requireOrganizationAccess,
  describeError, isUuid, todayIso, tzOffsetMs, parseAllowedOrigins, loadHistory,
  AGENT_ICON_KEYS,
} from '../_shared/gerrieCore.ts';
import type { AgentStep, Emit, OrganizationRole } from '../_shared/gerrieCore.ts';
import { sendViaResend } from '../_shared/resend.ts';

const AGENTS_CRON_SECRET = Deno.env.get('AGENTS_CRON_SECRET') || '';
const CLAIM_LIMIT = Math.max(1, Math.min(5, Number(Deno.env.get('AGENTS_CLAIM_LIMIT') || '3') || 3));
const CIRCUIT_BREAKER_FAILURES = 3;

const ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('BANK_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || Deno.env.get('BANK_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const noopEmit: Emit = async () => {};

// De vaste lees-tools (alles wat niet met propose_ begint). Uit gerrieCore, dus geen drift.
const ALL_TOOL_NAMES: string[] = (TOOL_DEFINITIONS as Array<{ name: string }>).map((t) => t.name);
const READ_TOOL_NAMES: string[] = ALL_TOOL_NAMES.filter((n) => !n.startsWith('propose_'));

// De embleem-allowlist staat in gerrieCore, zodat de bouwer en deze schrijfpoort
// niet uit elkaar kunnen lopen.

// ── Het logboek ──────────────────────────────────────────────────────────────

/**
 * Schrijft de stappen van één run weg naar `ai_agent_run_events`.
 *
 * Een geplande agent draait terwijl niemand kijkt; wat hij deed moet daarna dus
 * na te lezen zijn, ook als de agent later gearchiveerd wordt. De regels worden
 * in het geheugen verzameld en in blokjes weggeschreven: één insert per stap zou
 * de edge-wallclock opeten die we voor het echte werk nodig hebben.
 *
 * Bewust BEST-EFFORT: een logboek dat de run laat mislukken is erger dan een
 * ontbrekende logregel. Een fout gaat naar de console (en dus naar de functie-logs).
 */
function runLogger(orgId: string, agentId: string, runId: string, startSeq = 0) {
  let seq = startSeq;
  let pending: Array<Record<string, unknown>> = [];
  return {
    add(kind: string, label: string, detail: Record<string, unknown> = {}): void {
      pending.push({
        organization_id: orgId, agent_id: agentId, run_id: runId,
        seq: seq, kind, label: String(label).slice(0, 400), detail,
      });
      seq += 1;
    },
    /** Een stap uit de agent-loop (tool/voorstel/fout) één-op-één overnemen. */
    addStep(step: AgentStep): void {
      this.add(step.kind, step.label, { tool: step.name, ok: step.ok, ...step.detail });
    },
    async flush(): Promise<void> {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      const { error } = await supabaseAdmin.from('ai_agent_run_events').insert(batch);
      if (error) console.error('gerrie-agent-runner logboek schrijven mislukt', runId, error.message);
    },
  };
}

/** Waar het logboek van deze run gebleven was (voor een antwoordbeurt erna). */
async function nextLogSeq(runId: string): Promise<number> {
  const { data } = await supabaseAdmin.from('ai_agent_run_events')
    .select('seq').eq('run_id', runId).order('seq', { ascending: false }).limit(1).maybeSingle();
  return Number(data?.seq ?? -1) + 1;
}

// ── Entry ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  const url = new URL(req.url);
  const cronParam = url.searchParams.get('cron');

  // Cron-pad: eerst het secret, vóór enige origin-check (server-to-server).
  if (cronParam) {
    try {
      assertCronSecret(req);
      if (cronParam === 'tick') return plainJson(await runTick());
      return plainJson({ ok: false, error: `Onbekende cron: ${cronParam}` }, 400);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error('gerrie-agent-runner cron error', describeError(error));
      return plainJson({ ok: false, error: error instanceof HttpError ? error.message : 'Serverfout.' }, status);
    }
  }

  // App-pad: JWT + owner/admin.
  try {
    if (req.method !== 'POST') return json(req, { error: 'Method not allowed.' }, 405);
    assertAllowedOrigin(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = String(body.organizationId || '');
    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);
    if (!['owner', 'admin'].includes(role)) throw new HttpError('Alleen owners en admins kunnen Routines beheren.', 403);

    const action = String(body.action || '');
    switch (action) {
      case 'create': return json(req, await createAgent(organizationId, user.id, body));
      case 'update': return json(req, await updateAgent(organizationId, body));
      case 'set_status': return json(req, await setStatus(organizationId, String(body.id || ''), String(body.status || '')));
      // 'delete' bestaat alleen nog als oude naam voor archiveren: een agent met
      // historie gooien we niet weg (zie archiveAgent).
      case 'delete':
      case 'archive': return json(req, await archiveAgent(organizationId, String(body.id || '')));
      case 'restore': return json(req, await restoreAgent(organizationId, String(body.id || '')));
      case 'run_now': return json(req, await runNow(organizationId, String(body.id || '')));
      case 'reply': return json(req, await replyToRun(organizationId, user.id, role, body));
      // Alles wat een agent MAG kunnen, afgeleid uit de echte tooldefinities en
      // gefilterd op de modulerechten van dit teamlid. De bouwer hoeft dus geen
      // eigen lijst bij te houden — zie de opmerking bij TOOL_LABELS in gerrieCore.
      case 'tools': return json(req, { tools: await listAgentTools(organizationId, user.id, role) });
      default: throw new HttpError('Onbekende actie.', 400);
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const internal = describeError(error);
    if (status >= 500) console.error('gerrie-agent-runner error', internal); else console.warn('gerrie-agent-runner warning', internal);
    const publicMessage = error instanceof HttpError ? error.message : 'Er ging iets mis met de Routines-motor.';
    return json(req, { error: publicMessage }, status);
  }
});

// ── Cron-tik: due agents claimen + draaien ───────────────────────────────────

async function runTick(): Promise<{ ok: true; claimed: number; results: Array<Record<string, unknown>> }> {
  const { data: agents, error } = await supabaseAdmin.rpc('claim_due_agents', { p_limit: CLAIM_LIMIT });
  if (error) throw new HttpError(`Claimen van agents mislukt: ${error.message}`, 500);
  const claimed = (agents ?? []) as Array<Record<string, unknown>>;
  const results: Array<Record<string, unknown>> = [];
  for (const agent of claimed) {
    try {
      results.push(await executeAgentRun(agent, 'schedule', occurrenceKeyForSlot(agent), { reschedule: true }));
    } catch (err) {
      // Vangnet: één kapotte agent mag de batch niet vastzetten.
      console.error('gerrie-agent-runner agent-run error', String(agent.id), describeError(err));
      await failAndReschedule(agent, describeError(err));
      results.push({ agentId: agent.id, status: 'failed', error: describeError(err) });
    }
  }
  return { ok: true, claimed: claimed.length, results };
}

function occurrenceKeyForSlot(agent: Record<string, unknown>): string {
  const slot = agent.next_run_at ? new Date(String(agent.next_run_at)).toISOString() : new Date().toISOString();
  return slot;
}

// ── De kern: één agent-run (gedeeld door cron + "nu draaien") ─────────────────

async function executeAgentRun(
  agent: Record<string, unknown>,
  triggeredBy: 'schedule' | 'manual',
  occurrenceKey: string,
  opts: { reschedule: boolean },
): Promise<Record<string, unknown>> {
  const agentId = String(agent.id);
  const orgId = String(agent.organization_id);
  const runAsUserId = agent.run_as_user_id ? String(agent.run_as_user_id) : '';
  const name = String(agent.name || 'Naamloze routine');
  const mode = String(agent.mode || 'report') === 'propose' ? 'propose' : 'report';
  const modelKind = resolveModelKind(agent.model_kind);

  // Gearchiveerd = met pensioen. Hij bestaat nog voor de historie, maar draait niet.
  if (String(agent.status) === 'archived') {
    await supabaseAdmin.from('ai_agents').update({ next_run_at: null, lease_until: null }).eq('id', agentId);
    return { agentId, status: 'skipped', reason: 'archived' };
  }

  // 1) Idempotente run-rij. Bestaat het slot al → dubbele tik, sla over.
  const { data: runRow, error: runErr } = await supabaseAdmin.from('ai_agent_runs').insert({
    organization_id: orgId, agent_id: agentId, triggered_by: triggeredBy, status: 'running',
    occurrence_key: occurrenceKey, scheduled_for: agent.next_run_at ?? null,
    started_at: new Date().toISOString(), attempts: 1,
  }).select('id').single();

  if (runErr) {
    if (String(runErr.code) === '23505') {
      // Dit slot draaide al (crash-vangnet): schuif alleen het schema door, draai niets.
      if (opts.reschedule) await rescheduleAgent(agent, {});
      return { agentId, status: 'skipped', reason: 'duplicate' };
    }
    throw new HttpError(`Run aanmaken mislukt: ${runErr.message}`, 500);
  }
  const runId = String(runRow.id);

  // 1b) Logboek openen. Vanaf hier is elke stap na te lezen op de agentpagina.
  const allowedToolNames = resolveAllowedTools(agent, mode);
  const log = runLogger(orgId, agentId, runId);
  log.add('start', triggeredBy === 'manual' ? 'Handmatig gestart' : 'Gestart volgens schema', {
    mode,
    model: modelKind,
    instruction: String(agent.instruction || '').slice(0, 2000),
    tools: allowedToolNames,
    scheduled_for: agent.next_run_at ?? null,
  });
  await log.flush();

  // 2) Identiteit herleiden (geen live sessie). Geen actief lid meer → pauzeer.
  let role: OrganizationRole;
  try {
    if (!runAsUserId) throw new Error('Geen actor meer aan deze agent gekoppeld.');
    role = await requireOrganizationAccess(runAsUserId, orgId);
  } catch {
    const reason = runAsUserId
      ? 'De medewerker namens wie deze agent draait, is geen actief lid meer. Agent gepauzeerd.'
      : 'De medewerker namens wie deze agent draaide, bestaat niet meer. Agent gepauzeerd; de historie blijft bewaard.';
    log.add('error', reason, {});
    log.add('finish', 'Afgebroken', { status: 'cancelled' });
    await log.flush();
    await finishRun(runId, { status: 'cancelled', error: reason });
    await supabaseAdmin.from('ai_agents').update({ status: 'paused', next_run_at: null, lease_until: null }).eq('id', agentId);
    return { agentId, status: 'cancelled', reason: 'actor_inactive' };
  }

  // 3) Budget — FAIL-CLOSED op dit onbewaakte pad. Er is één grens: het maandtegoed
  //    van het account. Wat een agent verbruikt telt daar gewoon in mee, want het
  //    verbruik wordt geboekt op de gebruiker namens wie hij draait.
  const userBudget = await checkUserBudget(runAsUserId);
  if (!userBudget.allowed) {
    log.add('error', 'Het maandtegoed van dit account is op — run overgeslagen.', {});
    log.add('finish', 'Overgeslagen', { status: 'skipped_budget' });
    await log.flush();
    await finishRun(runId, { status: 'skipped_budget', error: 'Budget bereikt.' });
    if (opts.reschedule) await rescheduleAgent(agent, {});
    return { agentId, status: 'skipped_budget' };
  }

  // 4) Gesprek (transcript) aanhaken.
  const convId = await createConversation(orgId, runAsUserId, `Agent: ${name} — ${todayIso()}`);
  await supabaseAdmin.from('ai_conversations').update({ agent_id: agentId, agent_run_id: runId }).eq('id', convId);
  await supabaseAdmin.from('ai_agent_runs').update({ conversation_id: convId }).eq('id', runId);

  // 5) Context (met de e-mail van de actor voor het label + eventuele bezorging).
  const { data: actor } = await supabaseAdmin.auth.admin.getUserById(runAsUserId);
  const actorEmail = actor?.user?.email || undefined;
  const ctx = await buildContext(orgId, role, { id: runAsUserId, email: actorEmail });
  ctx.clientEmail = clientEmailSettings(agent);

  // 6) De tool-allowlist is hierboven al bepaald (report = alleen lezen) en staat
  //    in het logboek, zodat achteraf vaststaat wat deze run mócht.

  // 7) De opdracht als bericht + een korte autonome-run-notitie.
  const instruction = String(agent.instruction || '').trim();
  const runMessage = `${instruction}\n\n(Automatische, geplande run — er is nu geen gebruiker om iets na te vragen. Werk zelfstandig met de beschikbare gegevens en geef een bondige samenvatting.)`;
  await insertMessage(convId, orgId, runAsUserId, 'user', instruction, []);

  try {
    // 8) Het brein draaien (headless, no-op emit).
    const outcome = await runAgent(ctx, [], runMessage, noopEmit, modelKind, allowedToolNames);

    // 8b) Elke stap uit de loop het logboek in — dít is "wat heeft hij gedaan?".
    for (const step of outcome.steps) log.addStep(step);

    const assistantId = await insertMessage(convId, orgId, runAsUserId, 'assistant', outcome.text, outcome.toolCalls);
    await recordUsage(orgId, convId, assistantId, runAsUserId, outcome.usage, modelKind, agentId, runId);

    // De VOLLEDIGE eindtekst; `summary` op de run is een afgekapte digest.
    log.add('answer', 'Zijn antwoord', { text: outcome.text });

    // 9) Voorstel (propose-modus) → goedkeurwachtrij, NIET uitvoeren.
    let proposalsCreated = 0;
    let auditId: string | null = null;
    if (outcome.proposal && mode === 'propose') {
      const { data: auditRow } = await supabaseAdmin.from('ai_action_audit').insert({
        organization_id: orgId, conversation_id: convId, message_id: assistantId, user_id: runAsUserId,
        action: `propose_${outcome.proposal.type}`, params: outcome.proposal, status: 'proposed',
        agent_id: agentId, agent_run_id: runId,
      }).select('id').single();
      auditId = (auditRow?.id as string) ?? null;
      proposalsCreated = 1;
      log.add('proposal', 'Wacht op jouw akkoord', { auditId, type: outcome.proposal.type });
    } else if (outcome.proposal) {
      // Kan alleen als iemand de modus terugzet terwijl er al een run liep.
      log.add('proposal', 'Voorstel niet klaargezet: deze agent mag alleen rapporteren.', { type: outcome.proposal.type });
    }

    const costUsdVal = costUsd(outcome.usage, modelKind);
    await finishRun(runId, {
      status: 'succeeded',
      summary: outcome.text.slice(0, 4000),
      result: { toolCalls: outcome.toolCalls.map((t) => t.name), auditId },
      input_tokens: outcome.usage.input + outcome.usage.cacheRead + outcome.usage.cacheWrite,
      output_tokens: outcome.usage.output,
      cost_usd: costUsdVal,
      proposals_created: proposalsCreated,
    });

    // 10) Bezorgen (in-app = de run-rij zelf; e-mail best-effort).
    const delivered = await deliver(agent, runId, name, outcome.text, proposalsCreated, actorEmail);
    log.add('delivery', delivered.emailed ? `Bezorgd in de app en per e-mail (${delivered.to})` : 'Bezorgd in de app', delivered);

    log.add('finish', 'Klaar', {
      status: 'succeeded',
      tokens: outcome.usage.input + outcome.usage.cacheRead + outcome.usage.cacheWrite + outcome.usage.output,
      cost_usd: costUsdVal,
      proposals_created: proposalsCreated,
    });
    await log.flush();

    // 11) Succes: circuit-breaker resetten + herplannen.
    if (opts.reschedule) await rescheduleAgent(agent, { resetFailures: true });
    else await supabaseAdmin.from('ai_agents').update({ last_run_at: new Date().toISOString(), lease_until: null }).eq('id', agentId);

    return { agentId, runId, status: 'succeeded', proposalsCreated };
  } catch (err) {
    // Ook een mislukte run hoort in het logboek: juist die wil je terugzoeken.
    log.add('error', describeError(err), {});
    log.add('finish', 'Mislukt', { status: 'failed' });
    await log.flush();
    await finishRun(runId, { status: 'failed', error: describeError(err) });
    if (opts.reschedule) await rescheduleAgent(agent, { failure: true });
    else await supabaseAdmin.from('ai_agents').update({ lease_until: null }).eq('id', agentId);
    throw err;
  }
}

/**
 * Mailinstellingen van deze agent voor het brein. Bepaalt of de agent zijn eigen
 * tekst schrijft of jouw vaste tekst gebruikt — en hoeveel mails één run hoogstens
 * mag klaarzetten.
 */
function clientEmailSettings(agent: Record<string, unknown>): { mode: 'compose' | 'template'; subject: string | null; body: string | null; max: number } {
  const max = Math.floor(Number(agent.max_emails_per_run));
  return {
    mode: String(agent.email_mode || 'compose') === 'template' ? 'template' : 'compose',
    subject: agent.email_subject ? String(agent.email_subject) : null,
    body: agent.email_body ? String(agent.email_body) : null,
    max: Number.isFinite(max) && max >= 1 && max <= 25 ? max : 5,
  };
}

/**
 * Welke tools de gebruiker aan een agent kan geven. Draait langs `buildContext`
 * zodat modules die voor dít teamlid dichtstaan er niet eens in staan.
 */
async function listAgentTools(orgId: string, userId: string, role: OrganizationRole) {
  const ctx = await buildContext(orgId, role, { id: userId });
  return toolCatalog(ctx);
}

function resolveAllowedTools(agent: Record<string, unknown>, mode: 'report' | 'propose'): string[] {
  const raw = Array.isArray(agent.enabled_tools) ? (agent.enabled_tools as unknown[]).map(String) : [];
  // Een onbewaakte agent mag nooit zelf nieuwe agents laten klaarzetten: dat is
  // een chat-handeling waar een mens bij zit. Ook niet als iemand hem aanvinkt.
  const enabled = raw.filter((n) => ALL_TOOL_NAMES.includes(n) && !AGENT_FORBIDDEN_TOOLS.includes(n));
  if (mode === 'report') {
    // Alleen lezen — strip elke propose_-tool, ook als hij per ongeluk is geconfigureerd.
    return enabled.length ? enabled.filter((n) => READ_TOOL_NAMES.includes(n)) : READ_TOOL_NAMES;
  }
  // propose: altijd de lees-tools + de gekozen (propose-)tools erbij.
  const chosen = enabled.length ? enabled : READ_TOOL_NAMES;
  return Array.from(new Set([...READ_TOOL_NAMES, ...chosen])).filter((n) => !AGENT_FORBIDDEN_TOOLS.includes(n));
}

async function finishRun(runId: string, fields: Record<string, unknown>): Promise<void> {
  await supabaseAdmin.from('ai_agent_runs').update({ ...fields, finished_at: new Date().toISOString() }).eq('id', runId);
}

// Bereken de volgende run-tijd (DST-bewust) en zet het schema door.
async function rescheduleAgent(agent: Record<string, unknown>, opts: { failure?: boolean; resetFailures?: boolean }): Promise<void> {
  const patch: Record<string, unknown> = {
    last_run_at: new Date().toISOString(),
    lease_until: null,
    next_run_at: computeNextRunAt(agent, new Date()).toISOString(),
  };
  if (opts.resetFailures) patch.consecutive_failures = 0;
  if (opts.failure) {
    const failures = Number(agent.consecutive_failures || 0) + 1;
    patch.consecutive_failures = failures;
    if (failures >= CIRCUIT_BREAKER_FAILURES) {
      patch.status = 'paused'; // circuit breaker
      patch.next_run_at = null;
    }
  }
  await supabaseAdmin.from('ai_agents').update(patch).eq('id', String(agent.id));
}

async function failAndReschedule(agent: Record<string, unknown>, _error: string): Promise<void> {
  try { await rescheduleAgent(agent, { failure: true }); } catch { /* best-effort */ }
}

// ── Bezorging ────────────────────────────────────────────────────────────────

async function deliver(agent: Record<string, unknown>, runId: string, name: string, summary: string, proposals: number, actorEmail?: string): Promise<{ emailed: boolean; to: string | null; note?: string }> {
  const delivery = (agent.delivery ?? {}) as { channels?: unknown };
  const channels = Array.isArray(delivery.channels) ? delivery.channels.map(String) : ['inapp'];
  // in-app = de ai_agent_runs-rij; niets extra's nodig.
  if (!channels.includes('email')) return { emailed: false, to: null };

  const apiKey = Deno.env.get('RESEND_API_KEY') || '';
  const from = Deno.env.get('GERRIE_ROUTINES_FROM') || Deno.env.get('RESEND_FROM') || '';
  if (!apiKey || !from || !actorEmail) {
    return { emailed: false, to: actorEmail ?? null, note: 'e-mailbezorging staat aan maar is niet geconfigureerd' };
  }
  const extra = proposals > 0 ? ` (${proposals} voorstel${proposals === 1 ? '' : 'len'} klaargezet om goed te keuren)` : '';
  const safe = summary.slice(0, 4000);
  try {
    await sendViaResend(apiKey, {
      from, to: [actorEmail],
      subject: `Gerrie Routine: ${name}${extra}`,
      text: safe,
      html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><h2 style="margin:0 0 8px">${escapeHtml(name)}</h2>${extra ? `<p style="color:#b8860b"><strong>${escapeHtml(extra.trim())}</strong></p>` : ''}<div style="white-space:pre-wrap;line-height:1.5">${escapeHtml(safe)}</div><p style="color:#888;font-size:12px;margin-top:16px">Automatisch gegenereerd door je Gerrie Routine.</p></div>`,
    }, `agent-run-${runId}`);
    return { emailed: true, to: actorEmail };
  } catch (e) {
    console.warn('gerrie-agent-runner e-mailbezorging mislukt', describeError(e));
    return { emailed: false, to: actorEmail, note: `e-mail mislukt: ${describeError(e)}` };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// ── Schema-berekening (presets, DST-bewust) ──────────────────────────────────

/** Lokale kalenderdatum (in tz) van een UTC-instant. */
function localYmd(tz: string, at: Date): { y: number; m: number; d: number } {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at).split('-').map(Number);
  return { y, m, d };
}

/** Wandkloktijd `y-m-d hh:00` in `tz` → echte UTC-Date (DST-bewust, zelfde truc als amsWallToUtc). */
function wallToUtc(tz: string, y: number, m: number, d: number, hh: number): Date {
  const guess = Date.UTC(y, m - 1, d, hh, 0);
  const offset = tzOffsetMs(tz, new Date(guess));
  return new Date(guess - offset);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Eerstvolgende run-tijd na `after`, volgens de preset (daily/weekly/monthly) in de agent-tijdzone. */
function computeNextRunAt(agent: Record<string, unknown>, after: Date): Date {
  const tz = String(agent.timezone || 'Europe/Amsterdam');
  const kind = String(agent.schedule_kind || 'weekly');
  const hour = clampInt(agent.hour, 8, 0, 23);
  const dow = agent.day_of_week != null ? clampInt(agent.day_of_week, 1, 1, 7) : null;   // ISO 1=ma..7=zo
  const domWanted = agent.day_of_month != null ? clampInt(agent.day_of_month, 1, 1, 31) : 1;

  const base = localYmd(tz, after);
  for (let off = 0; off <= 400; off += 1) {
    const cd = new Date(Date.UTC(base.y, base.m - 1, base.d + off));
    const y = cd.getUTCFullYear(), m = cd.getUTCMonth() + 1, d = cd.getUTCDate();
    const isoDow = ((cd.getUTCDay() + 6) % 7) + 1; // 1=ma..7=zo

    let matches = false;
    if (kind === 'daily') matches = true;
    else if (kind === 'weekly') matches = dow === null ? true : isoDow === dow;
    else if (kind === 'monthly') matches = d === Math.min(domWanted, daysInMonth(y, m));

    if (!matches) continue;
    const cand = wallToUtc(tz, y, m, d, hour);
    if (cand.getTime() > after.getTime()) return cand;
  }
  return new Date(after.getTime() + 86400000); // vangnet
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ── Beheer (app-pad) ─────────────────────────────────────────────────────────

function sanitizeAgentFields(body: Record<string, unknown>): Record<string, unknown> {
  const modelKind = String(body.model_kind || 'cheap') === 'strong' ? 'strong' : 'cheap';
  const mode = String(body.mode || 'report') === 'propose' ? 'propose' : 'report';
  const scheduleKind = ['daily', 'weekly', 'monthly'].includes(String(body.schedule_kind)) ? String(body.schedule_kind) : 'weekly';
  const enabledTools = Array.isArray(body.enabled_tools)
    ? [...new Set((body.enabled_tools as unknown[]).map(String).filter((n) => ALL_TOOL_NAMES.includes(n)))]
    : [];
  const channelsRaw = Array.isArray((body.delivery as { channels?: unknown })?.channels)
    ? ((body.delivery as { channels: unknown[] }).channels).map(String).filter((c) => ['inapp', 'email'].includes(c))
    : ['inapp'];
  const channels = channelsRaw.length ? [...new Set(channelsRaw)] : ['inapp'];

  // Embleem: alleen een bekende sleutel en een geldige tint komen erdoor. Alles
  // anders wordt null — de app leidt het embleem dan zelf af uit de opdracht.
  const icon = AGENT_ICON_KEYS.includes(String(body.icon)) ? String(body.icon) : null;
  const hueRaw = Math.floor(Number(body.hue));
  const hue = Number.isFinite(hueRaw) && hueRaw >= 0 && hueRaw <= 359 ? hueRaw : null;

  // Klantmail: schrijfwijze + eventuele vaste tekst. Bij 'compose' bewaren we de
  // sjabloontekst gewoon; wisselt iemand terug, dan staat hij er nog.
  const emailMode = String(body.email_mode || 'compose') === 'template' ? 'template' : 'compose';
  const emailSubject = body.email_subject != null ? String(body.email_subject).slice(0, 300) : null;
  const emailBody = body.email_body != null ? String(body.email_body).slice(0, 8000) : null;

  return {
    name: String(body.name || '').slice(0, 120),
    description: body.description != null ? String(body.description).slice(0, 500) : null,
    instruction: String(body.instruction || '').slice(0, 4000),
    model_kind: modelKind,
    mode,
    enabled_tools: enabledTools,
    schedule_kind: scheduleKind,
    hour: clampInt(body.hour, 8, 0, 23),
    day_of_week: scheduleKind === 'weekly' ? clampInt(body.day_of_week, 1, 1, 7) : null,
    day_of_month: scheduleKind === 'monthly' ? clampInt(body.day_of_month, 1, 1, 31) : null,
    timezone: String(body.timezone || 'Europe/Amsterdam').slice(0, 64),
    // Geen budget-velden meer: kosten worden begrensd door het maandtegoed van het
    // account (checkUserBudget). Zie migratie 20260820000000.
    delivery: { channels, recipient_user_ids: [] },
    icon,
    hue,
    email_mode: emailMode,
    email_subject: emailSubject,
    email_body: emailBody,
    max_emails_per_run: clampInt(body.max_emails_per_run, 5, 1, 25),
  };
}

/**
 * Maakt een agent aan. Met `activate` gaat hij in DEZELFDE aanroep aan.
 *
 * Dat is bewust één stap: een agent die je net hebt samengesteld hoort niet als
 * slapend concept te blijven liggen tot je hem nog eens apart aanzet. De grens
 * blijft waar hij hoort — alles wat hij vervolgens wil versturen komt als
 * afvinklijst bij jou terug.
 */
async function createAgent(orgId: string, userId: string, body: Record<string, unknown>): Promise<{ id: string; status: string; next_run_at: string | null }> {
  const fields = sanitizeAgentFields(body);
  if (!fields.instruction) throw new HttpError('Geef een opdracht voor de agent.', 400);
  const activate = body.activate === true;
  const nextRunAt = activate ? computeNextRunAt(fields, new Date()).toISOString() : null;
  const { data, error } = await supabaseAdmin.from('ai_agents').insert({
    organization_id: orgId, created_by: userId, run_as_user_id: userId,
    status: activate ? 'active' : 'draft', next_run_at: nextRunAt, ...fields,
  }).select('id').single();
  if (error) throw new HttpError(`Agent aanmaken mislukt: ${error.message}`, 500);
  return { id: data.id as string, status: activate ? 'active' : 'draft', next_run_at: nextRunAt };
}

async function updateAgent(orgId: string, body: Record<string, unknown>): Promise<{ ok: true }> {
  const id = String(body.id || '');
  if (!isUuid(id)) throw new HttpError('Ongeldig id.', 400);
  const fields = sanitizeAgentFields(body);
  if (!fields.instruction) throw new HttpError('Geef een opdracht voor de agent.', 400);
  const { data: existing, error: exErr } = await supabaseAdmin.from('ai_agents')
    .select('*').eq('id', id).eq('organization_id', orgId).maybeSingle();
  if (exErr) throw new HttpError(`Agent ophalen mislukt: ${exErr.message}`, 500);
  if (!existing) throw new HttpError('Agent niet gevonden.', 404);

  const patch: Record<string, unknown> = { ...fields };
  // Draait de agent al? Herbereken de volgende run met het nieuwe schema.
  if (String(existing.status) === 'active') {
    patch.next_run_at = computeNextRunAt({ ...existing, ...fields }, new Date()).toISOString();
  }
  const { error } = await supabaseAdmin.from('ai_agents').update(patch).eq('id', id).eq('organization_id', orgId);
  if (error) throw new HttpError(`Agent bijwerken mislukt: ${error.message}`, 500);
  return { ok: true };
}

async function setStatus(orgId: string, id: string, status: string): Promise<{ ok: true; next_run_at: string | null }> {
  if (!isUuid(id)) throw new HttpError('Ongeldig id.', 400);
  if (!['draft', 'active', 'paused', 'archived'].includes(status)) throw new HttpError('Ongeldige status.', 400);
  const { data: existing, error: exErr } = await supabaseAdmin.from('ai_agents')
    .select('*').eq('id', id).eq('organization_id', orgId).maybeSingle();
  if (exErr) throw new HttpError(`Agent ophalen mislukt: ${exErr.message}`, 500);
  if (!existing) throw new HttpError('Agent niet gevonden.', 404);

  const patch: Record<string, unknown> = { status, lease_until: null };
  // Het archief-moment loopt mee met de status, zodat "gearchiveerd zonder datum"
  // niet kan bestaan — de galerij sorteert het archief op dat moment.
  patch.archived_at = status === 'archived' ? (existing.archived_at ?? new Date().toISOString()) : null;
  if (status === 'active') {
    if (!String(existing.instruction || '').trim()) throw new HttpError('Geef eerst een opdracht voordat je de agent activeert.', 400);
    patch.next_run_at = computeNextRunAt(existing, new Date()).toISOString();
    patch.consecutive_failures = 0;
  } else {
    patch.next_run_at = null;
  }
  const { error } = await supabaseAdmin.from('ai_agents').update(patch).eq('id', id).eq('organization_id', orgId);
  if (error) throw new HttpError(`Status bijwerken mislukt: ${error.message}`, 500);
  return { ok: true, next_run_at: (patch.next_run_at as string | null) ?? null };
}

/**
 * "Verwijderen" van een agent = ARCHIVEREN.
 *
 * Een agent heeft namens de organisatie gewerkt: mail klaargezet, facturen
 * voorgesteld, cijfers gelezen. Dat weggooien betekent dat je achteraf niet meer
 * kunt verantwoorden wat er is gebeurd. Hij gaat dus uit (geen schema, geen lease)
 * maar blijft met zijn volledige logboek bestaan. Er is bewust géén hard-delete-pad.
 */
async function archiveAgent(orgId: string, id: string): Promise<{ ok: true; archived: true }> {
  if (!isUuid(id)) throw new HttpError('Ongeldig id.', 400);
  const { data, error } = await supabaseAdmin.from('ai_agents')
    .update({ status: 'archived', archived_at: new Date().toISOString(), next_run_at: null, lease_until: null })
    .eq('id', id).eq('organization_id', orgId).select('id').maybeSingle();
  if (error) throw new HttpError(`Agent archiveren mislukt: ${error.message}`, 500);
  if (!data) throw new HttpError('Agent niet gevonden.', 404);
  return { ok: true, archived: true };
}

/** Terug uit het archief: hij komt gepauzeerd terug, jij zet hem zelf weer aan. */
async function restoreAgent(orgId: string, id: string): Promise<{ ok: true }> {
  if (!isUuid(id)) throw new HttpError('Ongeldig id.', 400);
  const { data, error } = await supabaseAdmin.from('ai_agents')
    .update({ status: 'paused', archived_at: null, next_run_at: null, lease_until: null })
    .eq('id', id).eq('organization_id', orgId).select('id').maybeSingle();
  if (error) throw new HttpError(`Agent terugzetten mislukt: ${error.message}`, 500);
  if (!data) throw new HttpError('Agent niet gevonden.', 404);
  return { ok: true };
}

async function runNow(orgId: string, id: string): Promise<Record<string, unknown>> {
  if (!isUuid(id)) throw new HttpError('Ongeldig id.', 400);
  if (!ANTHROPIC_API_KEY) throw new HttpError('ANTHROPIC_API_KEY ontbreekt in de Edge Function secrets.', 500);
  const { data: agent, error } = await supabaseAdmin.from('ai_agents').select('*').eq('id', id).eq('organization_id', orgId).maybeSingle();
  if (error) throw new HttpError(`Agent ophalen mislukt: ${error.message}`, 500);
  if (!agent) throw new HttpError('Agent niet gevonden.', 404);
  if (String(agent.status) === 'archived') throw new HttpError('Deze agent is gearchiveerd. Zet hem eerst terug als je hem weer wilt laten draaien.', 400);
  if (!String(agent.instruction || '').trim()) throw new HttpError('Deze agent heeft nog geen opdracht.', 400);
  // Handmatige run: eigen occurrence-key, verandert het schema NIET.
  const occurrenceKey = `manual:${new Date().toISOString()}`;
  return await executeAgentRun(agent, 'manual', occurrenceKey, { reschedule: false });
}

/**
 * Antwoord van de (aanwezige) gebruiker op een run: zet het gesprek van die run voort.
 * Handig als de agent om input vroeg ("mag ik dit versturen?") — de gebruiker antwoordt,
 * de agent draait nog een beurt en kan alsnog een propose_* voorstel klaarzetten. Draait
 * met dezelfde modus/tools als de agent; een voorstel belandt (zoals altijd) in de
 * goedkeurwachtrij en wordt pas na expliciete goedkeuring uitgevoerd.
 */
async function replyToRun(orgId: string, userId: string, role: OrganizationRole, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = String(body.runId || '');
  const message = String(body.message || '').trim();
  if (!isUuid(runId)) throw new HttpError('Ongeldig run-id.', 400);
  if (!message) throw new HttpError('Leeg bericht.', 400);
  if (message.length > 4000) throw new HttpError('Bericht is te lang.', 400);
  if (!ANTHROPIC_API_KEY) throw new HttpError('ANTHROPIC_API_KEY ontbreekt in de Edge Function secrets.', 500);

  const { data: run, error: runErr } = await supabaseAdmin.from('ai_agent_runs')
    .select('agent_id, conversation_id').eq('id', runId).eq('organization_id', orgId).maybeSingle();
  if (runErr) throw new HttpError(`Run ophalen mislukt: ${runErr.message}`, 500);
  if (!run) throw new HttpError('Run niet gevonden.', 404);
  const convId = run.conversation_id ? String(run.conversation_id) : '';
  if (!convId) throw new HttpError('Deze run heeft geen gesprek om op te antwoorden.', 400);

  const { data: agent, error: agErr } = await supabaseAdmin.from('ai_agents')
    .select('*').eq('id', run.agent_id).eq('organization_id', orgId).maybeSingle();
  if (agErr) throw new HttpError(`Agent ophalen mislukt: ${agErr.message}`, 500);
  if (!agent) throw new HttpError('Agent niet gevonden.', 404);
  const mode = String(agent.mode || 'report') === 'propose' ? 'propose' : 'report';
  const modelKind = resolveModelKind(agent.model_kind);

  const budget = await checkUserBudget(userId);
  if (!budget.allowed) throw new HttpError('Je AI-tegoed voor deze maand is op.', 429);

  const history = await loadHistory(convId, orgId);
  await insertMessage(convId, orgId, userId, 'user', message, []);

  // Het logboek loopt door waar de run gebleven was: een antwoordbeurt hoort bij
  // dezelfde run, en wat de agent daarna deed hoort er net zo goed in.
  const log = runLogger(orgId, String(agent.id), runId, await nextLogSeq(runId));
  log.add('reply', 'Jij antwoordde de agent', { message: message.slice(0, 2000) });

  const ctx = await buildContext(orgId, role, { id: userId });
  // Antwoorden op een run gebruikt dezelfde schrijfwijze en hetzelfde mailplafond
  // als de geplande run zelf; anders zou "ja, stuur maar" ineens andere post opleveren.
  ctx.clientEmail = clientEmailSettings(agent);
  const allowedToolNames = resolveAllowedTools(agent, mode);
  const outcome = await runAgent(ctx, history, message, noopEmit, modelKind, allowedToolNames);
  for (const step of outcome.steps) log.addStep(step);

  const assistantId = await insertMessage(convId, orgId, userId, 'assistant', outcome.text, outcome.toolCalls);
  await recordUsage(orgId, convId, assistantId, userId, outcome.usage, modelKind, String(agent.id), runId);
  log.add('answer', 'Zijn antwoord', { text: outcome.text });

  let proposalCreated = 0;
  if (outcome.proposal && mode === 'propose') {
    const { data: auditRow } = await supabaseAdmin.from('ai_action_audit').insert({
      organization_id: orgId, conversation_id: convId, message_id: assistantId, user_id: userId,
      action: `propose_${outcome.proposal.type}`, params: outcome.proposal, status: 'proposed',
      agent_id: String(agent.id), agent_run_id: runId,
    }).select('id').single();
    proposalCreated = 1;
    log.add('proposal', 'Wacht op jouw akkoord', { auditId: auditRow?.id ?? null, type: outcome.proposal.type });
    // Houd de teller op de run bij (voor de UI-badge).
    const { data: cur } = await supabaseAdmin.from('ai_agent_runs').select('proposals_created').eq('id', runId).maybeSingle();
    await supabaseAdmin.from('ai_agent_runs').update({ proposals_created: Number(cur?.proposals_created || 0) + 1 }).eq('id', runId);
  }
  await log.flush();

  return { text: outcome.text, proposalCreated };
}

// ── HTTP-helpers ─────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function assertCronSecret(req: Request): void {
  if (!AGENTS_CRON_SECRET) throw new HttpError('AGENTS_CRON_SECRET ontbreekt in de Edge Function secrets.', 500);
  const provided = req.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, AGENTS_CRON_SECRET)) throw new HttpError('Ongeldig of ontbrekend cron-secret.', 401);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) || (ALLOW_LOCAL_DEV && isLocalOrigin(origin))
    ? origin : ALLOW_LOCAL_DEV && !origin ? '*' : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}
function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}
function plainJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';
  if (!origin && ALLOW_LOCAL_DEV) return;
  if (ALLOWED_ORIGINS.includes(origin)) return;
  if (ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (ALLOWED_ORIGINS.length === 0 && ALLOW_LOCAL_DEV) return;
  if (ALLOWED_ORIGINS.length === 0) throw new HttpError('GERRIE_ALLOWED_ORIGINS of APP_PUBLIC_URL is verplicht in productie.', 500);
  throw new HttpError('Deze frontend-origin is niet toegestaan.', 403);
}
function isLocalOrigin(origin: string): boolean { return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); }
