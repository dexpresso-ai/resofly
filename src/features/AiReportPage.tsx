import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertTriangle, Check, ChevronDown, Database, Download, History, MessageSquare, Pencil, RefreshCw, RotateCcw, Send, Sparkles, Trash2, X,
} from 'lucide-react';
import { Button } from '../components/Ui';
import { ReportFrame } from '../components/ReportFrame';
import { ReportBuilding, ReportUpdating } from '../components/ReportBuilding';
import { downloadCsv } from '../lib/csv';
import { loadGerrieBudget } from '../lib/gerrie-api';
import {
  clearReportChat, datasetCsvRows, deleteAiReport, getAiReport, getReportChat, listAiReportMessages, listAiReportVersions, loadAiReportData,
  NEW_REPORT_PREFIX, renameAiReport, restoreAiReportVersion, startReportChat, useReportChat,
  type AiReport, type AiReportMessage, type AiReportVersion, type DatasetResult, type ReportData,
} from '../lib/aiReports';
import type { UUID } from '../types';

/**
 * Eén rapportage van Gerrie, als eigen pagina.
 *
 * Links de rapportage zelf (in een afgeschermd kader, met de actuele cijfers),
 * rechts het gesprek waarmee je hem aanpast. Openen en verversen halen alleen de
 * gegevens opnieuw op en kosten geen AI-tegoed; elke vraag aan Gerrie wel, en
 * dat staat er per beurt bij.
 */

const SUGGESTIONS = [
  'Zet er vorig jaar naast ter vergelijking',
  'Maak er een lijngrafiek van',
  'Laat alleen de top 10 zien',
  'Voeg een tabel met de details toe',
];

const TOOL_LABEL: Record<string, string> = {
  query_records: 'Gegevens', list_invoices: 'Facturen', list_quotes: 'Offertes', search_clients: 'Klanten',
  list_projects: 'Projecten', list_tasks: 'Taken', list_tickets: 'Tickets', list_time_entries: 'Uren',
  get_financial_summary: 'Financieel overzicht', list_purchase_invoices: 'Inkoopfacturen', list_bank_transactions: 'Banktransacties',
  list_journal_entries: 'Journaalposten', list_ledger_accounts: 'Grootboek', list_contracts: 'Contracten',
};

function sourceLabel(d: DatasetResult): string {
  if (d.tool.startsWith('action:')) return 'Handeling';
  return TOOL_LABEL[d.tool] ?? 'Gegevens';
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function usageNote(fraction: number | null | undefined): string | null {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0) return null;
  const pct = fraction * 100;
  return `≈ ${pct < 0.1 ? '< 0,1' : pct.toLocaleString('nl-NL', { maximumFractionDigits: pct < 10 ? 1 : 0 })}% van je AI-tegoed`;
}

export function AiReportPage({ organizationId, reportKey, canChat, onOpenOverview, onDeleted }: {
  organizationId: UUID;
  /** Het id van de rapportage, of een tijdelijke sleutel ("nieuw:…") zolang Gerrie hem nog aanmaakt. */
  reportKey: string;
  canChat: boolean;
  onOpenOverview: () => void;
  onDeleted: () => void;
}) {
  const isTemp = reportKey.startsWith(NEW_REPORT_PREFIX);
  const session = useReportChat(reportKey);
  const reportId: UUID | null = isTemp ? (session?.reportId ?? null) : reportKey;

  const [report, setReport] = useState<AiReport | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiReportMessage[]>([]);
  const [data, setData] = useState<ReportData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [versions, setVersions] = useState<AiReportVersion[] | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [preview, setPreview] = useState<{ version: number; html: string; data: ReportData } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [budget, setBudget] = useState<number | null>(null);
  // Net een nieuwe versie binnen: die komt even met een gloed tevoorschijn.
  const [fresh, setFresh] = useState(false);
  const msgsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const handledDone = useRef<unknown>(null);
  // Of deze pagina al gegevens heeft (bijv. meegekomen met het antwoord van Gerrie):
  // dan hoeft het openen ze niet nog eens op te halen.
  const hasData = useRef(false);

  const loadReport = useCallback(async (id: UUID) => {
    setLoadError(null);
    try {
      const [row, msgs] = await Promise.all([getAiReport(organizationId, id), listAiReportMessages(organizationId, id)]);
      if (!row) { setMissing(true); return null; }
      setMissing(false);
      setReport(row);
      setMessages(msgs);
      return row;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Laden mislukt.');
      return null;
    }
  }, [organizationId]);

  const loadData = useCallback(async (id: UUID) => {
    setDataLoading(true); setDataError(null);
    try {
      setData(await loadAiReportData(organizationId, id));
      hasData.current = true;
      setFrameError(null);
    } catch (e) {
      setDataError(e instanceof Error ? e.message : 'De gegevens konden niet worden opgehaald.');
    } finally { setDataLoading(false); }
  }, [organizationId]);

  // Openen: de rapportage, het gesprek en (als er al inhoud is) de actuele gegevens.
  // Niet als Gerrie nog bezig is of de gegevens net meegaf: die staan er dan al
  // (of komen zo). De sessie lezen we hier vers uit de store; de waarde uit de
  // render kan al verouderd zijn, en dan haalde de pagina alles dubbel op.
  useEffect(() => {
    if (!reportId) return;
    let cancelled = false;
    void (async () => {
      const row = await loadReport(reportId);
      const latest = getReportChat(reportKey) ?? getReportChat(reportId);
      if (!cancelled && row && row.version > 0 && !latest?.running && !latest?.done?.data && !hasData.current) await loadData(reportId);
    })();
    return () => { cancelled = true; };
  }, [reportId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canChat) return;
    let cancelled = false;
    void loadGerrieBudget(organizationId).then((f) => { if (!cancelled) setBudget(f); });
    return () => { cancelled = true; };
  }, [organizationId, canChat]);

  // Een beurt is klaar: de nieuwe versie en (als Gerrie ze al ophaalde) de gegevens erbij.
  useEffect(() => {
    const done = session?.done;
    if (!done || handledDone.current === done) return;
    handledDone.current = done;
    if (done.budget) setBudget(done.budget.remainingFraction);
    const id = done.reportId ?? reportId;
    if (!id) return;
    if (done.report) setReport({ ...done.report, datasets: Array.isArray(done.report.datasets) ? done.report.datasets : [] });
    if (done.data) { setData(done.data); hasData.current = true; setFrameError(null); }
    if (done.changed) setFresh(true);
    setPreview(null);
    setVersions(null);
    void listAiReportMessages(organizationId, id).then((msgs) => {
      setMessages(msgs);
      clearReportChat(session?.key);
    }).catch(() => undefined);
    if (done.changed && !done.data) void loadData(id);
  }, [session?.done]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!fresh) return;
    const timer = window.setTimeout(() => setFresh(false), 1800);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, session?.streamed, session?.status, session?.running]);

  function send(text: string, withFrameError = false) {
    const message = text.trim();
    if (!message || !canChat) return;
    if (session?.running) { setNotice('Gerrie is nog bezig; wacht even tot hij klaar is.'); return; }
    // Een rapportage die nog geen id heeft (aanmaken mislukte): niet stil een tweede aanmaken.
    if (isTemp && !reportId) { setNotice('Deze rapportage is nog niet aangemaakt. Stel je vraag opnieuw vanaf het overzicht.'); return; }
    try {
      startReportChat({ organizationId, reportId, message, frameError: withFrameError ? frameError : null });
      setDraft('');
      setNotice(null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Versturen lukte niet.');
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); }
  }

  async function saveName() {
    if (!report) return;
    const next = nameDraft.trim();
    if (!next || next === report.title) { setRenaming(false); return; }
    setBusy(true);
    try {
      await renameAiReport(organizationId, report.id, next);
      setReport({ ...report, title: next });
      setRenaming(false);
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Hernoemen lukte niet.'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!report) return;
    if (!window.confirm(`Rapportage "${report.title}" verwijderen? De pagina, de versies en het gesprek verdwijnen. Het AI-tegoed dat hij kostte, komt niet terug.`)) return;
    setBusy(true);
    try {
      await deleteAiReport(organizationId, report.id);
      onDeleted();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Verwijderen lukte niet.'); setBusy(false); }
  }

  async function toggleVersions() {
    const next = !versionsOpen;
    setVersionsOpen(next);
    if (next && report && versions === null) {
      try { setVersions(await listAiReportVersions(organizationId, report.id)); }
      catch (e) { setNotice(e instanceof Error ? e.message : 'De versies konden niet worden geladen.'); }
    }
  }

  async function showVersion(version: number) {
    if (!report) return;
    setVersionsOpen(false);
    if (version === report.version) { setPreview(null); return; }
    setBusy(true);
    try {
      const result = await loadAiReportData(organizationId, report.id, version);
      setPreview({ version, html: result.html ?? '', data: result });
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Deze versie kon niet worden getoond.'); }
    finally { setBusy(false); }
  }

  async function restore(version: number) {
    if (!report) return;
    setBusy(true);
    try {
      await restoreAiReportVersion(organizationId, report.id, version);
      setPreview(null);
      setVersions(null);
      const row = await loadReport(report.id);
      if (row) await loadData(row.id);
      setNotice(`Versie ${version} staat weer op de pagina (als nieuwe versie ${row?.version ?? ''}).`);
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Terugzetten lukte niet.'); }
    finally { setBusy(false); }
  }

  function exportDataset(d: DatasetResult) {
    const table = datasetCsvRows(d.data);
    if (!table) return;
    const name = `${(report?.title || 'rapportage').replace(/[^\w-]+/g, '-').toLowerCase()}-${d.key}.csv`;
    downloadCsv(name, table.header, table.rows);
  }

  // ── Wat er te zien is ────────────────────────────────────────────────────
  if (missing || (isTemp && !session)) {
    return (
      <div className="empty">
        <div className="e-big">Deze rapportage bestaat niet (meer)</div>
        <p>Misschien is hij verwijderd, of hoort hij bij een andere gebruiker. Rapportages zijn alleen zichtbaar voor wie ze maakte.</p>
        <Button onClick={onOpenOverview}>Naar je rapportages</Button>
      </div>
    );
  }

  const running = Boolean(session?.running);
  const title = report?.title ?? (session?.question ? session.question.slice(0, 80) : 'Nieuwe rapportage');
  const shownHtml = preview ? preview.html : report?.html ?? '';
  const shownData = preview ? preview.data : data;
  const hasContent = Boolean(shownHtml);
  const datasets = shownData?.datasets ?? [];
  const lowBudget = budget !== null && budget <= 0.2;

  const chat = (
    <aside className={`aire-chat${chatOpen ? ' is-open' : ''}`} aria-label="Rapportage aanpassen met Gerrie">
      <header className="aire-chat-head">
        <span className="aire-chat-avatar" aria-hidden="true"><Sparkles size={15} /></span>
        <div>
          <div className="aire-chat-title">Aanpassen met Gerrie</div>
          <div className="aire-chat-sub">Vraag in gewone taal wat er anders moet.</div>
        </div>
        <button type="button" className="aire-chat-close" onClick={() => setChatOpen(false)} aria-label="Gesprek sluiten"><X size={16} /></button>
      </header>
      <div className="aire-msgs" ref={msgsRef}>
        {messages.length === 0 && !running && (
          <p className="aire-msgs-empty">Nog geen gesprek. Stel hieronder je vraag; Gerrie bouwt er een pagina van die altijd de actuele cijfers toont.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`aire-msg ${m.role}`}>
            <div className="aire-bubble">{m.content}</div>
            {m.role === 'assistant' && (m.version || usageNote(m.usage_fraction)) && (
              <div className="aire-msg-meta">
                {m.version ? <span className="aire-chip">versie {m.version}</span> : null}
                {usageNote(m.usage_fraction) && <span>{usageNote(m.usage_fraction)}</span>}
              </div>
            )}
          </div>
        ))}
        {session && (running || session.error) && (
          <>
            <div className="aire-msg user"><div className="aire-bubble">{session.question}</div></div>
            {session.streamed && <div className="aire-msg assistant"><div className="aire-bubble">{session.streamed}</div></div>}
            {running && (
              <div className="aire-msg assistant">
                <div className="aire-bubble aire-status" role="status"><span className="aire-dots" aria-hidden="true"><i /><i /><i /></span>{session.status ?? 'Gerrie denkt na…'}</div>
              </div>
            )}
            {session.error && <div className="aire-msg assistant"><div className="aire-bubble is-error">⚠️ {session.error}</div></div>}
          </>
        )}
      </div>
      {frameError && canChat && !running && (
        <div className="aire-fix">
          <AlertTriangle size={14} />
          <span>De pagina gaf een fout bij het tonen.</span>
          <button type="button" onClick={() => send('De rapportage geeft een fout bij het tonen. Kun je die oplossen?', true)}>Laat Gerrie het oplossen</button>
        </div>
      )}
      {canChat ? (
        <>
          {messages.length <= 2 && !running && hasContent && (
            <div className="aire-suggest">
              {SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => send(s)}>{s}</button>)}
            </div>
          )}
          {notice && <p className="aire-notice" role="status">{notice}</p>}
          <div className="aire-composer">
            <textarea
              ref={inputRef}
              rows={2}
              value={draft}
              placeholder={running ? 'Gerrie is bezig…' : hasContent ? 'Wat moet er anders?' : 'Wat wil je in deze rapportage zien?'}
              onChange={(e) => setDraft(e.target.value.slice(0, 4000))}
              onKeyDown={onKeyDown}
              disabled={running}
              aria-label="Bericht aan Gerrie"
            />
            <button type="button" className="aire-send" onClick={() => send(draft)} disabled={running || !draft.trim()} aria-label="Versturen"><Send size={16} /></button>
          </div>
          <div className="aire-budget" role="status" aria-label="Resterend AI-tegoed deze maand">
            {budget !== null && (
              <>
                <span>AI-tegoed</span>
                <span className="aire-budget-track"><span className="aire-budget-fill" data-low={lowBudget ? 'true' : 'false'} style={{ width: `${Math.round(budget * 100)}%` }} /></span>
                <span className="aire-budget-pct">{Math.round(budget * 100)}%</span>
              </>
            )}
          </div>
          <p className="aire-foot">Aanpassen via de chat kost AI-tegoed. Openen en verversen niet.</p>
        </>
      ) : (
        <p className="aire-foot">Je hebt geen toegang tot Gerrie, dus aanpassen via de chat kan niet. Bekijken en verversen wel.</p>
      )}
    </aside>
  );

  return (
    <div className="aire-page">
      <div className="aire-main">
        <header className="aire-head">
          <div className="aire-head-text">
            {renaming && report ? (
              <form className="aire-rename" onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
                <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={120} autoFocus aria-label="Naam van de rapportage" />
                <button type="submit" disabled={busy} aria-label="Naam opslaan"><Check size={15} /></button>
                <button type="button" onClick={() => setRenaming(false)} aria-label="Annuleren"><X size={15} /></button>
              </form>
            ) : (
              <h2>
                <span>{title}</span>
                {report && <button type="button" className="aire-icon-btn" onClick={() => { setNameDraft(report.title); setRenaming(true); }} aria-label="Naam wijzigen" title="Naam wijzigen"><Pencil size={14} /></button>}
              </h2>
            )}
            {report?.summary && <p>{report.summary}</p>}
            <div className="aire-meta">
              {report && report.version > 0 && <span>Versie {report.version}</span>}
              {report && <span>Bijgewerkt {formatWhen(report.updated_at)}</span>}
              {shownData?.fetchedAt && <span>Cijfers van {formatWhen(shownData.fetchedAt)}</span>}
              <span className="aire-private">Alleen zichtbaar voor jou</span>
            </div>
          </div>
          <div className="aire-actions">
            <Button onClick={() => reportId && void loadData(reportId)} disabled={!report || report.version === 0 || dataLoading || running} title="Haalt de cijfers opnieuw op. Kost geen AI-tegoed.">
              <RefreshCw size={14} className={dataLoading ? 'aire-spin' : undefined} /> Verversen
            </Button>
            <div className="aire-versions">
              <Button onClick={() => void toggleVersions()} disabled={!report || report.version < 2} aria-expanded={versionsOpen}>
                <History size={14} /> Versies <ChevronDown size={13} />
              </Button>
              {versionsOpen && versions && (
                <div className="aire-versions-menu" role="menu">
                  {versions.map((v) => (
                    <button key={v.version} type="button" role="menuitem" onClick={() => void showVersion(v.version)} className={(preview?.version ?? report?.version) === v.version ? 'is-active' : ''}>
                      <b>Versie {v.version}{v.version === report?.version ? ' · huidig' : ''}</b>
                      <span>{v.request ? v.request.slice(0, 90) : v.title}</span>
                      <em>{formatWhen(v.created_at)}</em>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button variant="danger" onClick={() => void remove()} disabled={!report || busy || running}><Trash2 size={14} /> Verwijderen</Button>
            <Button className="aire-chat-toggle" onClick={() => setChatOpen(true)}><MessageSquare size={14} /> Gerrie</Button>
          </div>
        </header>

        {notice && !canChat && <div className="error">{notice}</div>}
        {loadError && <div className="error">{loadError}</div>}

        {preview && (
          <div className="aire-preview-bar" role="status">
            <span>Je bekijkt versie {preview.version}. De pagina zelf staat nog op versie {report?.version}.</span>
            <Button variant="primary" onClick={() => void restore(preview.version)} disabled={busy}><RotateCcw size={14} /> Deze versie terugzetten</Button>
            <Button onClick={() => setPreview(null)}>Terug naar de huidige</Button>
          </div>
        )}

        {!hasContent && running && session ? (
          <ReportBuilding status={session.status} phase={session.phase} startedAt={session.startedAt} />
        ) : !hasContent ? (
          <div className="aire-placeholder">
            <Sparkles size={22} />
            {session?.error ? (
              <>
                <b>Dit lukte nog niet</b>
                <span>{session.error}</span>
                {canChat && <Button variant="primary" onClick={() => send(session.question)}>Opnieuw vragen</Button>}
              </>
            ) : session?.done?.blocked ? (
              <>
                <b>Geen AI-tegoed meer</b>
                <span>{session.done.text}</span>
              </>
            ) : (
              <>
                <b>Nog geen inhoud</b>
                <span>Vertel Gerrie in het gesprek wat je in deze rapportage wilt zien.</span>
              </>
            )}
          </div>
        ) : dataError && !preview ? (
          <div className="aire-placeholder">
            <AlertTriangle size={20} />
            <b>De cijfers konden niet worden opgehaald</b>
            <span>{dataError}</span>
            <Button onClick={() => reportId && void loadData(reportId)}>Opnieuw proberen</Button>
          </div>
        ) : !shownData ? (
          <div className="aire-placeholder is-busy"><RefreshCw size={20} className="aire-spin" /><b>Cijfers ophalen…</b><span>Dit kost geen AI-tegoed.</span></div>
        ) : (
          <div className={`aire-live${running && !preview ? ' is-updating' : ''}${fresh ? ' is-fresh' : ''}`}>
            {running && !preview && session && (
              <>
                <ReportUpdating status={session.status} phase={session.phase} startedAt={session.startedAt} />
                <span className="aire-live-veil" aria-hidden="true" />
              </>
            )}
            <ReportFrame html={shownHtml} data={shownData} title={title} onError={setFrameError} />
          </div>
        )}

        {hasContent && datasets.length > 0 && (
          <details className="aire-sources">
            <summary><Database size={14} /> Bronnen ({datasets.length}) — waar deze cijfers vandaan komen</summary>
            <ul>
              {datasets.map((d) => (
                <li key={d.key}>
                  <div>
                    <b>{d.label}</b>
                    <span>{sourceLabel(d)}{d.rows !== null ? ` · ${d.rows.toLocaleString('nl-NL')} regel${d.rows === 1 ? '' : 's'}` : ''}</span>
                    {d.truncated && <span className="aire-warn">Niet alle regels zijn meegenomen; kies een kortere periode.</span>}
                    {!d.ok && <span className="aire-warn">{d.error}</span>}
                  </div>
                  {d.ok && datasetCsvRows(d.data) && <button type="button" onClick={() => exportDataset(d)}><Download size={13} /> CSV</button>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {chat}
      {chatOpen && <button type="button" className="aire-scrim" aria-label="Gesprek sluiten" onClick={() => setChatOpen(false)} />}
    </div>
  );
}
