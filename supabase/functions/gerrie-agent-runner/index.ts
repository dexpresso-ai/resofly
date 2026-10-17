// ============================================================
// gerrie-agent-runner — de headless motor voor geplande agents
// ("Gerrie Routines": gebruikers bouwen eigen terugkerende agents).
//
// Dual-path Edge Function (zelfde vorm als web-push):
//  1. ?cron=tick  — server-to-server, geauthenticeerd met x-cron-secret
//     (AGENTS_CRON_SECRET). pg_cron roept dit per minuut aan (GERRIE_ROUTINES_SETUP.md).
//     Claimt due agents (lease) en draait ze naast elkaar via HETZELFDE brein als
//     de chat (_shared/gerrieCore.ts) met een no-op emit (geen browser).
//  2. app-pad    — Supabase-JWT; beheer (create/update/status/archive/clone/share),
//     "nu draaien", antwoorden en proefdraaien. Lezen doet de client rechtstreeks
//     via RLS: je eigen agents, en als owner/admin die van het hele team.
//
// Wie mag wat (_shared/agentAccess.ts): iedereen die Gerrie mag gebruiken, kan
// eigen agents hebben. Een agent kan nooit meer dan degene namens wie hij draait
// (run_as_user_id): zijn tools volgen diens modulerechten, en iets klaarzetten mag
// hij alleen als die persoon zelf mag wijzigen. Dat wordt bij het opslaan
// afgedwongen én bij elke run opnieuw, want rechten kunnen intussen veranderen.
//
// Veiligheidsinvariant: een geplande agent voert NOOIT onbewaakt schrijf-acties
// uit. 'report'-agents krijgen alleen lees-tools; 'propose'-agents mogen daarnaast
// een paar acties VOORSTELLEN, die (net als in de chat) in ai_action_audit
// ('proposed') belanden en pas door een mens in de app worden uitgevoerd — onder
// diens eigen sessie. Budget is FAIL-CLOSED op dit pad.
//
// Tenant-grens: de runner draait als service-role (RLS uit). organization_id komt
// ALTIJD uit ai_agents.organization_id, nooit uit het model; elke tool-query is
// org-scoped in gerrieCore.
// ============================================================

import {
  supabaseAdmin, HttpError, ANTHROPIC_API_KEY, TOOL_DEFINITIONS, toolCatalog, AGENT_FORBIDDEN_TOOLS, MAX_AGENT_ITERATIONS,
  resolveModelKind, runAgent, buildContext, createConversation, insertMessage,
  recordUsage, costUsd, checkUserBudget, requireUser, requireOrganizationAccess,
  describeError, isUuid, todayIso, parseAllowedOrigins, loadHistory, describeProposal,
  AGENT_ICON_KEYS, isEnabledToolName, isReadOnlyToolName, auditActionName,
} from '../_shared/gerrieCore.ts';
import type { AgentOutcome, AgentStep, Emit, GerrieContext, OrganizationRole, Proposal } from '../_shared/gerrieCore.ts';
import {
  agentCapabilities, allowedAgentMode, canCloneAgent, canManageAgent, manageRefusal, permittedAgentTools,
  DEFAULT_MAX_PROPOSALS, MAX_AGENTS_PER_USER, MAX_PROPOSALS_LIMIT,
  type AgentAction, type AgentCapabilities, type AgentMode,
} from '../_shared/agentAccess.ts';
import { clampInt, computeNextRunAt, normalizeSchedule } from '../_shared/agentSchedule.ts';
import { buildScheduledRunMessage, decisionStatusLabel, isNothingToReport, MEMORY_RUNS, type PastRun } from '../_shared/agentRun.ts';
import { sendViaResend } from '../_shared/resend.ts';

const AGENTS_CRON_SECRET = Deno.env.get('AGENTS_CRON_SECRET') || '';
// Hoeveel agents één minuut-tik claimt (1-10). Ze draaien naast elkaar, dus een tik
// duurt zo lang als de langzaamste — niet als alle samen.
const CLAIM_LIMIT = Math.max(1, Math.min(10, Number(Deno.env.get('AGENTS_CLAIM_LIMIT') || '5') || 5));
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

const DELIVERY_CHANNELS = ['inapp', 'email', 'push'];

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

  // App-pad: JWT + toegang tot Gerrie. Wat iemand daarna met een agent mag, beslist
  // agentAccess per actie (eigenaar, of owner/admin voor toezicht).
  try {
    if (req.method !== 'POST') return json(req, { error: 'Method not allowed.' }, 405);
    assertAllowedOrigin(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = String(body.organizationId || '');
    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);
    const ctx = await buildContext(organizationId, role, user);
    const caps = agentCapabilities(role, ctx.moduleAccess);
    if (!caps.canUse) throw new HttpError('Je hebt in deze organisatie geen toegang tot Gerrie, en dus ook niet tot agents.', 403);

    const action = String(body.action || '');
    const id = String(body.id || '');
    switch (action) {
      case 'create': return json(req, await createAgent(ctx, caps, body));
      case 'update': return json(req, await updateAgent(ctx, caps, body));
      case 'set_status': return json(req, await setStatus(ctx, caps, id, String(body.status || '')));
      // 'delete' bestaat alleen nog als oude naam voor archiveren: een agent met
      // historie gooien we niet weg (zie archiveAgent).
      case 'delete':
      case 'archive': return json(req, await archiveAgent(ctx, caps, id));
      case 'restore': return json(req, await restoreAgent(ctx, caps, id));
      case 'run_now': return json(req, await runNow(ctx, caps, id));
      case 'reply': return json(req, await replyToRun(ctx, caps, body));
      case 'clone': return json(req, await cloneAgent(ctx, caps, id, body.activate === true));
      case 'share': return json(req, await shareAgent(ctx, caps, id, body.visibility));
      // Alles wat een agent MAG kunnen, afgeleid uit de echte tooldefinities en
      // gefilterd op de modulerechten van dit teamlid. De bouwer hoeft dus geen
      // eigen lijst bij te houden — zie de opmerking bij TOOL_LABELS in gerrieCore.
      // Met wat dit teamlid met agents mag, zodat de app niets aanbiedt wat straks
      // toch wordt geweigerd.
      case 'tools': return json(req, { tools: toolCatalog(ctx), capabilities: caps, maxAgents: MAX_AGENTS_PER_USER });
      case 'preview': return json(req, await previewAgent(ctx, body));
      default: throw new HttpError('Onbekende actie.', 400);
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const internal = describeError(error);
    if (status >= 500) console.error('gerrie-agent-runner error', internal); else console.warn('gerrie-agent-runner warning', internal);
    const publicMessage = error instanceof HttpError ? error.message : 'Er ging iets mis met de agents.';
    return json(req, { error: publicMessage }, status);
  }
});

// ── Cron-tik: due agents claimen + draaien ───────────────────────────────────

async function runTick(): Promise<{ ok: true; claimed: number; results: Array<Record<string, unknown>> }> {
  const { data: agents, error } = await supabaseAdmin.rpc('claim_due_agents', { p_limit: CLAIM_LIMIT });
  if (error) throw new HttpError(`Claimen van agents mislukt: ${error.message}`, 500);
  const claimed = (agents ?? []) as Array<Record<string, unknown>>;
  // Naast elkaar: een agent wacht vooral op het model, niet op de processor.
  const results = await Promise.all(claimed.map(async (agent) => {
    try {
      return await executeAgentRun(agent, 'schedule', occurrenceKeyForSlot(agent), { reschedule: true });
    } catch (err) {
      // Vangnet: één kapotte agent mag de batch niet vastzetten.
      console.error('gerrie-agent-runner agent-run error', String(agent.id), describeError(err));
      await failAndReschedule(agent, describeError(err));
      return { agentId: agent.id, status: 'failed', error: describeError(err) } as Record<string, unknown>;
    }
  }));
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
  const name = String(agent.name || 'Naamloze agent');
  const modelKind = resolveModelKind(agent.model_kind);
  const maxProposals = clampInt(agent.max_proposals_per_run, DEFAULT_MAX_PROPOSALS, 1, MAX_PROPOSALS_LIMIT);

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
  const log = runLogger(orgId, agentId, runId);

  // 2) Identiteit herleiden (geen live sessie). Geen actief lid meer → pauzeer.
  let role: OrganizationRole;
  try {
    if (!runAsUserId) throw new Error('Geen actor meer aan deze agent gekoppeld.');
    role = await requireOrganizationAccess(runAsUserId, orgId);
  } catch {
    const reason = runAsUserId
      ? 'De medewerker namens wie deze agent draait, is geen actief lid meer. Agent gepauzeerd.'
      : 'De medewerker namens wie deze agent draaide, bestaat niet meer. Agent gepauzeerd; de historie blijft bewaard.';
    return await cancelRun(agentId, runId, log, reason, 'actor_inactive');
  }

  // 3) Zijn rechten van VANDAAG — niet die van toen de agent gemaakt werd. Gerrie
  //    dicht = geen agent; niet meer mogen wijzigen = alleen nog meekijken.
  const { data: actor } = await supabaseAdmin.auth.admin.getUserById(runAsUserId);
  const actorEmail = actor?.user?.email || undefined;
  const ctx = await buildContext(orgId, role, { id: runAsUserId, email: actorEmail });
  ctx.clientEmail = clientEmailSettings(agent);
  const caps = agentCapabilities(role, ctx.moduleAccess);
  if (!caps.canUse) {
    return await cancelRun(agentId, runId, log, 'De medewerker namens wie deze agent draait, heeft geen toegang meer tot Gerrie. Agent gepauzeerd.', 'gerrie_closed');
  }
  const wanted: AgentMode = String(agent.mode || 'report') === 'propose' ? 'propose' : 'report';
  const mode = allowedAgentMode(wanted, caps);

  // 3b) Het logboek begint: wat deze run mag. Vanaf hier is elke stap na te lezen op
  //     de agentpagina — ook dat hij als meekijker draait als de rechten dat vragen.
  const allowedToolNames = resolveAllowedTools(agent, mode);
  log.add('start', triggeredBy === 'manual' ? 'Handmatig gestart' : 'Gestart volgens schema', {
    mode,
    model: modelKind,
    instruction: String(agent.instruction || '').slice(0, 2000),
    tools: allowedToolNames,
    max_proposals: mode === 'propose' ? maxProposals : 0,
    scheduled_for: agent.next_run_at ?? null,
  });
  if (wanted === 'propose' && mode === 'report') {
    log.add('error', 'Draait als meekijker: de eigenaar mag zelf niet (meer) wijzigen, dus deze agent zet niets klaar.', {});
  }
  await log.flush();

  // 4) Budget — FAIL-CLOSED op dit onbewaakte pad. Er is één grens: het maandtegoed
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

  // 5) Gesprek (transcript) aanhaken.
  const convId = await createConversation(orgId, runAsUserId, `Agent: ${name} — ${todayIso()}`);
  await supabaseAdmin.from('ai_conversations').update({ agent_id: agentId, agent_run_id: runId }).eq('id', convId);
  await supabaseAdmin.from('ai_agent_runs').update({ conversation_id: convId }).eq('id', runId);

  // 6) De opdracht, met de spelregels van deze run en wat hij de vorige keren vond.
  const instruction = String(agent.instruction || '').trim();
  const delivery = deliverySettings(agent);
  const memory = await loadMemory(agentId, runId);
  const runMessage = buildScheduledRunMessage({
    instruction, mode, maxProposals, quietWhenEmpty: delivery.quiet, memory,
    timeZone: String(agent.timezone || 'Europe/Amsterdam'),
  });
  await insertMessage(convId, orgId, runAsUserId, 'user', instruction, []);

  try {
    // 7) Het brein draaien (headless, no-op emit).
    const outcome = await runAgent(ctx, [], runMessage, noopEmit, modelKind, allowedToolNames, {
      maxProposals: mode === 'propose' ? maxProposals : 1,
      maxIterations: MAX_AGENT_ITERATIONS,
    });

    // 7b) Elke stap uit de loop het logboek in — dít is "wat heeft hij gedaan?".
    for (const step of outcome.steps) log.addStep(step);

    const assistantId = await insertMessage(convId, orgId, runAsUserId, 'assistant', outcome.text, outcome.toolCalls);
    await recordUsage(orgId, convId, assistantId, runAsUserId, outcome.usage, modelKind, agentId, runId);

    // De VOLLEDIGE eindtekst; `summary` op de run is een afgekapte digest.
    log.add('answer', 'Zijn antwoord', { text: outcome.text });

    // 8) Voorstellen (propose-modus) → goedkeurwachtrij, NIET uitvoeren.
    const auditIds = mode === 'propose'
      ? await queueProposals(orgId, convId, assistantId, runAsUserId, agentId, runId, outcome.proposals)
      : [];
    auditIds.forEach((auditId, i) => {
      log.add('proposal', 'Wacht op jouw akkoord', { auditId, type: auditActionName(outcome.proposals[i]), what: describeProposal(outcome.proposals[i]) });
    });
    if (mode !== 'propose' && outcome.proposals.length > 0) {
      // Kan alleen als iemand de modus of de rechten veranderde terwijl er een run liep.
      log.add('proposal', 'Voorstel niet klaargezet: deze agent mag alleen rapporteren.', { type: auditActionName(outcome.proposals[0]) });
    }
    const proposalsCreated = auditIds.length;

    // 9) Stil-als-leeg: niets gevonden en niets klaargezet → geen mail of push.
    const quiet = delivery.quiet && proposalsCreated === 0 && !outcome.refused && isNothingToReport(outcome.text);
    const costUsdVal = costUsd(outcome.usage, modelKind);
    await finishRun(runId, {
      // Een weigering van de veiligheidsfilter is geen storing, maar ook niet "gelukt".
      status: outcome.refused ? 'partial' : 'succeeded',
      summary: quiet ? 'Niets te melden.' : outcome.text.slice(0, 4000),
      result: { toolCalls: outcome.toolCalls.map((t) => t.name), auditIds, quiet, models: outcome.models },
      input_tokens: outcome.usage.input + outcome.usage.cacheRead + outcome.usage.cacheWrite,
      output_tokens: outcome.usage.output,
      cost_usd: costUsdVal,
      proposals_created: proposalsCreated,
    });

    // 10) Bezorgen (in-app = de run-rij zelf; e-mail en push best-effort).
    if (quiet) {
      log.add('delivery', 'Niets te melden — geen mail of pushmelding verstuurd', { quiet: true });
    } else {
      const delivered = await deliver(agent, runId, name, outcome.text, proposalsCreated, actorEmail);
      log.add('delivery', deliveryLabel(delivered), { ...delivered });
    }

    log.add('finish', outcome.refused ? 'Deels — de veiligheidsfilter hield iets tegen' : 'Klaar', {
      status: outcome.refused ? 'partial' : 'succeeded',
      tokens: outcome.usage.input + outcome.usage.cacheRead + outcome.usage.cacheWrite + outcome.usage.output,
      cost_usd: costUsdVal,
      proposals_created: proposalsCreated,
      models: outcome.models,
    });
    await log.flush();

    // 11) Succes: circuit-breaker resetten + herplannen.
    if (opts.reschedule) await rescheduleAgent(agent, { resetFailures: true });
    else await supabaseAdmin.from('ai_agents').update({ last_run_at: new Date().toISOString(), lease_until: null }).eq('id', agentId);

    return { agentId, runId, status: outcome.refused ? 'partial' : 'succeeded', proposalsCreated, quiet };
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

/** Afbreken omdat de eigenaar er niet (meer) is of niet meer mag; de agent gaat op pauze. */
async function cancelRun(agentId: string, runId: string, log: ReturnType<typeof runLogger>, reason: string, code: string): Promise<Record<string, unknown>> {
  log.add('error', reason, {});
  log.add('finish', 'Afgebroken', { status: 'cancelled' });
  await log.flush();
  await finishRun(runId, { status: 'cancelled', error: reason });
  await supabaseAdmin.from('ai_agents').update({ status: 'paused', next_run_at: null, lease_until: null }).eq('id', agentId);
  return { agentId, status: 'cancelled', reason: code };
}

/**
 * Zet de voorstellen van een run in de goedkeurwachtrij. Op naam van de eigenaar
 * (user_id): hij beslist erover, en voert ze uit onder zijn eigen sessie.
 */
async function queueProposals(
  orgId: string, convId: string, messageId: string, userId: string, agentId: string, runId: string, proposals: Proposal[],
): Promise<string[]> {
  if (proposals.length === 0) return [];
  const { data, error } = await supabaseAdmin.from('ai_action_audit').insert(proposals.map((proposal) => ({
    organization_id: orgId, conversation_id: convId, message_id: messageId, user_id: userId,
    action: auditActionName(proposal), params: proposal, status: 'proposed',
    agent_id: agentId, agent_run_id: runId,
  }))).select('id');
  if (error) throw new HttpError(`Voorstellen klaarzetten mislukt: ${error.message}`, 500);
  return ((data ?? []) as Array<{ id: string }>).map((row) => String(row.id));
}

/**
 * Het geheugen van een agent: zijn laatste runs, met wat er van zijn voorstellen
 * werd. Best-effort — zonder geheugen draait hij gewoon zoals vroeger.
 */
async function loadMemory(agentId: string, currentRunId: string): Promise<PastRun[]> {
  try {
    const { data: runs } = await supabaseAdmin.from('ai_agent_runs')
      .select('id, created_at, summary')
      .eq('agent_id', agentId).in('status', ['succeeded', 'partial']).neq('id', currentRunId)
      .order('created_at', { ascending: false }).limit(MEMORY_RUNS);
    const rows = (runs ?? []) as Array<{ id: string; created_at: string; summary: string | null }>;
    if (rows.length === 0) return [];
    const { data: audits } = await supabaseAdmin.from('ai_action_audit')
      .select('agent_run_id, params, status, result')
      .in('agent_run_id', rows.map((r) => r.id));
    const byRun = new Map<string, PastRun['decisions']>();
    for (const a of (audits ?? []) as Array<{ agent_run_id: string; params: unknown; status: string; result: { decision?: string } | null }>) {
      let title = 'een voorstel';
      try { title = describeProposal(a.params as Proposal); } catch { /* een oud voorstel in een andere vorm */ }
      const list = byRun.get(a.agent_run_id) ?? [];
      list.push({ title, status: decisionStatusLabel(a.status, a.result?.decision ?? null) });
      byRun.set(a.agent_run_id, list);
    }
    return rows.map((r) => ({ at: r.created_at, summary: String(r.summary ?? ''), decisions: byRun.get(r.id) ?? [] }));
  } catch (error) {
    console.warn('gerrie-agent-runner geheugen laden mislukt', agentId, describeError(error));
    return [];
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

/** Waar het resultaat heen gaat, en of een lege run stil mag blijven. */
function deliverySettings(agent: Record<string, unknown>): { channels: string[]; quiet: boolean } {
  const raw = (agent.delivery ?? {}) as { channels?: unknown; quiet?: unknown };
  const channels = Array.isArray(raw.channels) ? raw.channels.map(String).filter((c) => DELIVERY_CHANNELS.includes(c)) : ['inapp'];
  return { channels: channels.length ? channels : ['inapp'], quiet: raw.quiet === true };
}

/**
 * Proefdraaien: laat vóór het aanmaken zien wat deze agent écht vindt.
 *
 * Dit bestaat omdat een agent kon beloven wat hij daarna niet waarmaakte. Je bouwde
 * hem in een gesprek, zette hem aan, en pas bij de eerste run bleek dat de opdracht
 * iets vroeg wat de tools niet kunnen. Nu draait hij één keer vóór hij bestaat.
 *
 * Twee harde grenzen: er wordt NIETS aangemaakt (geen agent, geen run) en er worden
 * ALLEEN lees-tools meegegeven — ook als de agent straks in propose-modus komt. Een
 * proefrun hoort niets klaar te zetten dat op je akkoord gaat wachten. Het verbruik
 * telt wel mee met je maandtegoed; het is een echte run.
 */
async function previewAgent(ctx: GerrieContext, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!ANTHROPIC_API_KEY) throw new HttpError('ANTHROPIC_API_KEY ontbreekt in de Edge Function secrets.', 500);
  const instruction = String(body.instruction || '').trim();
  if (!instruction) throw new HttpError('Geef een opdracht om te proefdraaien.', 400);

  const budget = await checkUserBudget(ctx.userId);
  if (!budget.allowed) return { ok: false, budget: true, text: '', steps: [] };

  const fields = sanitizeAgentFields({ ...body, mode: 'report' });
  ctx.clientEmail = clientEmailSettings(fields);
  // Alleen wat deze gebruiker zelf mag lezen.
  const { tools } = permittedAgentTools(fields.enabled_tools as string[], toolCatalog(ctx), 'report');
  const allowedToolNames = resolveAllowedTools({ ...fields, enabled_tools: tools }, 'report');
  const modelKind = resolveModelKind(fields.model_kind);

  const message = `${instruction}\n\n(PROEFRUN — laat zien wat je met de beschikbare gegevens vindt. Zet niets klaar en verstuur niets; je mag alleen kijken. Kun je iets niet met de tools die je hebt, zeg dat dan expliciet in plaats van het te benaderen.)`;
  const outcome = await runAgent(ctx, [], message, noopEmit, modelKind, allowedToolNames, { maxIterations: MAX_AGENT_ITERATIONS });

  // Verbruik boeken op een los gesprek: een proefrun kost tegoed, dus die mag niet
  // buiten de telling vallen.
  const convId = await createConversation(ctx.organizationId, ctx.userId, `Proefrun: ${instruction.slice(0, 50)}`);
  const msgId = await insertMessage(convId, ctx.organizationId, ctx.userId, 'assistant', outcome.text, outcome.toolCalls);
  await recordUsage(ctx.organizationId, convId, msgId, ctx.userId, outcome.usage, modelKind);

  return {
    ok: true,
    text: outcome.text,
    // De stappen zijn het bewijs: hiermee zie je of hij echt heeft gekeken, waarmee
    // hij filterde en hoeveel hij vond — of dat hij het antwoord heeft verzonnen.
    steps: outcome.steps.map((s) => ({ kind: s.kind, label: s.label, ok: s.ok, detail: s.detail })),
    tools: allowedToolNames,
  };
}

function resolveAllowedTools(agent: Record<string, unknown>, mode: AgentMode): string[] {
  const raw = Array.isArray(agent.enabled_tools) ? (agent.enabled_tools as unknown[]).map(String) : [];
  // Een onbewaakte agent mag nooit zelf nieuwe agents laten klaarzetten: dat is
  // een chat-handeling waar een mens bij zit. Ook niet als iemand hem aanvinkt.
  const enabled = raw.filter((n) => isEnabledToolName(n) && !AGENT_FORBIDDEN_TOOLS.includes(n));
  if (mode === 'report') {
    // Alleen lezen — strip elke schrijf-tool en elke schrijf-handeling, ook als iemand
    // die per ongeluk heeft aangevinkt.
    return enabled.length ? enabled.filter(isReadOnlyToolName) : READ_TOOL_NAMES;
  }
  // propose: altijd de lees-tools + de gekozen (propose-)tools erbij.
  const chosen = enabled.length ? enabled : READ_TOOL_NAMES;
  return Array.from(new Set([...READ_TOOL_NAMES, ...chosen])).filter((n) => !AGENT_FORBIDDEN_TOOLS.includes(n));
}

async function finishRun(runId: string, fields: Record<string, unknown>): Promise<void> {
  await supabaseAdmin.from('ai_agent_runs').update({ ...fields, finished_at: new Date().toISOString() }).eq('id', runId);
}

// Bereken de volgende run-tijd (DST-bewust, _shared/agentSchedule.ts) en zet het schema door.
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

interface Delivered { emailed: boolean; to: string | null; pushed: boolean; note?: string }

function deliveryLabel(d: Delivered): string {
  const ways = ['in de app', d.emailed ? `per e-mail (${d.to})` : null, d.pushed ? 'met een pushmelding' : null].filter(Boolean);
  return `Bezorgd ${ways.join(', ').replace(/, ([^,]*)$/, ' en $1')}`;
}

async function deliver(agent: Record<string, unknown>, runId: string, name: string, summary: string, proposals: number, actorEmail?: string): Promise<Delivered> {
  const { channels } = deliverySettings(agent);
  // in-app = de ai_agent_runs-rij; niets extra's nodig.
  const result: Delivered = { emailed: false, to: null, pushed: false };
  const notes: string[] = [];

  if (channels.includes('push')) {
    // De ontvanger (de eigenaar) en de tekst bepaalt de database; geen push-abonnement
    // of de melding uitgezet in Instellingen → Meldingen = er gaat niets uit.
    const { error } = await supabaseAdmin.rpc('ai_agent_run_push', { p_run_id: runId });
    if (error) notes.push(`pushmelding mislukt: ${error.message}`);
    else result.pushed = true;
  }

  if (channels.includes('email')) {
    const apiKey = Deno.env.get('RESEND_API_KEY') || '';
    const from = Deno.env.get('GERRIE_ROUTINES_FROM') || Deno.env.get('RESEND_FROM') || '';
    result.to = actorEmail ?? null;
    if (!apiKey || !from || !actorEmail) {
      notes.push('e-mailbezorging staat aan maar is niet geconfigureerd');
    } else {
      const extra = proposals > 0 ? ` (${proposals} voorstel${proposals === 1 ? '' : 'len'} klaargezet om goed te keuren)` : '';
      const safe = summary.slice(0, 4000);
      try {
        await sendViaResend(apiKey, {
          from, to: [actorEmail],
          subject: `Je agent: ${name}${extra}`,
          text: safe,
          html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><h2 style="margin:0 0 8px">${escapeHtml(name)}</h2>${extra ? `<p style="color:#b8860b"><strong>${escapeHtml(extra.trim())}</strong></p>` : ''}<div style="white-space:pre-wrap;line-height:1.5">${escapeHtml(safe)}</div><p style="color:#888;font-size:12px;margin-top:16px">Automatisch gegenereerd door je Gerrie-agent. Er is niets verstuurd of aangemaakt zonder jouw akkoord.</p></div>`,
        }, `agent-run-${runId}`);
        result.emailed = true;
      } catch (e) {
        console.warn('gerrie-agent-runner e-mailbezorging mislukt', describeError(e));
        notes.push(`e-mail mislukt: ${describeError(e)}`);
      }
    }
  }
  if (notes.length) result.note = notes.join('; ');
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// ── Beheer (app-pad) ─────────────────────────────────────────────────────────

function sanitizeAgentFields(body: Record<string, unknown>): Record<string, unknown> {
  const modelKind = String(body.model_kind || 'cheap') === 'strong' ? 'strong' : 'cheap';
  const mode = String(body.mode || 'report') === 'propose' ? 'propose' : 'report';
  const schedule = normalizeSchedule(body);
  const enabledTools = Array.isArray(body.enabled_tools)
    ? [...new Set((body.enabled_tools as unknown[]).map(String).filter(isEnabledToolName))]
    : [];
  const rawDelivery = (body.delivery ?? {}) as { channels?: unknown; quiet?: unknown };
  const channelsRaw = Array.isArray(rawDelivery.channels)
    ? rawDelivery.channels.map(String).filter((c) => DELIVERY_CHANNELS.includes(c))
    : ['inapp'];
  // In de app staat een run altijd; mail en push komen erbij.
  const channels = [...new Set(['inapp', ...channelsRaw])];

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
    schedule_kind: schedule.kind,
    hour: schedule.hour,
    minute: schedule.minute,
    end_hour: schedule.endHour,
    day_of_week: schedule.dayOfWeek,
    day_of_month: schedule.dayOfMonth,
    timezone: schedule.timezone.slice(0, 64),
    // Geen budget-velden meer: kosten worden begrensd door het maandtegoed van het
    // account (checkUserBudget). Zie migratie 20260820000000.
    delivery: { channels, recipient_user_ids: [], quiet: rawDelivery.quiet === true },
    icon,
    hue,
    email_mode: emailMode,
    email_subject: emailSubject,
    email_body: emailBody,
    max_emails_per_run: clampInt(body.max_emails_per_run, 5, 1, 25),
    max_proposals_per_run: clampInt(body.max_proposals_per_run, DEFAULT_MAX_PROPOSALS, 1, MAX_PROPOSALS_LIMIT),
    visibility: body.visibility === 'team' ? 'team' : 'private',
  };
}

/**
 * Snoeit een agent bij tot wat zijn eigenaar mag: wie niet mag wijzigen, krijgt
 * een agent die alleen meekijkt, en tools buiten zijn modulerechten vallen eraf.
 * `dropped` en `downgraded` gaan terug naar de app, zodat die het kan zeggen in
 * plaats van het stil weg te laten.
 */
function fitToOwner(fields: Record<string, unknown>, ctx: GerrieContext, caps: AgentCapabilities): { fields: Record<string, unknown>; dropped: string[]; downgraded: boolean } {
  const mode = allowedAgentMode(fields.mode, caps);
  const { tools, dropped } = permittedAgentTools(fields.enabled_tools as string[], toolCatalog(ctx), mode);
  return {
    fields: { ...fields, mode, enabled_tools: tools },
    dropped,
    downgraded: fields.mode === 'propose' && mode === 'report',
  };
}

async function loadAgent(orgId: string, id: string): Promise<Record<string, unknown>> {
  if (!isUuid(id)) throw new HttpError('Ongeldig id.', 400);
  const { data, error } = await supabaseAdmin.from('ai_agents').select('*').eq('id', id).eq('organization_id', orgId).maybeSingle();
  if (error) throw new HttpError(`Agent ophalen mislukt: ${error.message}`, 500);
  if (!data) throw new HttpError('Agent niet gevonden.', 404);
  return data as Record<string, unknown>;
}

function assertMay(agent: Record<string, unknown>, ctx: GerrieContext, caps: AgentCapabilities, action: AgentAction): void {
  if (!canManageAgent(agent, ctx.userId, caps, action)) throw new HttpError(manageRefusal(action), 403);
}

/** Een plafond op het aantal agents per persoon: elke actieve agent is een run per tik. */
async function assertRoomForAgent(orgId: string, ownerId: string): Promise<void> {
  const { count, error } = await supabaseAdmin.from('ai_agents').select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId).eq('run_as_user_id', ownerId).neq('status', 'archived');
  if (error) throw new HttpError(`Agents tellen mislukt: ${error.message}`, 500);
  if (Number(count ?? 0) >= MAX_AGENTS_PER_USER) {
    throw new HttpError(`Er staan al ${MAX_AGENTS_PER_USER} agents op deze naam. Archiveer er eerst een die je niet meer gebruikt.`, 409);
  }
}

/**
 * Maakt een agent aan, op naam van wie hem maakt. Met `activate` gaat hij in
 * DEZELFDE aanroep aan.
 *
 * Dat is bewust één stap: een agent die je net hebt samengesteld hoort niet als
 * slapend concept te blijven liggen tot je hem nog eens apart aanzet. De grens
 * blijft waar hij hoort — alles wat hij vervolgens wil versturen komt als
 * afvinklijst bij jou terug.
 */
async function createAgent(ctx: GerrieContext, caps: AgentCapabilities, body: Record<string, unknown>) {
  const fitted = fitToOwner(sanitizeAgentFields(body), ctx, caps);
  if (!fitted.fields.instruction) throw new HttpError('Geef een opdracht voor de agent.', 400);
  await assertRoomForAgent(ctx.organizationId, ctx.userId);
  const activate = body.activate === true;
  const nextRunAt = activate ? computeNextRunAt(fitted.fields, new Date()).toISOString() : null;
  const { data, error } = await supabaseAdmin.from('ai_agents').insert({
    organization_id: ctx.organizationId, created_by: ctx.userId, run_as_user_id: ctx.userId,
    status: activate ? 'active' : 'draft', next_run_at: nextRunAt, ...fitted.fields,
  }).select('id').single();
  if (error) throw new HttpError(`Agent aanmaken mislukt: ${error.message}`, 500);
  return {
    id: data.id as string, status: activate ? 'active' : 'draft', next_run_at: nextRunAt,
    mode: fitted.fields.mode, dropped: fitted.dropped, downgraded: fitted.downgraded,
  };
}

async function updateAgent(ctx: GerrieContext, caps: AgentCapabilities, body: Record<string, unknown>) {
  const existing = await loadAgent(ctx.organizationId, String(body.id || ''));
  // Een agent draait als zijn maker (run_as_user_id): met diens rechten, privé-
  // agenda's, gesprekken en AI-tegoed. Aanpassen doet daarom alleen die persoon.
  assertMay(existing, ctx, caps, 'edit');
  const fitted = fitToOwner(sanitizeAgentFields(body), ctx, caps);
  if (!fitted.fields.instruction) throw new HttpError('Geef een opdracht voor de agent.', 400);

  const patch: Record<string, unknown> = { ...fitted.fields };
  // Draait de agent al? Herbereken de volgende run met het nieuwe schema.
  if (String(existing.status) === 'active') {
    patch.next_run_at = computeNextRunAt({ ...existing, ...fitted.fields }, new Date()).toISOString();
  }
  const { error } = await supabaseAdmin.from('ai_agents').update(patch).eq('id', String(existing.id)).eq('organization_id', ctx.organizationId);
  if (error) throw new HttpError(`Agent bijwerken mislukt: ${error.message}`, 500);
  return { ok: true as const, mode: fitted.fields.mode, dropped: fitted.dropped, downgraded: fitted.downgraded };
}

async function setStatus(ctx: GerrieContext, caps: AgentCapabilities, id: string, status: string): Promise<{ ok: true; next_run_at: string | null }> {
  if (!['draft', 'active', 'paused', 'archived'].includes(status)) throw new HttpError('Ongeldige status.', 400);
  const existing = await loadAgent(ctx.organizationId, id);
  // Aanzetten (of terug naar concept) is van de eigenaar: anders gaat hij draaien
  // namens iemand die daar niet om vroeg. Pauzeren en archiveren mag ook toezicht.
  assertMay(existing, ctx, caps, status === 'active' ? 'activate' : status === 'paused' ? 'pause' : status === 'archived' ? 'archive' : 'edit');

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
  const { error } = await supabaseAdmin.from('ai_agents').update(patch).eq('id', id).eq('organization_id', ctx.organizationId);
  if (error) throw new HttpError(`Status bijwerken mislukt: ${error.message}`, 500);
  return { ok: true, next_run_at: (patch.next_run_at as string | null) ?? null };
}

/**
 * "Verwijderen" van een agent = ARCHIVEREN.
 *
 * Een agent heeft namens iemand gewerkt: mail klaargezet, facturen voorgesteld,
 * cijfers gelezen. Dat weggooien betekent dat je achteraf niet meer kunt
 * verantwoorden wat er is gebeurd. Hij gaat dus uit (geen schema, geen lease) maar
 * blijft met zijn volledige logboek bestaan. Er is bewust géén hard-delete-pad.
 */
async function archiveAgent(ctx: GerrieContext, caps: AgentCapabilities, id: string): Promise<{ ok: true; archived: true }> {
  const existing = await loadAgent(ctx.organizationId, id);
  assertMay(existing, ctx, caps, 'archive');
  const { error } = await supabaseAdmin.from('ai_agents')
    .update({ status: 'archived', archived_at: new Date().toISOString(), next_run_at: null, lease_until: null, visibility: 'private' })
    .eq('id', id).eq('organization_id', ctx.organizationId);
  if (error) throw new HttpError(`Agent archiveren mislukt: ${error.message}`, 500);
  return { ok: true, archived: true };
}

/** Terug uit het archief: hij komt gepauzeerd terug; de eigenaar zet hem zelf weer aan. */
async function restoreAgent(ctx: GerrieContext, caps: AgentCapabilities, id: string): Promise<{ ok: true }> {
  const existing = await loadAgent(ctx.organizationId, id);
  assertMay(existing, ctx, caps, 'restore');
  if (existing.run_as_user_id) await assertRoomForAgent(ctx.organizationId, String(existing.run_as_user_id));
  const { error } = await supabaseAdmin.from('ai_agents')
    .update({ status: 'paused', archived_at: null, next_run_at: null, lease_until: null })
    .eq('id', id).eq('organization_id', ctx.organizationId);
  if (error) throw new HttpError(`Agent terugzetten mislukt: ${error.message}`, 500);
  return { ok: true };
}

/**
 * Een eigen agent maken op basis van een bestaande: een sjabloon dat een collega
 * deelde, of een eigen agent als startpunt. De kopie is van wie hem maakt en draait
 * met DIENS rechten — wat die niet mag, valt eraf en dat staat in het antwoord.
 */
async function cloneAgent(ctx: GerrieContext, caps: AgentCapabilities, id: string, activate: boolean) {
  const source = await loadAgent(ctx.organizationId, id);
  if (!canCloneAgent(source, ctx.userId, caps)) throw new HttpError('Deze agent is niet gedeeld; vraag de eigenaar om hem met het team te delen.', 403);
  await assertRoomForAgent(ctx.organizationId, ctx.userId);
  const own = String(source.run_as_user_id ?? '') === ctx.userId;
  const fields = sanitizeAgentFields({
    ...source,
    name: own ? `${String(source.name || 'Agent')} (kopie)` : String(source.name || 'Agent'),
    visibility: 'private',
  });
  const fitted = fitToOwner(fields, ctx, caps);
  if (!fitted.fields.instruction) throw new HttpError('Deze agent heeft geen opdracht om over te nemen.', 400);
  const nextRunAt = activate ? computeNextRunAt(fitted.fields, new Date()).toISOString() : null;
  const { data, error } = await supabaseAdmin.from('ai_agents').insert({
    organization_id: ctx.organizationId, created_by: ctx.userId, run_as_user_id: ctx.userId,
    status: activate ? 'active' : 'draft', next_run_at: nextRunAt, copied_from: String(source.id), ...fitted.fields,
  }).select('id').single();
  if (error) throw new HttpError(`Agent kopiëren mislukt: ${error.message}`, 500);
  return {
    id: data.id as string, status: activate ? 'active' : 'draft', next_run_at: nextRunAt,
    mode: fitted.fields.mode, dropped: fitted.dropped, downgraded: fitted.downgraded,
  };
}

/**
 * Delen met het team: collega's zien hem als startpunt en kunnen er een eigen kopie
 * van maken. Ze zien zijn instellingen, niet zijn runs, logboek of voorstellen.
 */
async function shareAgent(ctx: GerrieContext, caps: AgentCapabilities, id: string, visibility: unknown): Promise<{ ok: true; visibility: string }> {
  const existing = await loadAgent(ctx.organizationId, id);
  assertMay(existing, ctx, caps, 'share');
  if (String(existing.status) === 'archived') throw new HttpError('Een gearchiveerde agent kun je niet delen.', 400);
  const next = visibility === 'team' ? 'team' : 'private';
  const { error } = await supabaseAdmin.from('ai_agents').update({ visibility: next }).eq('id', id).eq('organization_id', ctx.organizationId);
  if (error) throw new HttpError(`Delen mislukt: ${error.message}`, 500);
  return { ok: true, visibility: next };
}

async function runNow(ctx: GerrieContext, caps: AgentCapabilities, id: string): Promise<Record<string, unknown>> {
  if (!ANTHROPIC_API_KEY) throw new HttpError('ANTHROPIC_API_KEY ontbreekt in de Edge Function secrets.', 500);
  const agent = await loadAgent(ctx.organizationId, id);
  assertMay(agent, ctx, caps, 'run');
  if (String(agent.status) === 'archived') throw new HttpError('Deze agent is gearchiveerd. Zet hem eerst terug als je hem weer wilt laten draaien.', 400);
  if (!String(agent.instruction || '').trim()) throw new HttpError('Deze agent heeft nog geen opdracht.', 400);
  // Handmatige run: eigen occurrence-key, verandert het schema NIET.
  const occurrenceKey = `manual:${new Date().toISOString()}`;
  return await executeAgentRun(agent, 'manual', occurrenceKey, { reschedule: false });
}

/**
 * Antwoord van de (aanwezige) eigenaar op een run: zet het gesprek van die run voort.
 * Handig als de agent om input vroeg ("mag ik dit versturen?") — de eigenaar antwoordt,
 * de agent draait nog een beurt en kan alsnog iets klaarzetten. Draait met dezelfde
 * modus/tools als de agent; een voorstel belandt (zoals altijd) in de goedkeurwachtrij
 * en wordt pas na expliciete goedkeuring uitgevoerd.
 */
async function replyToRun(ctx: GerrieContext, caps: AgentCapabilities, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = String(body.runId || '');
  const message = String(body.message || '').trim();
  if (!isUuid(runId)) throw new HttpError('Ongeldig run-id.', 400);
  if (!message) throw new HttpError('Leeg bericht.', 400);
  if (message.length > 4000) throw new HttpError('Bericht is te lang.', 400);
  if (!ANTHROPIC_API_KEY) throw new HttpError('ANTHROPIC_API_KEY ontbreekt in de Edge Function secrets.', 500);

  const orgId = ctx.organizationId;
  const { data: run, error: runErr } = await supabaseAdmin.from('ai_agent_runs')
    .select('agent_id, conversation_id').eq('id', runId).eq('organization_id', orgId).maybeSingle();
  if (runErr) throw new HttpError(`Run ophalen mislukt: ${runErr.message}`, 500);
  if (!run) throw new HttpError('Run niet gevonden.', 404);
  const convId = run.conversation_id ? String(run.conversation_id) : '';
  if (!convId) throw new HttpError('Deze run heeft geen gesprek om op te antwoorden.', 400);

  const agent = await loadAgent(orgId, String(run.agent_id));
  assertMay(agent, ctx, caps, 'reply');
  const mode = allowedAgentMode(agent.mode, caps);
  const modelKind = resolveModelKind(agent.model_kind);
  const maxProposals = clampInt(agent.max_proposals_per_run, DEFAULT_MAX_PROPOSALS, 1, MAX_PROPOSALS_LIMIT);

  const budget = await checkUserBudget(ctx.userId);
  if (!budget.allowed) throw new HttpError('Je AI-tegoed voor deze maand is op.', 429);

  const history = await loadHistory(convId, orgId);
  await insertMessage(convId, orgId, ctx.userId, 'user', message, []);

  // Het logboek loopt door waar de run gebleven was: een antwoordbeurt hoort bij
  // dezelfde run, en wat de agent daarna deed hoort er net zo goed in.
  const log = runLogger(orgId, String(agent.id), runId, await nextLogSeq(runId));
  log.add('reply', 'Jij antwoordde de agent', { message: message.slice(0, 2000) });

  // Antwoorden op een run gebruikt dezelfde schrijfwijze en hetzelfde mailplafond
  // als de geplande run zelf; anders zou "ja, stuur maar" ineens andere post opleveren.
  ctx.clientEmail = clientEmailSettings(agent);
  const allowedToolNames = resolveAllowedTools(agent, mode);
  const outcome: AgentOutcome = await runAgent(ctx, history, message, noopEmit, modelKind, allowedToolNames, {
    maxProposals: mode === 'propose' ? maxProposals : 1,
    maxIterations: MAX_AGENT_ITERATIONS,
  });
  for (const step of outcome.steps) log.addStep(step);

  const assistantId = await insertMessage(convId, orgId, ctx.userId, 'assistant', outcome.text, outcome.toolCalls);
  await recordUsage(orgId, convId, assistantId, ctx.userId, outcome.usage, modelKind, String(agent.id), runId);
  log.add('answer', 'Zijn antwoord', { text: outcome.text });

  const auditIds = mode === 'propose'
    ? await queueProposals(orgId, convId, assistantId, ctx.userId, String(agent.id), runId, outcome.proposals)
    : [];
  auditIds.forEach((auditId, i) => {
    log.add('proposal', 'Wacht op jouw akkoord', { auditId, type: auditActionName(outcome.proposals[i]), what: describeProposal(outcome.proposals[i]) });
  });
  if (auditIds.length > 0) {
    // Houd de teller op de run bij (voor de UI-badge).
    const { data: cur } = await supabaseAdmin.from('ai_agent_runs').select('proposals_created').eq('id', runId).maybeSingle();
    await supabaseAdmin.from('ai_agent_runs').update({ proposals_created: Number(cur?.proposals_created || 0) + auditIds.length }).eq('id', runId);
  }
  await log.flush();

  return { text: outcome.text, proposalCreated: auditIds.length };
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
    ? origin : ALLOW_LOCAL_DEV && !origin ? '*' : '';
  return {
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
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
  // Een pagina zonder herkomst (sandbox-iframe, data:, file:) is nooit de app.
  if (origin === 'null') throw new HttpError('Verzoeken zonder herkomst (origin "null") worden niet geaccepteerd.', 403);
  if (!origin && ALLOW_LOCAL_DEV) return;
  if (ALLOWED_ORIGINS.includes(origin)) return;
  if (ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (ALLOWED_ORIGINS.length === 0 && ALLOW_LOCAL_DEV) return;
  if (ALLOWED_ORIGINS.length === 0) throw new HttpError('GERRIE_ALLOWED_ORIGINS of APP_PUBLIC_URL is verplicht in productie.', 500);
  throw new HttpError('Deze frontend-origin is niet toegestaan.', 403);
}
function isLocalOrigin(origin: string): boolean { return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); }
