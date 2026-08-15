// ============================================================
// gerrie-agent — HTTP/SSE-schil van Gerrie, de AI-assistent.
//
// De volledige "hersenen" (agentische loop, tools, voorstellen, budget-plafond,
// audit) staan in ../_shared/gerrieCore.ts en worden gedeeld met de headless
// motor voor geplande agents (gerrie-agent-runner, "Routines"). Deze file bevat
// alleen de HTTP-toegang: CORS, origin-controle, auth-afhandeling van het request
// en de Server-Sent-Events-stream naar de browser.
//
// Beveiliging (ongewijzigd): organization_id komt altijd uit de geverifieerde
// sessie; elke query is org-scoped; schrijf-acties worden alleen VOORGESTELD; en
// gegevens uit tools zijn DATA, geen instructie.
// ============================================================

import {
  supabaseAdmin, HttpError, ANTHROPIC_API_KEY, MISSION_MAX_SUBTASKS, USD_TO_EUR,
  resolveModelKind, runAgent, planMission, designAgent, estimateMission, buildContext,
  createConversation, loadHistory, insertMessage, recordUsage, costUsd,
  checkUserBudget, remainingFraction, confirmAction, getUsageSummary,
  requireUser, requireOrganizationAccess, describeError, parseAllowedOrigins,
} from '../_shared/gerrieCore.ts';
import type { Emit, HttpStatus } from '../_shared/gerrieCore.ts';

// Toegestane frontend-origins (CORS + harde origin-controle). Alleen HTTP-schil.
const GERRIE_ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('BANK_ALLOWED_ORIGINS'),
]);
const GERRIE_ALLOW_LOCAL_DEV = (Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || Deno.env.get('BANK_ALLOW_LOCAL_DEV') || Deno.env.get('INVOICE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  try {
    if (req.method !== 'POST') return json(req, { error: 'Method not allowed.' }, 405 as HttpStatus);
    assertAllowedOrigin(req);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = String(body.organizationId || '');

    // Auth + org-toegang. Lezen mag elk actief lid (ook viewer).
    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);

    // Een uitgevoerde/mislukte actie loggen — gewone JSON, geen AI-call nodig.
    if (String(body.action || '') === 'confirm') {
      return json(req, await confirmAction(user.id, organizationId, role, body));
    }
    // AI-gebruik-dashboard: verbruik PER GEBRUIKER over alle organisaties (zoals de limiet).
    if (String(body.action || '') === 'usage') {
      return json(req, await getUsageSummary(organizationId, role));
    }
    // Resterend tegoed (fractie 0..1, of null als er geen limiet is) — voor de tegoed-balk
    // bij het openen van de chat, nog vóór het eerste bericht.
    if (String(body.action || '') === 'budget') {
      const budget = await checkUserBudget(user.id);
      return json(req, { remainingFraction: remainingFraction(budget, 0) });
    }
    // Commandocentrum — missieplan: splits een groot doel op in parallelle deeltaken (sterk model).
    if (String(body.action || '') === 'plan') {
      if (!ANTHROPIC_API_KEY) throw new HttpError('ANTHROPIC_API_KEY ontbreekt in de Edge Function secrets.', 500);
      const goal = String(body.goal || body.message || '').trim();
      if (!goal) throw new HttpError('Leeg doel.', 400);
      if (goal.length > 4000) throw new HttpError('Doel is te lang.', 400);
      const ctx = await buildContext(organizationId, role, user);
      return json(req, await planMission(ctx, user.id, goal));
    }
    // Agent-bouwer: een kort gesprek waarin de gebruiker vertelt wat hij nodig heeft
    // en dat eindigt in een compleet ingevulde agent. Maakt zelf niets aan — het
    // resultaat landt in het agent-formulier, waar de gebruiker het opslaat.
    if (String(body.action || '') === 'design_agent') {
      if (!ANTHROPIC_API_KEY) throw new HttpError('ANTHROPIC_API_KEY ontbreekt in de Edge Function secrets.', 500);
      const raw = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
      const messages = raw
        .map((m) => ({ role: String(m.role) === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }))
        .filter((m) => m.content.trim().length > 0)
        .slice(-12);
      if (messages.length === 0) throw new HttpError('Vertel eerst wat de agent moet doen.', 400);
      const ctx = await buildContext(organizationId, role, user);
      return json(req, await designAgent(ctx, user.id, messages));
    }
    // Commandocentrum — kosteninschatting vooraf (fractie van het maandtegoed) voor een missie.
    if (String(body.action || '') === 'estimate') {
      const budget = await checkUserBudget(user.id);
      const subtaskCount = Math.max(1, Math.min(Number(body.subtaskCount) || 1, MISSION_MAX_SUBTASKS));
      return json(req, { ...estimateMission(budget, subtaskCount, Boolean(body.withPlanner)), budget: { remainingFraction: remainingFraction(budget, 0) } });
    }

    if (!ANTHROPIC_API_KEY) throw new HttpError('ANTHROPIC_API_KEY ontbreekt in de Edge Function secrets.', 500);
    const message = String(body.message || '').trim();
    const conversationId = body.conversationId ? String(body.conversationId) : null;
    // Model-keuze: het Commandocentrum stuurt 'cheap' mee voor deel-agents; de gewone chat laat dit weg -> 'strong'.
    const modelKind = resolveModelKind(body.modelKind);
    if (!message) throw new HttpError('Leeg bericht.', 400);
    if (message.length > 4000) throw new HttpError('Bericht is te lang.', 400);

    // Alles is gevalideerd -> open de SSE-stream en doe het werk asynchroon.
    return streamResponse(req, async (emit) => {
      const ctx = await buildContext(organizationId, role, user);
      const convId = conversationId ?? (await createConversation(organizationId, user.id, message));
      const history = await loadHistory(convId, organizationId);

      await insertMessage(convId, organizationId, user.id, 'user', message, []);

      // Kostenlimiet per gebruiker: blokkeer vóór de (betaalde) Claude-call.
      const budget = await checkUserBudget(user.id);
      if (!budget.allowed) {
        const text = 'Je hebt je AI-tegoed voor deze maand opgebruikt. Begin volgende maand kun je weer verder, of vraag een beheerder om meer ruimte.';
        const blockedId = await insertMessage(convId, organizationId, user.id, 'assistant', text, []);
        await emit('done', { conversationId: convId, messageId: blockedId, text, budget: { remainingFraction: 0 } });
        return;
      }

      const outcome = await runAgent(ctx, history, message, emit, modelKind);

      const assistantId = await insertMessage(convId, organizationId, user.id, 'assistant', outcome.text, outcome.toolCalls);
      await recordUsage(organizationId, convId, assistantId, user.id, outcome.usage, modelKind);

      // Stelt Gerrie een actie voor, leg dat dan vast (status 'proposed') voor de audit.
      let auditId: string | null = null;
      if (outcome.proposal) {
        const { data: auditRow } = await supabaseAdmin.from('ai_action_audit').insert({
          organization_id: organizationId, conversation_id: convId, message_id: assistantId, user_id: user.id,
          action: `propose_${outcome.proposal.type}`, params: outcome.proposal, status: 'proposed',
        }).select('id').single();
        auditId = (auditRow?.id as string) ?? null;
      }

      // Alleen een fractie (0..1) naar de browser — nooit het eurobedrag zelf.
      const remaining = remainingFraction(budget, costUsd(outcome.usage) * USD_TO_EUR);
      const donePayload: Record<string, unknown> = { conversationId: convId, messageId: assistantId, text: outcome.text };
      if (remaining !== null) donePayload.budget = { remainingFraction: remaining };
      if (outcome.proposal) donePayload.proposal = outcome.proposal;
      if (auditId) donePayload.auditId = auditId;
      await emit('done', donePayload);
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const internal = describeError(error);
    if (status >= 500) console.error('gerrie-agent error', internal); else console.warn('gerrie-agent warning', internal);
    const publicMessage = error instanceof HttpError ? error.message : 'Gerrie is even niet bereikbaar door een serverfout.';
    return json(req, { error: publicMessage }, status as HttpStatus);
  }
});

// ── SSE-stream ───────────────────────────────────────────────────────────────
function streamResponse(req: Request, work: (emit: Emit) => Promise<void>): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const emit: Emit = async (event, data) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  (async () => {
    try {
      await work(emit);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : 'Gerrie liep ergens vast. Probeer het opnieuw.';
      console.error('gerrie-agent stream error', describeError(error));
      try { await emit('error', { message }); } catch { /* stream al dicht */ }
    } finally {
      try { await writer.close(); } catch { /* al gesloten */ }
    }
  })();
  return new Response(readable, {
    headers: { ...corsHeaders(req), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
  });
}

// ── CORS + origin-helpers ────────────────────────────────────────────────────
function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = GERRIE_ALLOWED_ORIGINS.includes(origin) || (GERRIE_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
    ? origin : GERRIE_ALLOW_LOCAL_DEV && !origin ? '*' : 'null';
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
function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';
  if (!origin && GERRIE_ALLOW_LOCAL_DEV) return;
  if (GERRIE_ALLOWED_ORIGINS.includes(origin)) return;
  if (GERRIE_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (GERRIE_ALLOWED_ORIGINS.length === 0 && GERRIE_ALLOW_LOCAL_DEV) return;
  if (GERRIE_ALLOWED_ORIGINS.length === 0) throw new HttpError('GERRIE_ALLOWED_ORIGINS of APP_PUBLIC_URL is verplicht in productie.', 500);
  throw new HttpError('Deze frontend-origin is niet toegestaan voor gerrie-agent.', 403);
}
function isLocalOrigin(origin: string): boolean { return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); }
