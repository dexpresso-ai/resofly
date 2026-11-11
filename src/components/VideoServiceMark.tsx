import { Video } from 'lucide-react';
import { VIDEO_INFO, type BookingVideoKind } from '../lib/bookingLinks';

/**
 * Het teken van een videodienst: een gekleurd vlak met een camera, in de kleur
 * van Jitsi, Google Meet, Teams of Zoom. Bewust geen logo's van die diensten
 * (die zijn van hen); de kleur en de naam ernaast zeggen genoeg.
 *
 * Gebruikt op de boekingspagina, in het klantportaal en in het beheer, zodat de
 * klant en het team overal hetzelfde zien.
 */
export function VideoServiceMark({ kind, size = 'md' }: { kind: BookingVideoKind; size?: 'sm' | 'md' | 'lg' }) {
  const px = size === 'lg' ? 22 : size === 'sm' ? 13 : 17;
  return <span className={`vsm vsm-${kind} vsm-${size}`} aria-hidden="true"><Video size={px} strokeWidth={2.2} /></span>;
}

/** Teken plus naam, met desgewenst hoe je meedoet eronder. */
export function VideoServiceLine({ kind, showHow = false, size = 'md' }: { kind: BookingVideoKind; showHow?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const info = VIDEO_INFO[kind];
  return <span className="vsm-line">
    <VideoServiceMark kind={kind} size={size} />
    <span className="vsm-text">
      <strong>{info.name}</strong>
      {showHow && <small>{info.how}</small>}
    </span>
  </span>;
}
