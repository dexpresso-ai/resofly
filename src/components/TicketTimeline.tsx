import { useMemo, useState } from 'react';
import type { TicketNote } from '../types';
import { Button, Textarea } from './Ui';
import { createTicketNote, deleteTicketNote, setTicketNoteInternal } from '../lib/repository';

/**
 * De tijdlijn van een ticket: notities van het team (zichtbaar voor de klant
 * of intern) en reacties van de klant uit het portaal. Eén component voor het
 * bewerkvenster van een ticket én de pagina Berichten, zodat een notitie er
 * overal hetzelfde uitziet en "Verwijderen" overal hetzelfde doet.
 *
 * `notes` komt uit AppData (alle notities van de organisatie, gefilterd op
 * dit ticket); na een wijziging vraagt `onChanged` de werkruimte-data opnieuw
 * op, zodat elke plek die dezelfde tijdlijn toont meteen bij is.
 */
export function TicketTimeline({ ticketId, organizationId, currentUserId, notes, canWrite, onChanged }: {
  ticketId: string;
  organizationId: string;
  currentUserId: string | null;
  notes: TicketNote[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...notes].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [notes],
  );
  const clientCount = sorted.filter(n => n.author_type === 'client').length;
  const hiddenCount = sorted.filter(n => n.is_internal).length;

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Actie mislukt');
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const body = draft.trim();
    if (!body) return;
    await run(async () => {
      await createTicketNote(organizationId, { ticketId, body, isInternal: internal });
      setDraft(''); setInternal(false);
    });
  }

  return <section className="ticket-timeline">
    <div className="ticket-timeline-head">
      <div>
        <strong>Tijdlijn</strong>
        <span>{sorted.length} notitie{sorted.length === 1 ? '' : 's'}{clientCount > 0 ? ` · ${clientCount} van klant` : ''}{hiddenCount > 0 ? ` · ${hiddenCount} verborgen` : ''}</span>
      </div>
    </div>

    {/* Eén kolom: schrijfvak boven, tijdlijn eronder — allebei op volle breedte. */}
    <div className="ticket-timeline-grid">
      {canWrite && <div className="ticket-timeline-compose-col">
        <div className="ticket-timeline-composer">
          <Textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="Schrijf een update voor de klant of een interne notitie…" rows={4} disabled={busy} />
          <div className="ticket-timeline-composer-actions">
            <label className={`ticket-visibility-toggle${internal ? ' is-internal' : ''}`}>
              <input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} disabled={busy} />
              <span>{internal ? 'Verborgen voor klant' : 'Zichtbaar voor klant'}</span>
            </label>
            <Button variant="primary" onClick={add} disabled={busy || !draft.trim()}>{busy ? 'Plaatsen…' : (internal ? 'Plaats interne notitie' : 'Plaats notitie')}</Button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
      </div>}

      <div className="ticket-timeline-feed-col">
        {sorted.length === 0 ? <div className="ticket-timeline-empty">Nog geen notities. Plaats de eerste update — de klant ziet zichtbare notities terug in het portaal.</div> : <ol className="ticket-timeline-list">
          {sorted.map(note => {
            const isClient = note.author_type === 'client';
            const mine = note.author_user_id && currentUserId && note.author_user_id === currentUserId;
            return <li className={`ticket-timeline-item${isClient ? ' from-client' : ''}${note.is_internal ? ' is-internal' : ''}`} key={note.id}>
              <span className="ttl-dot" aria-hidden="true" />
              <div className="ttl-body">
                <div className="ttl-meta">
                  <span className="ttl-author">{isClient ? (note.author_name ? `${note.author_name} (klant)` : 'Klant') : (mine ? 'Jij' : (note.author_name || 'Teamlid'))}</span>
                  <span className={`ttl-badge ${isClient ? 'client' : note.is_internal ? 'internal' : 'visible'}`}>{isClient ? 'Klant' : note.is_internal ? 'Intern' : 'Zichtbaar voor klant'}</span>
                  <span className="ttl-time">{new Date(note.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="ttl-text">{note.body}</p>
                {canWrite && <div className="ttl-actions">
                  {!isClient && <button type="button" disabled={busy} onClick={() => run(() => setTicketNoteInternal(note.id, !note.is_internal, organizationId))}>{note.is_internal ? 'Zichtbaar maken voor klant' : 'Verbergen voor klant'}</button>}
                  <button type="button" className="ttl-delete" disabled={busy} onClick={() => { if (confirm('Deze notitie uit de tijdlijn verwijderen?')) void run(() => deleteTicketNote(note.id, organizationId)); }}>Verwijderen</button>
                </div>}
              </div>
            </li>;
          })}
        </ol>}
      </div>
    </div>
  </section>;
}
