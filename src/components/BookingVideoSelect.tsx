import { Select } from './Ui';
import { calendarMakesConference, effectiveBookingVideo, type BookingVideo } from '../lib/meeting';
import type { CalendarProvider } from '../types';

/**
 * Welke videovergadering een boeking krijgt — op de boekingenpagina en bij
 * "Doorsturen naar klant" in de agenda. Jitsi kan op elke agenda (ook de eigen
 * ResoFly-agenda) en maakt per boeking een eigen vergaderruimte; Google Meet en
 * Teams alleen op hun eigen agenda. Een vaste link (apart veld) gaat voor.
 */
export function BookingVideoSelect({ value, sourceProvider, onChange }: {
  value: BookingVideo;
  sourceProvider: CalendarProvider | null;
  onChange: (next: BookingVideo) => void;
}) {
  const external = calendarMakesConference(sourceProvider);
  const effective = effectiveBookingVideo(value, sourceProvider);
  return (
    <div className="booking-video-select">
      <label>Videovergadering bij een boeking
        <Select value={effective} onChange={e => onChange(e.target.value as BookingVideo)}>
          <option value="jitsi">Jitsi Meet — per boeking een eigen vergaderruimte</option>
          {external && <option value="calendar">{sourceProvider === 'microsoft' ? 'Teams-vergadering van je Microsoft-agenda' : 'Google Meet van je Google-agenda'}</option>}
          <option value="none">Geen videovergadering</option>
        </Select>
      </label>
      {effective === 'jitsi' && <p className="muted booking-video-help">Werkt op elke agenda, zonder Google of Microsoft. De klant krijgt de link in de bevestiging en de agenda-uitnodiging, en heeft geen account nodig.</p>}
      {effective === 'calendar' && <p className="muted booking-video-help">De klant krijgt de deelnamelink in de agenda-uitnodiging.</p>}
    </div>
  );
}
