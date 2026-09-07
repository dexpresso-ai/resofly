import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus, Link2, X } from 'lucide-react';
import type { AppData, CalendarEventLink, CalendarExternalEvent, Task, UUID } from '../types';
import { listCalendarEventsCached } from '../lib/calendar-api';
import { calendarEventLinkMatchesEvent, formatLinkWhen, linkMinutes, localDayKey } from '../lib/calendar-links';
import { formatMinutes } from '../lib/format';
import { Button } from './Ui';

/**
 * Sectie "Agenda" in het taakvenster: welke afspraken horen bij deze taak, en
 * twee wegen om er een bij te leggen — tijd reserveren (de agenda opent met de
 * taak al ingevuld) of een bestaande afspraak kiezen uit de weken rond de
 * plandatum. Alleen voor een taak die al bestaat: een koppeling heeft een
 * taak-id nodig.
 */
export function TaskAgendaSection({ task, data, organizationId, canWrite, onReserve, onLinkEvent, onUnlink, onOpenDay }: {
  task: Task;
  data: AppData;
  organizationId: UUID;
  canWrite: boolean;
  /** Opent de agenda op de plandatum met deze taak als concept-afspraak. */
  onReserve: (task: Task) => void;
  onLinkEvent: (task: Task, event: CalendarExternalEvent) => Promise<void> | void;
  onUnlink: (link: CalendarEventLink) => Promise<void> | void;
  onOpenDay: (dateKey: string) => void;
}) {
  const links = useMemo(
    () => data.calendarEventLinks
      .filter(link => link.task_id === task.id)
      .sort((a, b) => a.event_starts_at.localeCompare(b.event_starts_at)),
    [data.calendarEventLinks, task.id],
  );
  const totalMinutes = links.reduce((sum, link) => sum + (link.track_time ? linkMinutes(link) : 0), 0);

  // Bestaande afspraak koppelen: pas ophalen als je erom vraagt — het venster
  // hoeft de agenda niet te raadplegen voor iemand die alleen de titel wijzigt.
  const [picking, setPicking] = useState(false);
  const [candidates, setCandidates] = useState<CalendarExternalEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!picking) return;
    let cancelled = false;
    // Een week terug tot drie weken vooruit rond de plandatum (of vandaag).
    const anchor = task.planned_date ? new Date(`${task.planned_date}T12:00:00`) : new Date();
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 7);
    const end = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 22);
    setCandidates(null);
    setError(null);
    listCalendarEventsCached(organizationId, start.toISOString(), end.toISOString())
      .then(events => { if (!cancelled) setCandidates(events); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Agenda ophalen mislukt'); });
    return () => { cancelled = true; };
  }, [picking, organizationId, task.planned_date]);

  const options = useMemo(() => {
    if (!candidates) return [];
    return candidates
      // Privé-afspraken blijven dicht: de koppeltabel is org-breed leesbaar.
      .filter(event => event.visibility === 'organization' && !event.is_private_masked && !event.all_day)
      // Wat al aan déze taak hangt hoeft niet nog eens in de lijst.
      .filter(event => !links.some(link => calendarEventLinkMatchesEvent(link, event)))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [candidates, links]);

  async function pick(event: CalendarExternalEvent) {
    setBusy(true);
    setError(null);
    try {
      await onLinkEvent(task, event);
      setPicking(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Koppelen mislukt');
    } finally {
      setBusy(false);
    }
  }

  return <section className="task-editor-section task-agenda">
    <div className="tes-head">
      <div>
        <strong>Agenda</strong>
        <span>{links.length === 0
          ? 'Nog geen afspraak gekoppeld'
          : `${links.length} ${links.length === 1 ? 'afspraak' : 'afspraken'}${totalMinutes > 0 ? ` · ${formatMinutes(totalMinutes)} op de taak` : ''}`}</span>
      </div>
      {canWrite && <div className="task-agenda-actions">
        <Button variant="primary" onClick={() => onReserve(task)} title="Opent de agenda op de plandatum met deze taak als afspraak"><CalendarPlus size={13}/> Tijd reserveren</Button>
        <Button onClick={() => setPicking(open => !open)} aria-expanded={picking}><Link2 size={13}/> Koppel bestaande afspraak</Button>
      </div>}
    </div>

    <div className="task-agenda-list">
      {links.map(link => {
        const dayKey = localDayKey(link.event_starts_at);
        return <div className="task-agenda-row" key={link.id}>
          <button type="button" className="task-agenda-when" onClick={() => onOpenDay(dayKey)} title="Open in de agenda">
            {formatLinkWhen(link)}
          </button>
          <span className="task-agenda-title">{link.event_title_snapshot || 'Afspraak'}</span>
          <span className="task-agenda-dur">
            {linkMinutes(link) > 0 ? formatMinutes(linkMinutes(link)) : ''}
            {!link.track_time && linkMinutes(link) > 0 && <em title="Telt niet mee voor de urenregistratie"> · telt niet</em>}
          </span>
          {canWrite && <button type="button" className="task-agenda-unlink" onClick={() => void onUnlink(link)} aria-label="Afspraak ontkoppelen"><X size={12}/> Ontkoppelen</button>}
        </div>;
      })}
      {links.length === 0 && !picking && <div className="task-empty-line">
        Reserveer tijd in je agenda of koppel een afspraak die er al staat; de uren van die afspraak tellen dan op deze taak.
      </div>}
    </div>

    {picking && <div className="task-agenda-picker">
      <div className="task-agenda-picker-head">
        <span>Kies een afspraak — een week terug tot drie weken vooruit{task.planned_date ? ' rond de plandatum' : ''}</span>
        <button type="button" className="task-agenda-unlink" onClick={() => setPicking(false)}><X size={12}/> Sluiten</button>
      </div>
      {error && <div className="error">{error}</div>}
      {candidates === null && !error && <div className="task-empty-line">Agenda ophalen…</div>}
      {candidates !== null && options.length === 0 && <div className="task-empty-line">Geen koppelbare afspraken in deze periode.</div>}
      {options.map(event => <button
        key={`${event.source_id}-${event.provider_event_id}-${event.starts_at}`}
        type="button"
        className="task-agenda-option"
        disabled={busy}
        onClick={() => void pick(event)}
      >
        <span className="task-agenda-when">{formatLinkWhen({ event_starts_at: event.starts_at, event_ends_at: event.ends_at, event_all_day: event.all_day })}</span>
        <span className="task-agenda-title">{event.title}</span>
        <span className="task-agenda-dur">{event.source_name}</span>
      </button>)}
    </div>}
  </section>;
}
