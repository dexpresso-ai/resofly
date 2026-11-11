import { Ban } from 'lucide-react';
import { calendarMakesConference, effectiveBookingVideo, type BookingVideo } from '../lib/meeting';
import { VideoServiceMark } from './VideoServiceMark';
import type { CalendarProvider, VideoServices } from '../types';

/**
 * Welke videovergadering een boeking krijgt — op de boekingenpagina en bij
 * "Doorsturen naar klant" in de agenda. Jitsi kan op elke agenda (ook de eigen
 * ResoFly-agenda) en maakt per boeking een eigen vergaderruimte. Google Meet en
 * Teams maakt een Google- of Microsoft-agenda zelf; op een andere agenda per
 * boeking los, met je eigen koppeling, als je daar bij Instellingen → Agenda
 * toestemming voor gaf. Een vaste link (apart veld) gaat voor.
 *
 * Sinds 11 november 2026 vier kaarten in plaats van een keuzelijst: Jitsi,
 * Google Meet, Teams en geen. Wat hier niet kan, staat er ook, met waarom en
 * wat je eraan doet. In de keuzelijst stond Teams eerst gewoon niet als het
 * (nog) niet kon, en zocht je ernaar zonder te weten waarom het ontbrak. De
 * klant ziet dezelfde naam en kleur op de boekingspagina.
 */
type ServiceCard = {
  id: 'jitsi' | 'google_meet' | 'teams' | 'none';
  /** De waarde voor meeting_booking_links: Meet op een Google-agenda is 'calendar'. */
  value: BookingVideo;
  name: string;
  detail: string;
  available: boolean;
};

const ACCOUNT = { google_meet: 'Google', teams: 'Microsoft' } as const;
const NAME = { google_meet: 'Google Meet', teams: 'Microsoft Teams' } as const;

function serviceCard(service: 'google_meet' | 'teams', sourceProvider: CalendarProvider | null, videoServices: VideoServices | null | undefined, effective: BookingVideo): ServiceCard {
  const own = (service === 'google_meet' && sourceProvider === 'google') || (service === 'teams' && sourceProvider === 'microsoft');
  if (own) return { id: service, value: 'calendar', name: NAME[service], detail: `Van je ${ACCOUNT[service]}-agenda. De klant krijgt de link in de agenda-uitnodiging.`, available: true };
  const state = videoServices?.[service]?.state;
  if (state === 'klaar' || effective === service) {
    const missing = Boolean(videoServices) && state !== 'klaar';
    return {
      id: service, value: service, name: NAME[service], available: true,
      detail: missing
        ? `Kan nu niet: zet het aan bij Instellingen → Agenda, bij je ${ACCOUNT[service]}-account, of kies iets anders.`
        : `Per boeking met je ${ACCOUNT[service]}-account. De klant krijgt de link in de bevestiging.`,
    };
  }
  const why = !videoServices ? 'Even kijken of dit kan…'
    : state === 'toestemming' ? `Zet het aan bij Instellingen → Agenda, bij je ${ACCOUNT[service]}-account.`
      : state === 'verlopen' ? `Koppel je ${ACCOUNT[service]}-account opnieuw (Instellingen → Agenda).`
        : state === 'account' ? `Je ${ACCOUNT[service]}-account kan dit niet${service === 'teams' ? ' (een privé-Microsoftaccount maakt geen Teams-vergaderingen)' : ''}.`
          : `Koppel eerst een ${ACCOUNT[service]}-account (Instellingen → Agenda).`;
  return { id: service, value: service, name: NAME[service], detail: why, available: false };
}

export function BookingVideoSelect({ value, sourceProvider, videoServices, onChange }: {
  value: BookingVideo;
  sourceProvider: CalendarProvider | null;
  /** Kan ik een losse Meet/Teams maken (van de server)? Zonder: alleen wat de agenda zelf kan. */
  videoServices?: VideoServices | null;
  onChange: (next: BookingVideo) => void;
}) {
  const effective = effectiveBookingVideo(value, sourceProvider);
  const cards: ServiceCard[] = [
    { id: 'jitsi', value: 'jitsi', name: 'Jitsi Meet', detail: 'Werkt op elke agenda. Per boeking een eigen ruimte; de klant heeft geen account nodig.', available: true },
    serviceCard('google_meet', sourceProvider, videoServices, effective),
    serviceCard('teams', sourceProvider, videoServices, effective),
    { id: 'none', value: 'none', name: 'Geen videogesprek', detail: 'Bijvoorbeeld een afspraak op locatie of aan de telefoon.', available: true },
  ];
  // 'calendar' hoort bij de kaart van de dienst die de agenda zelf maakt.
  const selectedId = effective === 'calendar'
    ? (sourceProvider === 'microsoft' ? 'teams' : calendarMakesConference(sourceProvider) ? 'google_meet' : 'jitsi')
    : effective;
  return (
    <fieldset className="booking-video-select">
      <legend>Videogesprek bij een boeking</legend>
      <div className="bvs-grid" role="radiogroup" aria-label="Videogesprek bij een boeking">
        {cards.map(card => {
          const checked = selectedId === card.id;
          return (
            <button
              key={card.id}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={!card.available}
              className={`bvs-card${checked ? ' is-checked' : ''}${card.available ? '' : ' is-off'}`}
              onClick={() => card.available && onChange(card.value)}
            >
              {card.id === 'none'
                ? <span className="vsm vsm-link" aria-hidden="true"><Ban size={16} /></span>
                : <VideoServiceMark kind={card.id} />}
              <span className="bvs-text">
                <strong>{card.name}</strong>
                <small>{card.detail}</small>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
