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
  supabaseAdmin, HttpError, ANTHROPIC_API_KEY, USD_TO_EUR, TOOL_DEFINITIONS,
  resolveModelKind, runAgent, buildContext, createConversation, insertMessage,
  recordUsage, costUsd, checkUserBudget, requireUser, requireOrganizationAccess,
  describeError, isUuid, todayIso, tzOffsetMs, parseAllowedOrigins, loadHistory,
  AGENT_ICON_KEYS,
} from '../_shared/gerrieCore.ts';
import type { Emit, OrganizationRole } from '../_shared/gerrieCore.ts';
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
      case 'delete': return json(req, await deleteAgent(organizationId, String(body.id || '')));
      case 'run_now': return json(req, await runNow(organizationId, String(body.id || '')));
      case 'reply': return json(req, await replyToRun(organizationId, user.id, role, body));
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
  const runAsUserId = String(agent.run_as_user_id);
  const name = String(agent.name || 'Naamloze routine');
  const mode = String(agent.mode || 'report') === 'propose' ? 'propose' : 'report';
  const modelKind = resolveModelKind(agent.model_kind);

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

  // 2) Identiteit herleiden (geen live sessie). Geen actief lid meer → pauzeer.
  let role: OrganizationRole;
  try {
    role = await requireOrganizationAccess(runAsUserId, orgId);
  } catch {
    await finishRun(runId, { status: 'cancelled', error: 'Actor is geen actief lid meer.' });
    await supabaseAdmin.from('ai_agents').update({ status: 'paused', lease_until: null }).eq('id', agentId);
    return { agentId, status: 'cancelled', reason: 'actor_inactive' };
  }

  // 3) Budget — FAIL-CLOSED op dit onbewaakte pad.
  const userBudget = await checkUserBudget(runAsUserId);
  const agentOk = await agentMonthlyBudgetOk(agent);
  if (!userBudget.allowed || !agentOk) {
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

  // 6) Tool-allowlist bepalen (report = alleen lezen).
  const allowedToolNames = resolveAllowedTools(agent, mode);

  // 7) De opdracht als bericht + een korte autonome-run-notitie.
  const instruction = String(agent.instruction || '').trim();
  const runMessage = `${instruction}\n\n(Automatische, geplande run — er is nu geen gebruiker om iets na te vragen. Werk zelfstandig met de beschikbare gegevens en geef een bondige samenvatting.)`;
  await insertMessage(convId, orgId, runAsUserId, 'user', instruction, []);

  try {
    // 8) Het brein draaien (headless, no-op emit).
    const outcome = await runAgent(ctx, [], runMessage, noopEmit, modelKind, allowedToolNames);

    const assistantId = await insertMessage(convId, orgId, runAsUserId, 'assistant', outcome.text, outcome.toolCalls);
    await recordUsage(orgId, convId, assistantId, runAsUserId, outcome.usage, modelKind, agentId, runId);

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
    await deliver(agent, runId, name, outcome.text, proposalsCreated, actorEmail);

    // 11) Succes: circuit-breaker resetten + herplannen.
    if (opts.reschedule) await rescheduleAgent(agent, { resetFailures: true });
    else await supabaseAdmin.from('ai_agents').update({ last_run_at: new Date().toISOString(), lease_until: null }).eq('id', agentId);

    return { agentId, runId, status: 'succeeded', proposalsCreated };
  } catch (err) {
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

function resolveAllowedTools(agent: Record<string, unknown>, mode: 'report' | 'propose'): string[] {
  const raw = Array.isArray(agent.enabled_tools) ? (agent.enabled_tools as unknown[]).map(String) : [];
  // Een onbewaakte agent mag nooit zelf nieuwe agents laten klaarzetten: dat is
  // een chat-handeling waar een mens bij zit. Ook niet als iemand hem aanvinkt.
  const enabled = raw.filter((n) => ALL_TOOL_NAMES.includes(n) && n !== 'propose_create_agent');
  if (mode === 'report') {
    // Alleen lezen — strip elke propose_-tool, ook als hij per ongeluk is geconfigureerd.
    return enabled.length ? enabled.filter((n) => READ_TOOL_NAMES.includes(n)) : READ_TOOL_NAMES;
  }
  // propose: altijd de lees-tools + de gekozen (propose-)tools erbij.
  const chosen = enabled.length ? enabled : READ_TOOL_NAMES;
  return Array.from(new Set([...READ_TOOL_NAMES, ...chosen])).filter((n) => n !== 'propose_create_agent');
}

async function agentMonthlyBudgetOk(agent: Record<string, unknown>): Promise<boolean> {
  const cap = agent.monthly_budget_eur;
  if (cap === null || cap === undefined) return true;
  const monthStart = `${todayIso().slice(0, 7)}-01T00:00:00Z`;
  const { data, error } = await supabaseAdmin.from('ai_usage').select('cost_usd').eq('agent_id', String(agent.id)).gte('created_at', monthStart);
  if (error) return false; // fail-closed
  const usd = (data ?? []).reduce((s: number, r: Record<string, unknown>) => s + Number(r.cost_usd || 0), 0);
  return usd * USD_TO_EUR < Number(cap);
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

async function deliver(agent: Record<string, unknown>, runId: string, name: string, summary: string, proposals: number, actorEmail?: string): Promise<void> {
  const delivery = (agent.delivery ?? {}) as { channels?: unknown };
  const channels = Array.isArray(delivery.channels) ? delivery.channels.map(String) : ['inapp'];
  // in-app = de ai_agent_runs-rij; niets extra's nodig.
  if (channels.includes('email')) {
    const apiKey = Deno.env.get('RESEND_API_KEY') || '';
    const from = Deno.env.get('GERRIE_ROUTINES_FROM') || Deno.env.get('RESEND_FROM') || '';
    if (!apiKey || !from || !actorEmail) return; // best-effort: stil overslaan als niet geconfigureerd
    const extra = proposals > 0 ? ` (${proposals} voorstel${proposals === 1 ? '' : 'len'} klaargezet om goed te keuren)` : '';
    const safe = summary.slice(0, 4000);
    try {
      await sendViaResend(apiKey, {
        from, to: [actorEmail],
        subject: `Gerrie Routine: ${name}${extra}`,
        text: safe,
        html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><h2 style="margin:0 0 8px">${escapeHtml(name)}</h2>${extra ? `<p style="color:#b8860b"><strong>${escapeHtml(extra.trim())}</strong></p>` : ''}<div style="white-space:pre-wrap;line-height:1.5">${escapeHtml(safe)}</div><p style="color:#888;font-size:12px;margin-top:16px">Automatisch gegenereerd door je Gerrie Routine.</p></div>`,
      }, `agent-run-${runId}`);
    } catch (e) {
      console.warn('gerrie-agent-runner e-mailbezorging mislukt', describeError(e));
    }
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
    max_cost_eur_per_run: clampNum(body.max_cost_eur_per_run, 0.25, 0, 100),
    monthly_budget_eur: body.monthly_budget_eur == null ? null : clampNum(body.monthly_budget_eur, 5, 0, 1000),
    max_runs_per_day: clampInt(body.max_runs_per_day, 4, 1, 48),
    delivery: { channels, recipient_user_ids: [] },
    icon,
    hue,
    email_mode: emailMode,
    email_subject: emailSubject,
    email_body: emailBody,
    max_emails_per_run: clampInt(body.max_emails_per_run, 5, 1, 25),
  };
}

function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n * 100) / 100));
}

async function createAgent(orgId: string, userId: string, body: Record<string, unknown>): Promise<{ id: string }> {
  const fields = sanitizeAgentFields(body);
  if (!fields.instruction) throw new HttpError('Geef een opdracht voor de agent.', 400);
  const { data, error } = await supabaseAdmin.from('ai_agents').insert({
    organization_id: orgId, created_by: userId, run_as_user_id: userId, status: 'draft', ...fields,
  }).select('id').single();
  if (error) throw new HttpError(`Agent aanmaken mislukt: ${error.message}`, 500);
  return { id: data.id as string };
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

async function deleteAgent(orgId: string, id: string): Promise<{ ok: true }> {
  if (!isUuid(id)) throw new HttpError('Ongeldig id.', 400);
  const { error } = await supabaseAdmin.from('ai_agents').delete().eq('id', id).eq('organization_id', orgId);
  if (error) throw new HttpError(`Agent verwijderen mislukt: ${error.message}`, 500);
  return { ok: true };
}

async function runNow(orgId: string, id: string): Promise<Record<string, unknown>> {
  if (!isUuid(id)) throw new HttpError('Ongeldig id.', 400);
  if (!ANTHROPIC_API_KEY) throw new HttpError('ANTHROPIC_API_KEY ontbreekt in de Edge Function secrets.', 500);
  const { data: agent, error } = await supabaseAdmin.from('ai_agents').select('*').eq('id', id).eq('organization_id', orgId).maybeSingle();
  if (error) throw new HttpError(`Agent ophalen mislukt: ${error.message}`, 500);
  if (!agent) throw new HttpError('Agent niet gevonden.', 404);
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

  const ctx = await buildContext(orgId, role, { id: userId });
  // Antwoorden op een run gebruikt dezelfde schrijfwijze en hetzelfde mailplafond
  // als de geplande run zelf; anders zou "ja, stuur maar" ineens andere post opleveren.
  ctx.clientEmail = clientEmailSettings(agent);
  const allowedToolNames = resolveAllowedTools(agent, mode);
  const outcome = await runAgent(ctx, history, message, noopEmit, modelKind, allowedToolNames);

  const assistantId = await insertMessage(convId, orgId, userId, 'assistant', outcome.text, outcome.toolCalls);
  await recordUsage(orgId, convId, assistantId, userId, outcome.usage, modelKind, String(agent.id), runId);

  let proposalCreated = 0;
  if (outcome.proposal && mode === 'propose') {
    await supabaseAdmin.from('ai_action_audit').insert({
      organization_id: orgId, conversation_id: convId, message_id: assistantId, user_id: userId,
      action: `propose_${outcome.proposal.type}`, params: outcome.proposal, status: 'proposed',
      agent_id: String(agent.id), agent_run_id: runId,
    });
    proposalCreated = 1;
    // Houd de teller op de run bij (voor de UI-badge).
    const { data: cur } = await supabaseAdmin.from('ai_agent_runs').select('proposals_created').eq('id', runId).maybeSingle();
    await supabaseAdmin.from('ai_agent_runs').update({ proposals_created: Number(cur?.proposals_created || 0) + 1 }).eq('id', runId);
  }

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
