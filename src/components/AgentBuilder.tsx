import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, Clock, Eye, Loader2, Pencil, Sparkles, Wand2, X } from 'lucide-react';
import {
  designGerrieAgent, ROUTINE_PROPOSE_TOOLS, ROUTINE_READ_TOOLS,
  type GerrieAgentProposal,
} from '../lib/gerrie-api';
import { AgentGlyph } from './AgentGlyph';
import type { UUID } from '../types';

/**
 * De agent-bouwer: je vertelt wat je nodig hebt, Gerrie bouwt de agent.
 *
 * Het formulier met modus, tools en schema is prima als je precies weet wat je
 * doet, maar het is een slechte startpagina — je moet er de begrippen van de
 * machine voor kennen. Hier begin je bij je eigen woorden. Ontbreekt er iets
 * essentieels (hoe vaak? mag hij versturen?), dan vraagt Gerrie het na; verder
 * kiest hij zelf naam, embleem, tijdstip en rechten.
 *
 * Wat eruit komt is een VOORSTEL. Je ziet in gewone taal wat de agent gaat doen,
 * je kunt blijven bijsturen in hetzelfde gesprek ("maak hem maandelijks"), en
 * pas als je op Aanmaken drukt bestaat hij. Bijschaven in het formulier kan altijd.
 */

interface Turn { role: 'user' | 'assistant'; content: string }

const STARTERS = [
  'Elke maandag een overzicht van facturen die te laat zijn',
  'Wekelijks kijken welke offertes stil liggen en de klant een berichtje sturen',
  'Elke maand een samenvatting van mijn omzet en grootste klanten',
  'Klanten met een afgerond project een bedankje sturen',
];

const READ_LABELS = new Map(ROUTINE_READ_TOOLS.map((t) => [t.name, t.label]));
const PROPOSE_LABELS = new Map(ROUTINE_PROPOSE_TOOLS.map((t) => [t.name, t.label]));
const DOW = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

function scheduleText(a: GerrieAgentProposal): string {
  const time = `${String(a.hour).padStart(2, '0')}:00`;
  if (a.schedule_kind === 'daily') return `Elke dag om ${time}`;
  if (a.schedule_kind === 'weekly') return `Elke ${DOW[(a.day_of_week ?? 1) - 1]} om ${time}`;
  return `Maandelijks op dag ${a.day_of_month ?? 1} om ${time}`;
}

export function AgentBuilder({ organizationId, onCreate, onOpenForm, onCancel }: {
  organizationId: UUID;
  /** Slaat de agent op; `activate` bepaalt of hij meteen aan gaat. */
  onCreate: (agent: GerrieAgentProposal, activate: boolean) => Promise<void>;
  /** Naar het formulier: met een gebouwde agent erin, of leeg als er nog niets ligt. */
  onOpenForm: (agent: GerrieAgentProposal | null) => void;
  onCancel: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [built, setBuilt] = useState<{ agent: GerrieAgentProposal; summary: string } | null>(null);
  const [activate, setActivate] = useState(true);
  const [saving, setSaving] = useState(false);
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, built, thinking]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || thinking) return;
    const next: Turn[] = [...turns, { role: 'user', content: message }];
    setTurns(next);
    setDraft('');
    setSuggestions([]);
    setThinking(true);
    setError(null);
    try {
      const step = await designGerrieAgent(organizationId, next);
      if (step.kind === 'budget') {
        setError('Je AI-tegoed voor deze maand is op. Vul de agent zolang zelf in met “Liever zelf invullen”.');
        return;
      }
      if (step.kind === 'question') {
        setTurns([...next, { role: 'assistant', content: step.question }]);
        setSuggestions(step.suggestions);
        return;
      }
      setBuilt({ agent: step.agent, summary: step.summary });
      setTurns([...next, { role: 'assistant', content: step.summary }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gerrie kon deze agent even niet bouwen.');
    } finally {
      setThinking(false);
    }
  }

  async function create() {
    if (!built || saving) return;
    setSaving(true);
    setError(null);
    try { await onCreate(built.agent, activate); }
    catch (e) { setError(e instanceof Error ? e.message : 'Aanmaken mislukt.'); setSaving(false); }
  }

  const agent = built?.agent ?? null;
  const readTools = agent ? agent.enabled_tools.filter((t) => !t.startsWith('propose_')) : [];
  const proposeTools = agent ? agent.enabled_tools.filter((t) => t.startsWith('propose_')) : [];

  return (
    <div className="ag-page">
      <header className="ag-page-head">
        <div className="ag-editor-ident">
          <AgentGlyph agent={agent ? { id: agent.name, name: agent.name, instruction: agent.instruction, enabled_tools: agent.enabled_tools, icon: agent.icon } : { id: 'nieuw', name: 'Nieuwe agent' }} size="lg" />
          <div>
            <h2>Wat moet deze agent voor je doen?</h2>
            <p>Vertel het in je eigen woorden. Gerrie vraagt na wat hij nog moet weten en zet de rest zelf in elkaar.</p>
          </div>
        </div>
        <button className="cc-btn ghost" onClick={onCancel}><X size={14} /> Sluiten</button>
      </header>

      <div className="abx">
        <div className="abx-stream" ref={streamRef}>
          {turns.length === 0 && !thinking && (
            <div className="abx-starters">
              <span className="ag-tokens-label">Bijvoorbeeld</span>
              <div className="abx-starter-list">
                {STARTERS.map((s) => (
                  <button key={s} type="button" className="cc-chip" onClick={() => void send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            <div key={i} className={`abx-turn ${t.role}`}>
              {t.role === 'assistant' && <span className="abx-mark" aria-hidden="true"><Sparkles size={13} /></span>}
              <p>{t.content}</p>
            </div>
          ))}

          {thinking && (
            <div className="abx-turn assistant">
              <span className="abx-mark" aria-hidden="true"><Sparkles size={13} /></span>
              <p className="abx-thinking"><Loader2 size={13} className="ag-spin" /> Gerrie zet hem in elkaar…</p>
            </div>
          )}

          {agent && (
            <article className="abx-card">
              <header>
                <AgentGlyph agent={{ id: agent.name, name: agent.name, instruction: agent.instruction, enabled_tools: agent.enabled_tools, icon: agent.icon }} size="md" state="active" />
                <div>
                  <strong>{agent.name}</strong>
                  <span><Clock size={11} /> {scheduleText(agent)}</span>
                </div>
                <span className={`cc-kind ${agent.mode === 'propose' ? 'write' : 'read'}`}>
                  {agent.mode === 'propose' ? 'stelt acties voor' : 'alleen lezen'}
                </span>
              </header>

              <dl className="abx-facts">
                <div>
                  <dt><Eye size={12} /> Mag inzien</dt>
                  <dd>{readTools.length ? readTools.map((t) => READ_LABELS.get(t) ?? t).join(', ') : 'de standaard leesset'}</dd>
                </div>
                {agent.mode === 'propose' && (
                  <div>
                    <dt><Wand2 size={12} /> Mag klaarzetten</dt>
                    <dd>{proposeTools.length ? proposeTools.map((t) => PROPOSE_LABELS.get(t) ?? t).join(', ') : 'niets'}</dd>
                  </div>
                )}
                {agent.enabled_tools.includes('propose_send_client_email') && (
                  <div>
                    <dt>De mailtekst</dt>
                    <dd>{agent.email_mode === 'template'
                      ? <>Vaste tekst: <em>“{agent.email_subject || 'zonder onderwerp'}”</em></>
                      : 'Gerrie schrijft hem per klant'}</dd>
                  </div>
                )}
                <div>
                  <dt>Zijn opdracht</dt>
                  <dd className="abx-instruction">{agent.instruction}</dd>
                </div>
              </dl>

              <footer>
                <label className="abx-activate">
                  <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
                  Meteen aanzetten en nu draaien
                </label>
                <button type="button" className="cc-btn ghost" disabled={saving} onClick={() => onOpenForm(agent)}>
                  <Pencil size={13} /> Zelf bijschaven
                </button>
                <button type="button" className="cc-btn primary" disabled={saving} onClick={() => void create()}>
                  {saving
                    ? <><Loader2 size={14} className="ag-spin" /> Aanmaken…</>
                    : activate ? <>Aanmaken en starten</> : <>Aanmaken als concept</>}
                </button>
              </footer>
              <p className="abx-hint">
                {activate
                  ? <>Hij gaat meteen aan en draait direct één ronde, zodat je vandaag al ziet wat hij oplevert. {agent.mode === 'propose' ? <>Alles wat hij wil versturen komt als <b>afvinklijst</b> bij je terug.</> : 'Hij leest alleen mee en verandert niets.'}</>
                  : <>Niet helemaal goed? Zeg het gewoon hieronder — bijvoorbeeld “maak hem maandelijks” of “laat hem ook de offertes meenemen”.</>}
              </p>
            </article>
          )}

          {error && <p className="abx-error"><AlertTriangle size={13} /> {error}</p>}
        </div>

        <form
          className="abx-composer"
          onSubmit={(e) => { e.preventDefault(); void send(draft); }}
        >
          {suggestions.length > 0 && (
            <div className="abx-suggestions">
              {suggestions.map((s) => (
                <button key={s} type="button" className="cc-chip" onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          )}
          <div className="abx-input-row">
            <textarea
              className="cc-input"
              rows={2}
              value={draft}
              disabled={thinking}
              placeholder={built ? 'Nog iets aanpassen?' : 'Bijv. elke maandag kijken wie er nog niet betaald heeft'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
            />
            <button type="submit" className="abx-send" disabled={!draft.trim() || thinking} aria-label="Versturen">
              <ArrowUp size={16} />
            </button>
          </div>
          <button type="button" className="abx-manual" onClick={() => onOpenForm(built?.agent ?? null)}>
            Liever zelf invullen
          </button>
        </form>
      </div>
    </div>
  );
}
