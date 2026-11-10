import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BarChart3, FileBarChart, LayoutGrid, Send, Sparkles, Trash2 } from 'lucide-react';
import type { AppData } from '../types';
import type { ReportDefinition } from '../lib/reporting';
import { PageIcon } from '../components/PageIcon';
import { Statistics } from './Statistics';
import { loadGerrieBudget } from '../lib/gerrie-api';
import { deleteAiReport, startReportChat, useAiReportList, type AiReportMeta } from '../lib/aiReports';
import type { UUID } from '../types';

/**
 * Rapportages — de business intelligence van ResoFly.
 *
 * Bovenaan vraag je Gerrie om een overzicht. Elke vraag wordt een eigen pagina
 * (alleen zichtbaar voor jou) die bij het openen de actuele cijfers ophaalt.
 * Daaronder je rapportages. De vaste rapportbouwer van voorheen staat op het
 * tweede tabblad: de rapporten die op het dashboard zijn vastgezet, en de
 * rapportages die Gerrie in de gewone chat klaarzet, openen daar.
 */

const SUGGESTIONS = [
  'Omzet per maand dit jaar, naast vorig jaar',
  'Welke klanten leveren dit jaar het meest op?',
  'Uren per project deze maand, declarabel en niet-declarabel',
  'Openstaande facturen per klant, met wat te laat is',
  'Offerteconversie per kwartaal',
  'Kosten per leverancier dit jaar',
];

type Mode = 'ai' | 'builder';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function Reports({ data, organizationId, canWrite, canChat, onChanged, openReportId, pendingReport, onOpenReport, onNewReport }: {
  data: AppData;
  organizationId: UUID;
  /** Schrijfrecht op Statistieken: voor de rapportbouwer (gedeelde rapporten). */
  canWrite: boolean;
  /** Toegang tot Gerrie: vragen stellen kost AI-tegoed en loopt via Gerrie. */
  canChat: boolean;
  onChanged: () => void | Promise<void>;
  openReportId?: string | null;
  pendingReport?: { key: string; name: string; definition: ReportDefinition } | null;
  onOpenReport: (id: UUID) => void;
  onNewReport: (key: string) => void;
}) {
  const builderContext = Boolean(openReportId || pendingReport);
  const [mode, setMode] = useState<Mode>(builderContext ? 'builder' : 'ai');
  useEffect(() => { if (builderContext) setMode('builder'); }, [builderContext, pendingReport?.key, openReportId]);

  const list = useAiReportList(organizationId, canChat);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!canChat || mode !== 'ai') return;
    let cancelled = false;
    void loadGerrieBudget(organizationId).then((f) => { if (!cancelled) setBudget(f); });
    return () => { cancelled = true; };
  }, [organizationId, canChat, mode]);

  function ask(text: string) {
    const message = text.trim();
    if (!message) { inputRef.current?.focus(); return; }
    if (message.length > 4000) { setError('Je vraag is te lang; houd hem onder de 4000 tekens.'); return; }
    try {
      const key = startReportChat({ organizationId, reportId: null, message });
      setQuestion('');
      setError(null);
      onNewReport(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Versturen lukte niet.');
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(question); }
  }

  async function remove(report: AiReportMeta) {
    if (!window.confirm(`Rapportage "${report.title}" verwijderen? De pagina, de versies en het gesprek verdwijnen. Het AI-tegoed dat hij kostte, komt niet terug.`)) return;
    setDeleting(report.id);
    try { await deleteAiReport(organizationId, report.id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Verwijderen lukte niet.'); }
    finally { setDeleting(null); }
  }

  const tabs = (
    <div className="bk-seg aire-mode" role="tablist" aria-label="Soort rapportage">
      <button type="button" role="tab" aria-selected={mode === 'ai'} className={mode === 'ai' ? 'is-active' : ''} onClick={() => setMode('ai')}><Sparkles size={14} /><span>Met Gerrie</span></button>
      <button type="button" role="tab" aria-selected={mode === 'builder'} className={mode === 'builder' ? 'is-active' : ''} onClick={() => setMode('builder')}><LayoutGrid size={14} /><span>Rapportbouwer</span></button>
    </div>
  );

  if (mode === 'builder') {
    return (
      <div className="aire-hub">
        <div className="aire-hub-bar">{tabs}</div>
        <Statistics data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} openReportId={openReportId} pendingReport={pendingReport} />
      </div>
    );
  }

  const reports = list.reports;
  return (
    <div className="aire-hub">
      <div className="bk-head aire-hub-head">
        <div>
          <PageIcon page="stats" />
          <h2>Rapportages</h2>
          <p>Vraag Gerrie om een overzicht. Elke vraag wordt een eigen pagina die bij het openen de actuele cijfers laat zien. Alleen jij ziet je rapportages.</p>
        </div>
        {tabs}
      </div>

      {canChat ? (
        <section className="aire-ask" aria-label="Nieuwe rapportage">
          <label className="aire-ask-label" htmlFor="aire-ask-input"><Sparkles size={15} /> Wat wil je weten?</label>
          <div className="aire-ask-row">
            <textarea
              id="aire-ask-input"
              ref={inputRef}
              rows={2}
              value={question}
              placeholder="Bijvoorbeeld: omzet per maand dit jaar, naast vorig jaar, met de vijf grootste klanten"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button type="button" className="aire-ask-send" onClick={() => ask(question)} disabled={!question.trim()}>
              <Send size={15} /><span>Maak rapportage</span>
            </button>
          </div>
          <div className="aire-suggest">
            {SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => ask(s)}>{s}</button>)}
          </div>
          <div className="aire-ask-foot">
            {budget !== null && (
              <span className="aire-budget">
                <span>AI-tegoed</span>
                <span className="aire-budget-track"><span className="aire-budget-fill" data-low={budget <= 0.2 ? 'true' : 'false'} style={{ width: `${Math.round(budget * 100)}%` }} /></span>
                <span className="aire-budget-pct">{Math.round(budget * 100)}%</span>
              </span>
            )}
            <span>Een vraag of aanpassing kost AI-tegoed. Een rapportage openen of verversen niet.</span>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
        </section>
      ) : (
        <div className="aire-note">Je hebt in deze organisatie geen toegang tot Gerrie. Rapportages met Gerrie maken kan daarom niet; de rapportbouwer werkt wel.</div>
      )}

      {canChat && (
        <section className="aire-list" aria-label="Mijn rapportages">
          <div className="aire-list-head">
            <h3>Mijn rapportages</h3>
            {list.loaded && reports.length > 0 && <span>{reports.length}</span>}
          </div>
          {list.error && <div className="error">{list.error}</div>}
          {!list.loaded ? (
            <div className="aire-cards"><div className="aire-card is-skeleton" /><div className="aire-card is-skeleton" /></div>
          ) : reports.length === 0 ? (
            <div className="aire-empty">
              <BarChart3 size={22} />
              <b>Nog geen rapportages</b>
              <span>Stel hierboven je eerste vraag. Gerrie haalt de gegevens op en zet ze op een eigen pagina.</span>
            </div>
          ) : (
            <div className="aire-cards">
              {reports.map((r) => (
                <article key={r.id} className="aire-card">
                  <button type="button" className="aire-card-open" onClick={() => onOpenReport(r.id)}>
                    <span className="aire-card-icon" aria-hidden="true"><FileBarChart size={16} /></span>
                    <span className="aire-card-title">{r.title}</span>
                    <span className="aire-card-summary">{r.summary || (r.version === 0 ? 'Nog in de maak.' : 'Rapportage van Gerrie.')}</span>
                    <span className="aire-card-meta">{r.version > 0 ? `Versie ${r.version} · ` : ''}bijgewerkt {formatWhen(r.updated_at)}</span>
                  </button>
                  <button type="button" className="aire-card-del" onClick={() => void remove(r)} disabled={deleting === r.id} aria-label={`Verwijder ${r.title}`} title="Verwijderen"><Trash2 size={14} /></button>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
