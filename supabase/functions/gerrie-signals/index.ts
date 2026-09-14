// ============================================================
// gerrie-signals — de motor van de beslislijst ("Gerrie signaleert").
//
// Dual-path, zelfde vorm als gerrie-agent-runner:
//   ?cron=tick  — server-to-server (x-cron-secret), elke minuut:
//                 1) veegrondes: tijdgebonden signalen + backfill + verlopen kaarten
//                    + de dagelijkse digest-push;
//                 2) rijpe signalen claimen en per signaal één kaart maken:
//                    regelkaart (geen model) of Gerrie-kaart (goedkoop model,
//                    strikte allowlist, budget FAIL-CLOSED, dagcap).
//   app-pad     — ingelogd + owner/admin: sweep_now, evaluate_now, status.
//
// De invariant van het hele plan: hier wordt NOOIT iets uitgevoerd. Een kaart is
// een voorstel in ai_action_audit ('proposed') plus een rij in ai_decisions; de
// browser voert het uit met de sessie van wie op Akkoord klikt.
// organization_id komt uitsluitend uit de signaalrij, nooit uit het model.
// ============================================================

import {
  supabaseAdmin, HttpError, MODELS, runAgent, buildContext, buildProposal, checkUserBudget, costUsd,
  requireUser, requireOrganizationAccess, describeError, parseAllowedOrigins, isUuid, todayIso,
  auditActionName, lineTotal,
} from '../_shared/gerrieCore.ts';
import type { Emit, GerrieContext, OrganizationRole, Proposal, Usage } from '../_shared/gerrieCore.ts';
import { localYmd, wallToUtc } from '../_shared/schedule.ts';
import {
  GERRIE_KINDS, KIND_MODULE, KIND_ORIGIN, SIGNAL_KINDS,
  buildGerrieBrief, buildRuleCard, severityForProposal,
  type DecisionTarget, type GerrieFacts, type RuleFacts, type Severity, type SignalKind,
} from '../_shared/signalRules.ts';

const SIGNALS_CRON_SECRET = Deno.env.get('SIGNALS_CRON_SECRET') || '';
const CLAIM_LIMIT = Math.max(1, Math.min(5, Number(Deno.env.get('SIGNALS_CLAIM_LIMIT') || '3') || 3));
const SWEEP_LIMIT = 2;
const MAX_ATTEMPTS = 3;
/** Voor regelkaarten zonder actor: een vaste, niet-bestaande gebruiker als "wie". */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

const ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('BANK_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || Deno.env.get('BANK_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const noopEmit: Emit = async () => {};

type Row = Record<string, unknown>;

interface SettingsRow {
  organization_id: string; enabled: boolean; actor_user_id: string | null; kinds: Record<string, boolean>;
  digest_hour: number; timezone: string; quote_follow_up_days: number; contract_follow_up_days: number;
  max_gerrie_cards_per_day: number; next_sweep_at: string | null; sweep_lease_until: string | null;
  last_sweep_at: string | null; budget_blocked_at: string | null;
}
interface SignalRow {
  id: string; organization_id: string; kind: string; signal_key: string; entity_type: string; entity_id: string | null;
  client_id: string | null; payload: Row; occurred_at: string; due_at: string; status: string; attempts: number;
}
interface Actor { id: string; email?: string; role: OrganizationRole }
type SignalOutcome = { id: string; kind: string; outcome: 'card' | 'skipped' | 'failed'; reason?: string; decision_id?: string };

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
      if (status >= 500) console.error('gerrie-signals cron error', describeError(error));
      return plainJson({ ok: false, error: error instanceof HttpError ? error.message : 'Serverfout.' }, status);
    }
  }

  // App-pad: JWT + owner/admin.
  try {
    if (req.method !== 'POST') return json(req, { error: 'Method not allowed.' }, 405);
    assertAllowedOrigin(req);
    const body = (await req.json().catch(() => ({}))) as Row;
    const organizationId = String(body.organizationId || '');
    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);
    if (!['owner', 'admin'].includes(role)) throw new HttpError('Alleen owners en admins kunnen de beslislijst beheren.', 403);

    const action = String(body.action || '');
    switch (action) {
      case 'sweep_now': return json(req, await sweepNow(organizationId));
      case 'evaluate_now': return json(req, await evaluateNow(organizationId, String(body.signalId || '')));
      case 'status': return json(req, await statusFor(organizationId));
      default: throw new HttpError('Onbekende actie.', 400);
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const internal = describeError(error);
    if (status >= 500) console.error('gerrie-signals error', internal); else console.warn('gerrie-signals warning', internal);
    return json(req, { error: error instanceof HttpError ? error.message : 'Er ging iets mis met de beslislijst.' }, status);
  }
});

// ── Cron-tik ─────────────────────────────────────────────────────────────────

async function runTick(): Promise<{ ok: true; sweeps: number; claimed: number; results: SignalOutcome[] }> {
  // 1. Veegrondes (tijdgebonden signalen, backfill, verlopen kaarten, digest).
  const { data: sweeps, error: sweepError } = await supabaseAdmin.rpc('claim_due_sweeps', { p_limit: SWEEP_LIMIT });
  if (sweepError) throw new HttpError(`Claimen van veegrondes mislukt: ${sweepError.message}`, 500);
  for (const s of (sweeps ?? []) as SettingsRow[]) {
    try { await runSweep(s); }
    catch (error) {
      console.error('gerrie-signals veegronde mislukt', s.organization_id, describeError(error));
      await supabaseAdmin.from('ai_signal_settings').update({ sweep_lease_until: null }).eq('organization_id', s.organization_id);
    }
  }

  // 2. Rijpe signalen.
  const { data: signals, error } = await supabaseAdmin.rpc('claim_due_signals', { p_limit: CLAIM_LIMIT });
  if (error) throw new HttpError(`Claimen van signalen mislukt: ${error.message}`, 500);
  const results: SignalOutcome[] = [];
  for (const signal of (signals ?? []) as SignalRow[]) {
    try { results.push(await processSignal(signal)); }
    catch (err) {
      const reason = describeError(err).slice(0, 400);
      console.error('gerrie-signals signaal mislukt', signal.id, reason);
      results.push(await failSignal(signal, reason));
    }
  }

  // 3. Af en toe opruimen (patroon purge_inbound_messages).
  if (Math.random() < 0.02) {
    const { error: purgeError } = await supabaseAdmin.rpc('purge_ai_signals');
    if (purgeError) console.warn('gerrie-signals opruimen mislukt', purgeError.message);
  }

  return { ok: true, sweeps: (sweeps ?? []).length, claimed: (signals ?? []).length, results };
}

async function runSweep(s: SettingsRow): Promise<{ signals: number; expired: number; open: number }> {
  const org = s.organization_id;
  const { data: nSignals, error: e1 } = await supabaseAdmin.rpc('collect_time_signals', { p_org: org });
  if (e1) throw new HttpError(`Veegronde mislukt: ${e1.message}`, 500);
  const { data: nExpired, error: e2 } = await supabaseAdmin.rpc('ai_decisions_expire', { p_org: org });
  if (e2) console.warn('gerrie-signals verlopen-check mislukt', org, e2.message);

  const now = new Date();
  await supabaseAdmin.from('ai_signal_settings').update({
    last_sweep_at: now.toISOString(),
    next_sweep_at: nextSweepAt(s.timezone || 'Europe/Amsterdam', Number(s.digest_hour ?? 7), now).toISOString(),
    sweep_lease_until: null,
  }).eq('organization_id', org);

  // Eén push per veegronde (dus per dag): "3 beslissingen wachten op je".
  const open = await countOpenDecisions(org);
  if (open > 0) {
    const { error: e3 } = await supabaseAdmin.rpc('ai_decision_digest_push', { p_org: org, p_count: open });
    if (e3) console.warn('gerrie-signals digest-push mislukt', org, e3.message);
  }
  return { signals: Number(nSignals ?? 0), expired: Number(nExpired ?? 0), open };
}

/** Eerstvolgende wandkloktijd `hour:00` in `tz` strikt ná `after`. */
function nextSweepAt(tz: string, hour: number, after: Date): Date {
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  const { y, m, d } = localYmd(tz, after);
  const today = wallToUtc(tz, y, m, d, h);
  if (today.getTime() > after.getTime()) return today;
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return wallToUtc(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h);
}

// ── Eén signaal → één kaart ──────────────────────────────────────────────────

async function processSignal(signal: SignalRow): Promise<SignalOutcome> {
  const org = signal.organization_id;
  const settings = await loadSettings(org);
  if (!settings || !settings.enabled) return skipSignal(signal, 'beslislijst staat uit');
  if (!(SIGNAL_KINDS as readonly string[]).includes(signal.kind)) return failSignal(signal, `onbekende soort ${signal.kind}`);
  const kind = signal.kind as SignalKind;
  if (settings.kinds && settings.kinds[kind] === false) return skipSignal(signal, 'soort staat uit');

  // Trap 1 opnieuw: geldt het signaal nog, en wat zijn de feiten?
  const gathered = await gatherFacts(kind, signal, settings);
  if ('skip' in gathered) return skipSignal(signal, gathered.skip);

  const actor = await resolveActor(settings);
  const origin = KIND_ORIGIN[kind];

  if (origin === 'rule') {
    if (!('rule' in gathered)) return failSignal(signal, 'regelkaart zonder feiten');
    const card = buildRuleCard(gathered.rule);
    const ctx = await contextFor(org, actor);
    const built = await buildProposal(ctx, card.tool, card.input);
    if (!built.ok) return skipSignal(signal, `voorstel niet mogelijk: ${built.error}`);
    const severity = severityForProposal(built.proposal.type, (built.proposal as { risk?: string }).risk, card.severity);
    const decisionId = await insertCard({
      signal, kind, origin: 'rule', actorId: actor?.id ?? null, proposal: built.proposal,
      title: card.title, summary: card.summary, evidence: card.evidence, severity, target: card.target,
    });
    return { id: signal.id, kind, outcome: 'card', decision_id: decisionId };
  }

  // Gerrie-kaart: handen (actor), dagcap, budget fail-closed, dan één opdracht.
  if (!actor) return skipSignal(signal, 'geen actieve owner/admin als actor');
  const cap = Number(settings.max_gerrie_cards_per_day ?? 10);
  const today = await countGerrieCardsToday(org, settings.timezone || 'Europe/Amsterdam');
  if (today >= cap) return skipSignal(signal, `dagcap van ${cap} Gerrie-kaarten bereikt`);

  const budget = await checkUserBudget(actor.id);
  if (!budget.allowed) {
    await supabaseAdmin.from('ai_signal_settings').update({ budget_blocked_at: new Date().toISOString() }).eq('organization_id', org);
    return skipSignal(signal, 'maandtegoed van de actor is op');
  }
  if (settings.budget_blocked_at) {
    await supabaseAdmin.from('ai_signal_settings').update({ budget_blocked_at: null }).eq('organization_id', org);
  }

  if (!('gerrie' in gathered)) return failSignal(signal, 'Gerrie-kaart zonder feiten');
  const brief = buildGerrieBrief(gathered.gerrie);
  const ctx = await contextFor(org, actor);
  // Een headless kaart mag niet zelf in de handelingenregistry gaan grasduinen.
  ctx.allowedActionIds = new Set<string>();
  const outcome = await runAgent(ctx, [], brief.instruction, noopEmit, 'cheap', brief.tools);
  await recordSignalUsage(org, actor.id, signal.id, outcome.usage);
  const cost = costUsd(outcome.usage, 'cheap');

  if (!outcome.proposal) {
    const said = outcome.text.replace(/\s+/g, ' ').trim();
    return skipSignal(signal, said ? `Gerrie: ${said.slice(0, 380)}` : 'Gerrie zag geen actie', { cost_usd: cost, trace: outcome.steps });
  }
  const severity = severityForProposal(outcome.proposal.type, (outcome.proposal as { risk?: string }).risk, brief.severity);
  const said = outcome.text.replace(/\s+/g, ' ').trim();
  const decisionId = await insertCard({
    signal, kind, origin: 'gerrie', actorId: actor.id, proposal: outcome.proposal,
    title: brief.title, summary: said ? said.slice(0, 600) : brief.summary, evidence: brief.evidence, severity, target: brief.target,
    model_kind: 'cheap', cost_usd: cost, trace: outcome.steps,
  });
  return { id: signal.id, kind, outcome: 'card', decision_id: decisionId };
}

async function insertCard(args: {
  signal: SignalRow; kind: SignalKind; origin: 'rule' | 'gerrie'; actorId: string | null; proposal: Proposal;
  title: string; summary: string; evidence: string[]; severity: Severity; target: DecisionTarget | null;
  model_kind?: 'cheap' | 'strong'; cost_usd?: number; trace?: unknown;
}): Promise<string> {
  const { signal } = args;
  const { data: audit, error: auditError } = await supabaseAdmin.from('ai_action_audit').insert({
    organization_id: signal.organization_id, user_id: args.actorId, action: auditActionName(args.proposal),
    params: args.proposal, status: 'proposed', signal_id: signal.id,
  }).select('id').single();
  if (auditError) throw new HttpError(`Auditrij schrijven mislukt: ${auditError.message}`, 500);

  const { data: decision, error } = await supabaseAdmin.from('ai_decisions').insert({
    organization_id: signal.organization_id, signal_id: signal.id, signal_key: signal.signal_key,
    kind: args.kind, module: KIND_MODULE[args.kind], origin: args.origin, severity: args.severity,
    entity_type: signal.entity_type, entity_id: signal.entity_id, client_id: signal.client_id,
    title: args.title.slice(0, 200), summary: args.summary.slice(0, 600), evidence: args.evidence.slice(0, 8),
    proposal: args.proposal, audit_id: audit.id, target: args.target, status: 'open',
    model_kind: args.model_kind ?? null, cost_usd: args.cost_usd ?? null, trace: args.trace ?? null,
  }).select('id').single();
  if (error) throw new HttpError(`Kaart schrijven mislukt: ${error.message}`, 500);

  await supabaseAdmin.from('ai_signals').update({ status: 'decided', decision_id: decision.id, lease_until: null, reason: null }).eq('id', signal.id);
  return String(decision.id);
}

async function skipSignal(signal: SignalRow, reason: string, extra: Row = {}): Promise<SignalOutcome> {
  await supabaseAdmin.from('ai_signals').update({ status: 'skipped', reason: reason.slice(0, 400), lease_until: null, payload: { ...signal.payload, ...(Object.keys(extra).length ? { outcome: extra } : {}) } }).eq('id', signal.id);
  return { id: signal.id, kind: signal.kind, outcome: 'skipped', reason };
}

async function failSignal(signal: SignalRow, reason: string): Promise<SignalOutcome> {
  // Onder de drempel laten we de lease verlopen: de volgende tik probeert het opnieuw.
  const final = Number(signal.attempts ?? 1) >= MAX_ATTEMPTS;
  await supabaseAdmin.from('ai_signals').update(final
    ? { status: 'failed', reason: reason.slice(0, 400), lease_until: null }
    : { reason: reason.slice(0, 400) }).eq('id', signal.id);
  return { id: signal.id, kind: signal.kind, outcome: 'failed', reason };
}

// ── Actor, context, budget, verbruik ─────────────────────────────────────────

async function loadSettings(org: string): Promise<SettingsRow | null> {
  const { data } = await supabaseAdmin.from('ai_signal_settings').select('*').eq('organization_id', org).maybeSingle();
  return (data as SettingsRow | null) ?? null;
}

async function resolveActor(settings: SettingsRow): Promise<Actor | null> {
  if (!settings.actor_user_id) return null;
  const { data } = await supabaseAdmin.from('organization_members').select('role, email')
    .eq('organization_id', settings.organization_id).eq('user_id', settings.actor_user_id).eq('status', 'active').limit(1).maybeSingle();
  const role = data?.role as OrganizationRole | undefined;
  if (!role || !['owner', 'admin'].includes(role)) return null;
  return { id: settings.actor_user_id, email: (data?.email as string | undefined) || undefined, role };
}

/** Regelkaarten mogen ook zonder actor: dan een admin-context zonder ledenrij (alle modules open). */
async function contextFor(org: string, actor: Actor | null): Promise<GerrieContext> {
  if (actor) return buildContext(org, actor.role, { id: actor.id, email: actor.email });
  return buildContext(org, 'admin', { id: SYSTEM_USER_ID });
}

async function countGerrieCardsToday(org: string, tz: string): Promise<number> {
  const now = new Date();
  const { y, m, d } = localYmd(tz, now);
  const start = wallToUtc(tz, y, m, d, 0).toISOString();
  const { count } = await supabaseAdmin.from('ai_decisions').select('id', { count: 'exact', head: true })
    .eq('organization_id', org).eq('origin', 'gerrie').gte('created_at', start);
  return Number(count ?? 0);
}

async function countOpenDecisions(org: string): Promise<number> {
  const { count } = await supabaseAdmin.from('ai_decisions').select('id', { count: 'exact', head: true })
    .eq('organization_id', org).eq('status', 'open');
  return Number(count ?? 0);
}

/** Verbruik op naam van de actor (dus binnen zijn maandtegoed), getagd met het signaal. */
async function recordSignalUsage(org: string, actorId: string, signalId: string, usage: Usage): Promise<void> {
  const { error } = await supabaseAdmin.from('ai_usage').insert({
    organization_id: org, conversation_id: null, message_id: null, user_id: actorId, model: MODELS.cheap.id,
    input_tokens: usage.input, output_tokens: usage.output, cache_read_tokens: usage.cacheRead, cache_creation_tokens: usage.cacheWrite,
    cost_usd: costUsd(usage, 'cheap'), signal_id: signalId,
  });
  if (error) console.warn('gerrie-signals verbruik schrijven mislukt', error.message);
}

// ── Feiten per soort ─────────────────────────────────────────────────────────

type Gathered = { skip: string } | { rule: RuleFacts } | { gerrie: GerrieFacts };

async function gatherFacts(kind: SignalKind, signal: SignalRow, settings: SettingsRow): Promise<Gathered> {
  const org = signal.organization_id;
  const today = todayIso();
  const p = signal.payload ?? {};

  switch (kind) {
    case 'quote_opened_unanswered': {
      const q = await one(org, 'quotes', 'id, number, client_id, status, valid_until, lines, sent_at', signal.entity_id);
      if (!q) return { skip: 'offerte niet gevonden' };
      if (q.status !== 'sent') return { skip: `offerte heeft status ${q.status}` };
      const client = await clientOf(org, q.client_id as string | null);
      if (!client?.email) return { skip: 'klant heeft geen e-mailadres' };
      const opens = await countQuoteOpens(org, String(q.id));
      const lastOpened = opens.last ?? (p.opened_at as string | null) ?? null;
      return {
        gerrie: { kind, facts: {
          quote_id: String(q.id), number: String(q.number), client_id: client.id, client_name: client.name, client_email: client.email,
          contact_name: client.contact_name, total_eur: round2(lineTotal(q.lines)), valid_until: (q.valid_until as string | null) ?? null,
          sent_at: (q.sent_at as string | null) ?? null, opens: Math.max(1, opens.count), last_opened_at: lastOpened,
          days_since_open: daysBetween(lastOpened, today), today,
        } },
      };
    }
    case 'quote_expiring': {
      const q = await one(org, 'quotes', 'id, number, client_id, status, valid_until, lines', signal.entity_id);
      if (!q) return { skip: 'offerte niet gevonden' };
      if (q.status !== 'sent') return { skip: `offerte heeft status ${q.status}` };
      const validUntil = String(q.valid_until || '');
      if (!validUntil) return { skip: 'geen geldigheidsdatum' };
      const daysLeft = daysBetween(today, validUntil);
      if (daysLeft < 0) return { skip: 'offerte is al verlopen' };
      const client = await clientOf(org, q.client_id as string | null);
      return {
        rule: { kind, facts: {
          quote_id: String(q.id), number: String(q.number), client_id: client?.id ?? null, client_name: client?.name ?? 'de klant',
          total_eur: round2(lineTotal(q.lines)), valid_until: validUntil, days_left: daysLeft, today,
        } },
      };
    }
    case 'contract_unsigned': {
      const c = await one(org, 'contracts', 'id, number, title, client_id, status, sent_at', signal.entity_id);
      if (!c) return { skip: 'contract niet gevonden' };
      if (c.status !== 'sent') return { skip: `contract heeft status ${c.status}` };
      const client = await clientOf(org, c.client_id as string | null);
      if (!client?.email) return { skip: 'klant heeft geen e-mailadres' };
      const { data: signers } = await supabaseAdmin.from('contract_signers').select('name, email, status, role')
        .eq('organization_id', org).eq('contract_id', String(c.id));
      const all = (signers ?? []) as Array<{ name: string; email: string; status: string; role: string }>;
      const pending = all.filter((s) => s.status === 'pending');
      if (all.length > 0 && pending.length === 0) return { skip: 'alle ondertekenaars hebben getekend' };
      return {
        gerrie: { kind, facts: {
          contract_id: String(c.id), number: String(c.number), title: String(c.title || ''), client_id: client.id, client_name: client.name,
          client_email: client.email, contact_name: client.contact_name, sent_at: (c.sent_at as string | null) ?? null,
          days_since_sent: daysBetween((c.sent_at as string | null) ?? (p.sent_at as string | null) ?? null, today),
          signers_total: all.length, signers_pending: pending.length,
          pending_names: pending.map((s) => s.name || s.email).filter(Boolean).slice(0, 4), today,
        } },
      };
    }
    case 'inbound_mail': {
      const e = await one(org, 'client_emails', 'id, client_id, thread_id, subject, from_email, from_name, received_at, created_at, body_text, deleted_at', signal.entity_id);
      if (!e || e.deleted_at) return { skip: 'mail verwijderd of niet gevonden' };
      const { count: reads } = await supabaseAdmin.from('client_email_reads').select('client_email_id', { count: 'exact', head: true })
        .eq('organization_id', org).eq('client_email_id', String(e.id));
      if (Number(reads ?? 0) > 0) return { skip: 'iemand in het team heeft de mail al gelezen' };
      const receivedAt = String(e.received_at || e.created_at);
      if (e.thread_id) {
        const { count: replies } = await supabaseAdmin.from('client_emails').select('id', { count: 'exact', head: true })
          .eq('organization_id', org).eq('thread_id', String(e.thread_id)).eq('direction', 'outbound').gt('created_at', receivedAt);
        if (Number(replies ?? 0) > 0) return { skip: 'al beantwoord' };
      }
      const client = await clientOf(org, e.client_id as string | null);
      if (!client) return { skip: 'klant niet gevonden' };
      const { data: quotes } = await supabaseAdmin.from('quotes').select('number, lines, valid_until')
        .eq('organization_id', org).eq('client_id', client.id).eq('status', 'sent').order('created_at', { ascending: false }).limit(3);
      const { data: invoices } = await supabaseAdmin.from('invoices').select('number, lines, due_date, status, total_amount')
        .eq('organization_id', org).eq('client_id', client.id).in('status', ['sent', 'overdue']).order('created_at', { ascending: false }).limit(3);
      const { data: lastOut } = await supabaseAdmin.from('client_emails').select('subject, created_at')
        .eq('organization_id', org).eq('client_id', client.id).eq('direction', 'outbound').is('deleted_at', null)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      return {
        gerrie: { kind, facts: {
          client_email_id: String(e.id), thread_id: (e.thread_id as string | null) ?? null, client_id: client.id, client_name: client.name,
          client_email: client.email, from_name: (e.from_name as string | null) ?? null, from_email: (e.from_email as string | null) ?? null,
          subject: String(e.subject || ''), received_at: receivedAt, hours_ago: Math.max(1, Math.round((Date.now() - Date.parse(receivedAt)) / 3600000)),
          body_text: String(e.body_text || (p.body_text as string) || '').replace(/\r/g, '').slice(0, 3000),
          open_quotes: ((quotes ?? []) as Row[]).map((q) => ({ number: String(q.number), total_eur: round2(lineTotal(q.lines)), valid_until: (q.valid_until as string | null) ?? null })),
          open_invoices: ((invoices ?? []) as Row[]).map((i) => ({
            number: String(i.number), total_eur: typeof i.total_amount === 'number' && i.total_amount > 0 ? round2(i.total_amount) : round2(lineTotal(i.lines)),
            due_date: (i.due_date as string | null) ?? null, status: String(i.status),
          })),
          last_outbound_subject: (lastOut?.subject as string | null) ?? null, last_outbound_at: (lastOut?.created_at as string | null) ?? null, today,
        } },
      };
    }
    case 'mail_unmatched': {
      const m = await one(org, 'inbound_messages', 'id, sender_email, sender_name, subject, received_at, status, suggested_client_id', signal.entity_id);
      if (!m) return { skip: 'bericht niet gevonden' };
      if (m.status !== 'unmatched') return { skip: `bericht heeft status ${m.status}` };
      const suggestedId = String(m.suggested_client_id || signal.client_id || '');
      const client = await clientOf(org, suggestedId || null);
      if (!client) return { skip: 'voorgestelde klant niet gevonden' };
      return {
        rule: { kind, facts: {
          message_id: String(m.id), sender_email: (m.sender_email as string | null) ?? null, sender_name: (m.sender_name as string | null) ?? null,
          subject: (m.subject as string | null) ?? null, received_at: (m.received_at as string | null) ?? null,
          suggested_client_id: client.id, suggested_client_name: client.name,
        } },
      };
    }
    case 'meeting_notes_ready': {
      const r = await one(org, 'meeting_recordings', 'id, event_title_snapshot, client_id, project_id, status, summary_json, created_at', signal.entity_id);
      if (!r) return { skip: 'opname niet gevonden' };
      if (r.status !== 'done') return { skip: `opname heeft status ${r.status}` };
      const summary = (r.summary_json ?? {}) as Row;
      const actiepunten = strings(summary.actiepunten ?? p.actiepunten);
      if (actiepunten.length === 0) return { skip: 'geen actiepunten in de notulen' };
      const projectId = String(r.project_id || '');
      if (!isUuid(projectId)) return { skip: 'geen project aan het gesprek gekoppeld' };
      const project = await one(org, 'projects', 'id, name, client_id', projectId);
      if (!project) return { skip: 'project niet gevonden' };
      const client = await clientOf(org, (r.client_id as string | null) ?? (project.client_id as string | null));
      return {
        rule: { kind, facts: {
          recording_id: String(r.id), title: (r.event_title_snapshot as string | null) ?? null, recorded_at: (r.created_at as string | null) ?? null,
          project_id: projectId, project_name: String(project.name), client_id: client?.id ?? null, client_name: client?.name ?? null,
          actiepunten, besluiten: strings(summary.besluiten),
        } },
      };
    }
    case 'meeting_notes_unsent': {
      const r = await one(org, 'meeting_recordings', 'id, event_title_snapshot, client_id, status, summary_sent_at, summary_text, created_at, updated_at', signal.entity_id);
      if (!r) return { skip: 'opname niet gevonden' };
      if (r.status !== 'done' || !r.summary_text) return { skip: 'notulen niet klaar' };
      if (r.summary_sent_at) return { skip: 'notulen al gemaild' };
      const client = await clientOf(org, r.client_id as string | null);
      return {
        rule: { kind, facts: {
          recording_id: String(r.id), title: (r.event_title_snapshot as string | null) ?? null, recorded_at: (r.created_at as string | null) ?? null,
          done_at: (r.updated_at as string | null) ?? (p.done_at as string | null) ?? null, client_name: client?.name ?? null,
        } },
      };
    }
    case 'gallery_favorites_chosen': {
      const g = await one(org, 'galleries', 'id, title, project_id', signal.entity_id);
      if (!g) return { skip: 'galerij niet gevonden' };
      const project = await one(org, 'projects', 'id, name, client_id', String(g.project_id || ''));
      if (!project) return { skip: 'project van de galerij niet gevonden' };
      const tz = settings.timezone || 'Europe/Amsterdam';
      const { y, m, d } = localYmd(tz, new Date());
      const dayStart = wallToUtc(tz, y, m, d, 0).toISOString();
      const { count: total } = await supabaseAdmin.from('gallery_favorites').select('id', { count: 'exact', head: true })
        .eq('organization_id', org).eq('gallery_id', String(g.id)).eq('reaction', 'favorite');
      const { count: todayCount } = await supabaseAdmin.from('gallery_favorites').select('id', { count: 'exact', head: true })
        .eq('organization_id', org).eq('gallery_id', String(g.id)).eq('reaction', 'favorite').gte('created_at', dayStart);
      if (Number(total ?? 0) === 0) return { skip: 'geen favorieten meer in de galerij' };
      const client = await clientOf(org, project.client_id as string | null);
      return {
        rule: { kind, facts: {
          gallery_id: String(g.id), gallery_title: String(g.title || 'galerij'), project_id: String(project.id), project_name: String(project.name),
          client_id: client?.id ?? null, client_name: client?.name ?? null,
          favorites_total: Number(total ?? 0), favorites_today: Number(todayCount ?? 0), today,
        } },
      };
    }
  }
  return { skip: 'onbekende soort' };
}

// ── Kleine datahulpjes (altijd org-gepind) ───────────────────────────────────

async function one(org: string, table: string, select: string, id: string | null | undefined): Promise<Row | null> {
  if (!id || !isUuid(id)) return null;
  const { data, error } = await supabaseAdmin.from(table).select(select).eq('organization_id', org).eq('id', id).maybeSingle();
  if (error) throw new HttpError(`${table} ophalen mislukt: ${error.message}`, 500);
  return (data as Row | null) ?? null;
}

async function clientOf(org: string, id: string | null): Promise<{ id: string; name: string; email: string | null; contact_name: string | null } | null> {
  const c = await one(org, 'clients', 'id, name, email, contact_name', id);
  if (!c) return null;
  return { id: String(c.id), name: String(c.name || 'de klant'), email: (c.email as string | null) || null, contact_name: (c.contact_name as string | null) || null };
}

async function countQuoteOpens(org: string, quoteId: string): Promise<{ count: number; last: string | null }> {
  const { data: deliveries } = await supabaseAdmin.from('quote_email_deliveries').select('opened_at')
    .eq('organization_id', org).eq('quote_id', quoteId).not('opened_at', 'is', null);
  const { data: views } = await supabaseAdmin.from('quote_approval_events').select('created_at')
    .eq('organization_id', org).eq('quote_id', quoteId).eq('event_type', 'client_viewed');
  const stamps = [
    ...((deliveries ?? []) as Row[]).map((r) => String(r.opened_at)),
    ...((views ?? []) as Row[]).map((r) => String(r.created_at)),
  ].filter(Boolean).sort();
  return { count: stamps.length, last: stamps.length ? stamps[stamps.length - 1] : null };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
function daysBetween(fromIso: string | null, toIso: string): number {
  if (!fromIso) return 0;
  const from = Date.parse(fromIso.length === 10 ? `${fromIso}T12:00:00Z` : fromIso);
  const to = Date.parse(`${toIso}T12:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86400000);
}

// ── App-pad ──────────────────────────────────────────────────────────────────

async function sweepNow(org: string): Promise<Row> {
  const settings = await loadSettings(org);
  if (!settings) throw new HttpError('De beslislijst is voor deze organisatie nog niet ingesteld.', 404);
  if (!settings.enabled) throw new HttpError('De beslislijst staat uit. Zet hem eerst aan.', 400);
  const result = await runSweep(settings);
  return { ok: true, ...result };
}

async function evaluateNow(org: string, signalId: string): Promise<Row> {
  if (!isUuid(signalId)) throw new HttpError('Ongeldig signaal.', 400);
  const { data, error } = await supabaseAdmin.from('ai_signals')
    .update({ status: 'claimed', lease_until: new Date(Date.now() + 600000).toISOString(), due_at: new Date().toISOString() })
    .eq('organization_id', org).eq('id', signalId).in('status', ['queued', 'claimed']).select('*').maybeSingle();
  if (error) throw new HttpError(`Signaal claimen mislukt: ${error.message}`, 500);
  if (!data) throw new HttpError('Dit signaal wacht niet meer.', 404);
  const signal = data as SignalRow;
  try { return { ok: true, result: await processSignal(signal) }; }
  catch (err) { return { ok: false, result: await failSignal(signal, describeError(err).slice(0, 400)) }; }
}

async function statusFor(org: string): Promise<Row> {
  const settings = await loadSettings(org);
  const { count: queued } = await supabaseAdmin.from('ai_signals').select('id', { count: 'exact', head: true })
    .eq('organization_id', org).in('status', ['queued', 'claimed']);
  const open = await countOpenDecisions(org);
  const gerrieToday = settings ? await countGerrieCardsToday(org, settings.timezone || 'Europe/Amsterdam') : 0;
  return {
    ok: true, enabled: Boolean(settings?.enabled), queued: Number(queued ?? 0), open, gerrie_today: gerrieToday,
    last_sweep_at: settings?.last_sweep_at ?? null, next_sweep_at: settings?.next_sweep_at ?? null,
    budget_blocked_at: settings?.budget_blocked_at ?? null,
    kinds: GERRIE_KINDS,
  };
}

// ── HTTP-hulpjes (zelfde vorm als de runner) ─────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function assertCronSecret(req: Request): void {
  if (!SIGNALS_CRON_SECRET) throw new HttpError('SIGNALS_CRON_SECRET ontbreekt in de Edge Function secrets.', 500);
  const provided = req.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, SIGNALS_CRON_SECRET)) throw new HttpError('Ongeldig of ontbrekend cron-secret.', 401);
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
