import { useMemo, useState } from 'react';
import { Check, FileText, Loader2, Search, StickyNote } from 'lucide-react';
import { Button, Input } from './Ui';
import { filterContentTargets, type ContentTarget } from '../lib/notulen';

/** Meer rijen tegelijk maakt de lijst onoverzichtelijk; wie verder wil, zoekt. */
const MAX_ROWS = 30;

/**
 * Kies een notitie of document en zet de notulen eronder. Staat bij de notulen
 * in MeetingRecorder; het wegschrijven gebeurt door de aanroeper (`onAppend`),
 * zodat de rechten en het verversen bij de pagina blijven.
 */
export function NotulenToevoegen({ targets, onAppend, onClose }: {
  targets: ContentTarget[];
  onAppend: (target: ContentTarget) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<ContentTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedTo, setAddedTo] = useState<ContentTarget | null>(null);

  const matches = useMemo(() => filterContentTargets(targets, query), [targets, query]);
  const shown = matches.slice(0, MAX_ROWS);

  async function add() {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAppend(chosen);
      setAddedTo(chosen);
    } catch (e) {
      // De tekst staat er dan niet bij; laat de keuze staan zodat je het opnieuw kunt proberen.
      setError(e instanceof Error && e.message ? e.message : 'Toevoegen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  if (addedTo) {
    return (
      <div className="mr-append" role="status">
        <p className="mr-append-done">
          <Check size={14} /> De notulen staan onderaan {addedTo.kind === 'note' ? 'de notitie' : 'het document'} “{addedTo.title}”.
        </p>
        <div className="mr-actions">
          <Button variant="ghost" onClick={onClose}>Sluiten</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mr-append">
      <div className="mr-append-head">Toevoegen aan een notitie of document</div>
      <label className="mr-append-search">
        <Search size={14} aria-hidden="true" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Zoek op titel of klant…"
          aria-label="Zoek een notitie of document"
        />
      </label>

      {shown.length === 0 ? (
        <p className="mr-append-empty">Niets gevonden{query.trim() ? ` voor “${query.trim()}”` : ''}.</p>
      ) : (
        <ul className="mr-append-list" aria-label="Notities en documenten">
          {shown.map((target) => {
            const on = chosen?.kind === target.kind && chosen.id === target.id;
            return (
              <li key={`${target.kind}:${target.id}`}>
                <button
                  type="button"
                  className={`mr-append-row${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => setChosen(target)}
                >
                  {target.kind === 'note' ? <StickyNote size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
                  <span className="mr-append-title">{target.title}</span>
                  <span className="mr-append-hint">{target.hint}</span>
                  {on && <Check size={14} className="mr-append-check" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {matches.length > shown.length && (
        <p className="mr-append-more">{matches.length - shown.length} meer. Zoek om ze te vinden.</p>
      )}

      {error && <p className="mr-error" role="alert">{error}</p>}

      <div className="mr-actions">
        <Button variant="primary" disabled={!chosen || busy} onClick={() => void add()}>
          {busy ? <><Loader2 size={13} className="spin" /> Toevoegen…</> : 'Voeg notulen toe'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Annuleren</Button>
      </div>
    </div>
  );
}
