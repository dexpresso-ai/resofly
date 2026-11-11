import { useEffect, useMemo, useRef, useState } from 'react';
import type { Client, InboundMessage, InboundMessageCategory } from '../types';
import { Button, Select } from './Ui';
import { blockInboundSender, linkInboundMessage, loadInboundAlias, loadInboundMessages, setInboundMessageStatus } from '../lib/repository';
import { formatEmailDateTime } from './ClientEmailMessage';

// Waarom een bericht niet vanzelf bij een klant belandde, in gewone taal.
export const INBOUND_REASON_LABELS: Record<string, string> = {
  no_match: 'Afzender hoort niet bij een bekende klant',
  ambiguous: 'Meerdere klanten hebben dit e-mailadres',
  blocked: 'Afzender staat op je negeerlijst',
  alias_retiring: 'Binnengekomen op je oude doorstuuradres',
  no_forwarding_evidence: 'Rechtstreeks gestuurd, niet via je doorstuurregel',
  rate_limited: 'Ongewoon veel post tegelijk — even apart gezet',
  token_sender_mismatch: 'Antwoord kwam van iemand anders dan de klant',
  token_org_mismatch: 'Tegenstrijdige adressering',
  messageid_conflict: 'Zelfde kenmerk als een bericht dat er al staat',
  auto_generated: 'Automatisch gegenereerd bericht',
  autoresponder: 'Automatisch antwoord (afwezigheid)',
  bulk: 'Nieuwsbrief of bulkbericht',
  noreply_sender: 'Afzender is een no-reply-adres',
  tnef: 'Bijlage in Outlook-formaat (winmail.dat)',
  oversized: 'Bericht te groot om volledig te lezen',
  parse_error: 'Bericht kon niet gelezen worden',
};

/**
 * De opvangbak: post die binnenkwam maar niet eenduidig aan een klant te
 * koppelen was. Leeft op twee plekken met dezelfde code: als tabblad "Niet
 * gekoppeld" op de klantenlijst, en op de pagina Berichten — daar hoort hij
 * bij de rest van de post. Koppelen, negeren en blokkeren doen op beide
 * plekken precies hetzelfde.
 */
export function InboundInboxTab({ organizationId, clients, canWrite, onChanged, heading = true, onCreateClient, refreshKey = 0 }: {
  organizationId: string;
  clients: Client[];
  canWrite: boolean;
  onChanged: () => void;
  /** De kop "Niet gekoppelde berichten" met uitleg. Uit op de pagina Berichten: daar zegt het tabblad het al. */
  heading?: boolean;
  /**
   * Opent het klantformulier, ingevuld uit deze mail. Na opslaan koppelt de app
   * de mail aan de nieuwe klant (main.tsx, persistEdit) en verhoogt `refreshKey`.
   */
  onCreateClient?: (message: InboundMessage) => void;
  /** Loopt op als er van buitenaf iets in de opvangbak veranderde: dan opnieuw laden. */
  refreshKey?: number;
}) {
  const [category, setCategory] = useState<InboundMessageCategory>('human');
  const [messages, setMessages] = useState<InboundMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aliasId, setAliasId] = useState<string | null>(null);
  const [hasAlias, setHasAlias] = useState<boolean | null>(null);

  // Opnieuw laden na een klant uit een mail gebeurt stil: de lijst staat er al,
  // en "Opvangbak laden…" tussendoor zou de rij waar je net mee bezig was even
  // laten verdwijnen en terugkomen.
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const listKey = `${organizationId}|${category}`;
    if (loadedFor.current !== listKey) setLoaded(false);
    setLoadError(null);
    Promise.all([loadInboundMessages(organizationId, category), loadInboundAlias(organizationId)])
      .then(([rows, alias]) => {
        if (cancelled) return;
        setMessages(rows);
        setAliasId(alias?.id ?? null);
        setHasAlias(Boolean(alias));
        setLoaded(true);
        loadedFor.current = listKey;
      })
      .catch(err => { if (!cancelled) { setLoadError(err instanceof Error ? err.message : 'Opvangbak laden mislukt.'); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [organizationId, category, refreshKey]);

  function removeRow(id: string) {
    setMessages(prev => prev.filter(m => m.id !== id));
    onChanged();
  }

  return <div className="inbound-inbox">
    <div className={`inbound-inbox-head${heading ? '' : ' is-compact'}`}>
      {heading
        ? <div>
            <h3>Niet gekoppelde berichten</h3>
            <p className="settings-help">
              Post die op je doorstuuradres binnenkwam maar niet vanzelf bij een klant te plaatsen was.
              Koppel hem hier alsnog, of leg hem weg.
            </p>
          </div>
        : <p className="settings-help">
            Post die binnenkwam maar niet vanzelf bij een klant te plaatsen was. Koppel hem alsnog, of leg hem weg.
          </p>}
      <div className="client-view-toggle" role="group" aria-label="Soort berichten">
        <button type="button" className={category === 'human' ? 'active' : ''} onClick={() => setCategory('human')} aria-pressed={category === 'human'}>Persoonlijk</button>
        <button type="button" className={category === 'automated' ? 'active' : ''} onClick={() => setCategory('automated')} aria-pressed={category === 'automated'}>Automatisch</button>
      </div>
    </div>

    {!loaded && <div className="client-empty-line">Opvangbak laden…</div>}
    {loaded && loadError && <div className="error">{loadError}</div>}

    {loaded && !loadError && hasAlias === false && <div className="client-empty-state">
      <strong>Je hebt nog geen doorstuuradres</strong>
      <span>
        Stel er een in onder Instellingen → E-mail &amp; domeinen. Daarna komt mail die een klant rechtstreeks
        naar je eigen adres stuurt hier binnen als hij niet vanzelf te plaatsen is.
      </span>
    </div>}

    {loaded && !loadError && hasAlias !== false && messages.length === 0 && <div className="client-empty-state">
      <strong>Niets te doen</strong>
      <span>{category === 'human'
        ? 'Alle binnengekomen post is aan een klant gekoppeld.'
        : 'Geen automatische berichten in de wacht.'}</span>
    </div>}

    <div className="inbound-inbox-list">
      {messages.map(message => (
        <InboundInboxRow
          key={message.id}
          message={message}
          clients={clients}
          organizationId={organizationId}
          aliasId={aliasId}
          canWrite={canWrite}
          onDone={() => removeRow(message.id)}
          onCreateClient={onCreateClient}
        />
      ))}
    </div>
  </div>;
}

function InboundInboxRow({ message, clients, organizationId, aliasId, canWrite, onDone, onCreateClient }: {
  message: InboundMessage;
  clients: Client[];
  organizationId: string;
  aliasId: string | null;
  canWrite: boolean;
  onDone: () => void;
  onCreateClient?: (message: InboundMessage) => void;
}) {
  const [clientId, setClientId] = useState<string>(message.suggested_client_id ?? '');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(() => [...clients].sort((a, b) => a.name.localeCompare(b.name, 'nl')), [clients]);
  const snippet = (message.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  // Weergavenaam afkappen: die is vrij te kiezen door de afzender en een lange
  // naam kan het echte adres uit beeld duwen.
  const senderName = (message.sender_name ?? '').slice(0, 80);

  const daysLeft = message.purge_after
    ? Math.ceil((new Date(message.purge_after).getTime() - Date.now()) / 86400000)
    : null;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Actie mislukt.');
      setBusy(false);
    }
  }

  return <article className="inbound-row">
    <div className="inbound-row-head">
      <div className="inbound-row-sender">
        <strong>{senderName || message.sender_email || 'Onbekende afzender'}</strong>
        {senderName && message.sender_email && <span className="inbound-row-address">{message.sender_email}</span>}
      </div>
      <time>{formatEmailDateTime(message.received_at)}</time>
    </div>

    <div className="inbound-row-subject">{message.subject || '(geen onderwerp)'}</div>
    {snippet && <p className="inbound-row-snippet">{snippet}{snippet.length === 240 ? '…' : ''}</p>}

    {message.attachment_names.length > 0 && <p className="inbound-row-note">
      {message.attachment_names.length} bijlage{message.attachment_names.length === 1 ? '' : 'n'}: {message.attachment_names.join(', ')}
      {' — '}niet opgeslagen, die staan nog in je eigen postvak.
    </p>}

    {message.reason && <p className="inbound-row-reason">
      {INBOUND_REASON_LABELS[message.reason] ?? message.reason}
    </p>}

    {message.candidates.length > 1 && <div className="inbound-row-candidates">
      <span>Bedoelde je:</span>
      {message.candidates.map(candidate => (
        <Button key={candidate.client_id} onClick={() => setClientId(candidate.client_id)} disabled={busy}>
          {candidate.label}
        </Button>
      ))}
    </div>}

    {daysLeft != null && daysLeft <= 14 && <p className="inbound-row-note">
      Wordt over {daysLeft} dag{daysLeft === 1 ? '' : 'en'} automatisch opgeruimd.
    </p>}

    {error && <div className="error">{error}</div>}

    <div className="inbound-row-actions">
      <Select value={clientId} onChange={e => { setClientId(e.target.value); setError(null); }} disabled={!canWrite || busy}>
        <option value="">Kies een klant…</option>
        {sorted.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
      </Select>
      <Button
        variant="primary"
        disabled={!canWrite || busy || !clientId}
        onClick={() => act(() => linkInboundMessage(organizationId, message.id, clientId, remember))}
      >
        {busy ? 'Bezig…' : 'Koppelen'}
      </Button>
      {onCreateClient && <Button
        disabled={!canWrite || busy}
        onClick={() => onCreateClient(message)}
        title="Maak een nieuwe klant met de gegevens uit deze mail. Na opslaan komt de mail in het dossier."
      >
        Nieuwe klant
      </Button>}
      <Button disabled={!canWrite || busy} onClick={() => act(() => setInboundMessageStatus(organizationId, message.id, 'dropped'))}>
        Negeren
      </Button>
      {aliasId && message.sender_email && <Button
        variant="danger"
        disabled={!canWrite || busy}
        onClick={() => {
          if (!window.confirm(`Post van ${message.sender_email} voortaan altijd negeren?`)) return;
          void act(async () => {
            await blockInboundSender(organizationId, aliasId, message.sender_email!);
            await setInboundMessageStatus(organizationId, message.id, 'dropped');
          });
        }}
      >
        Altijd negeren
      </Button>}
    </div>

    <label className="inbound-row-remember">
      <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} disabled={!canWrite || busy} />
      Onthoud dit adres bij deze klant, zodat volgende berichten vanzelf goed komen
    </label>
  </article>;
}
