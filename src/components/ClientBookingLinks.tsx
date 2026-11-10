import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import type { MeetingBookingLinkListItem, MeetingBookingLinkState, UUID } from '../types';
import { listBookingLinks } from '../lib/meetingBookingApi';
import { LINK_STATE_LABELS, expiryLabel, fmtDayLong, fmtTime } from '../lib/bookingLinks';

/** De stand van een boekingslink in één woord, met een kleur (globals.css: .mbk-badge). */
export function BookingStateBadge({ state }: { state: MeetingBookingLinkState }) {
  const s = LINK_STATE_LABELS[state] ?? LINK_STATE_LABELS.open;
  return <span className={`mbk-badge tone-${s.tone}`}>{s.label}</span>;
}

/**
 * De afspraken van één klant op de klantpagina: wat er via een boekingslink al
 * gepland staat, welke links er voor deze klant zijn en hoe ze ervoor staan,
 * en een knop om er een te maken.
 *
 * Waarom hier: een boekingslink hing wel aan een klant, maar was alleen te
 * vinden onder Agenda → Boekingslinks. Wie bij een klant keek, zag niet dat er
 * een link uitstond, dat die verlopen was, of dat de klant volgende week
 * dinsdag al kwam. Leesrecht op de Agenda is genoeg om dit te zien; zonder dat
 * recht toont de klantpagina deze kaart niet (harde regel 3).
 */
export function ClientBookingLinks({ organizationId, clientId, canWrite, onOpenLink, onNewLink }: {
  organizationId: UUID;
  clientId: UUID;
  canWrite: boolean;
  onOpenLink: (linkId: UUID) => void;
  onNewLink: () => void;
}) {
  const [links, setLinks] = useState<MeetingBookingLinkListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLinks(null); setError(null);
    listBookingLinks(organizationId, { clientId })
      .then(rows => { if (alive) setLinks(rows); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Boekingslinks laden mislukt.'); });
    return () => { alive = false; };
  }, [organizationId, clientId]);

  const upcoming = (links ?? [])
    .flatMap(l => (l.upcoming_bookings ?? []).map(b => ({ ...b, linkId: l.id, linkTitle: l.title })))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  return <article className="client-panel client-bookings">
    <div className="client-panel-head">
      <h3>Afspraken</h3>
      <div className="client-panel-head-right">
        {links && links.length > 0 && <span>{links.length}</span>}
        {canWrite && <button type="button" className="client-overview-more-btn" onClick={onNewLink}>+ Boekingslink</button>}
      </div>
    </div>

    {links === null && !error && <div className="client-empty-line">Laden…</div>}
    {error && <div className="client-empty-line">{error}</div>}

    {upcoming.length > 0 && <div className="client-booking-upcoming">
      <div className="client-booking-label">Komt eraan</div>
      {upcoming.slice(0, 4).map(b => <button key={b.id} type="button" className="client-booking-next" onClick={() => onOpenLink(b.linkId)}>
        <CalendarClock size={15} aria-hidden="true" />
        <span>
          <strong>{fmtDayLong(b.starts_at)} · {fmtTime(b.starts_at)}–{fmtTime(b.ends_at)}</strong>
          <em>{b.linkTitle}{b.name ? ` · ${b.name}` : ''}</em>
        </span>
      </button>)}
    </div>}

    {links && links.length === 0 && <>
      <div className="client-empty-line">Nog geen boekingslink voor deze klant.</div>
      {canWrite && <button type="button" className="client-overview-more-link" onClick={onNewLink}>+ Laat de klant zelf een moment kiezen</button>}
    </>}

    {links && links.length > 0 && <div className="client-booking-links">
      {links.length > 0 && <div className="client-booking-label">Boekingslinks</div>}
      {links.map(l => {
        const expiry = expiryLabel(l.public_token_expires_at);
        return <button key={l.id} type="button" className="client-booking-row" onClick={() => onOpenLink(l.id)}>
          <span className="client-booking-title">
            <span>{l.title}</span>
            <BookingStateBadge state={l.state} />
          </span>
          <span className="client-booking-meta">
            {l.booking_count}/{l.max_total_bookings} geboekt
            {l.state === 'open' ? ` · ${l.open_slot_count} ${l.open_slot_count === 1 ? 'moment' : 'momenten'} vrij` : ''}
            {l.state === 'open' || l.state === 'expired' ? ` · ${expiry.text.charAt(0).toLowerCase()}${expiry.text.slice(1)}` : ''}
          </span>
        </button>;
      })}
    </div>}
  </article>;
}
