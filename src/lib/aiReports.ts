import { useEffect, useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { rememberReportTitle } from './aiReportTitles';
import type { UUID } from '../types';

/**
 * Rapportages van Gerrie: elke vraag wordt een eigen pagina, alleen van jou.
 *
 * Lezen, hernoemen, verwijderen en een oude versie terugzetten gaan rechtstreeks
 * naar de database, met jouw sessie (RLS: alleen je eigen rapportages, en alleen
 * met leesrecht op Statistieken). De chat en het ophalen van de gegevens gaan via
 * gerrie-agent: die draait de lees-endpoints met jouw rechten.
 *
 * De chat loopt in een eigen "sessie" buiten de React-componenten. Ga je tijdens
 * het bouwen naar een andere pagina en weer terug, dan loopt hij gewoon door en
 * zie je waar Gerrie is; anders verdween het antwoord (en het tegoed dat het kostte).
 */

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface ReportDatasetSpec { key: string; label: string; tool: string; input: Record<string, unknown> }
export interface AiReportMeta {
  id: UUID;
  title: string;
  summary: string | null;
  version: number;
  updated_at: string;
  created_at: string;
}
export interface AiReport extends AiReportMeta { html: string; datasets: ReportDatasetSpec[] }
export interface AiReportMessage {
  id: UUID;
  role: 'user' | 'assistant';
  content: string;
  version: number | null;
  usage_fraction: number | null;
  created_at: string;
}
export interface AiReportVersion { version: number; title: string; request: string | null; created_at: string }
export interface DatasetResult {
  key: string;
  label: string;
  tool: string;
  ok: boolean;
  data: unknown;
  rows: number | null;
  truncated: boolean;
  error?: string;
}
export interface ReportData { reportId?: UUID; version?: number; fetchedAt: string; today: string; datasets: DatasetResult[]; html?: string }

const META_COLUMNS = 'id, title, summary, version, updated_at, created_at';

function fail(message: string, error: { message?: string } | null): never {
  throw new Error(error?.message ? `${message} (${error.message})` : message);
}

export async function listAiReports(organizationId: UUID): Promise<AiReportMeta[]> {
  const { data, error } = await supabase.from('ai_reports').select(META_COLUMNS)
    .eq('organization_id', organizationId).order('updated_at', { ascending: false }).limit(200);
  if (error) fail('De rapportages konden niet worden geladen.', error);
  const rows = (data ?? []) as AiReportMeta[];
  for (const r of rows) rememberReportTitle(r.id, r.title);
  return rows;
}

export async function getAiReport(organizationId: UUID, id: UUID): Promise<AiReport | null> {
  const { data, error } = await supabase.from('ai_reports').select(`${META_COLUMNS}, html, datasets`)
    .eq('organization_id', organizationId).eq('id', id).maybeSingle();
  if (error) fail('De rapportage kon niet worden geladen.', error);
  if (!data) return null;
  const report = { ...(data as AiReport), datasets: Array.isArray((data as AiReport).datasets) ? (data as AiReport).datasets : [] };
  rememberReportTitle(report.id, report.title);
  return report;
}

export async function listAiReportMessages(organizationId: UUID, reportId: UUID): Promise<AiReportMessage[]> {
  const { data, error } = await supabase.from('ai_report_messages').select('id, role, content, version, usage_fraction, created_at')
    .eq('organization_id', organizationId).eq('report_id', reportId).order('created_at', { ascending: true }).limit(200);
  if (error) fail('Het gesprek kon niet worden geladen.', error);
  return ((data ?? []) as AiReportMessage[]).map((m) => ({ ...m, usage_fraction: m.usage_fraction === null ? null : Number(m.usage_fraction) }));
}

export async function listAiReportVersions(organizationId: UUID, reportId: UUID): Promise<AiReportVersion[]> {
  const { data, error } = await supabase.from('ai_report_versions').select('version, title, request, created_at')
    .eq('organization_id', organizationId).eq('report_id', reportId).order('version', { ascending: false }).limit(50);
  if (error) fail('De versies konden niet worden geladen.', error);
  return (data ?? []) as AiReportVersion[];
}

export async function renameAiReport(organizationId: UUID, id: UUID, title: string): Promise<void> {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) throw new Error('Geef de rapportage een naam.');
  const { error } = await supabase.from('ai_reports').update({ title: clean }).eq('organization_id', organizationId).eq('id', id);
  if (error) fail('Hernoemen lukte niet.', error);
  rememberReportTitle(id, clean);
  void refreshAiReportList(organizationId);
}

export async function deleteAiReport(organizationId: UUID, id: UUID): Promise<void> {
  const { error, count } = await supabase.from('ai_reports').delete({ count: 'exact' }).eq('organization_id', organizationId).eq('id', id);
  if (error) fail('Verwijderen lukte niet.', error);
  if (count === 0) throw new Error('Deze rapportage bestaat niet (meer), of je mag hem niet verwijderen.');
  void refreshAiReportList(organizationId);
}

/**
 * Een oudere versie terugzetten: die inhoud wordt de nieuwe, nieuwste versie.
 * Zo blijft ook de versie die je wegzet bewaard, en kun je terug.
 */
export async function restoreAiReportVersion(organizationId: UUID, id: UUID, version: number): Promise<void> {
  const { data, error } = await supabase.from('ai_report_versions').select('title, summary, html, datasets')
    .eq('organization_id', organizationId).eq('report_id', id).eq('version', version).maybeSingle();
  if (error) fail('Deze versie kon niet worden geladen.', error);
  if (!data) throw new Error('Deze versie bestaat niet (meer).');
  const { error: updateError } = await supabase.from('ai_reports').update({
    title: data.title, summary: data.summary, html: data.html, datasets: data.datasets,
    last_request: `Versie ${version} teruggezet`,
  }).eq('organization_id', organizationId).eq('id', id);
  if (updateError) fail('Terugzetten lukte niet.', updateError);
  void refreshAiReportList(organizationId);
}

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const value = data.session?.access_token;
  if (!value) throw new Error('Je sessie is verlopen. Log opnieuw in.');
  return value;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try { const payload = await res.json(); if (payload?.error) return String(payload.error); } catch { /* geen JSON */ }
  return fallback;
}

/** De gegevens van een rapportage (of een oudere versie) opnieuw ophalen. Kost geen AI-tegoed. */
export async function loadAiReportData(organizationId: UUID, reportId: UUID, version?: number): Promise<ReportData> {
  const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}`, apikey: ANON_KEY },
    body: JSON.stringify({ action: 'report_data', organizationId, reportId, ...(version ? { version } : {}) }),
  });
  if (!res.ok) throw new Error(await readError(res, 'De gegevens konden niet worden opgehaald.'));
  const payload = await res.json() as ReportData;
  return { ...payload, datasets: Array.isArray(payload.datasets) ? payload.datasets : [] };
}

// ── De lijst (zijbalk, tabbladtitels, overzicht) ─────────────────────────────

interface ListState { organizationId: UUID | null; reports: AiReportMeta[]; loaded: boolean; error: string | null }
let listState: ListState = { organizationId: null, reports: [], loaded: false, error: null };
const listListeners = new Set<() => void>();
let listRequest = 0;

function setList(next: ListState) {
  listState = next;
  for (const fn of listListeners) fn();
}

export async function refreshAiReportList(organizationId: UUID): Promise<void> {
  const request = ++listRequest;
  if (listState.organizationId !== organizationId) setList({ organizationId, reports: [], loaded: false, error: null });
  try {
    const reports = await listAiReports(organizationId);
    if (request === listRequest) setList({ organizationId, reports, loaded: true, error: null });
  } catch (e) {
    if (request === listRequest) setList({ ...listState, organizationId, loaded: true, error: e instanceof Error ? e.message : 'Laden mislukt.' });
  }
}

/** De rapportages van deze gebruiker in deze organisatie; laadt één keer per organisatie. */
export function useAiReportList(organizationId: UUID | null, enabled: boolean): ListState {
  const state = useSyncExternalStore(
    (fn) => { listListeners.add(fn); return () => { listListeners.delete(fn); }; },
    () => listState,
  );
  useEffect(() => {
    // Eén keer per organisatie; daarna ververst elke wijziging de lijst zelf.
    if (enabled && organizationId && listState.organizationId !== organizationId) void refreshAiReportList(organizationId);
  }, [enabled, organizationId]);
  return enabled && state.organizationId === organizationId ? state : { organizationId, reports: [], loaded: !enabled, error: null };
}

// ── De chat ─────────────────────────────────────────────────────────────────

export interface ReportChatDone {
  reportId: UUID | null;
  version: number | null;
  text: string;
  changed?: boolean;
  blocked?: boolean;
  report?: AiReport;
  data?: ReportData | null;
  usedFraction?: number | null;
  budget?: { remainingFraction: number };
}
export interface ReportChatState {
  key: string;
  reportId: UUID | null;
  running: boolean;
  question: string;
  status: string | null;
  streamed: string;
  error: string | null;
  done: ReportChatDone | null;
  startedAt: number;
}

const sessions = new Map<string, ReportChatState>();
const sessionListeners = new Map<string, Set<() => void>>();
const createdListeners = new Set<(key: string, reportId: UUID) => void>();
let sessionSeq = 0;

function notify(state: ReportChatState) {
  for (const key of new Set([state.key, state.reportId ?? ''])) {
    for (const fn of sessionListeners.get(key) ?? []) fn();
  }
}
function patch(state: ReportChatState, next: Partial<ReportChatState>) {
  const updated = { ...state, ...next };
  sessions.set(updated.key, updated);
  if (updated.reportId) sessions.set(updated.reportId, updated);
  notify(updated);
  return updated;
}

export function getReportChat(key: string | null | undefined): ReportChatState | null {
  return key ? sessions.get(key) ?? null : null;
}
export function subscribeReportChat(key: string, fn: () => void): () => void {
  const set = sessionListeners.get(key) ?? new Set();
  set.add(fn);
  sessionListeners.set(key, set);
  return () => { set.delete(fn); };
}
export function useReportChat(key: string | null): ReportChatState | null {
  return useSyncExternalStore(
    (fn) => (key ? subscribeReportChat(key, fn) : () => {}),
    () => getReportChat(key),
  );
}
/** Een nieuwe rapportage kreeg zijn id: het tabblad kan van de tijdelijke sleutel naar het echte id. */
export function onReportCreated(fn: (key: string, reportId: UUID) => void): () => void {
  createdListeners.add(fn);
  return () => { createdListeners.delete(fn); };
}
export const NEW_REPORT_PREFIX = 'nieuw:';

/**
 * Start een chatbeurt. Zonder reportId maakt Gerrie een nieuwe rapportage; de
 * teruggegeven sleutel is dan tijdelijk ("nieuw:…") tot het echte id binnen is.
 */
export function startReportChat(opts: { organizationId: UUID; reportId: UUID | null; message: string; frameError?: string | null }): string {
  const running = opts.reportId ? sessions.get(opts.reportId) : null;
  if (running?.running) throw new Error('Gerrie is nog bezig met deze rapportage.');
  const key = opts.reportId ?? `${NEW_REPORT_PREFIX}${Date.now().toString(36)}${(++sessionSeq).toString(36)}`;
  let state: ReportChatState = {
    key, reportId: opts.reportId, running: true, question: opts.message, status: 'Gerrie denkt na…',
    streamed: '', error: null, done: null, startedAt: Date.now(),
  };
  sessions.set(key, state);
  notify(state);
  void (async () => {
    try {
      const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}`, apikey: ANON_KEY },
        body: JSON.stringify({ action: 'report_chat', organizationId: opts.organizationId, reportId: opts.reportId, message: opts.message, frameError: opts.frameError ?? null }),
      });
      if (!res.ok || !res.body) throw new Error(await readError(res, 'Gerrie is even niet bereikbaar. Probeer het zo opnieuw.'));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const parsed = parseSse(block);
          if (!parsed) continue;
          const payload = parsed.data as Record<string, unknown>;
          if (parsed.event === 'status') state = patch(state, { status: String(payload.label ?? '') || state.status });
          else if (parsed.event === 'delta') state = patch(state, { streamed: state.streamed + String(payload.text ?? '') });
          else if (parsed.event === 'report') {
            const report = payload.report as AiReport | undefined;
            if (report?.id) {
              rememberReportTitle(report.id, report.title);
              state = patch(state, { reportId: report.id });
              for (const fn of createdListeners) fn(key, report.id);
              void refreshAiReportList(opts.organizationId);
            }
          } else if (parsed.event === 'done') {
            const done = payload as unknown as ReportChatDone;
            if (done.report?.id) rememberReportTitle(done.report.id, done.report.title);
            finished = true;
            state = patch(state, { running: false, status: null, done, reportId: done.reportId ?? state.reportId });
          } else if (parsed.event === 'error') {
            throw new Error(String(payload.message ?? 'Gerrie liep ergens vast. Probeer het opnieuw.'));
          }
        }
      }
      if (!finished) throw new Error('De verbinding met Gerrie viel weg voordat hij klaar was. Kijk of de rapportage is bijgewerkt, of probeer het opnieuw.');
    } catch (e) {
      state = patch(state, { running: false, status: null, error: e instanceof Error ? e.message : 'Er ging iets mis.' });
    } finally {
      void refreshAiReportList(opts.organizationId);
    }
  })();
  return key;
}

function parseSse(block: string): { event: string; data: unknown } | null {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

/** Een afgeronde sessie opruimen, zodat een volgende beurt schoon begint. */
export function clearReportChat(key: string | null | undefined): void {
  if (!key) return;
  const state = sessions.get(key);
  if (!state || state.running) return;
  sessions.delete(state.key);
  if (state.reportId) sessions.delete(state.reportId);
  notify({ ...state, running: false });
}

/** Een CSV van één dataset (de hoofdlijst), voor wie de cijfers zelf wil narekenen. */
export function datasetCsvRows(data: unknown): { header: string[]; rows: (string | number)[][] } | null {
  let list: unknown[] | null = null;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value) && (!list || value.length > list.length)) list = value;
    }
  }
  if (!list || list.length === 0) return null;
  const objects = list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  if (!objects.length) return null;
  const header = [...new Set(objects.flatMap((r) => Object.keys(r)))]
    .filter((k) => objects.some((r) => r[k] === null || ['string', 'number', 'boolean'].includes(typeof r[k])));
  // Getallen blijven getallen: downloadCsv zet ze in de Nederlandse notatie.
  const cell = (v: unknown): string | number => (v === null || v === undefined ? '' : typeof v === 'number' ? v : String(v));
  return { header, rows: objects.map((r) => header.map((k) => cell(r[k]))) };
}
