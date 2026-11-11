import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, ArrowLeft, ArrowUp, CalendarClock, ClipboardCheck, Eye, Loader2, Mails, ScanSearch, SlidersHorizontal, Sparkles, WandSparkles } from 'lucide-react';
import {
  designGerrieAgent, routineToolLabel, routineToolIsRead, previewRoutine,
  type GerrieAgentProposal, type GerrieRoutine, type RoutinePreview,
} from '../lib/gerrie-api';
import { scheduleLabel } from '../lib/agents';
import { AgentGlyph } from './AgentGlyph';
import type { UUID } from '../types';

/**
 * De agent-bouwer: je vertelt het Gerrie, en ziet de agent ontstaan.
 *
 * Opnieuw opgezet op 2026-11-11. Het gesprek stond eerst alleen op de pagina, met
 * de agent pas onderaan zodra hij af was; je zag niet wat Gerrie aan het doen was,
 * en aanpassen via de chat kon niet (alleen in het formulier). Nu:
 *   - links het gesprek; Gerrie begint zelf, met voorbeelden om op te tikken;
 *   - rechts de agent in opbouw: een blauwdruk, die tijdens het nadenken in elkaar
 *     wordt gezet en daarna de echte agent laat zien, met proefdraaien en aanmaken;
 *   - met `editing` pas je een bestaande agent aan: Gerrie krijgt zijn huidige
 *     instellingen mee en wat er verandert, staat erbij als "gewijzigd".
 *
 * Wat eruit komt is een VOORSTEL. Pas bij Aanmaken of Opslaan bestaat (of verandert)
 * de agent; bijschaven in het formulier kan altijd.
 */

interface Turn { role: 'user' | 'assistant'; content: string }

const STARTERS = [
  'Elke maandag een overzicht van facturen die te laat zijn',
  'Zodra een klant mailt, een antwoord voor me klaarzetten',
  'Elke ochtend mijn agenda, taken en open tickets',
  'Wekelijks kijken welke offertes stilliggen',
];
const EDIT_STARTERS = [
  'Laat hem elke maand draaien in plaats van elke week',
  'Alleen facturen boven € 500',
  'Neem ook de offertes mee',
  'Maak de opdracht korter en zakelijker',
];

/** Een opgeslagen agent in de vorm van een voorstel, zodat de kaart hem net zo toont. */
export function routineToProposal(r: GerrieRoutine): GerrieAgentProposal {
  return {
    type: 'agent', name: r.name, icon: r.icon, instruction: r.instruction, mode: r.mode, enabled_tools: r.enabled_tools,
    schedule_kind: r.schedule_kind, hour: r.hour, minute: r.minute, end_hour: r.end_hour, day_of_week: r.day_of_week, day_of_month: r.day_of_month,
    max_proposals_per_run: r.max_proposals_per_run, email_mode: r.email_mode, email_subject: r.email_subject, email_body: r.email_body,
    max_emails_per_run: r.max_emails_per_run, trigger_events: r.trigger_events ?? [], max_event_runs_per_day: r.max_event_runs_per_day,
  };
}

type Field = 'name' | 'when' | 'mode' | 'read' | 'propose' | 'instruction' | 'mail';

/** Wat er verschilt tussen de huidige agent en het nieuwe voorstel. */
function changedFields(before: GerrieAgentProposal | null, after: GerrieAgentProposal): Set<Field> {
  const out = new Set<Field>();
  if (!before) return out;
  const tools = (p: GerrieAgentProposal, read: boolean) => p.enabled_tools.filter((t) => routineToolIsRead(t) === read).sort().join('|');
  if (before.name !== after.name) out.add('name');
  if (scheduleLabel(before) !== scheduleLabel(after)) out.add('when');
  if (before.mode !== after.mode) out.add('mode');
  if (tools(before, true) !== tools(after, true)) out.add('read');
  if (tools(before, false) !== tools(after, false)) out.add('propose');
  if (before.instruction.trim() !== after.instruction.trim()) out.add('instruction');
  if (before.email_mode !== after.email_mode || (before.email_subject ?? '') !== (after.email_subject ?? '')) out.add('mail');
  return out;
}

export function AgentBuilder({ organizationId, editing = null, initialMessage = null, initial = null, onCreate, onSave, onOpenForm, onCancel }: {
  organizationId: UUID;
  /** Een bestaande agent aanpassen via de chat; null = een nieuwe bouwen. */
  editing?: GerrieRoutine | null;
  /** De eerste vraag, al getypt bovenaan de agentspagina. */
  initialMessage?: string | null;
  /** Een startpunt dat al klaarstaat: meteen te zien, en via de chat bij te sturen. */
  initial?: { agent: GerrieAgentProposal; summary: string } | null;
  /** Slaat een nieuwe agent op; `activate` bepaalt of hij meteen aan gaat. */
  onCreate: (agent: GerrieAgentProposal, activate: boolean) => Promise<void>;
  /** Slaat de aangepaste versie op over de bestaande agent heen. */
  onSave?: (agent: GerrieAgentProposal) => Promise<void>;
  /** Naar het formulier: met een gebouwde agent erin, of leeg als er nog niets ligt. */
  onOpenForm: (agent: GerrieAgentProposal | null) => void;
  onCancel: () => void;
}) {
  const current = editing ? routineToProposal(editing) : null;
  const [turns, setTurns] = useState<Turn[]>(() => (initial
    ? [{ role: 'assistant', content: `Ik heb “${initial.agent.name}” voor je klaargezet. ${initial.summary} Wil je iets anders? Zeg het hieronder; anders kun je hem rechts meteen aanmaken.` }]
    : []));
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [built, setBuilt] = useState<{ agent: GerrieAgentProposal; summary: string } | null>(initial);
  const [fresh, setFresh] = useState(false);
  const [activate, setActivate] = useState(true);
  const [saving, setSaving] = useState(false);
  const [trying, setTrying] = useState(false);
  const [preview, setPreview] = useState<RoutinePreview | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const bpRef = useRef<HTMLElement | null>(null);
  const started = useRef(false);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, thinking, error]);

  useEffect(() => {
    if (!fresh) return undefined;
    // Op een smal scherm staat de agent ónder het gesprek: daarheen, anders zie je
    // niet dat hij klaar is.
    if (window.matchMedia?.('(max-width: 1000px)').matches) {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      bpRef.current?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    }
    const timer = window.setTimeout(() => setFresh(false), 1600);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  // De vraag die bovenaan de agentspagina al getypt was: meteen versturen. Eén keer,
  // ook als React het effect in de ontwikkelmodus twee keer draait.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initialMessage?.trim()) void send(initialMessage);
    else inputRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Bij aanpassen, en bij een startpunt, krijgt Gerrie de agent mee zoals hij
      // nu is; anders wist hij bij "maak hem maandelijks" niet over welke agent het ging.
      // Het welkomstbericht is van de app, niet van het gesprek: dat gaat niet mee.
      const base = built?.agent ?? editing;
      const history = initial ? next.slice(1) : next;
      const step = await designGerrieAgent(organizationId, history, base);
      if (step.kind === 'budget') {
        setError('Je AI-tegoed voor deze maand is op. Vul de agent zolang zelf in met “Zelf invullen”.');
        return;
      }
      if (step.kind === 'question') {
        setTurns([...next, { role: 'assistant', content: step.question }]);
        setSuggestions(step.suggestions);
        return;
      }
      setBuilt({ agent: step.agent, summary: step.summary });
      setFresh(true);
      setPreview(null);
      setTurns([...next, { role: 'assistant', content: step.summary || (editing ? 'Aangepast. Rechts zie je de nieuwe versie.' : 'Je agent staat klaar. Rechts zie je wat hij gaat doen.') }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gerrie kon deze agent even niet bouwen.');
    } finally {
      setThinking(false);
      inputRef.current?.focus();
    }
  }

  /** Eén keer proef, alleen kijken: zo beoordeel je hem op wat hij vindt. */
  async function tryOut() {
    const agent = built?.agent ?? current;
    if (!agent || trying) return;
    setTrying(true);
    setError(null);
    try {
      setPreview(await previewRoutine(organizationId, { instruction: agent.instruction, enabled_tools: agent.enabled_tools, model_kind: 'strong' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Proefdraaien lukte niet.');
    } finally {
      setTrying(false);
    }
  }

  async function confirm() {
    if (!built || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (editing && onSave) await onSave(built.agent);
      else await onCreate(built.agent, activate);
    } catch (e) {
      setError(e instanceof Error ? e.message : editing ? 'Opslaan mislukt.' : 'Aanmaken mislukt.');
      setSaving(false);
    }
  }

  const shown = built?.agent ?? current;
  const changes = built ? changedFields(current, built.agent) : new Set<Field>();
  const state = thinking && !built ? 'thinking' : shown ? 'built' : 'empty';
  const greeting = editing
    ? `Wat wil je anders aan “${editing.name || 'deze agent'}”? Zeg het in gewone taal; ik pas hem aan en laat rechts zien wat er verandert.`
    : 'Vertel me wat er vanzelf moet gebeuren: iets wat je elke week controleert, of wat er moet gebeuren zodra er een mail of ticket binnenkomt. Ik zet de agent voor je in elkaar.';
  const starters = editing ? EDIT_STARTERS : STARTERS;

  return (
    <div className="ag-page agx-builder">
      <header className="agx-builder-head">
        <button type="button" className="agx-back" onClick={onCancel}><ArrowLeft size={15} /> {editing ? 'Terug naar de agent' : 'Alle agents'}</button>
        <div className="agx-builder-title">
          <h2>{editing ? `${editing.name || 'Agent'} aanpassen` : 'Nieuwe agent'}</h2>
          <p>{editing ? 'Met Gerrie, in gewone taal. Er verandert pas iets als je opslaat.' : 'Met Gerrie, in gewone taal. Hij vraagt na wat hij nog moet weten.'}</p>
        </div>
        <button type="button" className="agx-ghost" onClick={() => onOpenForm(built?.agent ?? current)}><SlidersHorizontal size={14} /> Zelf invullen</button>
      </header>

      <div className={`agx-split is-${state}`}>
        <section className="agx-chat" aria-label="Gesprek met Gerrie">
          <div className="agx-stream" ref={streamRef}>
            {/* Bij een startpunt begint het gesprek met dat startpunt, niet met de
                algemene uitnodiging en voorbeelden. */}
            {!initial && (
              <div className="agx-msg is-assistant">
                <span className="agx-orb" aria-hidden="true" />
                <p>{greeting}</p>
              </div>
            )}
            {turns.length === 0 && !thinking && (
              <div className="agx-chat-starters">
                {starters.map((s) => <button key={s} type="button" className="agx-chip" onClick={() => void send(s)}>{s}</button>)}
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`agx-msg is-${t.role}`}>
                {t.role === 'assistant' && <span className="agx-orb" aria-hidden="true" />}
                <p>{t.content}</p>
              </div>
            ))}
            {thinking && (
              <div className="agx-msg is-assistant is-thinking" role="status">
                <span className="agx-orb is-busy" aria-hidden="true" />
                <p><span className="agw-dots" aria-hidden="true"><i /><i /><i /></span> {built || editing ? 'Gerrie past hem aan…' : 'Gerrie zet hem in elkaar…'}</p>
              </div>
            )}
            {error && <p className="agx-error"><AlertTriangle size={13} /> {error}</p>}
          </div>

          <form className="agx-composer" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
            {suggestions.length > 0 && (
              <div className="agx-suggestions">
                {suggestions.map((s) => <button key={s} type="button" className="agx-chip" onClick={() => void send(s)}>{s}</button>)}
              </div>
            )}
            <div className="agx-input">
              <textarea
                ref={inputRef}
                rows={2}
                value={draft}
                disabled={thinking}
                aria-label="Bericht aan Gerrie"
                placeholder={built || editing ? 'Wat moet er anders?' : 'Bijv. elke maandag kijken wie er nog niet betaald heeft'}
                onChange={(e) => setDraft(e.target.value.slice(0, 4000))}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
              />
              <button type="submit" className="agx-send" disabled={!draft.trim() || thinking} aria-label="Versturen"><ArrowUp size={17} /></button>
            </div>
            <span className="agx-composer-note">Gerrie bouwt alleen een voorstel. Bouwen kost een klein beetje AI-tegoed.</span>
          </form>
        </section>

        <aside ref={bpRef} className={`agx-bp is-${state}${fresh ? ' is-fresh' : ''}${thinking && shown ? ' is-reworking' : ''}`} aria-label="Je agent" aria-busy={thinking}>
          <div className="agx-bp-label">
            {state === 'built' && built ? (editing ? 'Nieuwe versie' : 'Je nieuwe agent') : editing ? 'Zoals hij nu is' : state === 'thinking' ? 'In opbouw' : 'Je agent'}
          </div>
          {!shown ? <Blueprint thinking={thinking} /> : (
            <AgentPreviewCard
              agent={shown}
              changes={changes}
              reworking={thinking}
              preview={preview}
              trying={trying}
              onTry={() => void tryOut()}
            />
          )}

          {built && (
            <footer className="agx-bp-foot">
              {!editing && (
                <label className="agx-check">
                  <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
                  Meteen aanzetten en één keer draaien
                </label>
              )}
              <button type="button" className="agx-primary" disabled={saving || thinking} onClick={() => void confirm()}>
                {saving
                  ? <><Loader2 size={15} className="ag-spin" /> {editing ? 'Opslaan…' : 'Aanmaken…'}</>
                  : editing ? <>Wijzigingen opslaan</> : activate ? <><WandSparkles size={15} /> Aanmaken en starten</> : <>Aanmaken als concept</>}
              </button>
            </footer>
          )}
          {!built && editing && <p className="agx-bp-hint">Vertel links wat er anders moet; hier verschijnt dan de nieuwe versie.</p>}
        </aside>
      </div>
    </div>
  );
}

/** De lege agent, of de agent die in elkaar wordt gezet terwijl Gerrie nadenkt. */
function Blueprint({ thinking }: { thinking: boolean }) {
  const rows = [
    { icon: <CalendarClock size={13} />, label: 'Wanneer' },
    { icon: <ScanSearch size={13} />, label: 'Kijkt in' },
    { icon: <ClipboardCheck size={13} />, label: 'Mag klaarzetten' },
  ];
  return (
    <div className={`agx-bp-card is-blueprint${thinking ? ' is-assembling' : ''}`} aria-hidden="true">
      <div className="agx-bp-top">
        <span className="agx-bp-slot"><Sparkles size={20} /></span>
        <span className="agx-bp-lines"><i /><i /></span>
      </div>
      {rows.map((r, i) => (
        <div key={r.label} className="agx-bp-row" style={{ '--i': i } as CSSProperties}>
          <span className="agx-bp-key">{r.icon}{r.label}</span>
          <span className="agx-bp-val"><i /><i /></span>
        </div>
      ))}
      <span className="agx-bp-beam" />
      <p className="agx-bp-caption">{thinking ? 'Gerrie kiest wat hij moet bekijken, wanneer hij draait en wat hij mag klaarzetten…' : 'Hier verschijnt je agent. Gerrie vult hem in terwijl jullie praten.'}</p>
    </div>
  );
}

/** De agent zoals hij wordt: in gewone taal, met wat er verandert. */
function AgentPreviewCard({ agent, changes, reworking, preview, trying, onTry }: {
  agent: GerrieAgentProposal;
  changes: Set<Field>;
  reworking: boolean;
  preview: RoutinePreview | null;
  trying: boolean;
  onTry: () => void;
}) {
  const read = agent.enabled_tools.filter(routineToolIsRead);
  const propose = agent.enabled_tools.filter((t) => !routineToolIsRead(t));
  const mark = (f: Field) => (changes.has(f) ? <em className="agx-changed">gewijzigd</em> : null);
  const sendsMail = agent.enabled_tools.includes('propose_send_client_email');
  return (
    <div className={`agx-bp-card is-real${reworking ? ' is-assembling' : ''}`}>
      <div className="agx-bp-top">
        <AgentGlyph agent={{ id: agent.name, name: agent.name, instruction: agent.instruction, enabled_tools: agent.enabled_tools, icon: agent.icon }} size="lg" state={reworking ? 'running' : 'active'} />
        <div className="agx-bp-ident">
          <strong>{agent.name}{mark('name')}</strong>
          <span className={`agx-mode is-${agent.mode}`}>{agent.mode === 'propose' ? 'Zet klaar, jij keurt goed' : 'Kijkt mee, verandert niets'}{mark('mode')}</span>
        </div>
      </div>
      <dl className="agx-facts">
        <div className={changes.has('when') ? 'is-changed' : undefined}>
          <dt><CalendarClock size={13} /> Wanneer</dt>
          <dd>{scheduleLabel(agent)}{mark('when')}</dd>
        </div>
        <div className={changes.has('read') ? 'is-changed' : undefined}>
          <dt><ScanSearch size={13} /> Kijkt in</dt>
          <dd>{read.length ? <span className="agx-tags">{read.map((t) => <span key={t}>{routineToolLabel(t)}</span>)}</span> : 'De standaard leesset'}{mark('read')}</dd>
        </div>
        {agent.mode === 'propose' && (
          <div className={changes.has('propose') ? 'is-changed' : undefined}>
            <dt><ClipboardCheck size={13} /> Mag klaarzetten</dt>
            <dd>
              {propose.length ? <span className="agx-tags is-write">{propose.map((t) => <span key={t}>{routineToolLabel(t)}</span>)}</span> : 'Niets'}
              {mark('propose')}
              {propose.length > 0 && <small>Hoogstens {agent.max_proposals_per_run ?? 3} per keer, elk wacht op jouw akkoord.</small>}
            </dd>
          </div>
        )}
        {sendsMail && (
          <div className={changes.has('mail') ? 'is-changed' : undefined}>
            <dt><Mails size={13} /> Mailtekst</dt>
            <dd>{agent.email_mode === 'template' ? <>Vaste tekst: “{agent.email_subject || 'zonder onderwerp'}”</> : 'Gerrie schrijft hem per klant'}{mark('mail')}</dd>
          </div>
        )}
      </dl>
      <details className={`agx-brief${changes.has('instruction') ? ' is-changed' : ''}`}>
        <summary>Zijn opdracht{mark('instruction')}</summary>
        <p>{agent.instruction}</p>
      </details>

      <div className="agx-try">
        <button type="button" className="agx-ghost" disabled={trying || reworking} onClick={onTry}>
          {trying ? <><Loader2 size={13} className="ag-spin" /> Hij kijkt…</> : <><Eye size={13} /> Laat zien wat hij vindt</>}
        </button>
        <span>Eén keer proef. Hij kijkt alleen, zet niets klaar en verstuurt niets.</span>
      </div>
      {preview && (
        <div className={`agx-preview${preview.ok ? '' : ' is-empty'}`}>
          {preview.budget
            ? <p>Je maandtegoed is op, dus proefdraaien kan nu niet.</p>
            : <>
                <p className="agx-preview-text">{preview.text || 'Hij kwam niet met een antwoord terug.'}</p>
                {preview.steps.length > 0 && <ul>{preview.steps.map((st, i) => <li key={i} className={st.ok ? undefined : 'is-fail'}>{st.label}</li>)}</ul>}
                <p className="agx-preview-note">Klopt dit niet? Zeg het links in het gesprek, bijvoorbeeld “alleen facturen boven €500”.</p>
              </>}
        </div>
      )}
    </div>
  );
}
