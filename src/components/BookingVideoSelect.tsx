import { Select } from './Ui';
import { calendarMakesConference, effectiveBookingVideo, type BookingVideo } from '../lib/meeting';
import type { CalendarProvider, VideoServices } from '../types';

/**
 * Welke videovergadering een boeking krijgt — op de boekingenpagina en bij
 * "Doorsturen naar klant" in de agenda. Jitsi kan op elke agenda (ook de eigen
 * ResoFly-agenda) en maakt per boeking een eigen vergaderruimte. Google Meet en
 * Teams maakt een Google- of Microsoft-agenda zelf; op een andere agenda per
 * boeking los, met je eigen koppeling, als je daar bij Instellingen → Agenda
 * toestemming voor gaf. Een vaste link (apart veld) gaat voor.
 */
export function BookingVideoSelect({ value, sourceProvider, videoServices, onChange }: {
  value: BookingVideo;
  sourceProvider: CalendarProvider | null;
  /** Kan ik een losse Meet/Teams maken (van de server)? Zonder: alleen wat de agenda zelf kan. */
  videoServices?: VideoServices | null;
  onChange: (next: BookingVideo) => void;
}) {
  const external = calendarMakesConference(sourceProvider);
  const effective = effectiveBookingVideo(value, sourceProvider);
  // Los per boeking: alleen bij een agenda van een ándere aanbieder (Meet op een
  // Google-agenda is gewoon "van je agenda"), en als het recht er is. Staat de
  // link al op Meet/Teams terwijl dat (nu) niet kan, dan blijft hij zichtbaar
  // met uitleg, zodat opslaan hem niet stil verandert.
  const standalone = (['google_meet', 'teams'] as const).filter(service => {
    if ((service === 'google_meet' && sourceProvider === 'google') || (service === 'teams' && sourceProvider === 'microsoft')) return false;
    return videoServices?.[service]?.state === 'klaar' || effective === service;
  });
  const label = { google_meet: 'Google Meet', teams: 'Teams' } as const;
  // Pas iets zeggen als de stand bekend is (anders flitst de uitleg bij het laden).
  const missing = Boolean(videoServices) && (effective === 'google_meet' || effective === 'teams') && videoServices?.[effective]?.state !== 'klaar';
  return (
    <div className="booking-video-select">
      <label>Videovergadering bij een boeking
        <Select value={effective} onChange={e => onChange(e.target.value as BookingVideo)}>
          <option value="jitsi">Jitsi Meet — per boeking een eigen vergaderruimte</option>
          {external && <option value="calendar">{sourceProvider === 'microsoft' ? 'Teams-vergadering van je Microsoft-agenda' : 'Google Meet van je Google-agenda'}</option>}
          {standalone.map(service => (
            <option key={service} value={service}>{label[service]} — per boeking, met je {service === 'google_meet' ? 'Google' : 'Microsoft'}-account</option>
          ))}
          <option value="none">Geen videovergadering</option>
        </Select>
      </label>
      {effective === 'jitsi' && <p className="muted booking-video-help">Werkt op elke agenda, zonder Google of Microsoft. De klant krijgt de link in de bevestiging en de agenda-uitnodiging, en heeft geen account nodig.</p>}
      {effective === 'calendar' && <p className="muted booking-video-help">De klant krijgt de deelnamelink in de agenda-uitnodiging.</p>}
      {(effective === 'google_meet' || effective === 'teams') && (missing
        ? <p className="muted booking-video-help calendar-help-warn">{label[effective]} kan nu niet bij deze link: zet het aan bij Instellingen → Agenda, bij je {effective === 'google_meet' ? 'Google' : 'Microsoft'}-account, of kies iets anders.</p>
        : <p className="muted booking-video-help">Per boeking maakt ResoFly een {label[effective]}-vergadering met je {effective === 'google_meet' ? 'Google' : 'Microsoft'}-account. De klant krijgt de link in de bevestiging en de agenda-uitnodiging.</p>)}
    </div>
  );
}
